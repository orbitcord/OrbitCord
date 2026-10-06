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
    await buildPreload();
}

// Also used by the performance harness to build an exact source snapshot,
// without rebuilding Rust or modifying the user's installed profile.
export async function buildPreload({ sourceRoot = root, output = join(sourceRoot, '.lowcord') } = {}) {
    await mkdir(output, { recursive: true });
    const read = file => readFile(join(sourceRoot, 'src-tauri', 'injection', file), 'utf8');
    const [boot, shim, discord, extensions, gif, musicEmbeds, socialEmbeds, appearance, settings, appearanceCSS, uiCSS] = await Promise.all(
        ['boot.js', 'shim.js', 'discord.js', 'extensions.js', 'gif.js', 'music-embeds.js', 'social-embeds.js', 'chat-appearance.js', 'settings.js', 'chat-appearance.css', 'lowcord-ui.css'].map(read));
    // Static function body, serialized by Electron into the page's main world
    // synchronously at document start. No eval, script tag or CSP bypass.
    const socialLinks = await readFile(join(sourceRoot, 'electron', 'social-links.cjs'), 'utf8');
    const musicLinks = await readFile(join(sourceRoot, 'electron', 'music-links.cjs'), 'utf8');
    const contents = `const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
    require('./electron/update-notice.cjs').setupUpdateNotice(ipcRenderer);
    contextBridge.exposeInMainWorld('__LOWCORD_NATIVE__', {
        notify: (title, body) => ipcRenderer.invoke('lowcord:notify', title, body),
        setBadge: count => ipcRenderer.invoke('lowcord:badge', count),
        log: message => ipcRenderer.invoke('lowcord:log', message),
        openExternal: url => ipcRenderer.invoke('lowcord:open-external', url),
        updateStatus: () => ipcRenderer.invoke('lowcord:updates-status'),
        checkForUpdates: () => ipcRenderer.invoke('lowcord:updates-check'),
        downloadUpdate: () => ipcRenderer.invoke('lowcord:updates-download'),
        installUpdate: () => ipcRenderer.invoke('lowcord:updates-install'),
        onUpdateStatus: callback => {
            const listener = (_event, state) => callback(state);
            ipcRenderer.on('lowcord:updates-status', listener);
            return () => ipcRenderer.removeListener('lowcord:updates-status', listener);
        },
        appIcon: id => ipcRenderer.invoke('lowcord:app-icon', id),
        setEmbedPreferences: settings => ipcRenderer.invoke('lowcord:embed-preferences', settings),
        resolveSocialLink: (url, provider) => ipcRenderer.invoke('lowcord:resolve-social-link', url, provider),
        socialPost: url => ipcRenderer.invoke('lowcord:social-post', url),
        socialVideo: (url, limit) => ipcRenderer.invoke('lowcord:social-video', url, limit),
        socialMedia: (url, limit) => ipcRenderer.invoke('lowcord:social-media', url, limit),
    });
    contextBridge.executeInMainWorld({ func: function initializeLowcord(chatAppearanceCSS, lowcordUiCSS) {
        if (window.self !== window.top || window.__LOWCORD_INIT__) return;
        window.__LOWCORD_INIT__ = true;
        ${boot}\n${shim}\n${discord}\n${socialLinks}\n${musicLinks}\n${extensions}\n${gif}\n${musicEmbeds}\n${socialEmbeds}\n${appearance}\n
        setupLowcordChatAppearance();
        ${settings}\nsetupLowcordSettings();
        window.__LOWCORD_REPORT__();
    }, args: [${JSON.stringify(appearanceCSS)}, ${JSON.stringify(uiCSS)}] });
}`;
    await build({ stdin: { contents, resolveDir: sourceRoot, sourcefile: 'lowcord-preload.js' }, bundle: true,
        platform: 'node', format: 'cjs', external: ['electron'], outfile: join(output, 'preload.cjs') });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepare(process.argv.includes('--release'));
