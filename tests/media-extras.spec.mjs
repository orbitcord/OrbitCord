import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.addStyleTag({ url: '/injection/media-extras.css' });
});

// A one-file zip: docs/hi.txt = "hello zip".
function zipBytes() {
    const name = Buffer.from('docs/hi.txt'), raw = Buffer.from('hello zip'), body = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(name.length, 28);
    const offset = 30 + name.length + body.length, end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(offset, 16);
    return [...Buffer.concat([local, name, body, entry, name, end])];
}

async function install(page, bytes) {
    await page.evaluate(async bytes => {
        const row = document.createElement('li');
        row.id = 'chat-messages-1-2';
        row.innerHTML = `<div id="message-content-2">hola mundo</div>
            <div class="attachment_a"><a href="https://cdn.discordapp.com/attachments/1/3/pic.bmp?ex=1">pic.bmp</a></div>
            <div class="attachment_a" id="zipcard"><a href="https://cdn.discordapp.com/attachments/1/4/pack.zip?ex=1">pack.zip</a></div>`;
        document.body.append(row);
        const message = { id: '2', content: 'hola mundo', attachments: [
            { id: '3', filename: 'pic.bmp', url: 'https://cdn.discordapp.com/attachments/1/3/pic.bmp?ex=1', size: 100 },
            { id: '4', filename: 'pack.zip', url: 'https://cdn.discordapp.com/attachments/1/4/pack.zip?ex=1', size: bytes.length }] };
        const original = Lowcord.store;
        Lowcord.store = name => name === 'MessageStore' ? { getMessage: () => message } : original(name);
        window.fetches = [];
        window.__LOWCORD_NATIVE__ = { fetchRemote: async (url, options) => {
            window.fetches.push({ url, options });
            if (url.includes('translate.googleapis.com')) return { status: 200, headers: {}, body: JSON.stringify([[['hello world', 'hola mundo']], null, 'es']) };
            const data = new Uint8Array(bytes);
            const [start, end] = options.range;
            return { status: 206, headers: {}, body: data.slice(start, end + 1) };
        }, openExternal: () => {} };
        for (const path of ['/injection/translate.js', '/injection/embed-images.js', '/injection/zip-preview.js']) {
            const script = document.createElement('script'); script.textContent = await (await fetch(path)).text(); document.head.append(script);
        }
        Lowcord.extensions.set('translate', true); Lowcord.extensions.set('embedMoreImages', true); Lowcord.extensions.set('zipPreview', true);
    }, bytes);
}

test('BMP file cards get an inline preview that disappears when the extension is off', async ({ page }) => {
    await install(page, zipBytes());
    await expect(page.locator('.lowcord-embed-image img')).toHaveCount(1);
    await page.evaluate(() => Lowcord.extensions.set('embedMoreImages', false));
    await expect(page.locator('.lowcord-embed-image')).toHaveCount(0);
    await page.evaluate(() => Lowcord.extensions.set('embedMoreImages', true));
    await expect(page.locator('.lowcord-embed-image')).toHaveCount(1);
});

test('zip preview browses folders, previews text and cleans up when disabled', async ({ page }) => {
    await install(page, zipBytes());
    await page.getByRole('button', { name: 'Show files' }).click();
    await page.locator('.lowcord-zip-row').filter({ hasText: 'docs/' }).click();
    await page.locator('.lowcord-zip-row').filter({ hasText: 'hi.txt' }).click();
    await expect(page.locator('.lowcord-zip-text')).toHaveText('hello zip');
    await page.getByRole('button', { name: 'Up one folder' }).click();
    await expect(page.locator('.lowcord-zip-text')).toHaveCount(0);
    await page.evaluate(() => Lowcord.extensions.set('zipPreview', false));
    await expect(page.locator('.lowcord-zip')).toHaveCount(0);
});

test('translating through the native bridge parses the reply and keeps protected text', async ({ page }) => {
    await install(page, zipBytes());
    const result = await page.evaluate(async () => {
        const out = await Lowcord.translate.translateText('hola https://example.com `x` <@123>', 'en');
        return { out, query: decodeURIComponent(new URL(fetches.at(-1).url).searchParams.get('q')) };
    });
    expect(result.query).toBe('hola ⟦0⟧ ⟦1⟧ ⟦2⟧');
    expect(result.out).toEqual({ text: 'hello world', language: 'es' });
});
