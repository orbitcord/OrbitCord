const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { createReddit, mediaOf } = require('../electron/reddit.cjs');
const media = name => readFile(join(__dirname, 'fixtures/media', name));
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json; charset=UTF-8' } });
const listing = (posts, after = 't3_next') => json({ kind: 'Listing', data: { after, children: posts.map(data => ({ kind: 't3', data })) } });
const preview = { images: [{ source: { url: 'https://preview.redd.it/big.jpg?width=2000&amp;s=x', width: 2000, height: 1000 },
    resolutions: [{ url: 'https://preview.redd.it/small.jpg?width=320&amp;s=y', width: 320, height: 160 },
        { url: 'https://preview.redd.it/mid.jpg?width=640&amp;s=z', width: 640, height: 320 }] }] };
const posts = {
    video: { id: 'vid1', title: 'A video', subreddit: 'videos', author: 'op', over_18: false, preview,
        secure_media: { reddit_video: { fallback_url: 'https://v.redd.it/abc/DASH_720.mp4?source=fallback', duration: 12, width: 1280, height: 720 } } },
    image: { id: 'img1', title: 'A photo', subreddit: 'pics', author: 'op', post_hint: 'image', url: 'https://i.redd.it/photo.jpg', preview },
    gallery: { id: 'gal1', title: 'A gallery', subreddit: 'pics', over_18: true, gallery_data: { items: [{ media_id: 'a' }, { media_id: 'b' }] },
        media_metadata: { a: { status: 'valid', e: 'Image', s: { u: 'https://preview.redd.it/a.png?s=1', x: 10, y: 10 } },
            b: { status: 'valid', e: 'AnimatedImage', s: { mp4: 'https://preview.redd.it/b.gif?format=mp4&s=2', gif: 'https://preview.redd.it/b.gif' } } } },
    redgifs: { id: 'rg1', title: 'Linked', subreddit: 'gifs', url: 'https://www.redgifs.com/watch/SomeClip', preview },
    text: { id: 'txt1', title: 'Just words', subreddit: 'askreddit', is_self: true, url: 'https://www.reddit.com/r/askreddit/comments/txt1/' },
    foreign: { id: 'bad1', title: 'Elsewhere', subreddit: 'pics', post_hint: 'image', url: 'https://evil.example/photo.jpg' },
};

async function fixture(t, { signedIn = false, cdn, compress, listings } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'reddit-test-'));
    const calls = [], downloads = [];
    const service = createReddit({ tempRoot: root, compress,
        fetchAccount: async (value, options) => {
            const url = new URL(value); calls.push({ url, options });
            if (url.pathname === '/api/me.json') return signedIn ? json({ name: 'fixture_user', over_18: true }) : json({});
            if (listings) return listings(url);
            if (url.pathname.startsWith('/subreddits/')) return json({ data: { after: null, children: [
                { kind: 't5', data: { display_name: 'pics', title: 'Pictures', subscribers: 1000, over18: false } },
                { kind: 't5', data: { display_name: 'u_someone', subreddit_type: 'user' } },
                { kind: 't5', data: { display_name: 'bad name!' } }] } });
            if (url.pathname.startsWith('/by_id/')) return listing([posts.video], null);
            return listing(Object.values(posts));
        },
        fetchMedia: async (value, options) => {
            const url = new URL(value);
            if (url.hostname === 'api.reddit.com') {
                // Signed-out listings: the same fixtures, without the .json suffix.
                calls.push({ url: new URL(`https://www.reddit.com${url.pathname}.json${url.search}`), options, public: true });
                if (url.pathname.startsWith('/subreddits/')) return json({ data: { after: null, children: [] } });
                if (url.pathname.startsWith('/by_id/')) return listing([posts.video], null);
                return listings ? listings(url) : listing(Object.values(posts));
            }
            downloads.push({ url, options });
            const answer = cdn?.(url, options);
            if (answer) return answer;
            if (url.pathname.endsWith('DASHPlaylist.mpd')) return new Response('<MPD><BaseURL>DASH_720.mp4</BaseURL><BaseURL>DASH_360.mp4</BaseURL><BaseURL>DASH_AUDIO_128.mp4</BaseURL></MPD>');
            if (url.pathname.includes('AUDIO')) return new Response(await media('dash-audio.mp4'), { headers: { 'content-type': 'video/mp4' } });
            if (url.hostname === 'v.redd.it') return new Response(await media('dash-video.mp4'), { headers: { 'content-type': 'video/mp4' } });
            if (url.pathname.endsWith('.png')) return new Response(await media('sample.png'), { headers: { 'content-type': 'image/png' } });
            if (url.searchParams.get('format') === 'mp4') return new Response(await media('sample.mp4'), { headers: { 'content-type': 'video/mp4' } });
            return new Response(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]), { headers: { 'content-type': 'image/jpeg' } });
        } });
    t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
    return { root, service, calls, downloads };
}
const find = (result, id) => result.items.find(item => item.id === id);

