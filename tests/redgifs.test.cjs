const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, writeFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { createRedgifs, MAX_BYTES } = require('../electron/redgifs.cjs');
const { compressVideo } = require('../electron/video-compress.cjs');
const sample = readFile(join(__dirname, 'fixtures/media/sample.mp4'));
const gif = { id: 'SampleVideo', type: 1, userName: 'fixture', urls: {
    hd: 'https://thumbs4.redgifs.com/SampleVideo.mp4', sd: 'https://thumbs4.redgifs.com/SampleVideo-mobile.mp4',
    poster: 'https://thumbs4.redgifs.com/SampleVideo.jpg',
} };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('malformed saved entries cannot prevent the picker from initializing', async () => {
    const source = await readFile(join(__dirname, '../src-tauri/injection/redgifs.js'), 'utf8');
    const window = { Lowcord: { extensions: { ui() {}, addComposerAction() {} }, storage: { getItem: () => JSON.stringify({
        favorites: [null, {}, { id: 123 }, { id: 'ValidVideo', author: 'fixture' }],
        niches: [null, {}, { id: 'valid-niche', name: 'Fixture' }],
    }) } }, addEventListener() {} };
    runInNewContext(source, { window });
    assert.equal(typeof window.Lowcord.redgifs.open, 'function');
});

async function fixture(t, { media, gifs = [gif], compress, search, niches, nicheVideos, creators = [] } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'redgifs-test-'));
    const calls = [];
    const service = createRedgifs({ tempRoot: root, compress, fetchPage: async (value, options) => {
        const url = new URL(value); calls.push({ url, options });
        if (url.pathname === '/v2/auth/temporary') return json({ token: 'fixture-token' });
        if (url.pathname === '/v2/gifs/search' || url.pathname === '/v2/feeds/trending/popular') return search ? search(url, options) : json({ gifs, pages: 3 });
        if (url.pathname === '/v2/creators/search') return json({ items: creators, pages: 3 });
        if (/^\/v2\/users\/[^/]+\/search$/.test(url.pathname)) return json({ gifs, pages: 2 });
        if (/^\/v2\/gifs\/[a-z0-9]+$/i.test(url.pathname)) return json({ gif: gifs[0] });
        if (url.pathname === '/v2/niches/search') return json({ niches: niches ?? [], pages: 2 });
        if (/^\/v2\/niches\/[^/]+\/gifs$/.test(url.pathname)) return json({ gifs: nicheVideos ?? gifs, pages: 3 });
        return media ? media(url, options) : new Response(await sample, { headers: { 'content-type': 'video/mp4' } });
    } });
    t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
    return { root, service, calls, item: async owner => (await service.search(owner, 'neutral & fixture')).items[0] };
}

test('search encodes text, paginates, reuses temporary auth and exposes only opaque previews', async t => {
    const { service, calls } = await fixture(t);
    const first = await service.search(1, 'neutral & fixture');
    assert.equal(first.more, true); assert.equal(first.items.length, 1);
    assert.match(first.items[0].preview, /^lowcord-media:\/\/redgifs\/[a-f0-9]{36}\/video$/);
    assert.equal(JSON.stringify(first).includes('thumbs4'), false);
    await service.search(1, 'second', 2);
    assert.equal(calls.filter(call => call.url.pathname.includes('auth')).length, 1);
    assert.equal(calls[1].url.searchParams.get('tags'), 'neutral & fixture');
    assert.equal(calls[1].url.searchParams.has('search_text'), false);
    assert.equal(calls[2].url.searchParams.get('page'), '2');
    assert.equal(calls[1].options.headers.authorization, 'Bearer fixture-token');
    assert.equal(calls[1].options.credentials, 'omit');
    assert.equal(calls[1].options.redirect, 'error');
});

