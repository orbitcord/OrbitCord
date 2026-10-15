const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, session, screen, dialog, desktopCapturer, protocol, net, shell, clipboard, ClipboardItem } = require('electron');
const { join } = require('node:path');
const { readFileSync, writeFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { NativeBackend } = require('./native.cjs');
const { migrateProfile } = require('./profile.cjs');
const { setupEmbedPlugins } = require('./embed-plugins.cjs');
const { createSocialResolver } = require('./social-resolver.cjs');
const { createSocialPosts, scheme: mediaScheme } = require('./social-posts.cjs');
const { createUpdateController, latestRelease, macAsset, downloadMacInstaller } = require('./updates.cjs');
const { createBackgroundSaver } = require('./background.cjs');

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
// Social card media is proxied through tokens minted in social-posts.cjs, so
// Discord's CSP stays untouched and remote hosts never see Discord's origin.
protocol.registerSchemesAsPrivileged([{ scheme: mediaScheme,
    privileges: { standard: true, secure: true, bypassCSP: true, stream: true, supportFetchAPI: true } }]);
if (dev) app.commandLine.appendSwitch('remote-debugging-port', '9222');
let mainWindow, tray, backend, socialPosts, socialResolver, autoUpdater, quitting = false, finished = false;
let downloadedUpdate = null, updateDismissed = false, updateRestarting = false, updateError = null;
// Every open Discord window by its webContents id. The main window uses the
// default session; each extra account has a persistent partition of its own,
// so separate windows stay logged into different accounts.
const discordWindows = new Map();
const configuredSessions = new WeakSet();
const openingAccounts = new Map();
let lastFocused;

const trusted = value => {
    try {
        const url = new URL(value);
        return url.origin === 'https://discord.com' || (testing && url.origin === testURL.origin);
    } catch { return false; }
};
const recordFor = contents => {
    const record = contents && discordWindows.get(contents.id);
    return record && !record.window.isDestroyed() && record.window.webContents === contents ? record : undefined;
};
const assertSender = event => {
    const record = recordFor(event.sender);
    if (!record || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Untrusted native request');
    return record;
};
const showWindow = window => {
    if (!window || window.isDestroyed()) return;
    window.show();
    if (window.isMinimized()) window.restore();
    window.focus();
};
const show = () => showWindow(mainWindow);
// Another launch or a Dock click returns to the window last used.
const showLast = () => {
    const last = lastFocused && !lastFocused.window.isDestroyed() && lastFocused.window.isVisible() ? lastFocused.window : null;
    if (last) showWindow(last); else show();
};
const openExternal = url => backend.call('open_external', { url }).catch(error => console.error('[lowcord]', error.message));

const accountsFile = join(userData, 'accounts.json');
const accountId = /^account-\d{1,6}$/;
const labelText = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : null;
function readAccounts() {
    const list = [{ id: 'main', label: null }];
    let saved;
    try { saved = JSON.parse(readFileSync(accountsFile, 'utf8')).accounts; } catch {}
    for (const entry of Array.isArray(saved) ? saved : []) {
        if (entry?.id === 'main') list[0].label = labelText(entry.label);
        else if (accountId.test(entry?.id) && !list.some(account => account.id === entry.id)) list.push({ id: entry.id, label: labelText(entry.label) });
    }
    return list;
}
const accounts = readAccounts();
const saveAccounts = () => {
    try { writeFileSync(accountsFile, JSON.stringify({ accounts })); } catch (error) { console.error('[lowcord]', error.message); }
};
const accountName = account => account.label ?? (account.id === 'main' ? 'Main account' : `Account ${accounts.indexOf(account) + 1}`);
const windowFor = account => [...discordWindows.values()].find(record => record.account === account && !record.window.isDestroyed());
const windowTitle = record => accounts.length > 1 ? `OrbitCord — ${accountName(record.account)}` : 'OrbitCord';
const accountList = record => accounts.map(account => ({ id: account.id, name: accountName(account), main: account.id === 'main',
    current: record?.account === account, open: Boolean(windowFor(account)) }));
// Window titles, the tray, the app menu and open Accounts pages follow the list.
function accountsChanged() {
    for (const record of discordWindows.values()) {
        if (record.window.isDestroyed()) continue;
        record.window.setTitle(windowTitle(record));
        if (trusted(record.window.webContents.getURL())) record.window.webContents.send('lowcord:accounts-changed', accountList(record));
    }
    tray?.setContextMenu(trayMenu());
    Menu.setApplicationMenu(appMenu());
}
function openAccount(account) {
    const record = windowFor(account);
    if (record) { showWindow(record.window); return Promise.resolve(); }
    // Two quick clicks must not open the same profile twice.
    if (!openingAccounts.has(account)) openingAccounts.set(account, createDiscordWindow(account)
        .catch(error => console.error('[lowcord] Account window:', error.message))
        .finally(() => openingAccounts.delete(account)));
    return openingAccounts.get(account);
}
function newAccount() {
    const next = Math.max(0, ...accounts.map(account => Number(account.id.slice(8)) || 0)) + 1;
    const account = { id: `account-${next}`, label: null };
    accounts.push(account);
    saveAccounts();
    accountsChanged();
    return openAccount(account);
}
async function removeAccount(account, parent) {
    const { response } = await dialog.showMessageBox(parent, {
        type: 'warning', title: 'Remove account',
        message: `Remove ${accountName(account)} from OrbitCord?`,
        detail: 'Its window closes and OrbitCord signs it out on this computer. Your Discord account is not affected.',
        buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    if (response !== 0 || !accounts.includes(account)) return false;
    windowFor(account)?.window.destroy();
    accounts.splice(accounts.indexOf(account), 1);
    saveAccounts();
    accountsChanged();
    const ses = session.fromPartition(`persist:${account.id}`);
    await Promise.all([ses.clearStorageData(), ses.clearCache()]).catch(error => console.error('[lowcord]', error.message));
    return true;
}
const trayMenu = () => Menu.buildFromTemplate([
    ...(accounts.length > 1 ? accounts.map(account => ({ label: accountName(account), click: () => void openAccount(account) }))
        : [{ label: 'Show OrbitCord', click: show }]),
    { label: 'New Account Window', click: () => void newAccount() },
    { type: 'separator' },
    { label: 'OrbitCord Settings', click: () => { show(); void mainWindow?.webContents.executeJavaScript('window.__lowcordOpenSettings?.()'); } },
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() },
]);
const appMenu = () => Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'OrbitCord', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
        { label: 'New Account Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => void newAccount() },
        ...(accounts.length > 1 ? [{ type: 'separator' }, ...accounts.map(account => ({ label: accountName(account), click: () => void openAccount(account) }))] : []),
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
]);
const eachTrustedWindow = callback => {
    for (const record of discordWindows.values()) {
        if (!record.window.isDestroyed() && trusted(record.window.webContents.getURL())) callback(record.window.webContents);
    }
};
let notifiedMacVersion;
async function checkForMacUpdates() {
    const state = await updates.check();
    if (state.status !== 'available' || state.version === notifiedMacVersion || !mainWindow || mainWindow.isDestroyed()) return;
    notifiedMacVersion = state.version;
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'OrbitCord update available',
        message: `OrbitCord ${state.version} is ready to download.`,
        detail: 'Download the Mac installer, then open it to replace OrbitCord in Applications.',
        buttons: ['Download update', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (result.response !== 0) return;
    const downloaded = await updates.download();
    if (downloaded.status === 'error') {
        dialog.showErrorBox('OrbitCord update failed', downloaded.error);
        return;
    }
    if (downloaded.status !== 'downloaded' || !mainWindow || mainWindow.isDestroyed()) return;
    const install = await dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'OrbitCord update ready',
        message: `OrbitCord ${downloaded.version} has downloaded.`,
        detail: 'Open the installer, quit OrbitCord, and drag the new app to Applications to replace the old version.',
        buttons: ['Open installer', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (install.response === 0) await updates.install();
}
function initializeUpdater() {
    if (autoUpdater) return;
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.on('error', updateFailed);
    autoUpdater.on('update-downloaded', ({ version }) => {
        if (typeof version !== 'string' || !version || downloadedUpdate === version) return;
        downloadedUpdate = version;
        updateDismissed = updateRestarting = false;
        updateError = null;
        publishUpdateNotice();
    });
}
function startUpdater() {
    if (process.platform === 'win32') updates.initialize();
    const check = () => void (process.platform === 'darwin' ? checkForMacUpdates() : updates.check()).catch(error =>
        console.error('[lowcord] Update check failed:', error.message));
    setTimeout(check, 10_000).unref();
    setInterval(check, 24 * 60 * 60 * 1000).unref();
}
const updateNoticeState = () => downloadedUpdate && !updateDismissed
    ? { version: downloadedUpdate, restarting: updateRestarting, error: updateError } : null;
const publishUpdateNotice = () => eachTrustedWindow(contents => contents.send('lowcord:update-state', updateNoticeState()));
const updateFailed = error => {
    console.error('[lowcord] Update failed:', error.message);
    if (!updateRestarting) return;
    updateRestarting = false;
    updateError = 'Couldn’t restart. Try again, or quit OrbitCord to install.';
    publishUpdateNotice();
};
const updates = createUpdateController({
    currentVersion: app.getVersion(), platform: process.platform, packaged: app.isPackaged,
    getUpdater: () => { initializeUpdater(); return autoUpdater; },
    getRelease: () => latestRelease(net.fetch),
    downloadInstaller: (release, onProgress) => downloadMacInstaller({
        fetch: net.fetch, directory: join(userData, 'updates'), asset: macAsset(release, process.arch), onProgress,
    }),
    openInstaller: path => shell.openPath(path),
    publish: state => eachTrustedWindow(contents => contents.send('lowcord:updates-status', state)),
});
// Window bounds are saved per account; the main window keeps its old file.
const stateAccount = account => account.id === 'main' ? {} : { account: account.id };
const saveState = record => {
    clearTimeout(record.stateTimer);
    if (record.window.isDestroyed()) return Promise.resolve();
    return backend.call('save_window_state', { ...stateAccount(record.account), ...record.window.getNormalBounds(), maximized: record.window.isMaximized() });
};
const scheduleState = record => {
    clearTimeout(record.stateTimer);
    record.stateTimer = setTimeout(() => saveState(record).catch(error => console.error('[lowcord]', error.message)), 300);
};
const saveAllStates = () => Promise.all([...discordWindows.values()].map(saveState));
// The Dock/taskbar badge counts unread messages across every account.
const updateBadge = () => app.setBadgeCount([...discordWindows.values()].reduce((total, record) => total + record.badge, 0));

const appIcons = ['default', 'candy', 'champagne', 'graphite', 'midnight', 'sun', 'ember', 'fjord', 'marine', 'scarlet'];
let windowsIconUpdate = Promise.resolve();
const iconPath = (id, dock) => join(__dirname, '..', 'src-tauri', 'icons', 'app', `${id}${dock ? '-dock' : ''}.png`);
function readAppIcon() {
    try {
        const { icon } = JSON.parse(readFileSync(join(userData, 'app-icon.json'), 'utf8'));
        if (appIcons.includes(icon)) return icon;
    } catch {}
    return 'default';
}
// Changes the live dock/taskbar/window icon. Windows pins need their own icon
// resource updated too, and macOS shows the bundle's icon once the app quits.
function applyAppIcon(id, changed) {
    if (process.platform === 'darwin') {
        app.dock.setIcon(nativeImage.createFromPath(iconPath(id, true)));
        if (app.isPackaged && !testing) require('./mac-icon.cjs').applyMacBundleIcon(id === 'default' ? null : iconPath(id, true),
            { executable: process.execPath, userData, changed }).catch(error => console.error('[lowcord] Bundle icon:', error.message));
    }
    else if (process.platform === 'win32') {
        // Finish each shell refresh before applying the next selection. A fast
        // series of clicks must leave every surface on the last selected icon.
        windowsIconUpdate = windowsIconUpdate.catch(() => {}).then(async () => {
            if (mainWindow) await require('./windows-icon.cjs').applyWindowsIcon(mainWindow, iconPath(id), {
                userData, nativeImage, shell: require('electron').shell, appData: app.getPath('appData'),
                desktop: app.getPath('desktop'), programData: process.env.ProgramData, publicDirectory: process.env.PUBLIC,
                executable: process.execPath, packaged: app.isPackaged && !testing, tray,
            });
            for (const record of discordWindows.values()) {
                if (record.window !== mainWindow && !record.window.isDestroyed()) record.window.setIcon(windowIcon(id));
            }
        });
        return windowsIconUpdate;
    }
    else for (const record of discordWindows.values()) if (!record.window.isDestroyed()) record.window.setIcon(windowIcon(id));
}
const windowIcon = id => nativeImage.createFromPath(process.platform === 'win32'
    ? require('./windows-icon.cjs').windowsIconPath(iconPath(id), userData, nativeImage) : iconPath(id));

const permitted = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'display-capture', 'speaker-selection']);
// Session-wide handlers, installed once per account session. Each one looks
// up the window that owns the request, so a reopened account window reuses them.
function configureSession(ses) {
    if (configuredSessions.has(ses)) return;
    configuredSessions.add(ses);
    // Set the browser identity before creating WebContents: session changes
    // do not update an existing window's navigator.userAgent.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Lowcord|Datcord|OrbitCord)\/[\w.-]+/gi, ''));
    ses.protocol.handle(mediaScheme, request => socialPosts.serve(request));
    // Discord delegates fullscreen to cross-origin video players through its
    // iframe policy. Chromium still requires that delegation and a user gesture;
    // requiring the player's URL to be discord.com makes its button do nothing.
    // Device/capture and other permissions remain restricted to Discord's origin.
    const allowsPermission = (contents, permission, requestingUrl) =>
        Boolean(recordFor(contents)) && contents.session === ses && trusted(contents.getURL())
        && (permission === 'fullscreen' || (trusted(requestingUrl) && permitted.has(permission)));
    ses.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(allowsPermission(contents, permission, details.requestingUrl)));
    ses.setPermissionCheckHandler((contents, permission, origin) =>
        allowsPermission(contents, permission, origin));
    const sessionWindow = () => [...discordWindows.values()].find(record =>
        !record.window.isDestroyed() && record.window.webContents.session === ses)?.window;
    // Use the OS picker on macOS 15+, and a native source menu elsewhere.
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
        const window = sessionWindow();
        if (!window || request.frame !== window.webContents.mainFrame || !trusted(request.securityOrigin)) { callback({}); return; }
        try {
            const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
            let answered = false;
            const answer = streams => { if (!answered) { answered = true; callback(streams); } };
            const picker = Menu.buildFromTemplate([
                ...sources.map(source => ({ label: source.name, click: () => answer({ video: source,
                    ...(process.platform === 'win32' && request.audioRequested ? { audio: 'loopback' } : {}) }) })),
                { type: 'separator' }, { label: 'Cancel', click: () => answer({}) },
            ]);
            picker.popup({ window, callback: () => answer({}) });
        } catch { callback({}); }
    }, { useSystemPicker: true });
    // A security key holding several Discord passkeys asks which one to use.
    ses.on('select-webauthn-account', (_event, details, callback) => {
        let answered = false;
        const answer = id => { if (!answered) { answered = true; callback(id); } };
        const window = sessionWindow();
        if (!window || !trusted(`https://${details.relyingPartyId}`) || !details.accounts.length) { answer(); return; }
        Menu.buildFromTemplate([
            ...details.accounts.map(account => ({ label: account.displayName || account.name || 'Passkey',
                click: () => answer(account.credentialId) })),
            { type: 'separator' }, { label: 'Cancel', click: () => answer() },
        ]).popup({ window, callback: () => setTimeout(answer) });
    });
}

