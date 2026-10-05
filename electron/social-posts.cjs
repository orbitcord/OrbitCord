const { randomBytes } = require('node:crypto');
const links = require('./social-links.cjs');
const { mux } = require('./mp4-mux.cjs');

// Reads public post data for OrbitCord's social cards and video uploads.
// Requests never carry Discord credentials, cookies or message text.
// Media is served to the page through `lowcord-media://media/<token>`, where
// each token was minted here for a URL taken from the post's own data.
const scheme = 'lowcord-media';
const bot = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const browser = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function createSocialPosts(fetchPage = fetch) {
    const posts = new Map(), pending = new Map(), media = new Map(), muxed = new Map();

    async function request(url, { headers = {}, timeout = 6000, method = 'GET', redirect = 'follow', signal } = {}) {
        const response = await fetchPage(url, { method, redirect, credentials: 'omit',
            headers: { 'user-agent': bot, ...headers }, signal: signal ?? AbortSignal.timeout(timeout) });
        return response;
    }
    async function read(response, limit) {
        const declared = Number(response.headers.get('content-length'));
        if (declared > limit) { await response.body?.cancel().catch(() => {}); throw Object.assign(new Error('Too large'), { code: 'too-large' }); }
        const reader = response.body.getReader(), parts = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel().catch(() => {}); throw Object.assign(new Error('Too large'), { code: 'too-large' }); }
            parts.push(value);
        }
        return Buffer.concat(parts);
    }
    async function json(url, options) {
        const response = await request(url, { ...options, headers: { accept: 'application/json', ...options?.headers } });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`); }
        return JSON.parse((await read(response, 4 * 1024 * 1024)).toString('utf8'));
    }
    // With `redirect: 'manual'`, a redirect answers `{ location }` instead.
    async function page(url, { redirect = 'follow' } = {}) {
        const response = await request(url, { redirect, headers: { accept: 'text/html' } });
        if (redirect === 'manual' && response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => {});
            return { location: absolute(response.headers.get('location'), url), url };
        }
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
            await response.body?.cancel().catch(() => {});
            throw new Error(`HTTP ${response.status}`);
        }
        return { html: (await read(response, 768 * 1024)).toString('utf8'), url: response.url || url };
    }

    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const decode = value => value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name) => name[0] === '#'
        ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
        : entities[name.toLowerCase()] ?? whole);
    // Every value of each meta property, in document order.
    function metadata(html) {
        const values = new Map();
        for (const [tag] of html.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
            const attribute = name => {
                const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
                return match ? decode(match[1] ?? match[2]) : null;
            };
            const key = (attribute('property') ?? attribute('name') ?? (tag.toLowerCase().startsWith('<link') ? `link:${attribute('rel')}` : null))?.toLowerCase();
            const value = attribute('content') ?? attribute('href');
            if (!key || value == null) continue;
            if (!values.has(key)) values.set(key, []);
            values.get(key).push(value);
        }
        // Some providers emit an empty tag before the real one.
        return { get: key => values.get(key)?.find(value => value.trim()) ?? values.get(key)?.[0] ?? null, all: key => values.get(key) ?? [] };
    }

    function proxy(source) {
        if (!source) return null;
        if (typeof source === 'string') {
            let url;
            try { url = new URL(source); } catch { return null; }
            if (url.protocol !== 'https:' || url.username || url.password) return null;
            source = { url: url.href };
        }
        const token = randomBytes(12).toString('hex');
        if (media.size >= 4000) media.delete(media.keys().next().value);
        media.set(token, source);
        return `${scheme}://media/${token}`;
    }
    const absolute = (value, base) => { try { return value ? new URL(value, base).href : null; } catch { return null; } };
    const text = (value, limit = 1200) => {
        const clean = String(value ?? '').replace(/\r\n?/g, '\n').trim();
        return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
    };
    const number = value => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null;
    const image = (url, extra = {}) => { const src = proxy(url); return src ? { type: 'image', src, ...extra } : null; };
    const video = (url, poster, extra = {}) => { const src = proxy(url); return src ? { type: 'video', src, poster: proxy(poster), ...extra } : null; };
    const base = (target, fields) => ({ site: target.site, service: links.sites[target.site].name, color: links.sites[target.site].color,
        url: target.canonical, author: {}, text: '', stats: {}, media: [], sensitive: false, ...fields,
        media: (fields.media ?? []).filter(Boolean).slice(0, 20) });

    async function twitter(target) {
        const id = /\/status\/(\d+)/.exec(target.path)?.[1];
        const { tweet } = await json(`https://api.fxtwitter.com/status/${id}`);
        if (!tweet) throw new Error('Post not found');
        const items = tweet.media?.all ?? [...(tweet.media?.photos ?? []), ...(tweet.media?.videos ?? [])];
        return base(target, {
            url: tweet.url ?? target.canonical, text: text(tweet.text),
            author: { name: tweet.author?.name, handle: tweet.author?.screen_name && `@${tweet.author.screen_name}`,
                url: tweet.author?.url, avatar: proxy(tweet.author?.avatar_url) },
            created: tweet.created_timestamp ? tweet.created_timestamp * 1000 : null,
            stats: { replies: number(tweet.replies), reposts: number(tweet.retweets), likes: number(tweet.likes), views: number(tweet.views) },
            sensitive: Boolean(tweet.possibly_sensitive),
            media: items.map(item => item.type === 'photo'
                ? image(item.url, { width: item.width, height: item.height, alt: item.altText })
                : video(item.url, item.thumbnail_url, { width: item.width, height: item.height, ...(item.type === 'gif' ? { loop: true, gif: true } : {}) })),
        });
    }

    async function blueskyBlob(did, cid) {
        let document;
        if (did.startsWith('did:plc:')) document = await json(`https://plc.directory/${encodeURIComponent(did)}`);
        else if (/^did:web:[\w.-]+$/.test(did)) document = await json(`https://${did.slice(8)}/.well-known/did.json`);
        const endpoint = document?.service?.find(service => service.id?.endsWith('#atproto_pds'))?.serviceEndpoint;
        if (!/^https:\/\//.test(endpoint ?? '')) return null;
        return `${endpoint.replace(/\/$/, '')}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
    }
    async function bluesky(target) {
        const [, actor, rkey] = /^\/profile\/([^/]+)\/post\/(\w+)/.exec(target.path);
        const { thread } = await json(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${actor}/app.bsky.feed.post/${rkey}`)}&depth=0&parentHeight=0`);
        const post = thread?.post;
        if (!post) throw new Error('Post not found');
        let embed = post.embed;
        if (embed?.$type === 'app.bsky.embed.recordWithMedia#view') embed = embed.media;
        const ratio = item => item.aspectRatio ? { width: item.aspectRatio.width, height: item.aspectRatio.height } : {};
        let items = [];
        if (embed?.$type === 'app.bsky.embed.images#view') items = embed.images.map(item => image(item.fullsize, { alt: item.alt, ...ratio(item) }));
        else if (embed?.$type === 'app.bsky.embed.video#view') {
            const blob = embed.cid ? await blueskyBlob(post.author.did, embed.cid).catch(() => null) : null;
            items = [blob ? video(blob, embed.thumbnail, ratio(embed)) : image(embed.thumbnail, ratio(embed))];
        } else if (embed?.$type === 'app.bsky.embed.external#view' && embed.external?.thumb) items = [image(embed.external.thumb)];
        const labels = [...(post.labels ?? []), ...(post.author?.labels ?? [])].map(label => label.val);
        return base(target, {
            url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`, text: text(post.record?.text),
            author: { name: post.author.displayName || post.author.handle, handle: `@${post.author.handle}`,
                url: `https://bsky.app/profile/${post.author.handle}`, avatar: proxy(post.author.avatar) },
            created: Date.parse(post.record?.createdAt) || null,
            stats: { replies: number(post.replyCount), reposts: number(post.repostCount), likes: number(post.likeCount) },
            sensitive: labels.some(label => ['porn', 'sexual', 'nudity', 'graphic-media', 'gore'].includes(label)), media: items,
        });
    }

    // Share links (/r/sub/s/code) redirect to the post they name.
    async function redditId(target) {
        let path = target.path;
        if (/^\/r\/\w+\/s\//.test(path)) {
            const response = await request(`https://www.reddit.com${path}`, { redirect: 'manual', headers: { 'user-agent': browser } });
            await response.body?.cancel().catch(() => {});
            const next = links.parse(absolute(response.headers.get('location'), 'https://www.reddit.com') ?? '');
            if (next?.site !== 'reddit') throw new Error('Share link not found');
            path = next.path;
        }
        const id = /\/comments\/(\w+)/.exec(path)?.[1];
        if (!id) throw new Error('Post not found');
        return id;
    }
    async function redditPost(target) {
        const id = await redditId(target);
        const listing = await json(`https://api.reddit.com/comments/${id}?raw_json=1&limit=1&depth=1`);
        const post = listing?.[0]?.data?.children?.[0]?.data;
        if (!post) throw new Error('Post not found');
        return { id, post, source: post.crosspost_parent_list?.[0] ?? post };
    }
    const redditVideoOf = source => source.secure_media?.reddit_video ?? source.media?.reddit_video
        ?? source.preview?.reddit_video_preview ?? null;
    async function reddit(target) {
        const { post, source } = await redditPost(target);
        const about = await json(`https://api.reddit.com/r/${post.subreddit}/about?raw_json=1`, { timeout: 2500 }).catch(() => null);
        const icon = about?.data?.community_icon || about?.data?.icon_img;
        const poster = source.preview?.images?.[0]?.source?.url;
        let items = [];
        if (source.gallery_data?.items && source.media_metadata) {
            items = source.gallery_data.items.map(entry => {
                const item = source.media_metadata[entry.media_id];
                if (item?.status !== 'valid' || !item.s) return null;
                const size = { width: item.s.x, height: item.s.y, alt: entry.caption };
                if (item.e === 'AnimatedImage') return item.s.mp4 ? video(item.s.mp4, item.p?.at(-1)?.u, { ...size, loop: true, gif: true }) : image(item.s.gif, size);
                return image(item.s.u, size);
            });
        } else {
            const clip = redditVideoOf(source);
            if (clip?.fallback_url) {
                const sound = clip.has_audio !== false && !clip.is_gif;
                const src = proxy(sound ? { reddit: clip.fallback_url } : clip.fallback_url);
                if (src) items = [{ type: 'video', src, poster: proxy(poster), width: clip.width, height: clip.height, ...(clip.is_gif ? { loop: true, gif: true } : {}) }];
            } else if (source.post_hint === 'image' || /^https:\/\/i\.redd\.it\//.test(source.url ?? '')) {
                items = [image(source.url, { width: source.preview?.images?.[0]?.source?.width, height: source.preview?.images?.[0]?.source?.height })];
            } else if (poster) items = [image(poster)];
        }
        return base(target, {
            url: `https://www.reddit.com${post.permalink}`, title: text(post.title, 300), text: text(post.selftext, 600),
            author: { name: post.subreddit_name_prefixed, handle: `u/${post.author}`,
                url: `https://www.reddit.com/${post.subreddit_name_prefixed}`, avatar: proxy(icon) },
            created: post.created_utc ? post.created_utc * 1000 : null,
            stats: { score: number(post.score), comments: number(post.num_comments) },
            sensitive: Boolean(post.over_18), spoiler: Boolean(post.spoiler), media: items,
        });
    }

    // Open Graph data from a fix provider; used where no public API exists.
    function fromMeta(target, meta, address, extra = {}) {
        const videos = [...meta.all('og:video:secure_url'), ...meta.all('og:video'), ...meta.all('twitter:player:stream')]
            .map(value => absolute(value, address)).filter(Boolean);
        const images = [...new Set([...meta.all('og:image'), ...meta.all('twitter:image')].map(value => absolute(value, address)).filter(Boolean))];
        const title = meta.get('og:title') ?? meta.get('twitter:title');
        const handle = /\((@[\w.]+)\)\s*$/.exec(title ?? '')?.[1] ?? meta.get('twitter:creator');
        return base(target, {
            text: text(meta.get('og:description') ?? meta.get('description')),
            author: { name: title?.replace(/\s*\(@[\w.]+\)\s*$/, '') ?? links.sites[target.site].name, handle,
                avatar: proxy(absolute(meta.get('link:apple-touch-icon'), address)) },
            created: Date.parse(meta.get('article:published_time')) || null,
            media: videos.length ? [video(videos[0], images[0], { width: number(meta.get('og:video:width')), height: number(meta.get('og:video:height')) })]
                : images.slice(0, 20).map(url => image(url, images.length === 1 ? { width: number(meta.get('og:image:width')), height: number(meta.get('og:image:height')) } : {})),
            ...extra,
        });
    }
    async function generic(target) {
        let last;
        for (const host of links.providers[target.site]) {
            try {
                const { html, url } = await page(`https://${host}${target.path}`);
                const meta = metadata(html);
                const post = fromMeta(target, meta, url);
                if (post.media.length || meta.get('og:description')) return post;
            } catch (error) { last = error; }
        }
        throw last ?? new Error('No preview available');
    }

    // InstaFix-style descriptions start with a stats line, e.g.
    // "❤️ 54.0K · 💬 143 · 🖼️ 1/12", then the caption.
    const amount = value => {
        const match = /^([\d.,]+)\s*([KMB])?$/i.exec(value?.trim() ?? '');
        if (!match) return null;
        const base = Number(match[2] ? match[1].replace(/,/g, '.') : match[1].replace(/[.,]/g, ''));
        return Number.isFinite(base) ? Math.round(base * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase()] ?? 1)) : null;
    };
    function instagramMeta(meta) {
        const description = meta.get('og:description') ?? meta.get('description') ?? '';
        const [first, ...rest] = description.split('\n');
        const stats = /❤|💬|🖼/.test(first ?? '') ? first : null;
        const caption = (stats ? rest.join('\n') : description).trim() || meta.get('og:image:alt') || '';
        return { text: text(caption), count: Number(/🖼️?\s*\d+\s*\/\s*(\d+)/u.exec(stats ?? '')?.[1]) || 1,
            stats: { likes: amount(/❤️?\s*([\d.,]+[KMB]?)/iu.exec(stats ?? '')?.[1]), comments: amount(/💬\s*([\d.,]+[KMB]?)/iu.exec(stats ?? '')?.[1]) } };
    }
    // OGInstagram (zzinstagram) answers a past-the-end img_index with the
    // last item, and gives video slides as og:video. Photo slides redirect
    // straight to the image instead. InstaFix (hhinstagram) has the caption,
    // stats and slide count, and serves each photo slide by index.
    const instagramImage = location => { try { return /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(new URL(location).hostname) && location; } catch { return null; } };
    async function instagram(target) {
        const code = /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(target.path)?.[1];
        if (!code) return generic(target);
        const fixed = page(`https://hhinstagram.com/p/${code}/`).then(({ html, url }) => ({ meta: metadata(html), url })).catch(() => null);
        const finish = (post, meta) => {
            const info = instagramMeta(meta);
            return { ...post, text: info.text, stats: info.stats, url: `https://www.instagram.com/p/${code}/` };
        };
        try {
            const entry = async index => {
                const { html, url, location } = await page(`https://zzinstagram.com/p/${code}/?img_index=${index}`, { redirect: 'manual' });
                if (html == null && !instagramImage(location)) throw new Error('No media');
                return html == null ? { image: location } : { meta: metadata(html), url };
            };
            const [first, last, info] = await Promise.all([entry(1), entry(20), fixed]);
            const count = Math.min(20, Number(/\/offload\/[\w-]+\/(\d+)/.exec(last.meta?.get('og:image') ?? '')?.[1])
                || (info ? instagramMeta(info.meta).count : 1));
            const rest = await Promise.all(Array.from({ length: Math.max(0, count - 2) }, (_, index) => entry(index + 2)));
            const entries = count > 1 ? [first, ...rest, last] : [first];
            const head = first.meta ?? info?.meta ?? metadata('');
            const post = finish(fromMeta(target, head, first.url ?? info?.url), info?.meta ?? head);
            const size = info ? { width: number(info.meta.get('og:image:width')), height: number(info.meta.get('og:image:height')) } : {};
            post.media = entries.map((item, index) => item.image ? image(item.image, index ? {} : size)
                : fromMeta(target, item.meta, item.url).media[0]).filter(Boolean);
            if (!post.media.length) throw new Error('No media');
            return post;
        } catch {}
        try {
            const info = await fixed;
            if (!info) throw new Error('No preview');
            const { meta, url } = info;
            const post = finish(fromMeta(target, meta, url), meta);
            const count = Math.min(20, instagramMeta(meta).count);
            if (count > 1 && !post.media.some(item => item.type === 'video')) {
                const size = { width: number(meta.get('og:image:width')), height: number(meta.get('og:image:height')) };
                post.media = Array.from({ length: count }, (_, index) =>
                    image(`https://hhinstagram.com/proxy/image/${code}?type=p&s=${index + 1}`, index ? {} : size));
            }
            if (post.media.length) return post;
        } catch {}
        return generic(target);
    }

    async function pixiv(target) {
        const id = /artworks\/(\d+)/.exec(target.path)[1];
        const headers = { 'user-agent': browser, referer: 'https://www.pixiv.net/' };
        const [{ body: work }, pages] = await Promise.all([json(`https://www.pixiv.net/ajax/illust/${id}`, { headers }),
            json(`https://www.pixiv.net/ajax/illust/${id}/pages`, { headers }).catch(() => null)]);
        if (!work) throw new Error('Post not found');
        const urls = pages?.body?.map(item => item.urls?.regular).filter(Boolean) ?? [work.urls?.regular];
        return base(target, {
            url: `https://www.pixiv.net/artworks/${id}`, title: text(work.title, 300),
            text: text(decode(String(work.description ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')), 600),
            author: { name: work.userName, url: `https://www.pixiv.net/users/${work.userId}` },
            created: Date.parse(work.createDate) || null,
            stats: { likes: number(work.likeCount), bookmarks: number(work.bookmarkCount), views: number(work.viewCount) },
            sensitive: Number(work.xRestrict) > 0,
            media: urls.slice(0, 20).map(url => image(url && { url, headers: { referer: 'https://www.pixiv.net/' } })),
        });
    }

    const fetchers = { twitter, bluesky, reddit, instagram, pixiv };
    async function get(value) {
        const target = links.parse(value);
        if (!target) throw new Error('Unsupported link');
        const hit = posts.get(target.key);
        if (hit?.until > Date.now()) return hit.value;
        if (pending.has(target.key)) return pending.get(target.key);
        const work = (async () => {
            let value = null;
            try { value = await (fetchers[target.site] ?? generic)(target); } catch {}
            if (posts.size >= 200) posts.delete(posts.keys().next().value);
            posts.set(target.key, { value, until: Date.now() + (value ? 15 * 60_000 : 60_000) });
            return value;
        })().finally(() => pending.delete(target.key));
        pending.set(target.key, work);
        return work;
    }

    // ----- Reddit video: video and audio are separate DASH streams ---------
    async function size(url) {
        const response = await request(url, { method: 'HEAD', timeout: 8000 });
        return response.ok ? Number(response.headers.get('content-length')) || null : null;
    }
    async function redditStreams(fallback) {
        const folder = /^(https:\/\/v\.redd\.it\/\w+)\//.exec(fallback)?.[1];
        if (!folder) throw new Error('Not a Reddit video');
        let names = [];
        try {
            const response = await request(`${folder}/DASHPlaylist.mpd`, { timeout: 6000 });
            if (response.ok) names = [...(await read(response, 512 * 1024)).toString('utf8').matchAll(/<BaseURL>([\w.-]+)<\/BaseURL>/g)].map(match => match[1]);
        } catch {}
        const height = name => Number(/_(\d+)\.mp4$/.exec(name)?.[1]) || 0;
        const videos = names.filter(name => !/audio/i.test(name)).sort((a, b) => height(b) - height(a));
        if (!videos.length) videos.push(/\/([\w.-]+\.mp4)/.exec(new URL(fallback).pathname)[1]);
        const audios = names.filter(name => /audio/i.test(name)).sort((a, b) => height(b) - height(a));
        return { folder, videos: videos.map(name => ({ url: `${folder}/${name}`, height: height(name) })),
            audio: audios.length ? `${folder}/${audios[0]}` : null };
    }
    async function download(url, limit) {
        const response = await request(url, { timeout: 120_000 });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`); }
        return read(response, limit);
    }
    async function combine(streams, choice, limit) {
        const [picture, sound] = await Promise.all([download(choice.url, limit),
            streams.audio ? download(streams.audio, limit).catch(() => null) : null]);
        if (!sound) return picture;
        try { return mux(picture, sound); } catch { return picture; }
    }
    // Picks the best quality whose video plus audio fits in `limit` bytes.
    async function redditVideo(value, limit) {
        const target = links.parse(value);
        if (target?.site !== 'reddit') throw Object.assign(new Error('Not a Reddit link'), { code: 'not-video' });
        if (!Number.isSafeInteger(limit) || limit < 1024 * 1024 || limit > 1024 ** 3) throw new Error('Invalid limit');
        const { id, source } = await redditPost(target);
        const clip = redditVideoOf(source);
        if (!clip?.fallback_url) throw Object.assign(new Error('Not a video post'), { code: 'not-video' });
        const streams = await redditStreams(clip.fallback_url);
        // A GIF is silent, and the page re-encodes it at 480px at most.
        if (clip.has_audio === false || clip.is_gif) streams.audio = null;
        if (clip.is_gif) streams.videos.sort((a, b) => (a.height > 480) - (b.height > 480));
        const [audioSize, ...sizes] = await Promise.all([streams.audio ? size(streams.audio).catch(() => null) : 0,
            ...streams.videos.map(item => size(item.url).catch(() => null))]);
        if (audioSize === null) streams.audio = null;
        const choice = streams.videos.find((item, index) => sizes[index] && sizes[index] + (audioSize ?? 0) <= limit);
        if (!choice) throw Object.assign(new Error('Too large'), { code: 'too-large' });
        const data = await combine(streams, choice, limit);
        if (data.length > limit) throw Object.assign(new Error('Too large'), { code: 'too-large' });
        return { name: `reddit-${id}.mp4`, type: 'video/mp4', data, gif: Boolean(clip.is_gif) };
    }

    // Instagram Reels and X videos are one progressive MP4, taken from the
    // post's own data. X serves GIFs as MP4 too, which the page re-encodes.
    async function singleVideo(target, limit) {
        const post = await get(target.canonical);
        const item = post?.media?.length === 1 && post.media[0].type === 'video' ? post.media[0] : null;
        const source = item && media.get(/^lowcord-media:\/\/media\/([\da-f]+)$/.exec(item.src)?.[1]);
        if (!source?.url) throw Object.assign(new Error('Not a video post'), { code: 'not-video' });
        const declared = await size(source.url).catch(() => null);
        if (declared > limit) throw Object.assign(new Error('Too large'), { code: 'too-large' });
        const id = target.site === 'twitter' ? /\/status\/(\d+)/.exec(target.path)?.[1] : /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(target.path)?.[1];
        return { name: `${target.site === 'twitter' ? 'x' : target.site}-${id ?? 'video'}.mp4`, type: 'video/mp4', data: await download(source.url, limit), gif: Boolean(item.gif) };
    }
    async function socialVideo(value, limit) {
        const target = links.parse(value);
        if (!Number.isSafeInteger(limit) || limit < 1024 * 1024 || limit > 1024 ** 3) throw new Error('Invalid limit');
        if (target?.site === 'reddit') return redditVideo(value, limit);
        if (target?.site === 'instagram' || target?.site === 'twitter') return singleVideo(target, limit);
        throw Object.assign(new Error('Unsupported link'), { code: 'not-video' });
    }

    // ----- lowcord-media:// handler ------------------------------------------
    async function playable(fallback) {
        if (muxed.has(fallback)) return muxed.get(fallback);
        const work = (async () => {
            const streams = await redditStreams(fallback);
            // Cards stream a modest quality; uploads pick their own.
            const choice = streams.videos.find(item => item.height && item.height <= 480) ?? streams.videos.at(-1);
            return combine(streams, choice, 80 * 1024 * 1024);
        })();
        muxed.set(fallback, work);
        work.catch(() => muxed.delete(fallback));
        while (muxed.size > 3) muxed.delete(muxed.keys().next().value);
        return work;
    }
    function bytes(data, range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
        if (!match || (!match[1] && !match[2])) return new Response(data, { headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(data.length) } });
        let start = match[1] ? Number(match[1]) : data.length - Number(match[2]);
        let end = match[1] && match[2] ? Number(match[2]) : data.length - 1;
        start = Math.max(0, start); end = Math.min(end, data.length - 1);
        if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${data.length}` } });
        return new Response(data.subarray(start, end + 1), { status: 206, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes',
            'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${data.length}` } });
    }
    async function serve(request) {
        const url = new URL(request.url);
        const source = url.hostname === 'media' ? media.get(url.pathname.slice(1)) : null;
        if (!source) return new Response(null, { status: 404 });
        try {
            if (source.reddit) return bytes(await playable(source.reddit), request.headers.get('range'));
            const range = request.headers.get('range');
            const upstream = await fetchPage(source.url, { credentials: 'omit', redirect: 'follow',
                headers: { 'user-agent': browser, ...(range ? { range } : {}), ...source.headers }, signal: AbortSignal.timeout(30_000) });
            if (!new URL(upstream.url || source.url).protocol.startsWith('https')) return new Response(null, { status: 502 });
            const headers = new Headers({ 'cache-control': 'private, max-age=3600' });
            for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
                const value = upstream.headers.get(name);
                if (value) headers.set(name, value);
            }
            // Never let a remote file run as a page from this scheme.
            if (/html|xml|javascript/i.test(headers.get('content-type') ?? '')) { await upstream.body?.cancel().catch(() => {}); return new Response(null, { status: 415 }); }
            return new Response(upstream.body, { status: upstream.status, headers });
        } catch { return new Response(null, { status: 502 }); }
    }
    return { get, redditVideo, socialVideo, serve, metadata };
}
module.exports = { createSocialPosts, scheme };