test('Trending, Explore, creator discovery and creator videos match the site routes', async t => {
    const { service, calls } = await fixture(t, { creators: [{ username: 'neutral_creator', name: 'Neutral Creator',
        publishedGifs: 12, followers: 34, verified: true, profileImageUrl: 'https://unsafe.test/image' }, null, { username: '../bad' }] });
    await service.search(1);
    assert.equal(calls.at(-1).url.pathname, '/v2/feeds/trending/popular');
    assert.equal(calls.at(-1).url.searchParams.get('page'), '1');
    await service.search(1, '', 2);
    assert.equal(calls.at(-1).url.searchParams.get('page'), '2');
    await service.search(1, '', 1, { mode: 'explore' });
    assert.equal(calls.at(-1).url.pathname, '/v2/gifs/search');
    assert.equal(calls.at(-1).url.searchParams.get('verified'), 'y');
    assert.equal(calls.at(-1).url.searchParams.get('type'), 'g');
    const result = await service.search(1, 'neutral', 2, { mode: 'creators' });
    assert.deepEqual(result.creators, [{ id: 'neutral_creator', name: 'Neutral Creator', videos: 12, followers: 34, verified: true }]);
    assert.equal(result.more, true);
    assert.equal(calls.at(-1).url.pathname, '/v2/creators/search');
    assert.equal(calls.at(-1).url.searchParams.get('query'), 'neutral');
    assert.equal(calls.at(-1).url.searchParams.get('order'), 'best_match');
    await service.search(1, '', 1, { mode: 'creators' });
    assert.equal(calls.at(-1).url.searchParams.get('order'), 'trending');
    assert.equal((await service.search(1, '', 2, { mode: 'creators', creator: 'neutral_creator' })).items.length, 1);
    assert.equal(calls.at(-1).url.pathname, '/v2/users/neutral_creator/search');
    assert.equal(calls.at(-1).url.searchParams.get('order'), 'latest');
    assert.equal(calls.at(-1).url.searchParams.get('type'), 'g');
    for (const options of [{ mode: 'creators', creator: '../bad' }, { mode: 'explore', creator: 'valid' }, { mode: 'creators', nicheId: 'valid' }]) {
        await assert.rejects(service.search(1, '', 1, options), { code: 'invalid-search' });
    }
});

test('filtered and malformed entries do not truncate pagination or crash resolution', async t => {
    const { service } = await fixture(t, { gifs: [null, ...Array.from({ length: 23 }, () => ({ ...gif, type: 2 }))],
        search: () => json({ gifs: [null, ...Array.from({ length: 23 }, () => ({ ...gif, type: 2 }))] }) });
    assert.deepEqual(await service.search(1), { items: [], more: true });
    await assert.rejects(service.resolve(1, 'missing'), { code: 'expired' });
});

test('topic search sends tags, removes a leading hash, and does not silently return an unfiltered feed', async t => {
    const { service, calls } = await fixture(t, { search: url => {
        assert.equal(url.searchParams.get('tags'), 'Animation');
        return json({ gifs: [gif], pages: 1 });
    } });
    assert.equal((await service.search(1, '  #Animation  ')).items.length, 1);
    assert.equal(calls.at(-1).url.searchParams.has('search_text'), false);
});

test('niche search, popular browsing and niche video pagination use their own API paths', async t => {
    const { service, calls } = await fixture(t, { niches: [{ id: 'neutral-animation', name: 'Neutral animation', gifs: 123, subscribers: 456,
        thumbnail: 'https://media.redgifs.com/private.jpg' }, { id: '../unsafe', name: 'Invalid' }] });
    const result = await service.search(1, 'animation', 1, { mode: 'niches' });
    assert.deepEqual(result.niches, [{ id: 'neutral-animation', name: 'Neutral animation', videos: 123, subscribers: 456 }]);
    assert.equal(result.more, true);
    assert.equal(calls.at(-1).url.pathname, '/v2/niches/search');
    assert.equal(calls.at(-1).url.searchParams.get('query'), 'animation');
    assert.equal(calls.at(-1).url.searchParams.get('order'), 'best_match');
    await service.search(1, '', 1, { mode: 'niches' });
    assert.equal(calls.at(-1).url.searchParams.get('order'), 'subscribers');
    assert.equal((await service.search(1, 'ignored', 2, { mode: 'videos', nicheId: 'neutral-animation' })).items.length, 1);
    assert.equal(calls.at(-1).url.pathname, '/v2/niches/neutral-animation/gifs');
    assert.equal(calls.at(-1).url.searchParams.get('page'), '2');
    assert.equal(calls.at(-1).url.searchParams.has('tags'), false);
    for (const options of [null, [], { mode: 'invalid' }, { mode: 'videos', nicheId: '../bad' }, { mode: 'niches', nicheId: 'valid' }]) {
        await assert.rejects(service.search(1, '', 1, options), { code: 'invalid-search' });
    }
});

