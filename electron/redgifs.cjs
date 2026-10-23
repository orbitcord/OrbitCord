const { randomBytes } = require('node:crypto');
const { mkdtemp, open, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createMediaCache } = require('./media-cache.cjs');
const { createPreviewCache } = require('./redgifs-cache.cjs');
const { compressVideo } = require('./video-compress.cjs');

const MAX_BYTES = 20_000_000;
const sourceLimit = 256 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const mediaURL = value => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && /^(?:media|thumbs\d*)\.redgifs\.com$/.test(url.hostname)
            && !url.username && !url.password && !url.port ? url.href : null;
    } catch { return null; }
};

function createRedgifs({ fetchPage = fetch, compress = compressVideo, tempRoot = tmpdir() } = {}) {
    const entries = new Map(), jobs = new Map(), browsing = new Map();
    const lifetime = new AbortController();
    const assets = new Map(), searches = new Map();
    const files = createMediaCache({ directory: tempRoot });
    const previews = createPreviewCache({ directory: tempRoot });
    let token, tokenPending;
    const request = (url, signal, headers = {}) => fetchPage(url, {
        headers: { 'user-agent': 'OrbitCord/0.1 (+https://github.com/orbitcord/OrbitCord)',
            referer: 'https://www.redgifs.com/', ...headers },
        credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(signal ? 60_000 : 15_000)]),
    });
    async function bytes(response, limit) {
        if (!response.ok) { await response.body?.cancel(); throw fail(response.status === 429 ? 'rate-limited' : `http-${response.status}`); }
        if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fail('too-large'); }
        const parts = []; let size = 0;
        for await (const part of response.body) {
            size += part.length;
            if (size > limit) throw fail('too-large');
            parts.push(part);
        }
        return Buffer.concat(parts);
    }
    async function json(path, signal, authenticated = true, retry = true) {
        if (authenticated && !token) {
            // Concurrent windows share one temporary token, never Discord auth.
            tokenPending ??= json('/v2/auth/temporary', undefined, false).then(result => {
                if (typeof result.token !== 'string' || !result.token) throw fail('auth-failed');
                token = result.token;
            }).finally(() => { tokenPending = undefined; });
            await tokenPending;
        }
        signal?.throwIfAborted();
        const response = await request(`https://api.redgifs.com${path}`, signal,
            authenticated ? { authorization: `Bearer ${token}`, accept: 'application/json' } : { accept: 'application/json' });
        if (response.status === 401 && authenticated && retry) {
            await response.body?.cancel(); token = undefined;
            return json(path, signal, true, false);
        }
        return JSON.parse((await bytes(response, 4 * 1024 * 1024)).toString('utf8'));
    }
    let nextExpiry = Infinity;
    function mint(gif, owner) {
        if (!gif || typeof gif !== 'object' || typeof gif.id !== 'string') return null;
        const hd = mediaURL(gif.urls?.hd), sd = mediaURL(gif.urls?.sd);
        if (!/^[a-z0-9]{1,100}$/i.test(gif.id) || (!hd && !sd) || (gif.type != null && gif.type !== 1)) return null;
        const key = randomBytes(18).toString('hex');
        // Until the earliest expiry, a full table scan cannot remove anything.
        // Access still checks every token's expiry; no timer or grace period.
        const now = Date.now();
        if (nextExpiry < now) {
            nextExpiry = Infinity;
            for (const [id, entry] of entries) {
                if (entry.expires < now) entries.delete(id);
                else nextExpiry = Math.min(nextExpiry, entry.expires);
            }
        }
        while (entries.size >= 4096) entries.delete(entries.keys().next().value);
        const entry = { owner, id: gif.id, hd, sd, poster: mediaURL(gif.urls?.poster ?? gif.urls?.thumbnail), expires: now + 30 * 60_000 };
        entries.set(key, entry);
        nextExpiry = Math.min(nextExpiry, entry.expires);
        return { key, id: entry.id, author: String(gif.userName ?? '').slice(0, 100),
            duration: Number.isFinite(gif.duration) && gif.duration >= 0 ? gif.duration : null,
            width: Number.isFinite(gif.width) && gif.width > 0 ? gif.width : null,
            height: Number.isFinite(gif.height) && gif.height > 0 ? gif.height : null,
            preview: `lowcord-media://redgifs/${key}/video`, poster: entry.poster ? `lowcord-media://redgifs/${key}/poster` : null };
    }
    async function search(owner, query = '', page = 1, options = {}) {
        if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 1000) throw fail('invalid-search');
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('invalid-search');
        const mode = options.mode ?? 'videos', nicheId = options.nicheId, creator = options.creator;
        if (!['videos', 'explore', 'creators', 'niches'].includes(mode) || (nicheId != null && (mode !== 'videos' || typeof nicheId !== 'string'
            || !/^[a-z0-9_-]{1,100}$/i.test(nicheId))) || (creator != null && (mode !== 'creators' || typeof creator !== 'string'
            || !/^[a-z0-9_-]{1,100}$/i.test(creator)))) throw fail('invalid-search');
        browsing.get(owner)?.abort();
        const controller = new AbortController(); browsing.set(owner, controller);
        try {
            const text = query.trim().replace(/^#/, '').trim();
            const params = new URLSearchParams({ count: '24', page: String(page) });
            let endpoint;
            if (mode === 'niches') {
                params.set('order', text ? 'best_match' : 'subscribers');
                if (text) params.set('query', text);
                endpoint = '/v2/niches/search';
            } else if (nicheId) {
                params.set('order', 'recent');
                endpoint = `/v2/niches/${encodeURIComponent(nicheId)}/gifs`;
            } else if (mode === 'creators') {
                params.set('order', creator ? 'latest' : text ? 'best_match' : 'trending');
                if (creator) {
                    params.set('type', 'g');
                    if (text) params.set('tags', text);
                    endpoint = `/v2/users/${encodeURIComponent(creator)}/search`;
                } else {
                    if (text) params.set('query', text);
                    endpoint = '/v2/creators/search';
                }
            } else if (mode === 'videos' && !text) {
                endpoint = '/v2/feeds/trending/popular';
            } else {
                params.set('type', 'g'); params.set('order', 'trending');
                if (mode === 'explore') params.set('verified', 'y');
                if (text) params.set('tags', text);
                endpoint = '/v2/gifs/search';
            }
            const cacheKey = `${endpoint}?${params}`;
            let cached = searches.get(cacheKey);
            if (!cached || cached.expires < Date.now()) {
                cached = { result: await json(cacheKey, controller.signal), expires: Date.now() + 60_000 };
            }
            controller.signal.throwIfAborted();
            searches.delete(cacheKey); searches.set(cacheKey, cached);
            while (searches.size > 5) searches.delete(searches.keys().next().value);
            const result = cached.result;
            if (mode === 'creators' && !creator) {
                if (!Array.isArray(result.items)) throw fail('invalid-response');
                const creators = result.items.slice(0, 24).filter(user => typeof user?.username === 'string'
                    && /^[a-z0-9_-]{1,100}$/i.test(user.username)).map(user => ({
                    id: user.username, name: String(user.name || user.username).slice(0, 160),
                    videos: Number.isFinite(user.publishedGifs) && user.publishedGifs >= 0 ? user.publishedGifs : null,
                    followers: Number.isFinite(user.followers) && user.followers >= 0 ? user.followers : null,
                    verified: user.verified === true,
                }));
                return { creators, more: Number.isFinite(result.pages) ? page < result.pages : result.items.length === 24 };
            }
            if (mode === 'niches') {
                if (!Array.isArray(result.niches)) throw fail('invalid-response');
                const niches = result.niches.slice(0, 24).filter(niche => typeof niche?.id === 'string' && /^[a-z0-9_-]{1,100}$/i.test(niche.id))
                    .map(niche => ({ id: niche.id, name: String(niche.name ?? '').slice(0, 160),
                        videos: Number.isFinite(niche.gifs) && niche.gifs >= 0 ? niche.gifs : null,
                        subscribers: Number.isFinite(niche.subscribers) && niche.subscribers >= 0 ? niche.subscribers : null }));
                return { niches, more: Number.isFinite(result.pages) ? page < result.pages : result.niches.length === 24 };
            }
            if (!Array.isArray(result.gifs)) throw fail('invalid-response');
            const items = result.gifs.slice(0, 24).map(gif => mint(gif, owner)).filter(Boolean);
            return { items, more: Number.isFinite(result.pages) ? page < result.pages : result.gifs.length === 24 };
        } finally { if (browsing.get(owner) === controller) browsing.delete(owner); }
    }
    const entryFor = (key, owner) => {
        const entry = typeof key === 'string' && entries.get(key);
        if (!entry || entry.expires < Date.now() || (owner !== undefined && entry.owner !== owner)) throw fail('expired');
        return entry;
    };
    async function download(url, path, limit, signal) {
        const response = await request(url, signal);
        if (!response.ok) { await response.body?.cancel(); throw fail(`http-${response.status}`); }
        if (!/^video\/mp4(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw fail('invalid-video'); }
        if (Number(response.headers.get('content-length')) >= limit) { await response.body?.cancel(); throw fail('too-large'); }
        const file = await open(path, 'w');
        try {
            let size = 0;
            for await (const part of response.body) {
                signal.throwIfAborted(); size += part.length;
                if (size >= limit) throw fail('too-large');
                await file.writeFile(part);
            }
            if (size < 12) throw fail('invalid-video');
            return size;
        } finally { await file.close(); }
    }
    async function prepare(owner, key, requestedLimit) {
        const entry = entryFor(key, owner);
        if (!Number.isFinite(requestedLimit) || requestedLimit < 1024) throw fail('invalid-limit');
        if (jobs.has(owner)) throw fail('busy');
        const controller = new AbortController();
        const job = { controller }; jobs.set(owner, job);
        const signal = controller.signal;
        const limit = Math.floor(Math.min(MAX_BYTES, requestedLimit) * 0.98);
        let directory;
        job.done = (async () => {
            try {
                for (const [handle, asset] of assets) if (asset.owner === owner) await release(owner, handle);
                signal.throwIfAborted();
                directory = await mkdtemp(join(tempRoot, 'orbitcord-redgifs-'));
                const input = join(directory, 'source.mp4');
                const sources = [...new Set([entry.hd, entry.sd].filter(Boolean))];
                let path, quality;
                for (const [index, source] of sources.entries()) {
                    // Keep the final (usually SD) source even when it exceeds the
                    // upload budget. Compression consumes this same file.
                    const last = index === sources.length - 1;
                    try {
                        const size = await download(source, input, last ? sourceLimit : limit, signal);
                        path = input; quality = source === entry.hd ? 'HD' : 'SD';
                        if (size >= limit) { path = await compress(input, directory, limit, signal); quality = 'Compressed'; }
                        break;
                    } catch (error) { if (signal.aborted || error.code !== 'too-large' || last) throw error; }
                }
                signal.throwIfAborted();
                const size = (await stat(path)).size;
                const file = await open(path, 'r');
                const signature = Buffer.alloc(8);
                try { await file.read(signature, 0, 8, 0); } finally { await file.close(); }
                signal.throwIfAborted();
                if (size >= limit || size < 12 || signature.toString('ascii', 4, 8) !== 'ftyp') throw fail('invalid-video');
                const handle = randomBytes(18).toString('hex');
                assets.set(handle, { owner, path, size, directory, readers: 0, evicted: false });
                directory = undefined; // Owned until release/cancellation/window teardown.
                return { handle, url: `lowcord-media://redgifs/${handle}/prepared`, size,
                    name: `redgifs-${entry.id}.mp4`, type: 'video/mp4', quality };
            } finally {
                if (directory) await rm(directory, { recursive: true, force: true });
                if (jobs.get(owner) === job) jobs.delete(owner);
            }
        })();
        return job.done;
    }
    async function resolve(owner, id) {
        if (typeof id !== 'string' || !/^[a-z0-9]{1,100}$/i.test(id)) throw fail('expired');
        const result = await json(`/v2/gifs/${encodeURIComponent(id)}`, lifetime.signal);
        const item = mint(result.gif, owner);
        if (!item) throw fail('expired');
        return item;
    }
    async function release(owner, handle) {
        const asset = assets.get(handle);
        if (!asset || asset.owner !== owner) return;
        assets.delete(handle); asset.evicted = true;
        if (!asset.readers) await rm(asset.directory, { recursive: true, force: true });
    }
    function cancel(owner, scope = 'all') {
        if (!['all', 'browse', 'prepare'].includes(scope)) throw fail('invalid-scope');
        if (scope !== 'prepare') browsing.get(owner)?.abort();
        if (scope !== 'browse') jobs.get(owner)?.controller.abort();
        if (scope === 'all') {
            for (const [key, entry] of entries) if (entry.owner === owner) entries.delete(key);
            for (const [handle, asset] of assets) if (asset.owner === owner) void release(owner, handle);
        }
    }
    async function serve(requestData) {
        try {
            const url = new URL(requestData.url);
            const match = /^\/([a-f0-9]{36})\/(video|poster|prepared)$/.exec(url.pathname);
            if (url.hostname !== 'redgifs' || !match || !['GET', 'HEAD'].includes(requestData.method)) return new Response(null, { status: 404 });
            if (match[2] === 'prepared') {
                const asset = assets.get(match[1]);
                if (!asset) return new Response(null, { status: 404 });
                const response = files.response(asset, requestData);
                response.headers.set('access-control-allow-origin', '*');
                response.headers.set('cache-control', 'no-store');
                return response;
            }
            const entry = entryFor(match[1]);
            const source = match[2] === 'poster' ? entry.poster : entry.sd || entry.hd;
            if (!source) return new Response(null, { status: 404 });
            const range = requestData.headers.get('range');
            if (range && !/^bytes=\d+-\d*$/.test(range)) return new Response(null, { status: 416 });
            const cached = await previews.match(source, requestData);
            if (cached) return cached;
            const response = await request(source, requestData.signal, range ? { range } : {});
            const type = response.headers.get('content-type') ?? '';
            if (![200, 206].includes(response.status) || !/^(video\/mp4|image\/(jpeg|png|webp))(?:;|$)/i.test(type)) {
                await response.body?.cancel(); return new Response(null, { status: 502 });
            }
            const headers = new Headers({ 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': 'https://discord.com' });
            for (const key of ['content-length', 'content-range', 'accept-ranges']) {
                const value = response.headers.get(key); if (value) headers.set(key, value);
            }
            if (requestData.method === 'HEAD') { await response.body?.cancel(); return new Response(null, { headers }); }
            return previews.capture(source, requestData, new Response(response.body, { status: response.status, headers }));
        } catch { return new Response(null, { status: 404 }); }
    }
    async function close() {
        lifetime.abort();
        for (const controller of browsing.values()) controller.abort();
        for (const job of jobs.values()) job.controller.abort();
        await Promise.allSettled([...jobs.values()].map(job => job.done));
        await files.close();
        await Promise.allSettled([...assets].map(([handle, asset]) => release(asset.owner, handle)));
        await previews.close();
        entries.clear(); searches.clear(); token = undefined;
    }
    return { search, prepare, resolve, release, cancel, serve, close };
}

module.exports = { createRedgifs, MAX_BYTES };
