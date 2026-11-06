const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchRemote, fullQualityUrl } = require('../electron/remote-fetch.cjs');

test('rewrites attachment previews to the original, keeping signature params', () => {
    assert.equal(fullQualityUrl('https://media.discordapp.net/attachments/1/2/a.PNG?ex=a&is=b&hm=c&width=100&height=50&format=webp&quality=lossless'),
        'https://cdn.discordapp.com/attachments/1/2/a.PNG?ex=a&is=b&hm=c');
    for (const url of ['https://media.discordapp.net/attachments/1/2/a.mp4', 'https://media.discordapp.net/avatars/1/a.png',
        'https://cdn.discordapp.com/attachments/1/2/a.png', 'http://media.discordapp.net/attachments/1/2/a.png', 'bad'])
        assert.equal(fullQualityUrl(url), null);
});
test('fetchRemote enforces https, host allowlist, range and size cap', async () => {
    await assert.rejects(fetchRemote('http://cdn.discordapp.com/a', {}, async () => {}), /Host/);
    await assert.rejects(fetchRemote('https://example.com/a', {}, async () => {}), /Host/);
    let seen;
    const ok = async (url, init) => { seen = init; return new Response(new Uint8Array([104, 105]), { status: 206, headers: { 'content-type': 'text/plain', 'content-range': 'bytes 0-1/9' } }); };
    const result = await fetchRemote('https://cdn.discordapp.com/a', { range: [0, 1], as: 'text' }, ok);
    assert.equal(seen.headers.Range, 'bytes=0-1'); assert.equal(seen.credentials, 'omit');
    assert.equal(result.body, 'hi'); assert.equal(result.headers['content-range'], 'bytes 0-1/9');
    assert.match((await fetchRemote('https://cdn.discordapp.com/a', { as: 'dataUrl' }, ok)).body, /^data:text\/plain;base64,aGk=$/);
    await assert.rejects(fetchRemote('https://cdn.discordapp.com/a', { maxBytes: 1 }, ok), /too large/);
});
test('allows Discord media proxy hosts for GIF embeds', () => {
    const { remoteUrl } = require('../electron/remote-fetch.cjs');
    for (const host of ['images-ext-1.discordapp.net', 'images-ext-2.discordapp.net'])
        assert.equal(remoteUrl(`https://${host}/external/a/https/media.tenor.com/b/c.mp4`).hostname, host);
    assert.throws(() => remoteUrl('https://images-ext-3.discordapp.net/a.mp4'), /Host/);
});
