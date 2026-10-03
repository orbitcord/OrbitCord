import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

async function launch(dataDir) {
    const app = await electron.launch({ args: [resolve('electron/main.cjs')], env: { ...process.env,
        LOWCORD_TEST: '1', LOWCORD_TEST_URL: 'http://127.0.0.1:4319/electron', LOWCORD_TEST_DATA: dataDir } });
    app.process().stderr.on('data', data => {
        const message = data.toString();
        if (message.includes('[lowcord] Startup failed')) console.error(message);
    });
    return app;
}

test('real Electron decodes MP4/H.264, AAC, WebM and GIF loops inline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-electron-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.earlyInjection);
        const browser = await page.evaluate(() => ({
            userAgent: navigator.userAgent,
            getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
            peerConnection: typeof RTCPeerConnection,
        }));
        expect(browser.userAgent).toContain('Chrome/');
        expect(browser.userAgent).not.toMatch(/(?:Electron|Lowcord|Datcord|OrbitCord)\//i);
        expect(browser.getUserMedia).toBe('function');
        expect(browser.peerConnection).toBe('function');
        expect(await page.evaluate(() => window.earlyInjection)).toEqual({ initialized: true, hooked: true, extensions: 6, fetchHooked: true });
        expect(await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, bridge: Object.keys(window.__LOWCORD_NATIVE__) })))
            .toEqual({ node: 'undefined', process: 'undefined', bridge: ['notify', 'setBadge', 'log', 'openExternal'] });
        for (const id of ['video', 'audio', 'webm']) {
            await page.evaluate(async id => {
                const media = document.getElementById(id);
                media.muted = true;
                await media.play();
            }, id);
            await expect.poll(() => page.$eval(`#${id}`, media => media.currentTime)).toBeGreaterThan(0.15);
            expect(await page.$eval(`#${id}`, media => media.error)).toBeNull();
        }
        await expect.poll(() => page.$eval('#gif', media => media.currentTime)).toBeGreaterThan(0.1);
        expect(await page.locator('.lowcord-media-player, .lowcord-video-play, .lowcord-gif').count()).toBe(0);
        await page.evaluate(() => document.getElementById('video').pause());
        expect(await page.$eval('#video', media => media.paused)).toBe(true);
        await page.evaluate(() => { document.getElementById('video').currentTime = 0.8; });
        await expect.poll(() => page.$eval('#video', media => media.currentTime)).toBeCloseTo(0.8, 1);
        expect(app.windows()).toHaveLength(1);
        const frame = page.frame({ url: 'http://127.0.0.1:4319/electron-child' });
        expect(await frame.evaluate(() => typeof window.__LOWCORD_NATIVE__)).toBe('undefined');
        expect(await page.evaluate(async () => {
            try { await window.__LOWCORD_NATIVE__.openExternal('file:///tmp/test'); return false; } catch { return true; }
        })).toBe(true);
        await page.evaluate(() => window.__LOWCORD_NATIVE__.setBadge(2));
        expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(2);
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox)).toBe(true);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Rust saves window state across Electron restarts and quits with its parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-state-'));
    let app = await launch(dir);
    try {
        await (await app.firstWindow()).waitForLoadState('domcontentloaded');
        const backendPid = await app.evaluate(() => process._getActiveHandles().find(handle => handle.constructor.name === 'ChildProcess')?.pid);
        expect(backendPid).toBeGreaterThan(0);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 900, height: 650 }));
        await app.close();
        await expect.poll(() => {
            try { process.kill(backendPid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
        }).toBe(false);
        const state = JSON.parse(await readFile(join(dir, 'window-state.json'), 'utf8'));
        expect(state.width).toBe(900);
        expect(state.height).toBe(650);
        app = await launch(dir);
        await (await app.firstWindow()).waitForLoadState('domcontentloaded');
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width)).toBe(900);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('downloaded update shows a quiet corner notice, dismisses across reloads and restarts only on a real click', async ({}, testInfo) => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-update-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        const notice = page.locator('#orbitcord-update-notice');
        await expect(notice).toHaveCount(0);
        await app.evaluate(({ dialog }, updaterPath) => {
            global.testUpdater = process.mainModule.require(updaterPath).autoUpdater;
            global.updateRestarts = 0;
            global.updateDialogs = 0;
            dialog.showMessageBox = async () => { global.updateDialogs++; return { response:1 }; };
            global.testUpdater.quitAndInstall = () => { global.updateRestarts++; };
            global.testUpdater.emit('update-downloaded', { version:'0.1.3' });
        }, resolve('node_modules/electron-updater'));
        await expect(notice.getByRole('heading', { name:'Update ready' })).toBeVisible();
        await expect(notice).toContainText('OrbitCord 0.1.3 is ready to install.');
        expect(await notice.getByRole('heading').evaluate(heading => getComputedStyle(heading).fontFamily)).toContain('Segoe UI');
        expect(await app.evaluate(() => global.updateDialogs)).toBe(0);
        // A page reload restores the pending notice from the main process.
        await page.reload();
        await expect(notice).toBeVisible();
        await page.evaluate(() => {
            document.body.style.background = '#313338';
            document.documentElement.style.setProperty('--background-floating', '#18191c');
            document.documentElement.style.setProperty('--text-normal', '#f2f3f5');
            document.documentElement.style.setProperty('--header-primary', '#f2f3f5');
            document.documentElement.style.setProperty('--text-muted', '#b5bac1');
        });
        const bounds = await notice.boundingBox();
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 1280);
        expect(bounds.y).toBe(72);
        await page.screenshot({ path:testInfo.outputPath('update-notice-dark.png') });
        // Discord page scripts cannot trigger a restart by synthesizing a click.
        await notice.getByRole('button', { name:'Restart', exact:true }).evaluate(button => button.click());
        expect(await app.evaluate(() => global.updateRestarts)).toBe(0);
        await notice.getByRole('button', { name:'Later', exact:true }).click();
        await expect(notice).toHaveCount(0);
        await app.evaluate(() => global.testUpdater.emit('update-downloaded', { version:'0.1.3' }));
        await page.reload();
        await expect(notice).toHaveCount(0);
        await app.evaluate(() => global.testUpdater.emit('update-downloaded', { version:'0.1.4' }));
        await expect(notice).toContainText('0.1.4');
        await notice.getByRole('button', { name:'Dismiss update notice' }).click();
        await expect(notice).toHaveCount(0);
        await app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].setBounds({ width:520, height:400 });
            global.testUpdater.emit('update-downloaded', { version:'0.1.5' });
            global.testUpdater.quitAndInstall = () => global.testUpdater.emit('error', new Error('Installer unavailable'));
        });
        await expect(notice).toBeVisible();
        await page.evaluate(() => {
            document.body.style.background = '#fff';
            document.documentElement.style.setProperty('--background-floating', '#fff');
            document.documentElement.style.setProperty('--text-normal', '#313338');
            document.documentElement.style.setProperty('--header-primary', '#111214');
            document.documentElement.style.setProperty('--text-muted', '#4e5058');
        });
        expect((await notice.boundingBox()).width).toBeLessThanOrEqual(488);
        await page.screenshot({ path:testInfo.outputPath('update-notice-light-small.png') });
        await notice.getByRole('button', { name:'Restart', exact:true }).click();
        await expect(notice.getByRole('alert')).toContainText('Couldn’t restart');
        await expect(notice.getByRole('button', { name:'Restart', exact:true })).toBeEnabled();
        await app.evaluate(() => { global.testUpdater.quitAndInstall = () => { global.updateRestarts++; }; });
        await notice.getByRole('button', { name:'Restart', exact:true }).click();
        await expect(notice.getByRole('button', { name:'Restarting…' })).toBeDisabled();
        await expect(notice.getByRole('alert')).toBeHidden();
        expect(await app.evaluate(() => global.updateRestarts)).toBe(1);
        // A duplicate downloaded event must not reset the restarting state.
        await app.evaluate(() => global.testUpdater.emit('update-downloaded', { version:'0.1.5' }));
        await expect(notice.getByRole('button', { name:'Later', exact:true })).toBeDisabled();
        expect(await page.evaluate(() => Object.keys(window.__LOWCORD_NATIVE__)))
            .toEqual(['notify', 'setBadge', 'log', 'openExternal']);
        expect(await app.evaluate(() => global.updateDialogs)).toBe(0);
    } finally { await app.close(); await rm(dir, { recursive:true, force:true }); }
});

