const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, session, screen, dialog, desktopCapturer } = require('electron');
const { join } = require('node:path');
const { NativeBackend } = require('./native.cjs');
const { migrateProfile } = require('./profile.cjs');
const { autoUpdater } = require('electron-updater');

app.setName('OrbitCord');
app.setAppUserModelId('dev.lowcord.app'); // Stable identity preserves existing installs and notifications.
const testing = !app.isPackaged && process.env.LOWCORD_TEST === '1';
const dev = !app.isPackaged && process.env.LOWCORD_DEV === '1';
const testURL = testing ? new URL(process.env.LOWCORD_TEST_URL) : null;
if (testURL && (testURL.hostname !== '127.0.0.1' || testURL.protocol !== 'http:')) throw new Error('Test URL must be local');
const userData = testing ? process.env.LOWCORD_TEST_DATA : join(app.getPath('appData'), 'dev.lowcord.app');
if (!userData) throw new Error('Missing test data directory');
app.setPath('userData', userData);
app.setPath('sessionData', join(userData, 'Chromium'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (dev) app.commandLine.appendSwitch('remote-debugging-port', '9222');
let mainWindow, tray, backend, stateTimer, quitting = false, finished = false;
let downloadedUpdate = null, updateDismissed = false, updateRestarting = false, updateError = null;

const trusted = value => {
    try {
        const url = new URL(value);
        return url.origin === 'https://discord.com' || (testing && url.origin === testURL.origin);
    } catch { return false; }
};
const assertSender = event => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
        || !trusted(event.senderFrame.url)) throw new Error('Untrusted native request');
};
const show = () => {
    if (!mainWindow) return;
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
};
const openExternal = url => backend.call('open_external', { url }).catch(error => console.error('[lowcord]', error.message));
async function checkForMacUpdates() {
    try {
        const response = await fetch('https://api.github.com/repos/orbitcord/OrbitCord/releases/latest', {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'OrbitCord' },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return;
        const release = await response.json();
        const available = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name || '');
        const current = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(app.getVersion());
        if (!available || !current || !release.html_url || new URL(release.html_url).origin !== 'https://github.com') return;
        let isNewer = false;
        for (let index = 1; index <= 3; index++) {
            if (Number(available[index]) === Number(current[index])) continue;
            isNewer = Number(available[index]) > Number(current[index]);
            break;
        }
        if (!isNewer || !mainWindow || mainWindow.isDestroyed()) return;
        const result = await dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'OrbitCord update available',
            message: `OrbitCord ${release.tag_name} is ready to download.`,
            detail: 'Open the release page to download and install the update.',
            buttons: ['Open release page', 'Later'], defaultId: 0, cancelId: 1,
        });
        if (result.response === 0) void openExternal(release.html_url);
    } catch (error) {
        console.error('[lowcord] Update check failed:', error.message);
    }
}
function startWindowsUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const check = () => autoUpdater.checkForUpdates().catch(error =>
        console.error('[lowcord] Update check failed:', error.message));
    setTimeout(check, 10_000).unref();
    setInterval(check, 24 * 60 * 60 * 1000).unref();
}
const updateNoticeState = () => downloadedUpdate && !updateDismissed
    ? { version: downloadedUpdate, restarting: updateRestarting, error: updateError } : null;
const publishUpdateNotice = () => {
    if (mainWindow && !mainWindow.isDestroyed() && trusted(mainWindow.webContents.getURL())) {
        mainWindow.webContents.send('lowcord:update-state', updateNoticeState());
    }
};
const updateFailed = error => {
    console.error('[lowcord] Update failed:', error.message);
    if (!updateRestarting) return;
    updateRestarting = false;
    updateError = 'Couldn’t restart. Try again, or quit OrbitCord to install.';
    publishUpdateNotice();
};
const saveState = () => {
    clearTimeout(stateTimer);
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
    return backend.call('save_window_state', { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
};
const scheduleState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => saveState().catch(error => console.error('[lowcord]', error.message)), 300);
};

