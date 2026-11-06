const { randomBytes } = require('node:crypto');
const { mkdtemp, open, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createMediaCache } = require('./media-cache.cjs');
const { muxToFile } = require('./mp4-mux.cjs');
const { compressVideo } = require('./video-compress.cjs');

// Reddit browsing for the composer picker. Listings are read with the Reddit
// session (`fetchAccount`), so a signed-in user sees their own feed, saved
// posts and mature-content preference; Discord credentials are never sent.
// Media is fetched from Reddit's and Imgur's CDNs without cookies and reaches
// the page only as opaque `lowcord-media://reddit/<token>` URLs.
// Signed out, Reddit refuses anonymous listings except on api.reddit.com for
// the agent Discord's embeds use, as the social post cards already read it.
const bot = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const MAX_BYTES = 20_000_000;
const sourceLimit = 256 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const mediaHosts = /^(?:v\.redd\.it|i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it|[ab]\.thumbs\.redditmedia\.com|i\.imgur\.com)$/;
const mediaURL = value => {
    try {
        const url = new URL(String(value ?? '').replace(/&amp;/g, '&'));
        return url.protocol === 'https:' && mediaHosts.test(url.hostname) && !url.username && !url.password && !url.port ? url.href : null;
    } catch { return null; }
};
const subredditName = value => typeof value === 'string' && /^[a-z0-9_]{2,21}$/i.test(value);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const text = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const sorts = ['hot', 'new', 'top', 'rising'], times = ['day', 'week', 'month', 'year', 'all'];
const fileTypes = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4' };
function sniff(data) {
    const ascii = (start, end) => data.subarray(start, end).toString('latin1');
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
    if (ascii(0, 4) === 'GIF8') return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(4, 8) === 'ftyp') return 'video/mp4';
    return null;
}

// The post's own media, largest first, as URLs on the allowed CDNs.
function mediaOf(post) {
    const source = post.crosspost_parent_list?.[0] ?? post;
    const preview = source.preview?.images?.[0];
    const resolutions = [...(preview?.resolutions ?? [])].reverse();
    const poster = mediaURL(resolutions.find(item => item.width <= 640)?.url ?? preview?.source?.url ?? source.thumbnail);
    const size = { width: number(preview?.source?.width), height: number(preview?.source?.height) };
    const smaller = [preview?.source, ...resolutions].map(item => mediaURL(item?.url)).filter(Boolean);
    const link = (() => { try { return new URL(source.url_overridden_by_dest ?? source.url ?? ''); } catch { return null; } })();
    const redgifs = link && /(?:^|\.)redgifs\.com$/.test(link.hostname)
        ? /^\/(?:watch|ifr|i)\/([a-z0-9]{1,100})/i.exec(link.pathname)?.[1]?.toLowerCase() : null;
    if (redgifs) return { kind: 'redgifs', redgifs, poster, ...size };
    if (source.gallery_data?.items && source.media_metadata) {
        // Up to Reddit's 20 per gallery; the page picks at most 10 to send.
        // Each item also has a screen-sized view and a thumbnail for picking.
        const files = source.gallery_data.items.slice(0, 20).map(entry => {
            const item = source.media_metadata[entry.media_id];
            if (item?.status !== 'valid' || !item.s) return null;
            const sizes = [...(item.p ?? [])].reverse();
            const thumb = mediaURL(sizes.find(x => x.x <= 320)?.u ?? sizes.at(-1)?.u);
            const shape = { thumb, width: number(item.s.x), height: number(item.s.y) };
            if (item.e === 'AnimatedImage') {
                const clip = mediaURL(item.s.mp4), gif = mediaURL(item.s.gif);
                return clip ? { video: clip, view: clip, type: 'video', ...shape } : gif && { images: [gif], view: gif, type: 'image', animated: true, ...shape };
            }
            const images = [item.s.u, ...sizes.map(x => x.u)].map(mediaURL).filter(Boolean);
            const view = mediaURL(sizes.find(x => x.x <= 1080)?.u) ?? images[0];
            return images.length ? { images, view, type: 'image', ...shape } : null;
        }).filter(Boolean);
        const first = source.media_metadata[source.gallery_data.items[0]?.media_id];
        const cover = mediaURL([...(first?.p ?? [])].reverse().find(item => item.x <= 640)?.u ?? first?.s?.u);
        return files.length ? { kind: 'gallery', files, poster: cover ?? poster, count: files.length,
            animated: files.filter(file => file.type === 'video' || file.animated).length,
            width: number(first?.s?.x), height: number(first?.s?.y) } : null;
    }
    const clip = source.secure_media?.reddit_video ?? source.media?.reddit_video ?? source.preview?.reddit_video_preview;
    const fallback = mediaURL(clip?.fallback_url);
    if (fallback && /^https:\/\/v\.redd\.it\/\w+\//.test(fallback)) {
        return { kind: clip.is_gif ? 'gif' : 'video', dash: fallback, audio: clip.has_audio !== false && !clip.is_gif,
            preview: fallback, poster, duration: number(clip.duration),
            width: number(clip.width) ?? size.width, height: number(clip.height) ?? size.height };
    }
    if (link?.hostname === 'i.imgur.com' && /^\/\w+\.(?:gifv|mp4)$/.test(link.pathname)) {
        const video = `https://i.imgur.com${link.pathname.replace(/\.gifv$/, '.mp4')}`;
        return { kind: 'gif', video, preview: video, poster, ...size };
    }
    const direct = mediaURL(link?.href);
    if (direct && /\.gif$/i.test(link.pathname)) {
        const mp4 = mediaURL(preview?.variants?.mp4?.source?.url);
        return { kind: 'gif', images: [direct], ...(mp4 ? { video: mp4, preview: mp4 } : {}), poster, ...size };
    }
    if (direct && (source.post_hint === 'image' || /\.(?:jpe?g|png|webp)$/i.test(link.pathname))) {
        return { kind: 'image', images: [...new Set([direct, ...smaller])], poster: poster ?? direct, ...size };
    }
    return null;
}

