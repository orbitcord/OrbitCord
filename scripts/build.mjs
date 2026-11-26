import { readFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { build, transform } from 'esbuild';
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
    await buildPreload({ release });
}

// Also used by the performance harness to build an exact source snapshot,
// without rebuilding Rust or modifying the user's installed profile.
// Release builds are minified: the main-world script is parsed on every
// launch. The startup diagnostic only reaches stderr, so it is dev-only.
export async function buildPreload({ sourceRoot = root, output = join(sourceRoot, '.lowcord'), release = false } = {}) {
    await mkdir(output, { recursive: true });
    const read = file => readFile(join(sourceRoot, 'src-tauri', 'injection', file), 'utf8');
    const minifyCSS = async css => release ? (await transform(css, { loader: 'css', minify: true })).code : css;
    const minifyThemesCSS = async css => {
        if (!release) return css;
        // Preserve /* @theme <id> */ section markers that themes.js splits on.
        const parts = css.split(/^\/\*\s*@theme\s+([\w -]+?)\s*\*\/\s*$/m);
        const sections = [await minifyCSS(parts[0])];
        for (let i = 1; i < parts.length; i += 2) {
            sections.push(`\n/* @theme ${parts[i]} */\n${await minifyCSS(parts[i + 1])}`);
        }
        return sections.join('');
    };
    const [boot, shim, discord, themes, extensions, chatCapture, massDelete, mediaGallery, dmQuickReply, background, gif, musicEmbeds, socialEmbeds, appearance, settings, rawThemesCSS, rawAppearanceCSS, rawUiCSS] = await Promise.all(
        ['boot.js', 'shim.js', 'discord.js', 'themes.js', 'extensions.js', 'chat-capture.js', 'mass-delete.js', 'media-gallery.js', 'dm-quick-reply.js', 'background.js', 'gif.js', 'music-embeds.js', 'social-embeds.js', 'chat-appearance.js', 'settings.js', 'themes.css', 'chat-appearance.css', 'lowcord-ui.css'].map(read));
    // Static function body, serialized by Electron into the page's main world
    // synchronously at document start. No eval, script tag or CSP bypass.
    const socialLinks = await readFile(join(sourceRoot, 'electron', 'social-links.cjs'), 'utf8');
    const musicLinks = await readFile(join(sourceRoot, 'electron', 'music-links.cjs'), 'utf8');
    const [redgifs, rawRedgifsCSS] = await Promise.all(['redgifs.js', 'redgifs.css'].map(read));
    const [reddit, rawRedditCSS] = await Promise.all(['reddit.js', 'reddit.css'].map(read));
    const [pictureInPicture, rawPictureInPictureCSS] = await Promise.all(['picture-in-picture.js', 'picture-in-picture.css'].map(read));
    const [videoCompression, rawVideoCompressionCSS] = await Promise.all(['video-compression.js', 'video-compression.css'].map(read));
    const [mediaSources, rawMediaSourcesCSS] = await Promise.all(['media-sources.js', 'media-sources.css'].map(read));
    const imageDrop = await read('image-drop.js');
    const extraScripts = await Promise.all(['split-messages.js', 'read-all.js', 'call-timer.js', 'online-friends.js', 'translate.js', 'spellcheck.js', 'quick-reactions.js', 'command-palette.js', 'tabs.js', 'embed-images.js', 'zip-preview.js', 'gif-captioner.js', 'tenor.js'].map(read));
    const [rawUiExtrasCSS, rawMediaExtrasCSS, rawGifCaptionerCSS] = await Promise.all(['ui-extras.css', 'media-extras.css', 'gif-captioner.css'].map(read));
    const [privacyCore, privacyMedia, privacy, rawPrivacyCSS, imageCover] = await Promise.all(['privacy-core.js', 'privacy-media.js', 'privacy.js', 'privacy.css', 'image-cover.js'].map(read));
    const [themesCSS, appearanceCSS, uiCSS, privacyCSS, videoCompressionCSS, redgifsCSS, redditCSS, mediaSourcesCSS, pictureInPictureCSS, gifCaptionerCSS, mediaExtrasCSS] = await Promise.all([
        minifyThemesCSS(rawThemesCSS),
        minifyCSS(rawAppearanceCSS),
        minifyCSS(`${rawUiCSS}\n${rawUiExtrasCSS}`),
        minifyCSS(rawPrivacyCSS),
        minifyCSS(rawVideoCompressionCSS),
        minifyCSS(rawRedgifsCSS),
        minifyCSS(rawRedditCSS),
        minifyCSS(rawMediaSourcesCSS),
        minifyCSS(rawPictureInPictureCSS),
        minifyCSS(rawGifCaptionerCSS),
        minifyCSS(rawMediaExtrasCSS),
    ]);
    const lazyStyles = { privacy: privacyCSS, videoCompression: videoCompressionCSS, redgifs: redgifsCSS, reddit: redditCSS,
        mediaSources: mediaSourcesCSS, pictureInPicture: pictureInPictureCSS, gifCaptioner: gifCaptionerCSS, mediaExtras: mediaExtrasCSS };
    const contents = `const { contextBridge, ipcRenderer, webFrame } = require('electron');
// The sleep page (a data: URL) gets no bridge or Discord hooks.
if (process.isMainFrame && location.protocol !== 'data:') {
    require('./electron/update-notice.cjs').setupUpdateNotice(ipcRenderer);
    ipcRenderer.on('lowcord:trim-memory', () => webFrame.clearCache());
    // Discord's gateway checks its socket on "online"; see electron/network-watch.cjs.
    ipcRenderer.on('lowcord:network-changed', () => { if (navigator.onLine) window.dispatchEvent(new Event('online')); });
    contextBridge.exposeInMainWorld('__LOWCORD_NATIVE__', {
        notify: (title, body) => ipcRenderer.invoke('lowcord:notify', title, body),
        setBadge: count => ipcRenderer.invoke('lowcord:badge', count),
        setTabsCloseable: value => ipcRenderer.invoke('lowcord:tabs-closeable', value === true),
        onCloseTab: callback => {
            const listener = () => callback();
            ipcRenderer.on('lowcord:close-tab', listener);
            return () => ipcRenderer.removeListener('lowcord:close-tab', listener);
        },
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
        fetchRemote: (url, options) => ipcRenderer.invoke('lowcord:fetch-remote', url, options),
        touchId: reason => ipcRenderer.invoke('lowcord:touch-id', reason),
        touchIdAvailable: () => ipcRenderer.invoke('lowcord:touch-id-available'),
        setEmbedPreferences: settings => ipcRenderer.invoke('lowcord:embed-preferences', settings),
        spellcheck: settings => ipcRenderer.invoke('lowcord:spellcheck', settings),
        // Synchronous, trusted text input over the current selection, so an
        // editor's own beforeinput handling sees it like typing.
        insertText: text => { if (typeof text !== 'string' || text.length > 64) return false; webFrame.insertText(text); return true; },
        mediaProcess: (op, args, bytes) => ipcRenderer.invoke('lowcord:media-process', op, args, bytes),
        sanitizeImage: bytes => ipcRenderer.invoke('lowcord:sanitize-image', bytes),
        privacyPreferences: settings => ipcRenderer.invoke('lowcord:privacy-preferences', settings),
        traces: (action, value) => ipcRenderer.invoke('lowcord:traces', action, value),
        onWalkAway: callback => {
            const listener = (_event, value) => callback(value);
            ipcRenderer.on('lowcord:walk-away', listener);
            return () => ipcRenderer.removeListener('lowcord:walk-away', listener);
        },
        onAttachmentInspection: callback => {
            const listener = (_event, value) => callback(value);
            ipcRenderer.on('lowcord:attachment-inspection', listener);
            return () => ipcRenderer.removeListener('lowcord:attachment-inspection', listener);
        },
        background: settings => ipcRenderer.invoke('lowcord:background', settings),
        resolveSocialLink: (url, provider) => ipcRenderer.invoke('lowcord:resolve-social-link', url, provider),
        socialPost: url => ipcRenderer.invoke('lowcord:social-post', url),
        socialVideo: (url, limit, compress) => ipcRenderer.invoke('lowcord:social-video', url, limit, compress === true),
        socialMedia: (url, limit, compress) => ipcRenderer.invoke('lowcord:social-media', url, limit, compress === true),
        redgifsSearch: (query, page, options) => ipcRenderer.invoke('lowcord:redgifs-search', query, page, options),
        redgifsPrepare: (key, limit) => ipcRenderer.invoke('lowcord:redgifs-prepare', key, limit),
        redgifsCancel: scope => ipcRenderer.invoke('lowcord:redgifs-cancel', scope),
        redgifsResolve: id => ipcRenderer.invoke('lowcord:redgifs-resolve', id),
        redgifsRelease: handle => ipcRenderer.invoke('lowcord:redgifs-release', handle),
        reddit: (action, ...args) => ipcRenderer.invoke('lowcord:reddit', action, ...args),
        videoCompression: (action, ...args) => ipcRenderer.invoke('lowcord:video-compression', action, ...args),
        mediaSources: (action, ...args) => ipcRenderer.invoke('lowcord:media-sources', action, ...args),
        onMediaSource: callback => {
            const listener = (_event, value) => callback(value);
            ipcRenderer.on('lowcord:media-source', listener);
            return () => ipcRenderer.removeListener('lowcord:media-source', listener);
        },
        captureRegion: rect => ipcRenderer.invoke('lowcord:capture-region', rect),
        copyImage: bytes => ipcRenderer.invoke('lowcord:copy-image', bytes),
        saveImage: (bytes, name) => ipcRenderer.invoke('lowcord:save-image', bytes, name),
        downloadMedia: url => ipcRenderer.invoke('lowcord:download-media', url),
        downloadDroppedImage: url => ipcRenderer.invoke('lowcord:download-dropped-image', url),
        paste: plain => ipcRenderer.invoke('lowcord:paste', plain === true),
        reportAccount: name => ipcRenderer.invoke('lowcord:account', name),
        accounts: (action, id) => ipcRenderer.invoke('lowcord:accounts', action, id),
        onAccountsChanged: callback => {
            const listener = (_event, list) => callback(list);
            ipcRenderer.on('lowcord:accounts-changed', listener);
            return () => ipcRenderer.removeListener('lowcord:accounts-changed', listener);
        },
    });
    contextBridge.executeInMainWorld({ func: function initializeLowcord(themesCSS, chatAppearanceCSS, lowcordUiCSS, lazyStyles) {
        if (window.self !== window.top || window.__LOWCORD_INIT__) return;
        window.__LOWCORD_INIT__ = true;
        // The theme is applied first, before Discord paints anything.
        ${boot}\n${shim}\n${discord}
        // Modal/picker/feature stylesheets stay out of the cascade until first use.
        const loadedStyles = new Set();
        window.Lowcord.ensureStyle = name => {
            if (loadedStyles.has(name)) return;
            const css = lazyStyles?.[name];
            if (!css) return;
            loadedStyles.add(name);
            delete lazyStyles[name];
            const node = document.createElement('style');
            node.id = \`lowcord-style-\${name}\`;
            node.textContent = css;
            const mount = () => (document.head ?? document.documentElement).append(node);
            if (document.head || document.documentElement) mount();
            else document.addEventListener('DOMContentLoaded', mount, { once: true });
        };
        ${themes}\nsetupLowcordThemes();\n${socialLinks}\n${musicLinks}\n${privacyCore}\n${privacyMedia}\n${privacy}\n${videoCompression}\n${extensions}\n${chatCapture}\n${imageCover}\n${massDelete}\n${mediaGallery}\n${dmQuickReply}\n${background}\n${gif}\n${musicEmbeds}\n${socialEmbeds}\n${appearance}\n
        setupLowcordChatAppearance();
        ${redgifs}
        ${reddit}
        ${mediaSources}
        ${imageDrop}
        ${pictureInPicture}
        ${extraScripts.join('\n')}
        ${settings}\nsetupLowcordSettings();
        ${release ? '' : 'window.__LOWCORD_REPORT__();'}
    }, args: [${JSON.stringify(themesCSS)}, ${JSON.stringify(appearanceCSS)}, ${JSON.stringify(uiCSS)}, ${JSON.stringify(lazyStyles)}] });
}`;
    await build({ stdin: { contents, resolveDir: sourceRoot, sourcefile: 'lowcord-preload.js' }, bundle: true,
        platform: 'node', format: 'cjs', external: ['electron'], minify: release, outfile: join(output, 'preload.cjs') });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepare(process.argv.includes('--release'));