// Opens one Discord window for an account. Only the main window hides to the
// tray; extra account windows are destroyed on close to free their memory.
async function createDiscordWindow(account) {
    const main = account.id === 'main';
    const ses = main ? session.defaultSession : session.fromPartition(`persist:${account.id}`);
    configureSession(ses);
    const saved = await backend.call('get_window_state', main ? null : stateAccount(account)).catch(() => null);
    const onScreen = saved && screen.getAllDisplays().some(({ workArea }) =>
        saved.x + saved.width > workArea.x + 64 && saved.x < workArea.x + workArea.width - 64
        && saved.y + saved.height > workArea.y + 64 && saved.y < workArea.y + workArea.height - 64);
    // A new account window opens offset from the window in front.
    const front = !main && !onScreen ? (BrowserWindow.getFocusedWindow() ?? mainWindow) : null;
    const cascade = front && !front.isDestroyed() ? (({ x, y, width, height }) => ({ x: x + 32, y: y + 32, width, height }))(front.getNormalBounds()) : null;
    const window = new BrowserWindow({
        ...(onScreen ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : cascade ?? { width: 1280, height: 800 }),
        minWidth: 520, minHeight: 400, title: 'OrbitCord', backgroundColor: '#313338', show: !testing && process.platform !== 'win32',
        icon: join(__dirname, '..', 'src-tauri', 'icons', '128x128.png'), autoHideMenuBar: true,
        webPreferences: {
            session: ses, preload: join(__dirname, '..', '.lowcord', 'preload.cjs'), sandbox: true,
            contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: true,
        },
    });
    const contents = window.webContents;
    const id = contents.id;
    const record = { account, window, badge: 0, stateTimer: undefined,
        embedPlugins: setupEmbedPlugins(contents),
        // LOWCORD_FAST_SLEEP counts sleep delays in seconds for manual testing.
        background: createBackgroundSaver({ window, userData, trusted,
            minute: dev && process.env.LOWCORD_FAST_SLEEP === '1' ? 1000 : 60_000 }) };
    discordWindows.set(id, record);
    if (main) mainWindow = window;
    window.setTitle(windowTitle(record));
    if (main) await applyAppIcon(readAppIcon());
    else if (process.platform !== 'darwin') window.setIcon(windowIcon(readAppIcon()));
    if (saved?.maximized && onScreen) window.maximize();
    // Let Explorer see the selected icon and updated launch shortcuts before
    // it creates the taskbar button. Showing first can cache the default icon.
    if (!testing && process.platform === 'win32') window.show();
    contents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' }; });
    contents.on('will-navigate', (event, url) => {
        if (!trusted(url)) { event.preventDefault(); void openExternal(url); }
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('context-menu', async (_event, params) => {
        // Discord handles its own menus; Electron has no default one for text,
        // so text fields and selections get a native edit menu.
        if ((params.isEditable || params.selectionText) && params.frame === contents.mainFrame && trusted(params.pageURL)) {
            const { editFlags, isEditable, misspelledWord, dictionarySuggestions } = params;
            const edit = (label, action, enabled) => ({ label, enabled,
                click: () => { if (!contents.isDestroyed()) contents[action](); } });
            Menu.buildFromTemplate([
                ...(isEditable && misspelledWord ? [
                    ...dictionarySuggestions.slice(0, 5).map(word => ({ label: word,
                        click: () => { if (!contents.isDestroyed()) contents.replaceMisspelling(word); } })),
                    ...(dictionarySuggestions.length ? [] : [{ label: 'No suggestions', enabled: false }]),
                    { label: 'Add to dictionary', click: () => ses.addWordToSpellCheckerDictionary(misspelledWord) },
                    { type: 'separator' },
                ] : []),
                ...(isEditable ? [edit('Cut', 'cut', editFlags.canCut)] : []),
                edit('Copy', 'copy', editFlags.canCopy),
                ...(isEditable ? [edit('Paste', 'paste', editFlags.canPaste),
                    edit('Paste and Match Style', 'pasteAndMatchStyle', editFlags.canPaste)] : []),
                { type: 'separator' }, edit('Select All', 'selectAll', editFlags.canSelectAll),
            ]).popup({ window });
            return;
        }
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
            ]).popup({ window });
        } catch (error) {
            if (!contents.isDestroyed()) console.error('[lowcord] Image menu:', error.message);
        }
    });
    contents.on('page-title-updated', event => { event.preventDefault(); window.setTitle(windowTitle(record)); });
    contents.on('console-message', details => {
        if (details.level === 'error') console.error('[page]', details.message.slice(0, 600));
    });
    window.on('focus', () => { lastFocused = record; });
    window.on('close', event => {
        if (main && !quitting && !testing) { event.preventDefault(); window.hide(); void saveState(record).catch(console.error); }
        else if (!main) void saveState(record).catch(console.error);
    });
    window.on('closed', () => {
        clearTimeout(record.stateTimer);
        discordWindows.delete(id);
        if (window === mainWindow) mainWindow = null;
        if (lastFocused === record) lastFocused = undefined;
        updateBadge();
        if (!quitting) accountsChanged();
    });
    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) window.on(event, () => scheduleState(record));
    if (!main) accountsChanged();
    await window.loadURL(testing ? testURL.href : 'https://discord.com/channels/@me');
    return record;
}

