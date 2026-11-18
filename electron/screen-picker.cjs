const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const { join } = require('node:path');
const { release } = require('node:os');
const { pathToFileURL } = require('node:url');

// Screen share source picker: thumbnails of screens and windows, and a switch
// for system sound where Chromium can capture it (Windows, and macOS 14.2+
// through a Core Audio tap). The window exists only while it is open.
const audioSupported = process.platform === 'win32'
    || (process.platform === 'darwin' && (([major, minor]) => major > 23 || (major === 23 && minor >= 2))(release().split('.').map(Number)));
let current = null, shareSound = true;

ipcMain.handle('lowcord:screen-picker', (event, action, value) => {
    if (!current || event.sender !== current.window.webContents) throw new Error('No screen picker is open');
    if (action === 'sources') return current.list();
    if (action === 'choose') {
        const source = current.sources.get(value?.id);
        if (!source) throw new Error('That source is no longer available');
        if (current.audio) shareSound = value.audio === true;
        current.finish({ source, audio: current.audio && value.audio === true });
        return true;
    }
    if (action === 'cancel') { current.finish(null); return true; }
    throw new Error('Unknown picker action');
});

// Resolves to { source, audio } or null when cancelled.
function pick({ parent, audioRequested }) {
    current?.finish(null);
    return new Promise(resolve => {
        const window = new BrowserWindow({ parent, modal: process.platform !== 'linux', width: 760, height: 560, minWidth: 520, minHeight: 400,
            show: false, title: 'Share your screen', backgroundColor: '#1e1f22', autoHideMenuBar: true, minimizable: false, maximizable: false, fullscreenable: false,
            webPreferences: { preload: join(__dirname, 'screen-picker-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
                webSecurity: true, spellcheck: false, partition: 'orbitcord-screen-picker' } });
        const picker = { window, sources: new Map(), audio: audioRequested && audioSupported,
            async list() {
                let found = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true });
                // The picker itself is never offered.
                const own = window.isDestroyed() ? '' : window.getMediaSourceId();
                found = found.filter(source => source.id !== own);
                picker.sources = new Map(found.map(source => [source.id, source]));
                return { audio: picker.audio, shareSound,
                    sources: found.filter(source => !source.thumbnail.isEmpty() || source.id.startsWith('screen:')).map(source => ({
                        id: source.id, name: source.name, kind: source.id.startsWith('screen:') ? 'screen' : 'window',
                        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
                        icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.resize({ width: 32 }).toDataURL() : '' })) };
            },
            finish(choice) {
                if (current !== picker) return;
                current = null;
                resolve(choice);
                if (!window.isDestroyed()) window.destroy();
            } };
        current = picker;
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.on('closed', () => picker.finish(null));
        parent.once('closed', () => picker.finish(null));
        window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
        window.loadURL(pathToFileURL(join(__dirname, 'screen-picker.html')).href).catch(() => picker.finish(null));
    });
}

module.exports = { pick, audioSupported };
