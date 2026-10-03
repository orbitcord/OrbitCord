import { readFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import nativeTargets from './native-target.cjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
        child.on('error', reject);
        child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? signal}`)));
    });
}

export async function prepare(release = false, { platform = process.platform, arch = process.arch } = {}) {
    const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'src-tauri', 'target');
    const cross = platform !== process.platform || arch !== process.arch;
    const triple = nativeTargets.nativeTarget(platform, arch);
    if (cross && platform !== 'win32' && !(platform === 'darwin' && process.platform === 'darwin')) {
        throw new Error(`Build ${platform}-${arch} on its destination platform.`);
    }
    await run('cargo', [...(cross && platform === 'win32' ? ['xwin'] : []), 'build', '--locked',
        '--manifest-path', 'src-tauri/Cargo.toml', ...(release ? ['--release'] : []), ...(cross ? ['--target', triple] : []),
        ...(platform === 'win32' ? ['--config', `target.${triple}.rustflags=["-C","target-feature=+crt-static"]`] : [])],
        { env: { ...process.env, CARGO_TARGET_DIR: target } });
    const output = join(root, '.lowcord');
    const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform];
    const native = join(output, release ? `native-${os}-${arch}` : 'native');
    await mkdir(native, { recursive: true });
    const executable = `lowcord-native${platform === 'win32' ? '.exe' : ''}`;
    // Replace the inode atomically. Truncating a running, code-signed Mach-O
    // can leave macOS's executable/signature cache pointing at stale pages.
    const staged = join(native, `${executable}.${process.pid}.tmp`);
    await copyFile(join(target, ...(cross ? [triple] : []), release ? 'release' : 'debug', executable), staged);
    await nativeTargets.validateNative(staged, platform, arch);
    await rename(staged, join(native, executable));
    if (!cross && release) {
        const devNative = join(output, 'native');
        await mkdir(devNative, { recursive: true });
        const devStaged = join(devNative, `${executable}.${process.pid}.tmp`);
        await copyFile(join(native, executable), devStaged);
        await rename(devStaged, join(devNative, executable));
    }
    const read = file => readFile(join(root, 'src-tauri', 'injection', file), 'utf8');
    const [boot, shim, discord, extensions, appearance, settings, appearanceCSS, uiCSS] = await Promise.all(
        ['boot.js', 'shim.js', 'discord.js', 'extensions.js', 'chat-appearance.js', 'settings.js', 'chat-appearance.css', 'lowcord-ui.css'].map(read));
    // Static function body, serialized by Electron into the page's main world
    // synchronously at document start. No eval, script tag or CSP bypass.
    const contents = `const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
    contextBridge.exposeInMainWorld('__LOWCORD_NATIVE__', {
        notify: (title, body) => ipcRenderer.invoke('lowcord:notify', title, body),
        setBadge: count => ipcRenderer.invoke('lowcord:badge', count),
        log: message => ipcRenderer.invoke('lowcord:log', message),
        openExternal: url => ipcRenderer.invoke('lowcord:open-external', url),
    });
    contextBridge.executeInMainWorld({ func: function initializeLowcord(chatAppearanceCSS, lowcordUiCSS) {
        if (window.self !== window.top || window.__LOWCORD_INIT__) return;
        window.__LOWCORD_INIT__ = true;
        ${boot}\n${shim}\n${discord}\n${extensions}\n${appearance}\n
        setupLowcordChatAppearance();
        ${settings}\nsetupLowcordSettings();
        window.__LOWCORD_REPORT__();
    }, args: [${JSON.stringify(appearanceCSS)}, ${JSON.stringify(uiCSS)}] });
}`;
    await build({ stdin: { contents, resolveDir: root, sourcefile: 'lowcord-preload.js' }, bundle: true,
        platform: 'node', format: 'cjs', external: ['electron'], outfile: join(output, 'preload.cjs') });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepare(process.argv.includes('--release'));