function registerIpc() {
    ipcMain.handle('lowcord:app-icon', async (event, id) => {
        assertSender(event);
        if (id === undefined) return readAppIcon();
        if (id === 'previews') return Object.fromEntries(appIcons.map(name =>
            [name, nativeImage.createFromPath(iconPath(name)).resize({ width: 160, height: 160, quality: 'best' }).toDataURL()]));
        if (!appIcons.includes(id)) throw new Error('Unknown icon');
        await applyAppIcon(id, true);
        try { writeFileSync(join(userData, 'app-icon.json'), JSON.stringify({ icon: id })); } catch (error) { console.error('[lowcord]', error.message); }
        return id;
    });
    ipcMain.handle('lowcord:notify', (event, title, body) => {
        const record = assertSender(event);
        // With several accounts, a notification names the one it came from.
        if (accounts.length > 1 && typeof title === 'string') title = `${title.slice(0, 150)} · ${accountName(record.account).slice(0, 100)}`;
        return backend.call('notify', { title, body });
    });
    ipcMain.handle('lowcord:log', (event, message) => { assertSender(event); return backend.call('log', { message }); });
    ipcMain.handle('lowcord:open-external', (event, url) => { assertSender(event); return backend.call('open_external', { url }); });
    ipcMain.handle('lowcord:embed-preferences', (event, settings) => { assertSender(event).embedPlugins.set(settings); });
    ipcMain.handle('lowcord:background', (event, settings) => {
        const { background } = assertSender(event);
        if (settings === undefined) return background.get();
        const saved = background.set(settings);
        // The setting is app-wide; other open windows pick it up too.
        for (const record of discordWindows.values()) if (record.background !== background && !record.window.isDestroyed()) record.background.set(saved);
        return saved;
    });
    ipcMain.handle('lowcord:account', (event, name) => {
        const { account } = assertSender(event);
        const label = labelText(name);
        if (!label || typeof name !== 'string' || name.length > 100) throw new Error('Invalid account name');
        if (account.label === label || !accounts.includes(account)) return;
        account.label = label;
        saveAccounts();
        accountsChanged();
    });
    ipcMain.handle('lowcord:accounts', async (event, action, id) => {
        const record = assertSender(event);
        if (action === undefined) return accountList(record);
        if (action === 'new') { void newAccount(); return accountList(record); }
        const account = accounts.find(entry => entry.id === id);
        if (!account) throw new Error('Unknown account');
        if (action === 'open') void openAccount(account);
        else if (action === 'remove') {
            if (account.id === 'main') throw new Error('The main account cannot be removed');
            // The settings bridge is visible to Discord's main world, so removal
            // always asks natively first.
            await removeAccount(account, record.window);
        } else throw new Error('Unknown action');
        return accountList(recordFor(event.sender));
    });
    ipcMain.handle('lowcord:resolve-social-link', (event, url, provider) => {
        assertSender(event);
        if (typeof url !== 'string' || url.length > 2048 || typeof provider !== 'string') throw new Error('Invalid link');
        return socialResolver.resolve(url, provider);
    });
    ipcMain.handle('lowcord:social-post', (event, url) => {
        assertSender(event);
        if (typeof url !== 'string' || url.length > 2048) throw new Error('Invalid link');
        return socialPosts.get(url);
    });
    ipcMain.handle('lowcord:social-video', async (event, url, limit) => {
        assertSender(event);
        if (typeof url !== 'string' || url.length > 2048) throw new Error('Invalid link');
        try { return await socialPosts.socialVideo(url, limit); }
        catch (error) { return { error: error.code ?? 'failed' }; }
    });
    ipcMain.handle('lowcord:social-media', async (event, url, limit) => {
        assertSender(event);
        if (typeof url !== 'string' || url.length > 2048) throw new Error('Invalid link');
        try { return await socialPosts.socialMedia(url, limit); }
        catch (error) { return { error: error.code ?? 'failed' }; }
    });
    // Chat screenshots. The page captures only its own window, one visible
    // screenful at a time; files are written only where the user picks.
    ipcMain.handle('lowcord:capture-region', async (event, rect) => {
        const { window } = assertSender(event);
        const [width, height] = window.getContentSize();
        const { x, y, width: w, height: h } = rect ?? {};
        if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1) throw new Error('Invalid region');
        // The page measures CSS pixels; capturePage takes window points.
        const zoom = window.webContents.getZoomFactor();
        const region = { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(w * zoom), height: Math.round(h * zoom) };
        region.width = Math.min(region.width, width - region.x);
        region.height = Math.min(region.height, height - region.y);
        if (region.width < 1 || region.height < 1) throw new Error('Invalid region');
        return (await window.webContents.capturePage(region)).toPNG();
    });
    const capturedImage = bytes => {
        if (!(bytes instanceof Uint8Array) || bytes.length > 256 * 1024 * 1024) throw new Error('Invalid image');
        const image = nativeImage.createFromBuffer(Buffer.from(bytes));
        if (image.isEmpty()) throw new Error('Invalid image');
        return image;
    };
    ipcMain.handle('lowcord:copy-image', async (event, bytes) => {
        assertSender(event);
        capturedImage(bytes);
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    });
    ipcMain.handle('lowcord:save-image', async (event, bytes, name) => {
        const { window } = assertSender(event);
        capturedImage(bytes);
        const fileName = typeof name === 'string' ? name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) : '';
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
            title: 'Save chat image', defaultPath: join(app.getPath('pictures'), fileName.endsWith('.png') ? fileName : 'Chat.png'),
            filters: [{ name: 'PNG image', extensions: ['png'] }],
        });
        if (canceled || !filePath) return false;
        await writeFile(filePath, bytes);
        return true;
    });
    ipcMain.handle('lowcord:updates-status', event => { assertSender(event); return updates.snapshot(); });
    ipcMain.handle('lowcord:updates-check', event => { assertSender(event); return updates.check(); });
    ipcMain.handle('lowcord:updates-download', event => { assertSender(event); return updates.download(); });
    ipcMain.handle('lowcord:updates-install', async event => {
        const { window } = assertSender(event);
        const state = updates.snapshot();
        if (state.status !== 'downloaded') return state;
        // The settings bridge is visible to Discord's main world. Require a
        // native confirmation before a page script could restart or install.
        const confirmation = await dialog.showMessageBox(window, {
            type: 'question', title: 'Install OrbitCord update',
            message: `Install OrbitCord ${state.version}?`,
            detail: state.installMode === 'automatic' ? 'OrbitCord will close and restart to install the downloaded update.'
                : 'Open the downloaded installer, quit OrbitCord, and drag the new app to Applications.',
            buttons: [state.installMode === 'automatic' ? 'Restart and install' : 'Open installer', 'Cancel'],
            defaultId: 0, cancelId: 1,
        });
        return confirmation.response === 0 ? updates.install() : updates.snapshot();
    });
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
    ipcMain.handle('lowcord:badge', (event, count) => {
        const record = assertSender(event);
        if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw new Error('Invalid badge');
        record.badge = count;
        updateBadge();
        if (process.platform === 'win32') record.window.flashFrame(count > 0);
    });
}