function createReddit({ fetchAccount = fetch, fetchMedia = fetch, compress = compressVideo, mux = muxToFile, tempRoot = tmpdir() } = {}) {
    const entries = new Map(), jobs = new Map(), browsing = new Map(), assets = new Map(), listings = new Map();
    const lifetime = new AbortController();
    const files = createMediaCache({ directory: tempRoot });
    let me;
    const signalFor = (signal, timeout) => AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
    const media = (url, signal, headers = {}) => fetchMedia(url, { headers, credentials: 'omit', redirect: 'follow',
        signal: signalFor(signal, signal ? 120_000 : 15_000) });
    async function read(response, limit) {
        if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fail('too-large'); }
        const parts = []; let size = 0;
        for await (const part of response.body) {
            size += part.length;
            if (size > limit) throw fail('too-large');
            parts.push(part);
        }
        return Buffer.concat(parts);
    }
    async function json(path, signal, signedIn = Boolean(me)) {
        const response = signedIn ? await fetchAccount(`https://www.reddit.com${path}`, { headers: { accept: 'application/json' },
            redirect: 'follow', signal: signalFor(signal, 15_000) })
            : await fetchMedia(`https://api.reddit.com${path.replace(/\.json(?=\?|$)/, '')}`, { headers: { accept: 'application/json', 'user-agent': bot },
                credentials: 'omit', redirect: 'follow', signal: signalFor(signal, 15_000) });
        if (!response.ok) {
            await response.body?.cancel();
            throw fail(response.status === 429 ? 'rate-limited' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : `http-${response.status}`);
        }
        if (!/json/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw fail('invalid-response'); }
        return JSON.parse((await read(response, 4 * 1024 * 1024)).toString('utf8'));
    }
    async function account(refresh = false) {
        if (me !== undefined && !refresh) return me;
        try {
            const result = await json('/api/me.json?raw_json=1', undefined, true);
            const data = result?.data ?? result;
            me = typeof data?.name === 'string' && /^[\w-]{1,30}$/.test(data.name)
                ? { name: data.name, nsfw: data.over_18 === true } : null;
        } catch (error) { if (error.code !== 'forbidden') throw error; me = null; }
        listings.clear();
        return me;
    }
    function signedOut() { me = null; listings.clear(); for (const controller of browsing.values()) controller.abort(); }
    let nextExpiry = Infinity;
    function mint(post, owner) {
        if (!post || typeof post.id !== 'string' || !/^\w{1,16}$/.test(post.id) || post.removed_by_category) return null;
        const found = mediaOf(post);
        if (!found) return null;
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
        const expires = now + 30 * 60_000;
        entries.set(key, { ...found, owner, id: post.id, expires });
        nextExpiry = Math.min(nextExpiry, expires);
        return { key, id: post.id, kind: found.kind, title: text(post.title, 300), subreddit: text(post.subreddit, 30),
            author: text(post.author, 30), nsfw: post.over_18 === true, spoiler: post.spoiler === true,
            score: Number.isFinite(post.score) ? post.score : null, comments: number(post.num_comments),
            count: found.count ?? null, animated: found.animated ?? null, duration: found.duration ?? null,
            ...(found.files ? { items: found.files.map((file, index) => ({ index, type: file.type, animated: file.type === 'video' || file.animated === true,
                src: `lowcord-media://reddit/${key}/item/${index}`, thumb: file.thumb ? `lowcord-media://reddit/${key}/thumb/${index}` : null,
                width: file.width, height: file.height })) } : {}),
            // A GIF without Reddit's MP4 of it animates as an image instead.
            ...(found.kind === 'gif' && !found.preview && found.images ? { animation: `lowcord-media://reddit/${key}/item/0` } : {}), width: found.width ?? null, height: found.height ?? null,
            ...(found.redgifs ? { redgifs: found.redgifs } : {}),
            preview: found.preview ? `lowcord-media://reddit/${key}/video` : null,
            poster: found.poster ? `lowcord-media://reddit/${key}/poster` : null };
    }
    async function search(owner, query = '', after = null, options = {}) {
        if (typeof query !== 'string' || query.length > 200 || (after != null && (typeof after !== 'string' || !/^t[35]_\w{1,16}$/.test(after)))) throw fail('invalid-search');
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('invalid-search');
        const mode = options.mode ?? 'home', subreddit = options.subreddit ?? null, sort = options.sort ?? 'hot', time = options.time ?? 'week';
        if (!['home', 'popular', 'subreddits', 'saved'].includes(mode) || !sorts.includes(sort) || !times.includes(time)
            || (subreddit != null && !subredditName(subreddit))) throw fail('invalid-search');
        browsing.get(owner)?.abort();
        const controller = new AbortController(); browsing.set(owner, controller);
        try {
            const user = await account();
            const q = query.trim();
            const params = new URLSearchParams({ limit: '25', raw_json: '1' });
            if (after) params.set('after', after);
            let endpoint;
            if (mode === 'subreddits' && !subreddit) {
                if (q) { params.set('q', q); params.set('include_over_18', 'on'); endpoint = '/subreddits/search.json'; }
                else if (user) { params.set('limit', '100'); endpoint = '/subreddits/mine/subscriber.json'; }
                else endpoint = '/subreddits/popular.json';
            } else if (mode === 'saved' && !subreddit) {
                if (!user) throw fail('signed-out');
                params.set('type', 'links');
                endpoint = `/user/${encodeURIComponent(user.name)}/saved.json`;
            } else if (q) {
                params.set('q', q); params.set('sort', sort === 'rising' ? 'hot' : sort); params.set('t', time);
                params.set('include_over_18', 'on'); params.set('type', 'link');
                if (subreddit) params.set('restrict_sr', '1');
                endpoint = subreddit ? `/r/${subreddit}/search.json` : '/search.json';
            } else {
                if (sort === 'top') params.set('t', time);
                endpoint = subreddit ? `/r/${subreddit}/${sort}.json` : mode === 'home' && user ? `/${sort === 'hot' ? 'best' : sort}.json` : `/r/popular/${sort}.json`;
            }
            const cacheKey = `${endpoint}?${params}`;
            let cached = listings.get(cacheKey);
            if (!cached || cached.expires < Date.now()) cached = { result: await json(cacheKey, controller.signal), expires: Date.now() + 60_000 };
            controller.signal.throwIfAborted();
            listings.delete(cacheKey); listings.set(cacheKey, cached);
            while (listings.size > 8) listings.delete(listings.keys().next().value);
            const children = cached.result?.data?.children;
            if (!Array.isArray(children)) throw fail('invalid-response');
            const next = typeof cached.result.data.after === 'string' && /^t[35]_\w{1,16}$/.test(cached.result.data.after) ? cached.result.data.after : null;
            if (mode === 'subreddits' && !subreddit) {
                const communities = children.map(child => child?.data).filter(data => data && subredditName(data.display_name) && data.subreddit_type !== 'user')
                    .slice(0, 100).map(data => ({ id: data.display_name, name: `r/${data.display_name}`,
                        title: text(data.title, 160), subscribers: number(data.subscribers), nsfw: data.over18 === true }));
                return { communities, after: next, account: user };
            }
            // Reddit has no search of saved posts; filter each page by its text.
            const needle = mode === 'saved' && !subreddit && q ? q.toLowerCase() : null;
            const items = children.filter(child => child?.kind === 't3' && (!needle
                || `${child.data?.title} ${child.data?.subreddit}`.toLowerCase().includes(needle))).map(child => mint(child.data, owner)).filter(Boolean);
            return { items, after: next, account: user };
        } finally { if (browsing.get(owner) === controller) browsing.delete(owner); }
    }
    const entryFor = (key, owner) => {
        const entry = typeof key === 'string' && entries.get(key);
        if (!entry || entry.expires < Date.now() || (owner !== undefined && entry.owner !== owner)) throw fail('expired');
        return entry;
    };
    async function download(url, path, limit, signal) {
        const response = await media(url, signal);
        if (!response.ok) { await response.body?.cancel(); throw fail(`http-${response.status}`); }
        if (!mediaURL(response.url || url)) { await response.body?.cancel(); throw fail('invalid-media'); }
        if (Number(response.headers.get('content-length')) >= limit) { await response.body?.cancel(); throw fail('too-large'); }
        const file = await open(path, 'wx', 0o600);
        try {
            let size = 0;
            for await (const part of response.body) {
                signal.throwIfAborted(); size += part.length;
                if (size >= limit) throw fail('too-large');
                await file.writeFile(part);
            }
            if (size < 12) throw fail('invalid-media');
            return size;
        } finally { await file.close(); }
    }
    async function head(url, signal) {
        const response = await media(url, signal).catch(() => null);
        // A GET whose body is cancelled after the headers: the CDN answers
        // HEAD inconsistently, and only the declared length is read.
        await response?.body?.cancel().catch(() => {});
        return response?.ok ? Number(response.headers.get('content-length')) || null : null;
    }
    // Reddit video and audio are separate DASH streams, listed in the manifest.
    async function streams(fallback, signal) {
        const folder = /^(https:\/\/v\.redd\.it\/\w+)\//.exec(fallback)[1];
        let names = [];
        try {
            const response = await media(`${folder}/DASHPlaylist.mpd`, signal);
            if (response.ok) names = [...(await read(response, 512 * 1024)).toString('utf8').matchAll(/<BaseURL>([\w.-]+)<\/BaseURL>/g)].map(match => match[1]);
            else await response.body?.cancel();
        } catch (error) { if (signal.aborted) throw error; }
        const height = name => Number(/_(\d+)(?:\.mp4)?$/.exec(name)?.[1]) || 0;
        const videos = names.filter(name => !/audio/i.test(name)).sort((a, b) => height(b) - height(a));
        if (!videos.length) videos.push(/\/([\w.-]+\.mp4)/.exec(new URL(fallback).pathname)?.[1] ?? 'DASH_480.mp4');
        const audio = names.filter(name => /audio/i.test(name)).sort((a, b) => height(b) - height(a))[0];
        return { videos: videos.map(name => `${folder}/${name}`), audio: audio ? `${folder}/${audio}` : null };
    }
    async function finishVideo(path, directory, limit, signal) {
        let output = path, quality = 'Original';
        if ((await stat(path)).size >= limit) { output = await compress(path, directory, limit, signal); quality = 'Compressed'; }
        return { path: output, quality };
    }
    async function redditVideo(entry, directory, limit, signal) {
        const { videos, audio } = await streams(entry.dash, signal);
        const sound = entry.audio && audio;
        const sizes = await Promise.all([sound ? head(audio, signal) : 0, ...videos.map(url => head(url, signal))]);
        const audioSize = sizes.shift() ?? 0;
        // Best quality that fits as-is; otherwise the smallest, compressed.
        // Without declared sizes, take the best and compress if it is over.
        const fits = videos.findIndex((url, i) => sizes[i] && sizes[i] + audioSize < limit * 0.98);
        const index = fits >= 0 ? fits : sizes.some(Boolean) ? videos.length - 1 : 0;
        const choice = videos[index];
        const video = join(directory, 'video.mp4'), track = join(directory, 'audio.mp4'), joined = join(directory, 'joined.mp4');
        await download(choice, video, sourceLimit, signal);
        let path = video;
        if (sound) {
            try {
                await download(audio, track, sourceLimit, signal);
                await mux(video, track, joined, { signal }); path = joined;
            } catch (error) { if (signal.aborted) throw error; }
        }
        const result = await finishVideo(path, directory, limit, signal);
        if (result.quality === 'Original') result.quality = index === 0 ? 'HD' : 'SD';
        return [{ path: result.path, type: 'video/mp4', ext: 'mp4', quality: result.quality }];
    }
    async function image(urls, path, limit, signal) {
        for (const [index, url] of urls.entries()) {
            try {
                const size = await download(url, path, limit, signal);
                const file = await open(path, 'r'), signature = Buffer.alloc(12);
                try { await file.read(signature, 0, 12, 0); } finally { await file.close(); }
                const type = sniff(signature);
                if (!type || type === 'video/mp4') throw fail('invalid-media');
                return { path, size, type, ext: fileTypes[type], quality: index ? 'Resized' : 'Original' };
            } catch (error) {
                await rm(path, { force: true });
                if (signal.aborted || error.code !== 'too-large' || index === urls.length - 1) throw error;
            }
        }
        throw fail('invalid-media');
    }
    async function clip(url, directory, name, limit, signal) {
        const path = join(directory, `${name}.mp4`);
        await download(url, path, sourceLimit, signal);
        const result = await finishVideo(path, directory, limit, signal);
        return { path: result.path, type: 'video/mp4', ext: 'mp4', quality: result.quality };
    }
    async function prepare(owner, key, requestedLimit, selection) {
        const entry = entryFor(key, owner);
        if (entry.kind === 'redgifs') throw fail('redgifs');
        if (!Number.isFinite(requestedLimit) || requestedLimit < 1024) throw fail('invalid-limit');
        // Gallery items to send, in gallery order; at most Discord's ten.
        const picked = entry.kind !== 'gallery' ? null : selection == null ? entry.files.slice(0, 10).map((_file, index) => index)
            : Array.isArray(selection) && selection.length >= 1 && selection.length <= 10
                && selection.every(index => Number.isInteger(index) && index >= 0 && index < entry.files.length)
                && new Set(selection).size === selection.length ? [...selection].sort((a, b) => a - b) : null;
        if (entry.kind === 'gallery' && !picked) throw fail('invalid-selection');
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
                directory = await mkdtemp(join(tempRoot, 'orbitcord-reddit-'));
                let outputs;
                if (entry.dash) outputs = await redditVideo(entry, directory, limit, signal);
                else if (entry.kind === 'gallery') {
                    // One at a time: a gallery of large videos never encodes in parallel.
                    outputs = [];
                    for (const index of picked) {
                        const file = entry.files[index];
                        outputs.push({ ...(file.video ? await clip(file.video, directory, `item-${index}`, limit, signal)
                            : await image(file.images, join(directory, `item-${index}`), limit, signal)), number: index + 1 });
                    }
                } else if (entry.kind === 'gif' && entry.images) {
                    // A GIF that fits is sent as itself; otherwise Reddit's MP4 of it.
                    try { outputs = [await image(entry.images, join(directory, 'image'), limit, signal)]; }
                    catch (error) { if (signal.aborted || error.code !== 'too-large' || !entry.video) throw error; outputs = [await clip(entry.video, directory, 'clip', limit, signal)]; }
                } else if (entry.video) outputs = [await clip(entry.video, directory, 'clip', limit, signal)];
                else outputs = [await image(entry.images, join(directory, 'image'), limit, signal)];
                signal.throwIfAborted();
                const handle = randomBytes(18).toString('hex'), prepared = [];
                for (const [index, output] of outputs.entries()) {
                    const size = (await stat(output.path)).size;
                    if (size >= limit || size < 12) throw fail('too-large');
                    prepared.push({ path: output.path, directory, size, readers: 0, evicted: false, type: output.type,
                        name: `reddit-${entry.id}${entry.kind === 'gallery' && entry.files.length > 1 ? `-${output.number}` : ''}.${output.ext}`, quality: output.quality });
                }
                assets.set(handle, { owner, directory, files: prepared });
                directory = undefined; // Owned until release/cancellation/window teardown.
                return { handle, files: prepared.map((file, index) => ({ url: `lowcord-media://reddit/${handle}/prepared/${index}`,
                    name: file.name, type: file.type, size: file.size })),
                    quality: prepared.some(file => file.quality === 'Compressed') ? 'Compressed' : prepared[0].quality };
            } finally {
                if (directory) await rm(directory, { recursive: true, force: true });
                if (jobs.get(owner) === job) jobs.delete(owner);
            }
        })();
        return job.done;
    }
    async function resolve(owner, id) {
        if (typeof id !== 'string' || !/^\w{1,16}$/.test(id)) throw fail('expired');
        const result = await json(`/by_id/t3_${id}.json?raw_json=1`, lifetime.signal);
        const item = mint(result?.data?.children?.[0]?.data, owner);
        if (!item) throw fail('expired');
        return item;
    }
    async function release(owner, handle) {
        const asset = assets.get(handle);
        if (!asset || asset.owner !== owner) return;
        assets.delete(handle);
        for (const file of asset.files) file.evicted = true;
        if (!asset.files.some(file => file.readers)) await rm(asset.directory, { recursive: true, force: true });
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
            const match = /^\/([a-f0-9]{36})\/(video|poster|prepared\/(\d)|(item|thumb)\/(\d{1,2}))$/.exec(url.pathname);
            if (url.hostname !== 'reddit' || !match || !['GET', 'HEAD'].includes(requestData.method)) return new Response(null, { status: 404 });
            if (match[3] !== undefined) {
                const file = assets.get(match[1])?.files[Number(match[3])];
                if (!file) return new Response(null, { status: 404 });
                const response = files.response(file, requestData);
                response.headers.set('content-type', file.type);
                response.headers.set('access-control-allow-origin', '*');
                response.headers.set('cache-control', 'no-store');
                return response;
            }
            const entry = entryFor(match[1]);
            const part = match[4] && (entry.files?.[Number(match[5])] ?? (entry.images && match[5] === '0' ? { view: entry.images[0] } : null));
            const source = match[2] === 'poster' ? entry.poster : match[4] === 'item' ? part?.view : match[4] === 'thumb' ? part?.thumb : entry.preview;
            if (!source) return new Response(null, { status: 404 });
            const range = requestData.headers.get('range');
            if (range && !/^bytes=\d+-\d*$/.test(range)) return new Response(null, { status: 416 });
            const response = await media(source, requestData.signal, range ? { range } : {});
            const type = response.headers.get('content-type') ?? '';
            if (![200, 206].includes(response.status) || !mediaURL(response.url || source)
                || !/^(video\/mp4|image\/(jpeg|png|webp|gif))(?:;|$)/i.test(type)) {
                await response.body?.cancel(); return new Response(null, { status: 502 });
            }
            const headers = new Headers({ 'content-type': type, 'cache-control': 'private, max-age=600', 'access-control-allow-origin': 'https://discord.com' });
            for (const name of ['content-length', 'content-range', 'accept-ranges']) {
                const value = response.headers.get(name); if (value) headers.set(name, value);
            }
            if (requestData.method === 'HEAD') { await response.body?.cancel(); return new Response(null, { headers }); }
            return new Response(response.body, { status: response.status, headers });
        } catch { return new Response(null, { status: 404 }); }
    }
    async function close() {
        lifetime.abort();
        for (const controller of browsing.values()) controller.abort();
        for (const job of jobs.values()) job.controller.abort();
        await Promise.allSettled([...jobs.values()].map(job => job.done));
        await files.close();
        await Promise.allSettled([...assets].map(([handle, asset]) => release(asset.owner, handle)));
        entries.clear(); listings.clear();
    }
    return { account, signedOut, search, prepare, resolve, release, cancel, serve, close };
}

module.exports = { createReddit, mediaOf, MAX_BYTES };