test('opened image menu copies full image pixels and saves the original file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-image-menu-'));
    const app = await launch(dir);
    let clipboardSaved = false;
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await app.evaluate(async ({ Menu, clipboard, ClipboardItem, nativeImage }) => {
            // Capture the actual native menu produced by a Chromium right-click.
            Menu.prototype.popup = function () { global.imageMenu = this; };
            // Eagerly snapshot every format, including custom OS payloads, so
            // the test can restore the user's clipboard atomically afterwards.
            global.savedClipboard = await Promise.all((await clipboard.read()).map(async item =>
                new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type =>
                    [type, await item.getType(type)]))))));
            global.readCopiedImage = async () => {
                const item = (await clipboard.read()).find(item => item.types.includes('image/png'));
                return item ? nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer()))
                    : nativeImage.createEmpty();
            };
        });
        clipboardSaved = true;
        await page.locator('#inline-image').click({ button: 'right' });
        expect(await app.evaluate(() => !!global.imageMenu)).toBe(false);
        await page.getByRole('button', { name: 'Open image' }).click();
        await page.locator('#viewer-image').evaluate(img => img.decode());
        await page.locator('#viewer-image').click({ button: 'right' });
        await expect.poll(() => app.evaluate(() => global.imageMenu?.items.map(item => item.label)))
            .toEqual(['Copy image', 'Save image…']);
        await app.evaluate(({ clipboard }) => { clipboard.clear(); global.imageMenu.items[0].click(); });
        await expect.poll(() => app.evaluate(async () => (await global.readCopiedImage()).getSize()))
            .toEqual({ width: 32, height: 24 });
        // Check image content as well as dimensions, rather than a screenshot
        // of the 160x120 zoomed display.
        const original = await readFile('tests/fixtures/media/sample.png');
        expect(await app.evaluate(async ({ nativeImage }, data) => {
            const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
            return image.toBitmap().equals((await global.readCopiedImage()).toBitmap());
        }, original.toString('base64'))).toBe(true);
        const savePath = join(dir, 'saved-image.png');
        await app.evaluate(({ session }, path) => {
            session.defaultSession.once('will-download', (_event, item) => {
                // Select a test-only save path instead of opening the OS dialog.
                item.setSavePath(path);
                item.once('done', (_event, state) => { global.imageDownloadState = state; });
            });
            global.imageMenu.items[1].click();
        }, savePath);
        await expect.poll(() => app.evaluate(() => global.imageDownloadState)).toBe('completed');
        expect(await readFile(savePath)).toEqual(original);
        await app.evaluate(({ session }) => {
            global.imageDownloadState = undefined;
            session.defaultSession.once('will-download', (_event, item) => {
                item.once('done', (_event, state) => { global.imageDownloadState = state; });
                item.cancel();
            });
            global.imageMenu.items[1].click();
        });
        await expect.poll(() => app.evaluate(() => global.imageDownloadState)).toBe('cancelled');
        await page.getByRole('button', { name: 'Close image' }).click();
        await app.evaluate(() => { global.imageMenu = undefined; });
        await page.locator('#inline-image').click({ button: 'right' });
        expect(await app.evaluate(() => !!global.imageMenu)).toBe(false);
    } finally {
        if (clipboardSaved) await app.evaluate(({ clipboard }) => clipboard.write(global.savedClipboard));
        await app.close();
        await rm(dir, { recursive: true, force: true });
    }
});