test('expired API token retries authentication once', async t => {
    let searches = 0;
    const { service, calls } = await fixture(t, { search: () => ++searches === 1 ? new Response('', { status: 401 }) : json({ gifs: [gif] }) });
    assert.equal((await service.search(1)).items.length, 1);
    assert.equal(calls.filter(call => call.url.pathname.includes('auth')).length, 2);
});

test('reject unsafe hosts, image posts, invalid input and cross-window tokens', async t => {
    const { service } = await fixture(t, { gifs: [gif, { ...gif, urls: { hd: 'https://thumbs4.redgifs.com.evil.test/video.mp4' } },
        { ...gif, type: 2 }, { ...gif, urls: { hd: 'http://127.0.0.1/video.mp4' } }] });
    const result = await service.search(1);
    assert.equal(result.items.length, 1);
    await assert.rejects(service.prepare(2, result.items[0].key, MAX_BYTES), { code: 'expired' });
    await assert.rejects(service.search(1, 'x', -1), { code: 'invalid-search' });
    service.cancel(1);
    assert.equal((await service.serve(new Request(result.items[0].preview))).status, 404);
});

test('current media.redgifs.com CDN URLs are accepted alongside older thumbs hosts', async t => {
    const { service, item } = await fixture(t, { gifs: [{ ...gif, urls: {
        hd: 'https://media.redgifs.com/Sample.mp4', sd: 'https://media.redgifs.com/Sample-mobile.mp4', poster: 'https://media.redgifs.com/Sample.jpg',
    } }] });
    assert.equal((await service.prepare(1, (await item(1)).key, MAX_BYTES)).quality, 'HD');
});

test('HD sends original MP4 bytes and removes temporary files', async t => {
    const { service, item, root } = await fixture(t);
    const result = await service.prepare(1, (await item(1)).key, MAX_BYTES);
    assert.equal(result.quality, 'HD'); assert.equal(result.type, 'video/mp4');
    assert.equal(result.data, undefined);
    assert.equal(result.path, undefined);
    assert.deepEqual(Buffer.from(await (await service.serve(new Request(result.url))).arrayBuffer()), await sample);
    await service.release(2, result.handle);
    assert.equal((await service.serve(new Request(result.url, { method: 'HEAD' }))).status, 200);
    await service.release(1, result.handle);
    assert.equal((await service.serve(new Request(result.url))).status, 404);
    assert.deepEqual(await readdir(root), []);
});

test('oversized HD steps down to SD and strips API authorization on CDN requests', async t => {
    const { service, item, calls } = await fixture(t, { media: async url => new Response(await sample,
        { headers: { 'content-type': 'video/mp4', ...(!url.pathname.includes('mobile') ? { 'content-length': String(MAX_BYTES + 1) } : {}) } }) });
    assert.equal((await service.prepare(1, (await item(1)).key, MAX_BYTES)).quality, 'SD');
    for (const call of calls.filter(call => call.url.hostname.startsWith('thumbs'))) assert.equal(call.options.headers.authorization, undefined);
});

