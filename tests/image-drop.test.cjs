const { test } = require('node:test');
const assert = require('node:assert/strict');
const { downloadImage } = require('../electron/image-drop.cjs');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const image = (type = 'image/gif', headers = {}) => new Response(gif, { headers: { 'content-type': type, ...headers } });

test('preserves original GIF bytes and Unicode name without cookies', async () => {
    const result = await downloadImage('https://example.com/%E7%8C%AB.gif?signature=keep', { fetchPage: async (url, init) => {
        assert.equal(url, 'https://example.com/%E7%8C%AB.gif?signature=keep');
        assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
        return image();
    } });
    assert.equal(result.name, '猫.gif'); assert.equal(result.type, 'image/gif');
    assert.deepEqual(Buffer.from(result.data), gif);
});
test('extensionless image redirects keep query strings and use response type', async () => {
    const urls = [];
    const result = await downloadImage('https://example.com/image', { fetchPage: async url => {
        urls.push(url);
        return urls.length === 1 ? new Response(null, { status: 302, headers: { location: '/%E7%8C%AB?token=abc' } }) : image('image/png; charset=utf-8');
    } });
    assert.equal(urls[1], 'https://example.com/%E7%8C%AB?token=abc');
    assert.equal(result.name, '猫.png'); assert.equal(result.type, 'image/png');
});
test('sanitizes filenames and replaces a misleading extension', async () => {
    const result = await downloadImage('https://example.com/..%2Fevil%3Fphoto.html', { fetchPage: async () => image() });
    assert.equal(result.name, '_evil_photo.gif');
});
test('rejects unsafe URL schemes and embedded credentials before fetching', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'blob:https://example.com/id', 'http://user:pass@example.com/a', {}, 'bad']) {
        await assert.rejects(downloadImage(url, { fetchPage: () => assert.fail('must not fetch') }), { code: 'invalid-url' });
    }
});
test('validates each redirect and stops redirect loops', async () => {
    await assert.rejects(downloadImage('https://example.com/a', { fetchPage: async () => new Response(null, { status: 302, headers: { location: 'file:///private/image.png' } }) }), { code: 'invalid-url' });
    let calls = 0;
    await assert.rejects(downloadImage('https://example.com/a', { fetchPage: async () => {
        calls++; return new Response(null, { status: 302, headers: { location: '/again' } });
    } }), { code: 'download-failed' });
    assert.equal(calls, 6);
});
test('rejects HTML, failed responses and empty images', async () => {
    for (const response of [new Response('<img>', { headers: { 'content-type': 'text/html' } }), new Response('bad', { headers: { 'content-type': 'constructor' } }), new Response('', { status: 403 }), new Response('', { headers: { 'content-type': 'image/png' } })]) {
        await assert.rejects(downloadImage('https://example.com/a.png', { fetchPage: async () => response }));
    }
});
test('rejects declared and streamed oversized images without reading unbounded bodies', async () => {
    await assert.rejects(downloadImage('https://example.com/a', { fetchPage: async () => image('image/gif', { 'content-length': String(51 * 1024 ** 2) }) }), { code: 'too-large' });
    let reads = 0, cancelled = false;
    const stream = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 ** 2)); }, cancel() { cancelled = true; } });
    await assert.rejects(downloadImage('https://example.com/a', { fetchPage: async () => new Response(stream, { headers: { 'content-type': 'image/png' } }) }), { code: 'too-large' });
    assert.equal(cancelled, true); assert.ok(reads <= 52);
});
