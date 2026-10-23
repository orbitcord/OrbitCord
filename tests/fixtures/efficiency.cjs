const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// Production entry points with local JSON responses: no accounts or network.
function pickerFixture(directory, provider, overrides = {}) {
    const path = join(directory, 'electron', `${provider}.cjs`);
    let factory;
    if (Object.keys(overrides).length) {
        const module = { exports: {} };
        runInNewContext(readFileSync(path, 'utf8'), { module, exports: module.exports, require: createRequire(path),
            fetch, AbortController, AbortSignal, Response, Request, Headers, URL, URLSearchParams,
            Buffer, setTimeout, clearTimeout, console, ...overrides }, { filename: path });
        factory = module.exports[provider === 'reddit' ? 'createReddit' : 'createRedgifs'];
    } else factory = createRequire(path)(path)[provider === 'reddit' ? 'createReddit' : 'createRedgifs'];
    const count = provider === 'reddit' ? 25 : 24;
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const post = { id: 'img1', title: 'Fixture', author: 'fixture', subreddit: 'pics',
        post_hint: 'image', url: 'https://i.redd.it/fixture.jpg' };
    const gif = { id: 'FixtureVideo', type: 1, userName: 'fixture',
        urls: { hd: 'https://thumbs4.redgifs.com/FixtureVideo.mp4' } };
    const fetchPage = async value => {
        const path = new URL(value).pathname;
        if (path === '/v2/auth/temporary') return json({ token: 'fixture-token' });
        if (path.startsWith('/v2/')) return json({ gifs: Array(count).fill(gif), pages: 1000, gif });
        if (/\/api\/me/.test(path)) return new Response(null, { status: 403 });
        return json({ data: { after: 't3_next', children: Array(count).fill({ kind: 't3', data: post }) } });
    };
    const service = provider === 'reddit' ? factory({ fetchAccount: fetchPage, fetchMedia: fetchPage }) : factory({ fetchPage });
    return { service, count, page: page => provider === 'reddit'
        ? service.search(1, '', `t3_page${page}`) : service.search(1, '', page) };
}

// Expose only the byte writer and compressor in this test context. The shipped
// module retains its single public fromVideo method.
function gifFixture(source, extras = {}) {
    const window = { Lowcord: {} };
    const needle = 'window.Lowcord.gif = { fromVideo };';
    if (!source.includes(needle)) throw new Error('GIF instrumentation needs updating');
    source = source.replace(needle, `window.Lowcord.gif = { fromVideo, encodeFrames(frames) {
        const encode = typeof createLzw === 'function' ? createLzw() : lzw;
        return frames.map(pixels => { const out = new Bytes(); encode(pixels, out); return out.result(); });
    } };`);
    runInNewContext(source, { window, ...extras });
    return window;
}

function gifFrames() {
    let seed = 12345;
    return Array.from({ length: 12 }, (_, frame) => {
        const pixels = new Uint8Array(480 * 270);
        for (let i = 0; i < pixels.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels[i] = frame % 3 === 0 ? seed >>> 24 : frame % 3 === 1 ? i % 255 : 7;
        }
        return pixels;
    });
}

module.exports = { pickerFixture, gifFixture, gifFrames };