test('streamed bytes override missing or false content length and trigger compression', async t => {
    let compressed = 0;
    const original = await sample;
    // Target barely above sample size with margin, while sources are larger.
    const large = Buffer.concat([original, Buffer.alloc(original.length)]);
    // Separate service fixture so all downloads use the larger valid MP4.
    const other = await fixture(t, { media: () => new Response(large, { headers: { 'content-type': 'video/mp4', 'content-length': '1' } }),
        compress: async (input, directory, limit, signal) => {
            compressed++; signal.throwIfAborted(); assert.ok((await stat(input)).size >= limit);
            const output = join(directory, 'test.mp4'); await writeFile(output, original); return output;
        } });
    const result = await other.service.prepare(1, (await other.item(1)).key, original.length + 2048);
    assert.equal(result.quality, 'Compressed'); assert.equal(compressed, 1);
    assert.ok(result.size < original.length + 2048);
    assert.equal(other.calls.filter(call => call.url.pathname.includes('mobile')).length, 1);
    await other.service.release(1, result.handle);
    assert.deepEqual(await readdir(other.root), []);
});

test('compression cannot return an oversized file or HTML disguised as MP4', async t => {
    const { service, item, root } = await fixture(t, { media: () => new Response(Buffer.alloc(50_000), { headers: { 'content-type': 'video/mp4' } }),
        compress: async (input) => input });
    await assert.rejects(service.prepare(1, (await item(1)).key, 10_000), { code: 'invalid-video' });
    assert.deepEqual(await readdir(root), []);
});

test('cancelling a download aborts its request and cleans disk; another prepare is refused', async t => {
    let started;
    const downloading = new Promise(resolve => { started = resolve; });
    const { service, item, root } = await fixture(t, { media: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
    }) });
    const key = (await item(1)).key;
    const prepared = service.prepare(1, key, MAX_BYTES);
    await downloading;
    await assert.rejects(service.prepare(1, key, MAX_BYTES), { code: 'busy' });
    service.cancel(1);
    await assert.rejects(prepared);
    assert.deepEqual(await readdir(root), []);
});

test('preview proxy forwards ranges and only serves minted media', async t => {
    const { service, item, calls } = await fixture(t);
    const entry = await item(1);
    const result = await service.serve(new Request(entry.preview, { headers: { range: 'bytes=0-' } }));
    assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), await sample);
    assert.equal(calls.at(-1).options.headers.range, 'bytes=0-');
    assert.equal((await service.serve(new Request('lowcord-media://redgifs/https://evil.test'))).status, 404);
});