async function start() {
    if (!testing) await migrateProfile(app.getPath('sessionData'));
    backend = new NativeBackend(app.isPackaged ? join(process.resourcesPath, 'native', `lowcord-native${process.platform === 'win32' ? '.exe' : ''}`)
        : join(__dirname, '..', '.lowcord', 'native', `lowcord-native${process.platform === 'win32' ? '.exe' : ''}`), userData);
    const saved = await backend.call('get_window_state');
    const onScreen = saved && screen.getAllDisplays().some(({ workArea }) =>
        saved.x + saved.width > workArea.x + 64 && saved.x < workArea.x + workArea.width - 64
        && saved.y + saved.height > workArea.y + 64 && saved.y < workArea.y + workArea.height - 64);
    // Set the browser identity before creating WebContents: session changes
    // do not update an existing window's navigator.userAgent.
    const ses = session.defaultSession;
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Lowcord|Datcord|OrbitCord)\/[\w.-]+/gi, ''));
    mainWindow = new BrowserWindow({
        ...(onScreen ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: 1280, height: 800 }),
        minWidth: 520, minHeight: 400, title: 'OrbitCord', backgroundColor: '#313338', show: !testing,
        icon: join(__dirname, '..', 'src-tauri', 'icons', '128x128.png'), autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, '..', '.lowcord', 'preload.cjs'), sandbox: true,
            contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: true,
        },
    });
    if (process.platform === 'darwin') app.dock.setIcon(join(__dirname, '..', 'src-tauri', 'icons', 'icon.png'));
    if (saved?.maximized && onScreen) mainWindow.maximize();
    const permitted = new Set(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture', 'speaker-selection']);
    ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(
        contents === mainWindow.webContents && trusted(details.requestingUrl) && permitted.has(permission)));
    ses.setPermissionCheckHandler((contents, permission, origin) =>
        contents === mainWindow.webContents && trusted(origin) && permitted.has(permission));
    // Use the OS picker on macOS 15+, and a native source menu elsewhere.
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
        if (request.frame !== mainWindow.webContents.mainFrame || !trusted(request.securityOrigin)) { callback({}); return; }
        try {
            const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
            let answered = false;
            const answer = streams => { if (!answered) { answered = true; callback(streams); } };
            const picker = Menu.buildFromTemplate([
                ...sources.map(source => ({ label: source.name, click: () => answer({ video: source,
                    ...(process.platform === 'win32' && request.audioRequested ? { audio: 'loopback' } : {}) }) })),
                { type: 'separator' }, { label: 'Cancel', click: () => answer({}) },
            ]);
            picker.popup({ window: mainWindow, callback: () => answer({}) });
        } catch { callback({}); }
    }, { useSystemPicker: true });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!trusted(url)) { event.preventDefault(); void openExternal(url); }
    });
    mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    mainWindow.webContents.on('context-menu', async (_event, params) => {
        const contents = mainWindow.webContents;
        if (params.mediaType !== 'image' || !params.hasImageContents || !params.srcURL
            || params.frame !== contents.mainFrame || !trusted(params.pageURL)
            || !Number.isInteger(params.x) || !Number.isInteger(params.y)) return;
        try {
            const protocol = new URL(params.srcURL).protocol;
            if (!['https:', 'http:', 'blob:', 'data:'].includes(protocol)) return;
            // Discord keeps its own context menus in the timeline. Only add
            // native image actions inside an opened media/profile dialog.
            const inViewer = await contents.executeJavaScript(
                `Boolean(document.elementFromPoint(${params.x}, ${params.y})?.closest('[role="dialog"]'))`);
            if (!inViewer || contents.isDestroyed() || contents.getURL() !== params.pageURL) return;
            Menu.buildFromTemplate([
                { label: 'Copy image', click: () => {
                    if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
                } },
                { label: 'Save image…', click: () => {
                    // Chromium uses the existing session and a native Save As
                    // dialog, keeping the original file rather than a screenshot.
                    if (!contents.isDestroyed()) contents.downloadURL(params.srcURL);
                } },
            ]).popup({ window: mainWindow });
        } catch (error) {
            if (!contents.isDestroyed()) console.error('[lowcord] Image menu:', error.message);
        }
    });
    mainWindow.webContents.on('page-title-updated', event => { event.preventDefault(); mainWindow.setTitle('OrbitCord'); });
    mainWindow.webContents.on('console-message', details => {
        if (details.level === 'error') console.error('[page]', details.message.slice(0, 600));
    });
    ipcMain.handle('lowcord:notify', (event, title, body) => { assertSender(event); return backend.call('notify', { title, body }); });
    ipcMain.handle('lowcord:log', (event, message) => { assertSender(event); return backend.call('log', { message }); });
    ipcMain.handle('lowcord:open-external', (event, url) => { assertSender(event); return backend.call('open_external', { url }); });
    ipcMain.handle('lowcord:update-state', event => { assertSender(event); return updateNoticeState(); });
    ipcMain.handle('lowcord:update-dismiss', event => {
        assertSender(event);
        if (updateRestarting) return;
        updateDismissed = true;
        publishUpdateNotice();
    });
    ipcMain.handle('lowcord:update-restart', event => {
        assertSender(event);
        if (!downloadedUpdate || updateDismissed || updateRestarting) return;
        updateRestarting = true;
        updateError = null;
        publishUpdateNotice();
        try { autoUpdater.quitAndInstall(); } catch (error) { updateFailed(error); }
    });
    autoUpdater.on('error', updateFailed);
    autoUpdater.on('update-downloaded', ({ version }) => {
        if (typeof version !== 'string' || !version || downloadedUpdate === version) return;
        downloadedUpdate = version;
        updateDismissed = updateRestarting = false;
        updateError = null;
        publishUpdateNotice();
    });
    ipcMain.handle('lowcord:badge', (event, count) => {
        assertSender(event);
        if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw new Error('Invalid badge');
        app.setBadgeCount(count);
        if (process.platform === 'win32') mainWindow.flashFrame(count > 0);
    });
    mainWindow.on('close', event => {
        if (!quitting && !testing) { event.preventDefault(); mainWindow.hide(); void saveState().catch(console.error); }
    });
    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(event, scheduleState);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ label: 'OrbitCord', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
        { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    if (!testing) {
        const image = nativeImage.createFromPath(join(__dirname, '..', 'src-tauri', 'icons',
            process.platform === 'darwin' ? 'trayTemplate.png' : '32x32.png')).resize({ width: 18, height: 18 });
        image.setTemplateImage(process.platform === 'darwin');
        tray = new Tray(image);
        tray.setToolTip('OrbitCord');
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Show OrbitCord', click: show },
            { label: 'OrbitCord Settings', click: () => { show(); void mainWindow.webContents.executeJavaScript('window.__lowcordOpenSettings?.()'); } },
            { type: 'separator' }, { label: 'Quit', click: () => app.quit() },
        ]));
        tray.on('click', show);
    }
    await mainWindow.loadURL(testing ? testURL.href : 'https://discord.com/channels/@me');
    if (!testing && app.isPackaged && process.platform === 'win32') startWindowsUpdater();
    else if (!testing && process.platform === 'darwin') void checkForMacUpdates();
}

if (!testing && !app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', show);
    app.on('activate', show);
    app.on('window-all-closed', () => { if (testing) app.quit(); });
    app.on('before-quit', event => {
        if (finished) return;
        event.preventDefault();
        if (quitting) return;
        quitting = true;
        void saveState().catch(console.error).finally(() => { finished = true; backend?.close(); app.quit(); });
    });
    app.whenReady().then(start).catch(error => {
        if (quitting || finished) return;
        console.error('[lowcord] Startup failed:', error);
        if (!testing) dialog.showErrorBox('OrbitCord could not start', error.message);
        app.quit();
    });
}
