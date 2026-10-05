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
        expect(await page.evaluate(() => window.earlyInjection)).toEqual({ initialized: true, hooked: true, extensions: 12, fetchHooked: true });
        expect(await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, bridge: Object.keys(window.__LOWCORD_NATIVE__) })))
            .toEqual({ node: 'undefined', process: 'undefined', bridge: ['notify', 'setBadge', 'log', 'openExternal', 'setEmbedPreferences', 'resolveSocialLink', 'socialPost', 'socialVideo'] });
        // Card media loads like <img>/<video> (no CORS) from the privileged scheme;
        // an unhandled scheme would reject instead of answering.
        expect(await page.evaluate(() => fetch('lowcord-media://media/0123456789abcdef01234567', { mode: 'no-cors' }).then(r => r.type))).toBe('opaque');
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

test('embed plugins reach only official child frames and update without reloading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lowcord-embeds-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        const youtubeFixture = (await readFile('tests/fixtures/youtube-volume.html', 'utf8')).replace('</body>',
            '<div class="ad-showing"><button class="ytp-ad-skip-button" onclick="window.skipped=true">Skip</button></div></body>');
        await page.route('https://www.youtube.com/embed/**', route => route.fulfill({ contentType: 'text/html',
            body: youtubeFixture }));
        await page.route('https://open.spotify.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><audio></audio></body></html>' }));
        await page.route('https://embed.music.apple.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><audio></audio></body></html>' }));
        const urls = ['https://www.youtube.com/embed/test', 'https://open.spotify.com/embed/track/test', 'https://embed.music.apple.com/us/album/test/123'];
        await page.evaluate(urls => {
            for (const src of urls) {
                const iframe = document.createElement('iframe'); iframe.src = src;
                if (src.includes('youtube.com')) { iframe.width = '480'; iframe.height = '270'; }
                document.body.append(iframe);
            }
        }, urls);
        await expect.poll(() => page.frames().filter(frame => urls.includes(frame.url())).length).toBe(3);
        const youtube = page.frame({ url: urls[0] });
        const spotify = page.frame({ url: urls[1] });
        const apple = page.frame({ url: urls[2] });
        await expect.poll(() => youtube.evaluate(() => window.skipped)).toBe(true);
        await expect.poll(() => youtube.evaluate(() => document.querySelector('video').volume)).toBe(0.5);
        await expect(youtube.locator('#lowcord-youtube-controls')).toHaveCount(1);
        await youtube.getByRole('button', { name: 'Mute', exact: true }).hover();
        expect(await youtube.evaluate(() => document.elementFromPoint(336, 160).className)).toBe('ytdVolumeControlsNativeSlider');
        const sliderBounds = await youtube.getByRole('slider', { name: 'Volume' }).boundingBox();
        await page.mouse.move(sliderBounds.x + sliderBounds.width / 2, sliderBounds.y + sliderBounds.height * 0.65, { steps: 16 });
        await expect(youtube.getByRole('slider', { name: 'Volume' })).toBeVisible();
        await page.mouse.down();
        await page.mouse.move(sliderBounds.x + sliderBounds.width / 2, sliderBounds.y + sliderBounds.height * 0.8, { steps: 8 });
        await page.mouse.up();
        expect(await youtube.evaluate(() => document.querySelector('video').volume)).toBeLessThan(0.3);
        expect(await youtube.evaluate(() => JSON.parse('{"adSlots":[1],"id":"video"}'))).toEqual({ adSlots: [], id: 'video' });
        for (const frame of [spotify, apple]) {
            await expect.poll(() => frame.evaluate(() => document.querySelector('audio').volume)).toBe(0.5);
            expect(await frame.evaluate(() => typeof window.__LOWCORD_NATIVE__)).toBe('undefined');
        }
        await page.evaluate(() => Lowcord.extensions.setOption('musicVolume', 23));
        await expect.poll(() => youtube.evaluate(() => document.querySelector('video').volume)).toBe(0.23);
        for (const frame of [spotify, apple]) await expect.poll(() => frame.evaluate(() => document.querySelector('audio').volume)).toBe(0.23);
        await page.evaluate(() => { Lowcord.extensions.set('musicEmbeds', false); Lowcord.extensions.set('youtubeAdblock', false); });
        await expect(youtube.locator('#lowcord-youtube-controls')).toHaveCount(1);
        for (const frame of [spotify, apple]) await expect.poll(() => frame.evaluate(() => document.querySelector('audio').volume)).toBe(1);
        expect(await youtube.evaluate(() => document.querySelector('video').volume)).toBe(0.23);
        await expect.poll(() => youtube.evaluate(() => JSON.parse('{"adSlots":[1]}').adSlots)).toEqual([1]);
        await page.evaluate(() => Lowcord.extensions.set('youtubeAdblock', true));
        await expect.poll(() => youtube.evaluate(() => JSON.parse('{"adSlots":[1]}').adSlots)).toEqual([]);
        const untrusted = page.frame({ url: 'http://127.0.0.1:4319/electron-child' });
        expect(await untrusted.evaluate(() => typeof window.__lowcordMusicVolume)).toBe('undefined');
        await expect(page.evaluate(() => window.__LOWCORD_NATIVE__.setEmbedPreferences({ youtubeAdblock: true, musicEmbeds: true, musicVolume: -1 })))
            .rejects.toThrow('Invalid embed preferences');
        expect(await page.evaluate(() => window.__LOWCORD_NATIVE__.resolveSocialLink('https://evil.example/x', 'auto'))).toBe('https://evil.example/x');
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
            .toEqual(['notify', 'setBadge', 'log', 'openExternal', 'setEmbedPreferences', 'resolveSocialLink', 'socialPost', 'socialVideo']);
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

test('text fields get a native edit menu that pastes, and passkey autofill stays off', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitcord-edit-menu-'));
    const app = await launch(dir);
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        expect(await page.evaluate(() => PublicKeyCredential.isConditionalMediationAvailable()))
            .toBe(process.platform === 'win32');
        await app.evaluate(({ Menu, clipboard }) => {
            Menu.prototype.popup = function () { global.editMenu = this; };
            global.savedText = clipboard.readText();
            clipboard.writeText('https://example.com/pasted');
        });
        const input = page.locator('#message-input');
        await input.click({ button: 'right' });
        await expect.poll(() => app.evaluate(() => global.editMenu?.items.filter(item => item.label).map(item => item.label)))
            .toEqual(['Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Select All']);
        await app.evaluate(() => global.editMenu.items.find(item => item.label === 'Paste').click());
        await expect(input).toHaveValue('https://example.com/pasted');
        await app.evaluate(() => { global.editMenu = undefined; });
        await page.locator('p').first().click({ button: 'right' });
        expect(await app.evaluate(() => !!global.editMenu)).toBe(false);
    } finally {
        await app.evaluate(({ clipboard }) => clipboard.writeText(global.savedText ?? '')).catch(() => {});
        await app.close();
        await rm(dir, { recursive: true, force: true });
    }
});