test('only media posts on allowed CDNs become items, with opaque preview URLs', async t => {
    const { service } = await fixture(t);
    const result = await service.search(1);
    assert.deepEqual(result.items.map(item => [item.id, item.kind]),
        [['vid1', 'video'], ['img1', 'image'], ['gal1', 'gallery'], ['rg1', 'redgifs']]);
    assert.equal(result.after, 't3_next');
    assert.equal(find(result, 'gal1').count, 2); assert.equal(find(result, 'gal1').nsfw, true);
    assert.equal(find(result, 'rg1').redgifs, 'someclip');
    assert.match(find(result, 'vid1').preview, /^lowcord-media:\/\/reddit\/[a-f0-9]{36}\/video$/);
    assert.equal(JSON.stringify(result).includes('redd.it'), false);
    assert.equal(mediaOf(posts.foreign), null);
});

test('feeds map to Reddit routes; saved posts need a signed-in account', async t => {
    const anonymous = await fixture(t);
    await anonymous.service.search(1);
    await anonymous.service.search(1, 'cats', 't3_abc', { subreddit: 'aww', sort: 'top', time: 'all' });
    const routes = anonymous.calls.filter(call => call.url.pathname !== '/api/me.json');
    assert.ok(routes.every(call => call.public && call.options.credentials === 'omit'));
    assert.equal(routes[0].url.pathname, '/r/popular/hot.json');
    assert.equal(routes[1].url.pathname, '/r/aww/search.json');
    assert.equal(routes[1].url.searchParams.get('restrict_sr'), '1');
    assert.equal(routes[1].url.searchParams.get('after'), 't3_abc');
    assert.equal(routes[1].url.searchParams.get('t'), 'all');
    await assert.rejects(anonymous.service.search(1, '', null, { mode: 'saved' }), { code: 'signed-out' });
    await assert.rejects(anonymous.service.search(1, '', null, { subreddit: '../etc' }), { code: 'invalid-search' });
    await assert.rejects(anonymous.service.search(1, '', 'nope'), { code: 'invalid-search' });

    const user = await fixture(t, { signedIn: true });
    assert.deepEqual(await user.service.account(), { name: 'fixture_user', nsfw: true });
    await user.service.search(1);
    await user.service.search(1, '', null, { mode: 'saved' });
    const communities = await user.service.search(1, '', null, { mode: 'subreddits' });
    assert.ok(user.calls.every(call => !call.public));
    const paths = user.calls.map(call => call.url.pathname).filter(path => path !== '/api/me.json');
    assert.deepEqual(paths, ['/best.json', '/user/fixture_user/saved.json', '/subreddits/mine/subscriber.json']);
    assert.deepEqual(communities.communities.map(item => item.id), ['pics']);
});

test('a Reddit video is joined with its audio at the best size that fits', async t => {
    const { service, downloads } = await fixture(t);
    const item = find(await service.search(1), 'vid1');
    const result = await service.prepare(1, item.key, 20_000_000);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'reddit-vid1.mp4');
    assert.equal(result.quality, 'HD');
    assert.ok(downloads.some(call => call.url.pathname === '/abc/DASH_AUDIO_128.mp4'));
    assert.ok(downloads.every(call => call.options.credentials === 'omit'));
    const served = await service.serve(new Request(result.files[0].url));
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    assert.ok(bytes.length > (await media('dash-video.mp4')).length);
    await service.release(1, result.handle);
    assert.equal((await service.serve(new Request(result.files[0].url))).status, 404);
});

