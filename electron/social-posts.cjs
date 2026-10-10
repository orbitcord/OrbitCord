const { randomBytes } = require('node:crypto');
const links = require('./social-links.cjs');
const { mux, muxToFile } = require('./mp4-mux.cjs');
const { createMediaCache } = require('./media-cache.cjs');

// Reads public post data for OrbitCord's social cards and video uploads.
// Requests never carry Discord credentials, cookies or message text.
// Media is served to the page through `lowcord-media://media/<token>`, where
// each token was minted here for a URL taken from the post's own data.
const scheme = 'lowcord-media';
const bot = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const browser = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function createSocialPosts(fetchPage = fetch, cacheOptions) {
    const posts = new Map(), pending = new Map(), media = new Map(), muxed = new Map();
    const playbackCache = createMediaCache(cacheOptions);

    async function request(url, { headers = {}, timeout = 6000, method = 'GET', redirect = 'follow', body, signal } = {}) {
        const response = await fetchPage(url, { method, redirect, credentials: 'omit', body,
            headers: { 'user-agent': bot, ...headers }, signal: signal ?? AbortSignal.timeout(timeout) });
        return response;
    }
    const failed = response => Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    // With `head`, a longer body is cut at `limit` instead of refused.
    async function read(response, limit, head = false) {
        const declared = Number(response.headers.get('content-length'));
        if (declared > limit && !head) { await response.body?.cancel().catch(() => {}); throw Object.assign(new Error('Too large'), { code: 'too-large' }); }
        const reader = response.body.getReader(), parts = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit && head) { parts.push(value); await reader.cancel().catch(() => {}); break; }
            if (size > limit) { await reader.cancel().catch(() => {}); throw Object.assign(new Error('Too large'), { code: 'too-large' }); }
            parts.push(value);
        }
        return Buffer.concat(parts);
    }
    async function json(url, options) {
        const response = await request(url, { ...options, headers: { accept: 'application/json', ...options?.headers } });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw failed(response); }
        return JSON.parse((await read(response, 4 * 1024 * 1024)).toString('utf8'));
    }
    // With `redirect: 'manual'`, a redirect answers `{ location }` instead.
    async function page(url, { redirect = 'follow', head = false } = {}) {
        const response = await request(url, { redirect, headers: { accept: 'text/html' } });
        if (redirect === 'manual' && response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => {});
            return { location: absolute(response.headers.get('location'), url), url };
        }
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
            await response.body?.cancel().catch(() => {});
            throw failed(response);
        }
        return { html: (await read(response, head ? 256 * 1024 : 768 * 1024, head)).toString('utf8'), url: response.url || url };
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

    const secure = value => {
        let url;
        try { url = new URL(value); } catch { return null; }
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    };
    function proxy(source) {
        if (!source) return null;
        if (typeof source === 'string') source = { url: source };
        if ('url' in source) {
            const url = secure(source.url);
            if (!url) return null;
            source = { ...source, url, ...(source.variants ? { variants: source.variants.map(secure).filter(Boolean) } : {}) };
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
    // A source that refuses with 401, 403 or 429 rests for a few minutes, so
    // lookups go straight to the next source instead of waiting on it.
    const resting = new Map();
    // A carousel is one request per slide, and one failed slide fails the
    // post: retry brief failures, and keep few in flight at once, since
    // chat cards and a paste can ask for many posts together.
    async function patiently(work, tries = 3) {
        for (let attempt = 1; ; attempt++) {
            try { return await work(); } catch (error) {
                if (attempt >= tries || (error.status && error.status !== 429 && error.status < 500)) throw error;
                await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
            }
        }
    }
    function limiter(count) {
        let active = 0;
        const queue = [];
        const next = () => {
            if (active >= count || !queue.length) return;
            active++;
            const { work, resolve, reject } = queue.shift();
            work().then(resolve, reject).finally(() => { active--; next(); });
        };
        return work => new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); next(); });
    }
    const slide = limiter(6);
    // Photos download side by side; videos, which can be large, one at a time.
    const photoDownloads = limiter(4), videoDownloads = limiter(1);
    async function attempt(sources, ...args) {
        const failures = [];
        for (const [name, read, rests = true] of sources) {
            if (resting.get(name) > Date.now()) { failures.push(`${name}: resting`); continue; }
            try { return await read(...args); } catch (error) {
                if (rests && [401, 403, 429].includes(error.status)) resting.set(name, Date.now() + 5 * 60_000);
                failures.push(`${name}: ${error.message}`);
            }
        }
        throw new Error(failures.join('; ') || 'No source available');
    }
    // Every item must resolve, so a source that lost a slide or a video's
    // stream gives way to the next one instead of a partial post.
    const complete = items => {
        if (!items.length || items.some(item => !item)) throw new Error('Missing media');
        return items;
    };
    const largest = list => [...(list ?? [])].filter(item => item?.url).sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0]?.url;
    // X lists each video in several qualities. All MP4s go along, highest
    // bitrate first, so an upload can step down to one that fits.
    const mp4s = list => (list ?? []).filter(variant => variant?.url && (variant.content_type ?? (variant.container === 'mp4' ? 'video/mp4' : null)) === 'video/mp4')
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0)).map(variant => variant.url);
    const xVideo = (urls, poster, extra) => {
        const src = urls.length ? proxy({ url: urls[0], variants: urls }) : null;
        return src && { type: 'video', src, poster: proxy(poster), ...extra };
    };
    const base = (target, fields) => ({ site: target.site, service: links.sites[target.site].name, color: links.sites[target.site].color,
        url: target.canonical, author: {}, text: '', stats: {}, media: [], sensitive: false, ...fields,
        media: (fields.media ?? []).filter(Boolean).slice(0, 20) });

    // X's own embed API, the one behind its embedded posts; no sign-in.
    async function xSyndication(target, id) {
        const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
        const tweet = await json(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`);
        if (!tweet?.id_str || tweet.__typename === 'TweetTombstone') throw new Error('Post not found');
        let body = tweet.text ?? '';
        for (const link of tweet.entities?.media ?? []) body = body.replaceAll(link.url, '');
        for (const link of tweet.entities?.urls ?? []) if (link.expanded_url) body = body.replaceAll(link.url, link.expanded_url);
        const items = (tweet.mediaDetails ?? []).map(item => {
            const size = { width: number(item.original_info?.width), height: number(item.original_info?.height) };
            if (item.type === 'photo') return image(item.media_url_https && `${item.media_url_https}?name=large`, { ...size, alt: item.ext_alt_text ?? undefined });
            return xVideo(mp4s(item.video_info?.variants), item.media_url_https, { ...size, ...(item.type === 'animated_gif' ? { loop: true, gif: true } : {}) });
        });
        if (items.some(item => !item)) throw new Error('Missing media');
        const user = tweet.user ?? {};
        return base(target, {
            url: user.screen_name ? `https://x.com/${user.screen_name}/status/${id}` : target.canonical, text: text(decode(body)),
            author: { name: user.name, handle: user.screen_name && `@${user.screen_name}`, url: user.screen_name && `https://x.com/${user.screen_name}`,
                avatar: proxy(user.profile_image_url_https?.replace(/_normal(\.\w+)$/, '_200x200$1')) },
            created: Date.parse(tweet.created_at) || null,
            stats: { replies: number(tweet.conversation_count), likes: number(tweet.favorite_count) },
            sensitive: Boolean(tweet.possibly_sensitive), media: items,
        });
    }
    // Age-restricted posts come from here: X's embed API answers them with a tombstone.
    async function fxTwitter(target, id) {
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
            media: items.map(item => {
                if (item.type === 'photo') return image(item.url, { width: item.width, height: item.height, alt: item.altText });
                const urls = mp4s(item.variants ?? item.formats);
                return xVideo(urls.length ? urls : [item.url].filter(Boolean), item.thumbnail_url,
                    { width: item.width, height: item.height, ...(item.type === 'gif' ? { loop: true, gif: true } : {}) });
            }),
        });
    }
    async function vxTwitter(target, id) {
        const tweet = await json(`https://api.vxtwitter.com/Twitter/status/${id}`);
        if (!tweet?.tweetID) throw new Error('Post not found');
        return base(target, {
            url: tweet.tweetURL ?? target.canonical, text: text(tweet.text),
            author: { name: tweet.user_name, handle: tweet.user_screen_name && `@${tweet.user_screen_name}`,
                url: tweet.user_screen_name && `https://x.com/${tweet.user_screen_name}`, avatar: proxy(tweet.user_profile_image_url) },
            created: tweet.date_epoch ? tweet.date_epoch * 1000 : null,
            stats: { replies: number(tweet.replies), reposts: number(tweet.retweets), likes: number(tweet.likes) },
            sensitive: Boolean(tweet.possibly_sensitive),
            media: (tweet.media_extended ?? []).map(item => item.type === 'image'
                ? image(item.url, { width: item.size?.width, height: item.size?.height, alt: item.altText ?? undefined })
                : video(item.url, item.thumbnail_url, { width: item.size?.width, height: item.size?.height, ...(item.type === 'gif' ? { loop: true, gif: true } : {}) })),
        });
    }
    const xSources = [['x', xSyndication], ['fxtwitter', fxTwitter], ['vxtwitter', vxTwitter]];
    async function twitter(target) {
        return attempt(xSources, target, /\/status\/(\d+)/.exec(target.path)?.[1]);
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
                const preview = source.preview?.images?.[0];
                const size = { width: preview?.source?.width, height: preview?.source?.height };
                // A GIF plays from Reddit's MP4 of it, a fraction of the size.
                // An upload sends the GIF itself when it fits, else that MP4 as a GIF.
                const clip = /\.gif$/i.test(source.url ?? '') ? preview?.variants?.mp4?.source?.url : null;
                const src = clip && proxy({ url: clip, original: secure(source.url) });
                items = [src ? { type: 'video', src, poster: proxy(poster), ...size, loop: true, gif: true } : image(source.url, size)];
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

    // Counts as Instagram and OGInstagram write them: "16K", "51,581".
    const amount = value => {
        const match = /^([\d.,]+)\s*([KMB])?$/i.exec(value?.trim() ?? '');
        if (!match) return null;
        const base = Number(match[2] ? match[1].replace(/,/g, '.') : match[1].replace(/[.,]/g, ''));
        return Number.isFinite(base) ? Math.round(base * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase()] ?? 1)) : null;
    };
    const instagramImage = location => { try { return /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(new URL(location).hostname) && location; } catch { return null; } };

    // An Instagram post is complete or it fails: every item, full size. A
    // source that can't account for every item fails over to the next one,
    // never to a cropped preview standing in for the post.
    //
    // 1. Instagram's own web API, as its logged-out post page asks it.
    function instagramItem(item) {
        const size = { width: number(item.original_width), height: number(item.original_height) };
        const poster = largest(item.image_versions2?.candidates);
        if (item.media_type === 2) return video(largest(item.video_versions), poster, size);
        return image(poster, { ...size, alt: item.accessibility_caption ?? undefined });
    }
    async function instagramApi(target, code, lookup) {
        const { data } = await json('https://www.instagram.com/graphql/query', { method: 'POST',
            body: new URLSearchParams({ variables: JSON.stringify({ shortcode: code }), doc_id: '24368985919464652' }),
            headers: { 'user-agent': browser, 'content-type': 'application/x-www-form-urlencoded', 'x-ig-app-id': '936619743392459',
                'x-asbd-id': '359341', 'x-csrftoken': 'missing', 'sec-fetch-site': 'same-origin' } });
        const item = data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
        // Age-restricted accounts, among others, answer only signed-in users;
        // the embed page then refuses too, so the lookup skips it.
        if (!item) { lookup.signedInOnly = true; throw new Error('Not served logged out'); }
        const user = item.user ?? item.owner ?? {}, hidden = Boolean(item.like_and_view_counts_disabled);
        return base(target, {
            url: `https://www.instagram.com/p/${code}/`, text: text(item.caption?.text),
            author: { name: user.full_name || user.username, handle: user.username && `@${user.username}`,
                url: user.username && `https://www.instagram.com/${user.username}/`, avatar: proxy(user.profile_pic_url) },
            created: item.taken_at ? item.taken_at * 1000 : null,
            stats: { likes: hidden ? null : number(item.like_count), comments: number(item.comment_count), views: hidden ? null : number(item.view_count ?? item.play_count) },
            media: complete((item.carousel_media?.length ? item.carousel_media : [item]).map(instagramItem)),
        });
    }
    // 2. The page behind Instagram's embed iframe. Carousels and videos carry
    // their data as JSON; a single photo only as rendered markup.
    async function instagramEmbed(target, code, lookup) {
        if (lookup.signedInOnly) throw new Error('Skipped: not served logged out');
        const { html } = await page(`https://www.instagram.com/p/${code}/embed/captioned/`);
        const literal = /"contextJSON":("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
        const shared = literal ? JSON.parse(JSON.parse(literal))?.gql_data?.shortcode_media : null;
        const url = `https://www.instagram.com/p/${code}/`;
        if (shared) {
            const owner = shared.owner ?? {};
            const size = node => ({ width: number(node.dimensions?.width), height: number(node.dimensions?.height) });
            const nodes = shared.edge_sidecar_to_children?.edges?.map(edge => edge.node) ?? [shared];
            return base(target, {
                url, text: text(shared.edge_media_to_caption?.edges?.[0]?.node?.text),
                author: { name: owner.full_name || owner.username, handle: owner.username && `@${owner.username}`,
                    url: owner.username && `https://www.instagram.com/${owner.username}/`, avatar: proxy(owner.profile_pic_url) },
                created: shared.taken_at_timestamp ? shared.taken_at_timestamp * 1000 : null,
                stats: { likes: number(shared.edge_liked_by?.count ?? shared.edge_media_preview_like?.count),
                    comments: number(shared.edge_media_to_comment?.count), views: number(shared.video_view_count) },
                media: complete(nodes.map(node => node.is_video ? video(node.video_url, node.display_url, size(node))
                    : image(node.display_url, { ...size(node), alt: node.accessibility_caption ?? undefined }))),
            });
        }
        if (!/data-media-type="GraphImage"/.test(html)) throw new Error('Not served logged out');
        const tag = /<img\b[^>]*class="EmbeddedMediaImage"[^>]*>/.exec(html)?.[0] ?? '';
        const source = /\bsrc="([^"]+)"/.exec(tag)?.[1];
        const username = /class="UsernameText">([^<]+)</.exec(html)?.[1];
        const avatar = /<a class="Avatar"[^>]*>\s*<img\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
        const caption = /<div class="Caption">([\s\S]*?)(?:<div class="CaptionComments"|<\/div>)/.exec(html)?.[1] ?? '';
        return base(target, {
            url, text: text(decode(caption.replace(/<a class="CaptionUsername"[\s\S]*?<\/a>/, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))),
            author: { name: username && decode(username), handle: username && `@${decode(username)}`,
                url: username && `https://www.instagram.com/${decode(username)}/`, avatar: proxy(avatar && decode(avatar)) },
            stats: { likes: amount(/>([\d,.]+) likes</.exec(html)?.[1]), comments: amount(/View all ([\d,.]+) comments/.exec(html)?.[1]) },
            media: complete([image(source && decode(source))]),
        });
    }
    // 3. OGInstagram (zzinstagram), which also reads posts Instagram serves
    // only to signed-in users, one slide per request: a photo slide
    // redirects to the photo on Instagram's CDN, at full size; a video slide
    // is a page whose og:video is the clip and whose og:url names the slide
    // it served. An index past the end serves the last slide again. Any
    // other answer is a hiccup and is retried, so no slide is ever dropped.
    async function instagramSlide(code, index) {
        const { html, location } = await page(`https://zzinstagram.com/p/${code}/?img_index=${index}`, { redirect: 'manual' });
        if (html == null) {
            const photo = instagramImage(location);
            if (!photo) throw new Error(`Slide ${index} not served`);
            // The same photo comes back from different CDN hosts and signatures.
            return { type: 'image', url: photo, key: new URL(photo).pathname.split('/').pop() };
        }
        const meta = metadata(html);
        const clip = absolute(meta.get('og:video:secure_url') ?? meta.get('og:video'), 'https://zzinstagram.com/');
        let served;
        try { served = Number(new URL(meta.get('og:url')).searchParams.get('img_index')); } catch {}
        served ||= Number(/\/offload\/[\w-]+\/(\d+)/.exec(clip ?? '')?.[1]);
        // Its error page says why, e.g. "Embed failed: Post not found".
        if (!clip || !served) throw new Error(`Slide ${index} not served${meta.get('og:title') ? `: ${meta.get('og:title')}: ${meta.get('og:description')}` : ''}`);
        return { type: 'video', url: clip, poster: absolute(meta.get('og:image'), 'https://zzinstagram.com/'), key: `video ${served}`, served, meta };
    }
    async function instagramSlides(target, code, lookup) {
        const known = lookup.details().catch(() => null);
        const slides = new Map();
        const slideAt = index => {
            if (!slides.has(index)) slides.set(index, slide(() => patiently(() => instagramSlide(code, index))));
            return slides.get(index);
        };
        // The last slide is the first index that serves what 20 does. Asked
        // in waves, so most carousels are counted in one round trip.
        const waves = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12, 13, 14], [15, 16, 17, 18, 19]];
        const [end] = await Promise.all([slideAt(20), ...waves[0].map(slideAt)]);
        let count = end.served;
        for (const wave of waves) {
            if (count) break;
            const found = (await Promise.all(wave.map(slideAt))).findIndex(item => item.key === end.key);
            if (found >= 0) count = wave[found];
        }
        count ||= 20;
        const items = await Promise.all(Array.from({ length: count }, (_, index) => slideAt(index + 1)));
        if (new Set(items.map(item => item.key)).size !== items.length) throw new Error('Slides repeat');
        // The caption, author and counts, from Instagram's post page or else
        // from OGInstagram's page for a video slide.
        const details = await known;
        const page = items.find(item => item.meta)?.meta;
        const title = /^(.*) \(@([\w.]+)\)$/.exec(page?.get('og:title') ?? '');
        const description = page?.get('og:description') ?? '';
        return base(target, {
            url: `https://www.instagram.com/p/${code}/`,
            author: details?.author ?? (title ? { name: title[1], handle: `@${title[2]}`, url: `https://www.instagram.com/${title[2]}/` } : {}),
            text: details?.text || text(description.replace(/^[^\n]*[❤💬][^\n]*\n*/u, '')),
            stats: details?.stats ?? { likes: amount(/❤️?\s*([\d.,]+)/u.exec(description)?.[1]), comments: amount(/💬\s*([\d.,]+)/u.exec(description)?.[1]) },
            created: details?.created ?? (Date.parse(page?.get('article:published_time')) || null),
            media: complete(items.map(item => item.type === 'video' ? video(item.url, item.poster) : image(item.url))),
        });
    }
    // Instagram's public post page answers even for posts its API refuses
    // logged out. Its Open Graph tags name the author and carry the caption
    // and counts: "16K likes, 331 comments - handle on March 18, 2026: "…"."
    // Its image is a cropped preview, so it is never used as the media.
    async function instagramPage(code) {
        const { html } = await page(`https://www.instagram.com/p/${code}/`, { head: true });
        const meta = metadata(html);
        const description = meta.get('og:description') ?? '';
        const handle = /\s-\s([\w.]+) on [^:]+:/.exec(description)?.[1];
        if (!handle) throw new Error('No post data');
        return {
            author: { name: /^(.*?) on Instagram\b/.exec(meta.get('og:title') ?? '')?.[1] || handle, handle: `@${handle}`, url: `https://www.instagram.com/${handle}/` },
            text: text(/:\s"([\s\S]*)"\.?\s*$/.exec(description)?.[1] ?? ''),
            stats: { likes: amount(/([\d.,]+[KMB]?) likes?\b/i.exec(description)?.[1]), comments: amount(/([\d.,]+[KMB]?) comments?\b/i.exec(description)?.[1]) },
            created: Date.parse(/\son ([A-Z][a-z]+ \d{1,2}, \d{4}):/.exec(description)?.[1] ?? '') || null,
        };
    }
    // OGInstagram is the only source for some posts: retried, never rested.
    const instagramSources = [['instagram', instagramApi], ['instagram-embed', instagramEmbed], ['oginstagram', instagramSlides, false]];
    async function instagram(target) {
        const code = /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(target.path)?.[1];
        if (!code) return generic(target);
        let details;
        return attempt(instagramSources, target, code, { details: () => (details ??= instagramPage(code)) });
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
            // Names only the post, and what each source answered.
            try { value = await (fetchers[target.site] ?? generic)(target); }
            catch (error) { console.warn(`[lowcord] No ${target.site} post for ${target.path}: ${error.message}`); }
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
    async function redditStreams(fallback, signal) {
        const folder = /^(https:\/\/v\.redd\.it\/\w+)\//.exec(fallback)?.[1];
        if (!folder) throw new Error('Not a Reddit video');
        let names = [];
        try {
            const response = await request(`${folder}/DASHPlaylist.mpd`, { timeout: 6000, ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) } : {}) });
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

    // Media URLs are signed and expire, and a lookup can fail on a bad
    // moment: when a download fails, read the post again once and retry.
    async function withPost(target, work) {
        try {
            const post = await get(target.canonical);
            if (!post) throw new Error('Post unavailable');
            return await work(post);
        } catch (error) {
            if (error.code) throw error;
            posts.delete(target.key);
            return work(await get(target.canonical));
        }
    }
    const sourceOf = item => media.get(/^lowcord-media:\/\/media\/([\da-f]+)$/.exec(item?.src ?? '')?.[1]);
    // Fetches the best quality that fits in `limit`, where X offers several.
    // A variant of unknown size is tried, and a smaller one follows if it
    // turns out too large.
    async function fitting(source, limit, fetchOne) {
        const urls = source.variants?.length ? source.variants : [source.url];
        for (const [index, url] of urls.entries()) {
            const declared = await size(url).catch(() => null);
            if (declared > limit) continue;
            try { return await fetchOne(url); }
            catch (error) { if (declared || error.code !== 'too-large' || index === urls.length - 1) throw error; }
        }
        throw Object.assign(new Error('Too large'), { code: 'too-large' });
    }
    // Instagram Reels, X videos and Reddit GIFs are one progressive MP4, taken
    // from the post's own data. X serves GIFs as MP4 too, which the page
    // re-encodes; a Reddit GIF that fits is sent as itself instead.
    function singleVideo(target, limit) {
        return withPost(target, async post => {
            const item = post?.media?.length === 1 && post.media[0].type === 'video' ? post.media[0] : null;
            const source = item && sourceOf(item);
            if (!source?.url) throw Object.assign(new Error('Not a video post'), { code: 'not-video' });
            const id = target.site === 'twitter' ? /\/status\/(\d+)/.exec(target.path)?.[1]
                : target.site === 'reddit' ? /\/comments\/(\w+)/.exec(post.url ?? '')?.[1]
                : /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(target.path)?.[1];
            const name = `${target.site === 'twitter' ? 'x' : target.site}-${id ?? 'video'}`;
            if (source.original) {
                const data = await download(source.original, limit).catch(() => null);
                if (data && sniff(data) === 'image/gif') return { name: `${name}.gif`, type: 'image/gif', data, gif: true };
            }
            const data = await fitting(source, limit, url => download(url, limit));
            return { name: `${name}.mp4`, type: 'video/mp4', data, gif: Boolean(item.gif) };
        });
    }
    async function socialVideo(value, limit) {
        const target = links.parse(value);
        if (!Number.isSafeInteger(limit) || limit < 1024 * 1024 || limit > 1024 ** 3) throw new Error('Invalid limit');
        // Reddit's own videos are DASH streams; its GIFs are a single MP4.
        if (target?.site === 'reddit') return redditVideo(value, limit).catch(error => {
            if (error.code === 'not-video') return singleVideo(target, limit);
            throw error;
        });
        if (target?.site === 'instagram' || target?.site === 'twitter') return singleVideo(target, limit);
        throw Object.assign(new Error('Unsupported link'), { code: 'not-video' });
    }
    // A photo post or carousel as files: every item, in order, each within
    // Discord's per-file upload limit. Discord takes at most 10 attachments.
    const fileTypes = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4' };
    function sniff(data, declared) {
        const ascii = (start, end) => data.subarray(start, end).toString('latin1');
        if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
        if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
        if (ascii(0, 4) === 'GIF8') return 'image/gif';
        if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
        if (ascii(4, 8) === 'ftyp') return 'video/mp4';
        return fileTypes[declared] ? declared : null;
    }
    async function socialMedia(value, limit) {
        const target = links.parse(value);
        if (!Number.isSafeInteger(limit) || limit < 1024 * 1024 || limit > 1024 ** 3) throw new Error('Invalid limit');
        if (!['reddit', 'instagram', 'twitter'].includes(target?.site)) throw Object.assign(new Error('Unsupported link'), { code: 'not-media' });
        return withPost(target, async post => {
            const sources = (post?.media ?? []).map(sourceOf);
            // Reddit's own videos are separate DASH streams; those posts go through socialVideo.
            if (!sources.length || sources.some(source => !source?.url)) throw Object.assign(new Error('Not a media post'), { code: 'not-media' });
            if (sources.length > 10) throw Object.assign(new Error('Too many files'), { code: 'too-many' });
            const id = target.site === 'twitter' ? /\/status\/(\d+)/.exec(target.path)?.[1]
                : target.site === 'instagram' ? /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(target.path)?.[1]
                : /\/comments\/(\w+)/.exec(post.url ?? '')?.[1];
            const prefix = `${target.site === 'twitter' ? 'x' : target.site}-${id ?? 'post'}`;
            const fetchUrl = async (source, url) => {
                const response = await fetchPage(url, { credentials: 'omit', redirect: 'follow',
                    headers: { 'user-agent': browser, ...source.headers }, signal: AbortSignal.timeout(120_000) });
                const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
                if (!response.ok || !(response.url || url).startsWith('https:') || /html|xml|javascript/.test(declared)) { await response.body?.cancel().catch(() => {}); throw failed(response); }
                const data = await read(response, limit);
                const type = sniff(data, declared);
                if (!type) throw new Error('Unknown file type');
                return { data, type };
            };
            const fetchFile = async (source, index) => {
                const { data, type } = source.variants?.length > 1
                    ? await fitting(source, limit, url => fetchUrl(source, url)) : await fetchUrl(source, source.url);
                return { name: `${prefix}${sources.length > 1 ? `-${index + 1}` : ''}.${fileTypes[type]}`, type, data };
            };
            const files = await Promise.all(sources.map((source, index) =>
                (post.media[index].type === 'video' ? videoDownloads : photoDownloads)(() => fetchFile(source, index))));
            return { files };
        });
    }

    // ----- lowcord-media:// handler ------------------------------------------
    async function downloadFile(url, path, limit, signal) {
        const { createWriteStream } = require('node:fs');
        const { Readable, Transform } = require('node:stream');
        const { pipeline } = require('node:stream/promises');
        const response = await request(url, { timeout: 120_000,
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
        const tooLarge = () => Object.assign(new Error('Too large'), { code: 'too-large' });
        if (!response.ok || Number(response.headers.get('content-length')) > limit) {
            await response.body?.cancel().catch(() => {});
            if (response.ok) throw tooLarge();
            throw new Error(`HTTP ${response.status}`);
        }
        let size = 0;
        await pipeline(Readable.fromWeb(response.body), new Transform({
            transform(chunk, _encoding, callback) {
                size += chunk.length;
                callback(size > limit ? tooLarge() : null, chunk);
            }
        }), createWriteStream(path, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 }), { signal });
        return size;
    }
    async function playable(fallback) {
        try {
            return await playbackCache.get(fallback, async (directory, signal) => {
                const { join } = require('node:path');
                const { rm } = require('node:fs/promises');
                const streams = await redditStreams(fallback, signal);
                const choice = streams.videos.find(item => item.height && item.height <= 480) ?? streams.videos.at(-1);
                const video = join(directory, 'video.mp4'), audio = join(directory, 'audio.mp4'), output = join(directory, 'playable.mp4');
                const limit = 80 * 1024 * 1024;
                const transfers = new AbortController();
                const transferSignal = AbortSignal.any([signal, transfers.signal]);
                const videoWork = downloadFile(choice.url, video, limit, transferSignal).catch(error => { transfers.abort(); throw error; });
                const audioWork = streams.audio ? downloadFile(streams.audio, audio, limit, transferSignal).catch(error => {
                    if (transferSignal.aborted || ['ENOSPC', 'EACCES', 'EIO', 'EROFS'].includes(error.code)) { transfers.abort(); throw error; }
                    return null;
                }) : Promise.resolve(null);
                // Wait for both handles to close before a failed entry is deleted.
                const results = await Promise.allSettled([videoWork, audioWork]);
                const failed = results.filter(result => result.status === 'rejected');
                if (failed.length) throw (failed.find(result => result.reason.name !== 'AbortError') ?? failed[0]).reason;
                const [size, sound] = results.map(result => result.value);
                signal.throwIfAborted();
                if (sound) {
                    try {
                        const result = await muxToFile(video, audio, output, { signal });
                        await Promise.all([rm(video), rm(audio)]);
                        return { path: output, size: result.size };
                    } catch (error) {
                        if (signal.aborted || ['ENOSPC', 'EACCES', 'EIO', 'EROFS'].includes(error.code)) throw error;
                        // Keep the same silent-video fallback for unsupported MP4s.
                    }
                }
                await rm(audio, { force: true });
                return { path: video, size };
            });
        } catch (error) {
            // A read-only/full temporary volume must not disable playback.
            if (!['ENOSPC', 'EACCES', 'EIO', 'EROFS', 'ENOENT', 'ENOTDIR', 'EEXIST'].includes(error.code)) throw error;
            if (muxed.has(fallback)) return muxed.get(fallback);
            const work = (async () => {
                const streams = await redditStreams(fallback);
                const choice = streams.videos.find(item => item.height && item.height <= 480) ?? streams.videos.at(-1);
                return combine(streams, choice, 80 * 1024 * 1024);
            })();
            muxed.set(fallback, work);
            work.catch(() => { if (muxed.get(fallback) === work) muxed.delete(fallback); });
            while (muxed.size > 3) muxed.delete(muxed.keys().next().value);
            return work;
        }
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
            if (source.reddit) {
                const value = await playable(source.reddit);
                return Buffer.isBuffer(value) ? bytes(value, request.headers.get('range')) : playbackCache.response(value, request);
            }
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
    return { get, redditVideo, socialVideo, socialMedia, serve, metadata, close: () => { muxed.clear(); return playbackCache.close(); } };
}
module.exports = { createSocialPosts, scheme };
