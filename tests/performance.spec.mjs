import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { mux, muxToFile } = require('../electron/mp4-mux.cjs');
const { createMediaCache } = require('../electron/media-cache.cjs');
const { createSocialPosts } = require('../electron/social-posts.cjs');

const { createRedditFixture } = require('./fixtures/reddit-playback.cjs');
function redditFixture() {
    const fixture = createRedditFixture(process.cwd());
    return { ...fixture, fetch: fixture.fetchPage };
}

test('file muxing preserves every byte, cleans failures and honors cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lowcord-file-mux-test-'));
    try {
        const { video, audio } = await redditFixture();
        const v = join(directory, 'video'), a = join(directory, 'audio'), out = join(directory, 'out');
        await writeFile(v, video); await writeFile(a, audio);
        const result = await muxToFile(v, a, out);
        const data = await readFile(out);
        expect(data.equals(mux(video, audio))).toBe(true);
        expect(result.size).toBe(data.length);
        const controller = new AbortController(); controller.abort();
        await expect(muxToFile(v, a, join(directory, 'aborted'), { signal: controller.signal })).rejects.toThrow();
        await writeFile(v, Buffer.from('broken MP4'));
        await expect(muxToFile(v, a, join(directory, 'broken'))).rejects.toThrow();
        expect((await readdir(directory)).sort()).toEqual(['audio', 'out', 'video']);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('playback files reuse downloads, preserve ranges, and fall back on an unavailable temp directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lowcord-playback-test-'));
    const fixture = await redditFixture(), posts = createSocialPosts(fixture.fetch, { directory });
    let fallback;
    try {
        const post = await posts.get('https://www.reddit.com/comments/abc/');
        const expected = mux(fixture.video, fixture.audio), src = post.media[0].src;
        for (const range of [null, 'bytes=0-15', 'bytes=100-', 'bytes=-32', 'bytes=999999-']) {
            const response = await posts.serve(new Request(src, { headers: range ? { range } : {} }));
            expect(response.status).toBe(range === 'bytes=999999-' ? 416 : range ? 206 : 200);
            if (response.status === 416) continue;
            const data = Buffer.from(await response.arrayBuffer());
            const desired = range === 'bytes=0-15' ? expected.subarray(0, 16)
                : range === 'bytes=100-' ? expected.subarray(100) : range === 'bytes=-32' ? expected.subarray(-32) : expected;
            expect(data.equals(desired)).toBe(true);
            expect(Number(response.headers.get('content-length'))).toBe(data.length);
        }
        expect(fixture.requests.filter(url => url.endsWith('DASH_480.mp4'))).toHaveLength(1);
        const blocked = join(directory, 'not-a-directory'); await writeFile(blocked, 'occupied');
        fallback = createSocialPosts(fixture.fetch, { directory: blocked });
        const other = await fallback.get('https://www.reddit.com/comments/abc/');
        const response = await fallback.serve(new Request(other.media[0].src));
        expect(Buffer.from(await response.arrayBuffer()).equals(expected)).toBe(true);
    } finally { await posts.close(); await fallback?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('eviction keeps active readers alive, cancellation releases files, and duplicate requests share work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lowcord-cache-test-'));
    const cache = createMediaCache({ directory, maximum: 1 });
    let calls = 0;
    const produce = async directory => {
        calls++; const path = join(directory, 'video.mp4');
        await writeFile(path, Buffer.alloc(1024 * 1024, 97));
        return { path, size: 1024 * 1024 };
    };
    try {
        const [a, same] = await Promise.all([cache.get('a', produce), cache.get('a', produce)]);
        expect(a).toBe(same); expect(calls).toBe(1);
        const response = cache.response(a, new Request('https://fixture/'));
        await cache.get('b', produce);
        await access(a.path);
        expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.alloc(1024 * 1024, 97))).toBe(true);
        await expect.poll(async () => access(a.path).then(() => false, () => true)).toBe(true);
        const b = await cache.get('b', produce);
        await cache.response(b, new Request('https://fixture/')).body.cancel();
        await cache.close();
        expect(await readdir(directory)).toEqual([]);
    } finally { await cache.close(); await rm(directory, { recursive: true, force: true }); }
});

test('pending stores share a cache traversal, reject translation proxies, and stop polling', async () => {
    const source = await readFile('src-tauri/injection/discord.js', 'utf8');
    const window = { webpackChunkdiscord_app: [] }, timers = new Set(), modules = {};
    let reads = 0;
    Object.defineProperty(modules, '1', { enumerable: true, get: () => { reads++; return { exports: exportsValue }; } });
    let exportsValue = new Proxy({}, { get: () => () => {} });
    runInNewContext(source, { window, document: {}, console, setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn) });
    window.webpackChunkdiscord_app[0][2]({ c: modules });
    const found = [];
    window.Lowcord.waitForStore('A', store => found.push(store));
    window.Lowcord.waitForStore('A', store => found.push(store));
    window.Lowcord.waitForStore('B', store => found.push(store));
    expect(found).toHaveLength(0);
    class A {} A.displayName = 'A'; class B {} B.displayName = 'B';
    const a = new A(), b = new B(); exportsValue = { a, b };
    reads = 0; for (const poll of timers) poll();
    expect(reads).toBe(1); expect(found).toEqual([a, a, b]); expect(timers.size).toBe(0);
    reads = 0; window.Lowcord.waitForStore('A', store => found.push(store));
    expect(reads).toBe(0); expect(window.Lowcord.store('A')).toBe(a);
});

test('shutdown aborts queued productions and limits concurrent downloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lowcord-cache-shutdown-'));
    const cache = createMediaCache({ directory });
    let running = 0, peak = 0;
    const produce = async (_directory, signal) => {
        signal.throwIfAborted(); running++; peak = Math.max(peak, running);
        try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
        finally { running--; }
    };
    try {
        const work = Promise.allSettled(Array.from({ length: 6 }, (_, i) => cache.get(String(i), produce)));
        await expect.poll(() => running).toBe(2);
        await cache.close();
        expect((await work).every(result => result.status === 'rejected')).toBe(true);
        expect(peak).toBe(2); expect(running).toBe(0);
        expect(await readdir(directory)).toEqual([]);
    } finally { await cache.close(); await rm(directory, { recursive: true, force: true }); }
});

test('DOM listeners receive records, unsubscribe, and reattach without duplicate observers', async ({ page }) => {
    await page.goto('/electron-child');
    await page.addScriptTag({ content: await readFile('src-tauri/injection/discord.js', 'utf8') });
    const result = await page.evaluate(async () => {
        let calls = 0, records = 0;
        const listen = mutations => { calls++; if (Array.isArray(mutations)) records += mutations.length; };
        const wait = async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); };
        let remove = Lowcord.onDomChange(listen); calls = 0;
        document.body.append(document.createElement('div')); await wait();
        const first = calls; remove(); calls = 0;
        document.body.append(document.createElement('div')); await wait(); const stopped = calls;
        remove = Lowcord.onDomChange(listen); calls = 0;
        document.body.append(document.createElement('div')); await wait(); const restarted = calls; remove();
        return { first, stopped, restarted, records };
    });
    expect(result).toEqual({ first: 1, stopped: 0, restarted: 1, records: 2 });
});