test('a video over the limit is compressed below it', async t => {
    let compressed = 0;
    const { service } = await fixture(t, { compress: async (input, directory, limit) => {
        compressed++;
        const output = join(directory, 'compressed.mp4');
        await writeFile(output, (await media('sample.mp4')).subarray(0, Math.min(limit - 1, 4096)));
        return output;
    } });
    const item = find(await service.search(1), 'vid1');
    const result = await service.prepare(1, item.key, 2048);
    assert.equal(compressed, 1); assert.equal(result.quality, 'Compressed');
    assert.ok(result.files[0].size < 2048);
});

test('galleries send every item, and a large photo falls back to a smaller preview', async t => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30_000)]);
    const { service } = await fixture(t, { cdn: url => url.pathname === '/photo.jpg' ? new Response(big, { headers: { 'content-type': 'image/jpeg' } }) : null });
    const result = await service.search(1);
    const gallery = await service.prepare(1, find(result, 'gal1').key, 20_000_000);
    assert.deepEqual(gallery.files.map(file => [file.name, file.type]), [['reddit-gal1-1.png', 'image/png'], ['reddit-gal1-2.mp4', 'video/mp4']]);
    const photo = await service.prepare(1, find(result, 'img1').key, 20_000);
    assert.equal(photo.quality, 'Resized'); assert.equal(photo.files[0].type, 'image/jpeg');
    await assert.rejects(service.prepare(2, find(result, 'img1').key, 20_000_000), { code: 'expired' });
    await service.release(1, gallery.handle);
    const only = await service.prepare(1, find(result, 'gal1').key, 20_000_000, [1]);
    assert.deepEqual(only.files.map(file => file.name), ['reddit-gal1-2.mp4']);
    for (const bad of [[], [2], [0, 0], [-1], 'all', Array.from({ length: 11 }, (_, i) => i)]) {
        await assert.rejects(service.prepare(1, find(result, 'gal1').key, 20_000_000, bad), { code: 'invalid-selection' });
    }
    await assert.rejects(service.prepare(1, find(result, 'rg1').key, 20_000_000), { code: 'redgifs' });
});

test('gallery items have their own views, and saved posts can be searched', async t => {
    const { service } = await fixture(t, { signedIn: true });
    const gallery = find(await service.search(1), 'gal1');
    assert.equal(gallery.animated, 1);
    assert.deepEqual(gallery.items.map(item => [item.type, item.animated]), [['image', false], ['video', true]]);
    const view = await service.serve(new Request(gallery.items[1].src));
    assert.equal(view.headers.get('content-type'), 'video/mp4');
    assert.equal((await service.serve(new Request(gallery.items[1].src.replace(/1$/, '7')))).status, 404);
    const saved = await service.search(1, 'PHOTO', null, { mode: 'saved' });
    assert.deepEqual(saved.items.map(item => item.id), ['img1']);
});

test('cancelling removes temporary files', async t => {
    const { service, root } = await fixture(t, { compress: (_input, _directory, _limit, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const item = find(await service.search(1), 'vid1');
    const work = service.prepare(1, item.key, 2048);
    await new Promise(resolve => setTimeout(resolve, 100));
    service.cancel(1);
    await assert.rejects(work);
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('orbitcord-reddit-')), []);
});

test('the picker script initializes with malformed saved preferences', async () => {
    const source = await readFile(join(__dirname, '../src-tauri/injection/reddit.js'), 'utf8');
    const window = { Lowcord: { extensions: { ui() {}, addComposerAction() {} }, storage: { getItem: () => JSON.stringify({
        subreddits: [null, 'bad name', 'pics'], spoilers: 'yes' }) } }, addEventListener() {} };
    runInNewContext(source, { window, Intl });
    assert.equal(typeof window.Lowcord.reddit.open, 'function');
});
