import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/uploads');
    await page.addScriptTag({ url: '/injection/discord.js' });
    await page.evaluate(() => {
        Lowcord.storage = localStorage;
        const wrap = document.createElement('div'); wrap.className = 'channelTextArea_test'; document.body.append(wrap);
        wrap.append(document.querySelector('#drop'));
        const editor = document.createElement('textarea'); editor.setAttribute('aria-label', 'Message'); editor.value = 'Keep this draft'; wrap.append(editor);
        editor.addEventListener('paste', event => { if (event.clipboardData.files.length) fixtureAdd([event.clipboardData.files[0]]); });
        window.channel = 'original'; const listeners = new Set();
        window.switchChat = value => { window.channel = value; for (const fn of listeners) fn(); };
        Lowcord.store = name => name === 'SelectedChannelStore' ? {
            getChannelId: () => window.channel, addChangeListener: fn => listeners.add(fn), removeChangeListener: fn => listeners.delete(fn),
        } : null;
        window.calls = []; window.toasts = []; window.hold = false;
        window.__LOWCORD_NATIVE__ = { downloadDroppedImage: async url => {
            calls.push(url);
            if (window.hold) await new Promise(resolve => { window.releaseImage = resolve; });
            if (window.downloadError) return { error: window.downloadError };
            const response = await fetch('/media/sample.png');
            return { name: 'browser-image.png', type: 'image/png', data: new Uint8Array(await response.arrayBuffer()) };
        } };
    });
    await page.addScriptTag({ url: '/social-links.js' });
    await page.addScriptTag({ url: '/music-links.js' });
    await page.addScriptTag({ url: '/injection/extensions.js' });
    await page.addScriptTag({ url: '/injection/image-drop.js' });
    await page.addScriptTag({ url: '/injection/background.js' });
    await page.evaluate(() => Lowcord.extensions.set('anonymiseFileNames', false));
});
async function drop(page, { uri = 'https://images.example/image', html = '', file = false, selector = '#drop' } = {}) {
    return page.evaluate(({ uri, html, file, selector }) => {
        const data = new DataTransfer();
        if (uri) data.setData('text/uri-list', uri);
        if (html) data.setData('text/html', html);
        if (file) data.items.add(new File(['native bytes'], 'native.png', { type: 'image/png' }));
        const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
        document.querySelector(selector).dispatchEvent(event);
        return event.defaultPrevented;
    }, { uri, html, file, selector });
}
async function done(page, count = 1) {
    await expect.poll(() => page.evaluate(() => Lowcord.imageDrop.busy())).toBe(false);
    await expect(page.locator('#drafts article')).toHaveCount(count);
}
test('browser drag stays accepted when Discord rejects URL drags in its body handler', async ({ page }) => {
    await page.evaluate(() => {
        window.nativeDragRejections = 0;
        // Discord's UploadArea.preventUnwantedDrop rejects uri-list drags
        // during dragover, before Chromium can deliver a drop event.
        document.body.addEventListener('dragover', event => {
            if (event.dataTransfer.types.includes('text/uri-list')) {
                window.nativeDragRejections++;
                event.preventDefault(); event.stopPropagation();
                event.dataTransfer.effectAllowed = 'none'; event.dataTransfer.dropEffect = 'none';
            }
        });
    });
    const target = await page.locator('#drop').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [
        { mimeType: 'text/uri-list', data: 'https://images.example/photo.jpg' },
        { mimeType: 'text/html', data: '<img src="https://images.example/photo.jpg">' },
        { mimeType: 'chromium/x-drag-id', data: 'helium-fixture' },
    ], dragOperationsMask: 1 };
    // Go through Chromium's real drag acceptance phase, rather than directly
    // dispatching a synthetic drop that bypasses a rejected operation.
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
        type, x: target.x + target.width / 2, y: target.y + target.height / 2, data,
    });
    await cdp.detach();
    expect(await page.evaluate(() => window.nativeDragRejections)).toBe(0);
    await done(page);
});
test('browser image URL attaches original bytes once, preserves text and only sends on demand', async ({ page }) => {
    await drop(page); await done(page);
    await expect(page.locator('article')).toHaveAttribute('data-preview', 'ready');
    await expect(page.getByLabel('Message')).toHaveValue('Keep this draft');
    expect(await page.evaluate(() => receipts.length)).toBe(0);
    expect(await page.evaluate(async () => Array.from(new Uint8Array(await prepared[0].file.arrayBuffer()))))
        .toEqual(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/media/sample.png')).arrayBuffer()))));
    await page.getByRole('button', { name: 'Send test upload' }).click();
    await expect(page.locator('#state')).toHaveText('Sent');
    expect(await page.evaluate(() => receipts.length)).toBe(1);
});
test('linked image chooses src instead of the surrounding page and decodes HTML entities', async ({ page }) => {
    await drop(page, { uri: 'https://example.com/article', html: '<a href="https://example.com/article"><img src="https://cdn.example/photo?x=1&amp;y=2"></a>' });
    await done(page);
    expect(await page.evaluate(() => calls)).toEqual(['https://cdn.example/photo?x=1&y=2']);
});
test('native file drops and ordinary links retain native behavior', async ({ page }) => {
    await drop(page, { file: true }); await done(page);
    await expect(page.locator('article span')).toHaveText('native.png');
    await drop(page, { html: '<a href="https://example.com/article">Article</a>' });
    expect(await page.evaluate(() => calls)).toEqual([]);
});
test('internal image drags, settings dialogs and unsafe sources are ignored', async ({ page }) => {
    await page.evaluate(() => document.querySelector('#drop').dispatchEvent(new DragEvent('dragstart', { bubbles: true })));
    await drop(page);
    await page.evaluate(() => document.querySelector('#drop').dispatchEvent(new DragEvent('dragend', { bubbles: true })));
    await page.evaluate(() => document.querySelector('.channelTextArea_test').setAttribute('role', 'dialog'));
    await drop(page);
    await page.evaluate(() => document.querySelector('.channelTextArea_test').removeAttribute('role'));
    await drop(page, { uri: 'file:///private/photo.png' });
    expect(await page.evaluate(() => calls)).toEqual([]);
    await done(page, 0);
});
test('overlay drop outside main clears native drag state and delivers prepared image through paste', async ({ page }) => {
    await page.evaluate(() => {
        const overlay = document.createElement('div'); overlay.className = 'uploadArea_test'; overlay.id = 'overlay'; document.body.append(overlay);
        window.cleanups = 0;
        document.body.addEventListener('drop', event => { if (!event.dataTransfer.types.length) { window.cleanups++; overlay.remove(); } });
    });
    await drop(page, { selector: '#overlay' }); await done(page);
    expect(await page.evaluate(() => window.cleanups)).toBe(1);
});
test('switching chats and back discards pending download; background sleep sees work and duplicate drops do not download', async ({ page }) => {
    await page.evaluate(() => { window.hold = true; });
    await drop(page);
    expect(await page.evaluate(() => __lowcordBusy())).toBe(true);
    await drop(page);
    expect(await page.evaluate(() => calls.length)).toBe(1);
    await page.evaluate(() => { switchChat('other'); switchChat('original'); releaseImage(); });
    await done(page, 0);
    await expect(page.locator('.lowcord-toast').last()).toContainText('switched chats');
    expect(await page.evaluate(() => __lowcordBusy())).toBe(false);
});
test('failed download explains retry without attaching or inserting a URL', async ({ page }) => {
    await page.evaluate(() => { window.downloadError = 'too-large'; });
    await drop(page); await done(page, 0);
    await expect(page.locator('.lowcord-toast').last()).toContainText('50 MB');
    await expect(page.getByLabel('Message')).toHaveValue('Keep this draft');
});
test('filename anonymization runs once on the prepared image', async ({ page }) => {
    await page.evaluate(() => Lowcord.extensions.set('anonymiseFileNames', true));
    await drop(page); await done(page);
    await expect(page.locator('article span')).toHaveText(/^[a-z]{7}\.png$/);
    expect(await page.evaluate(() => calls.length)).toBe(1);
});

test('URI-only nonimage link returns its original payload to the native drop handler', async ({ page }) => {
    await page.evaluate(() => {
        window.downloadError = 'not-image'; window.nativeLinks = [];
        document.querySelector('#drop').addEventListener('drop', event => {
            if (event.dataTransfer.getData('text/uri-list')) window.nativeLinks.push(event.dataTransfer.getData('text/uri-list'));
        });
    });
    await drop(page, { uri: 'https://example.com/article' }); await done(page, 0);
    expect(await page.evaluate(() => window.nativeLinks)).toEqual(['https://example.com/article']);
    expect(await page.evaluate(() => calls.length)).toBe(1);
});

test('replacing the composer during download does not deliver a file to an obsolete editor', async ({ page }) => {
    await page.evaluate(() => { window.hold = true; }); await drop(page);
    await page.evaluate(() => { const editor = document.querySelector('textarea'); editor.replaceWith(editor.cloneNode()); releaseImage(); });
    await done(page, 0);
    await expect(page.locator('.lowcord-toast').last()).toContainText('composer closed');
});