test('installed FFmpeg compresses a real MP4 to a complete decodable MP4 under budget', async t => {
    const root = await mkdtemp(join(tmpdir(), 'redgifs-encode-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = join(root, 'input.mp4'); await writeFile(input, await sample);
    const output = await compressVideo(input, root, 120_000, new AbortController().signal);
    const data = await readFile(output);
    assert.equal(data.toString('ascii', 4, 8), 'ftyp'); assert.ok(data.length < 120_000);
});

test('five recent metadata sets are cached but mint fresh owner-scoped capabilities', async t => {
    const { service, calls } = await fixture(t);
    const first = await service.search(1, 'same');
    const second = await service.search(2, 'same');
    assert.notEqual(first.items[0].key, second.items[0].key);
    assert.equal(calls.filter(c => c.url.pathname === '/v2/gifs/search').length, 1);
    await assert.rejects(service.prepare(1, second.items[0].key, MAX_BYTES), { code: 'expired' });
    for (let i = 0; i < 5; i++) await service.search(1, `other${i}`);
    await service.search(1, 'same');
    assert.equal(calls.filter(c => c.url.searchParams.get('tags') === 'same').length, 2);
});

test('completed preview ranges are reused and all temporary files are deleted on close', async t => {
    const original = await sample;
    const { service, item, calls, root } = await fixture(t, { media: () => new Response(original,
        { headers: { 'content-type': 'video/mp4', 'content-length': String(original.length) } }) });
    const video = await item(1);
    for (let i = 0; i < 3; i++) {
        const response = await service.serve(new Request(video.preview));
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
    }
    assert.equal(calls.filter(c => c.url.hostname.startsWith('thumbs')).length, 1);
    await service.close();
    assert.deepEqual(await readdir(root), []);
});

test('prepared assets stay available across browse cancellation, and release is owner-scoped', async t => {
    const { service, item } = await fixture(t);
    const result = await service.prepare(1, (await item(1)).key, MAX_BYTES);
    service.cancel(1, 'browse');
    await service.release(2, result.handle);
    assert.equal((await service.serve(new Request(result.url, { method: 'HEAD' }))).status, 200);
    service.cancel(1);
    assert.equal((await service.serve(new Request(result.url))).status, 404);
});

test('preview cache has a byte budget, supports exact ranges, and cancels incomplete writes', async t => {
    const { createPreviewCache } = require('../electron/redgifs-cache.cjs');
    const root = await mkdtemp(join(tmpdir(), 'redgifs-cache-test-'));
    const cache = createPreviewCache({ directory: root, maximumBytes: 32 });
    t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
    const make = async (id, range = '') => {
        const request = new Request(`https://fixture.test/${id}`, { headers: range ? { range } : {} });
        const response = await cache.capture(id, request, new Response(Buffer.alloc(20), { status: range ? 206 : 200,
            headers: { 'content-length': '20', 'content-type': 'video/mp4', ...(range ? { 'content-range': 'bytes 10-29/100' } : {}) } }));
        await response.arrayBuffer(); return request;
    };
    const first = await make('first');
    const second = await make('second', 'bytes=10-29');
    assert.equal(await cache.match('first', first), null);
    const hit = await cache.match('second', second);
    assert.equal(hit.status, 206); assert.equal(hit.headers.get('content-range'), 'bytes 10-29/100');
    assert.equal((await hit.arrayBuffer()).byteLength, 20);
    assert.equal(await cache.match('second', new Request(second.url)), null);
    const pending = await cache.capture('third', first, new Response(Buffer.alloc(20), { headers: { 'content-length': '20' } }));
    await pending.body.cancel();
    await cache.close();
    assert.deepEqual(await readdir(root), []);
});

test('metadata cache expires after one minute', async t => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const { service, calls } = await fixture(t);
    await service.search(1, 'same'); await service.search(1, 'same');
    assert.equal(calls.filter(c => c.url.pathname === '/v2/gifs/search').length, 1);
    now += 60_001;
    await service.search(1, 'same');
    assert.equal(calls.filter(c => c.url.pathname === '/v2/gifs/search').length, 2);
});

test('cache budget includes active readers, and close waits for in-progress file creation', async t => {
    const { createPreviewCache } = require('../electron/redgifs-cache.cjs');
    const root = await mkdtemp(join(tmpdir(), 'redgifs-cache-lease-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cache = createPreviewCache({ directory: root, maximumBytes: 200_000 });
    const request = new Request('https://fixture.test/video');
    const response = () => new Response(Buffer.alloc(150_000), { headers: { 'content-length': '150000' } });
    await (await cache.capture('first', request, response())).arrayBuffer();
    const leased = await cache.match('first', request);
    await (await cache.capture('second', request, response())).arrayBuffer();
    assert.equal(await cache.match('second', request), null);
    await leased.body.cancel();
    const opening = cache.capture('third', request, response());
    await cache.close();
    const pending = await opening; await pending.body?.cancel();
    assert.deepEqual(await readdir(root), []);
});

test('saved IDs refresh into new owner-scoped capabilities without retaining media URLs', async t => {
    const { service, item, calls } = await fixture(t);
    const old = await item(1);
    service.cancel(1);
    const fresh = await service.resolve(1, old.id);
    assert.equal(fresh.id, old.id); assert.notEqual(fresh.key, old.key);
    assert.equal(calls.at(-1).url.pathname, '/v2/gifs/SampleVideo');
    assert.equal(JSON.stringify(fresh).includes('https://'), false);
    await assert.rejects(service.prepare(2, fresh.key, MAX_BYTES), { code: 'expired' });
    for (const id of ['../invalid', '', 'http://127.0.0.1', null]) await assert.rejects(service.resolve(1, id), { code: 'expired' });
});