async function start() {
    if (!testing) await migrateProfile(app.getPath('sessionData'));
    backend = new NativeBackend(app.isPackaged ? join(process.resourcesPath, 'native', `lowcord-native${process.platform === 'win32' ? '.exe' : ''}`)
        : join(__dirname, '..', '.lowcord', 'native', `lowcord-native${process.platform === 'win32' ? '.exe' : ''}`), userData);
    socialResolver = createSocialResolver();
    socialPosts = createSocialPosts();
    if (testing && process.env.LOWCORD_TEST_UPDATER === '1') updates.initialize();
    registerIpc();
    Menu.setApplicationMenu(appMenu());
    if (!testing) {
        const image = process.platform === 'win32'
            ? nativeImage.createFromPath(require('./windows-icon.cjs').windowsIconPath(iconPath(readAppIcon()), userData, nativeImage))
            : nativeImage.createFromPath(join(__dirname, '..', 'src-tauri', 'icons',
                process.platform === 'darwin' ? 'trayTemplate.png' : '32x32.png')).resize({ width: 18, height: 18 });
        image.setTemplateImage(process.platform === 'darwin');
        tray = new Tray(image);
        tray.setToolTip('OrbitCord');
        tray.setContextMenu(trayMenu());
        tray.on('click', show);
    }
    // Schedule independently of Discord's load event so a slow page cannot
    // delay the initial update check.
    if (!testing && app.isPackaged && ['win32', 'darwin'].includes(process.platform)) startUpdater();
    // Extra account windows open only on demand.
    await createDiscordWindow(accounts[0]);
}

if (!testing && !app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', showLast);
    app.on('activate', showLast);
    app.on('window-all-closed', () => { if (testing) app.quit(); });
    app.on('before-quit', event => {
        if (finished) return;
        event.preventDefault();
        if (quitting) return;
        quitting = true;
        void saveAllStates().catch(console.error).finally(async () => {
            await socialPosts?.close().catch(console.error);
            finished = true; backend?.close(); app.quit();
        });
    });
    app.whenReady().then(start).catch(error => {
        if (quitting || finished) return;
        console.error('[lowcord] Startup failed:', error);
        if (!testing) dialog.showErrorBox('OrbitCord could not start', error.message);
        app.quit();
    });
}
