// Shared by the renderer and main process; keep URL rules in one place.
function createSocialLinks() {
    const www = hosts => hosts.flatMap(host => [host, `www.${host}`]);
    // `providers` are fix-embed services that Discord's crawler can read, in
    // auto-mode preference order. `hosts` are the original service's domains.
    const sites = {
        twitter: { name: 'X', home: 'x.com', color: '#1d9bf0',
            hosts: ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com'],
            providers: ['fxtwitter.com', 'vxtwitter.com'], extra: ['fixupx.com', 'fixvx.com'] },
        instagram: { name: 'Instagram', home: 'www.instagram.com', color: '#e1306c',
            hosts: ['instagram.com', 'www.instagram.com', 'm.instagram.com'],
            providers: ['hhinstagram.com', 'zzinstagram.com', 'vxinstagram.com', 'eeinstagram.com'], extra: ['ddinstagram.com', 'uuinstagram.com'] },
        bluesky: { name: 'Bluesky', home: 'bsky.app', color: '#1185fe',
            hosts: ['bsky.app', 'www.bsky.app'], providers: ['bskx.app', 'fxbsky.app'], extra: ['bskyx.app'] },
        reddit: { name: 'Reddit', home: 'www.reddit.com', color: '#ff4500',
            hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com', 'sh.reddit.com', 'redd.it'],
            providers: ['vxreddit.com', 'rxddit.com'], extra: ['old.rxddit.com', 'old.vxreddit.com'] },
        tiktok: { name: 'TikTok', home: 'www.tiktok.com', color: '#ff0050',
            hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
            providers: ['tnktok.com', 'tiktxk.com', 'tfxktok.com'], extra: ['vxtiktok.com'] },
        twitch: { name: 'Twitch', home: 'clips.twitch.tv', color: '#9146ff',
            hosts: ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'clips.twitch.tv'], providers: ['fxtwitch.seria.moe'], extra: [] },
        tumblr: { name: 'Tumblr', home: 'www.tumblr.com', color: '#529ecc',
            hosts: ['tumblr.com', 'www.tumblr.com'], providers: ['tpmblr.com'], extra: [] },
        facebook: { name: 'Facebook', home: 'www.facebook.com', color: '#0866ff',
            hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com'], providers: ['facebed.com'], extra: [] },
        threads: { name: 'Threads', home: 'www.threads.com', color: '#a0a0a0',
            hosts: ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'], providers: ['fixthreads.net'], extra: [] },
        pixiv: { name: 'pixiv', home: 'www.pixiv.net', color: '#0096fa',
            hosts: ['pixiv.net', 'www.pixiv.net'], providers: ['phixiv.net'], extra: [] },
    };
    const providers = Object.fromEntries(Object.entries(sites).map(([site, { providers }]) => [site, providers]));
    const known = new Map();
    for (const [site, entry] of Object.entries(sites)) {
        for (const host of entry.hosts) known.set(host, { site, original: true });
        for (const host of www([...entry.providers, ...entry.extra])) known.set(host, { site, original: false });
    }
    const tumblrBlog = /^([a-z0-9-]+)\.tumblr\.com$/i;

    // Returns the post path shared by the service and its fix providers.
    function postPath(site, url) {
        const path = url.pathname, query = url.searchParams;
        if (site === 'twitter') return /^\/(?:\w+\/status|i\/web\/status)\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/.test(path) ? path : null;
        if (site === 'instagram') {
            if (!/^\/(?:(?:[\w.]+\/)?(?:p|reel|reels|tv)\/[\w-]+(?:\/\d+)?|stories\/[\w.]+\/\d+|share\/(?:p|reel)\/[\w-]+)\/?$/.test(path)) return null;
            // The carousel index selects media, rather than tracking a user.
            const index = query.get('img_index');
            return path + (/^\d+$/.test(index ?? '') && Number(index) < 100 ? `?img_index=${index}` : '');
        }
        if (site === 'bluesky') return /^\/profile\/[\w.:-]+\/post\/\w+\/?$/.test(path) ? path : null;
        if (site === 'reddit') {
            if (url.hostname === 'redd.it') return /^\/\w+\/?$/.test(path) ? `/comments${path.replace(/\/$/, '')}/` : null;
            return /^\/(?:(?:r\/\w+|u\/[\w-]+|user\/[\w-]+)\/)?comments\/\w+(?:\/[^/]+(?:\/\w+)?)?\/?$/.test(path)
                || /^\/r\/\w+\/s\/\w+\/?$/.test(path) ? path : null;
        }
        if (site === 'tiktok') {
            if (['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname)) return /^\/\w+\/?$/.test(path) ? `/t${path}` : null;
            return /^\/(?:@[\w.-]+\/(?:video|photo)\/\d+|t\/\w+)\/?$/.test(path) ? path : null;
        }
        if (site === 'twitch') {
            if (url.hostname === 'clips.twitch.tv') return /^\/[\w-]+\/?$/.test(path) && path !== '/embed' ? `/clip${path}` : null;
            return /^\/(?:\w+\/clip|clip)\/[\w-]+\/?$/.test(path) ? path : null;
        }
        if (site === 'tumblr') {
            const blog = tumblrBlog.exec(url.hostname)?.[1];
            if (blog && blog !== 'www') {
                const match = /^\/post\/(\d+)(?:\/[^/]*)?\/?$/.exec(path);
                return match ? `/${blog}/${match[1]}` : null;
            }
            return /^\/[\w-]+\/\d+(?:\/[^/]*)?\/?$/.test(path) ? path : null;
        }
        if (site === 'facebook') {
            if (/^\/(?:[\w.-]+\/(?:posts|videos)\/[\w.-]+|share\/[prv]\/\w+|reel\/\d+|groups\/[\w.-]+\/posts\/\w+)\/?$/.test(path)) return path;
            // Keep only the identifiers these pages need, not share tracking.
            const keep = { '/permalink.php': ['story_fbid', 'id'], '/story.php': ['story_fbid', 'id'], '/watch': ['v'], '/watch/': ['v'], '/photo': ['fbid'], '/photo.php': ['fbid'] }[path];
            if (!keep || !keep.every(name => /^[\w-]+$/.test(query.get(name) ?? '') || (name === 'id' && !query.has(name)))) return null;
            const params = new URLSearchParams(keep.filter(name => query.has(name)).map(name => [name, query.get(name)]));
            return `${path}?${params}`;
        }
        if (site === 'threads') return /^\/@[\w.]+\/post\/[\w-]+\/?$/.test(path) ? path : null;
        if (site === 'pixiv') return /^\/(?:[a-z]{2}\/)?artworks\/\d+\/?$/.test(path) ? path : null;
        return null;
    }
    function parse(value) {
        let url;
        try { url = new URL(value); } catch { return null; }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
        let entry = known.get(url.hostname);
        const blog = tumblrBlog.exec(url.hostname)?.[1];
        if (!entry && blog && blog !== 'www') entry = { site: 'tumblr', original: true };
        if (!entry) return null;
        const path = postPath(entry.site, url);
        if (!path) return null;
        const home = entry.site === 'twitch' && path.startsWith('/clip/') ? 'clips.twitch.tv' : sites[entry.site].home;
        const canonical = `https://${home}${entry.site === 'twitch' ? path.replace(/^\/clip\//, '/') : path}`;
        // One key per post, whatever host or tracking suffix was used.
        const redditId = entry.site === 'reddit' ? /\/comments\/(\w+)/.exec(path)?.[1] : null;
        const key = `${entry.site}:${redditId ? `comments/${redditId.toLowerCase()}`
            : entry.site === 'facebook' ? path : path.split('?')[0].replace(/\/$/, '').toLowerCase()}`;
        return { site: entry.site, path, original: entry.original, canonical, key };
    }
    function mapUrls(content, transform) {
        // Preserve code and explicitly suppressed embeds. Backtick runs are
        // matched by length so fenced code and multi-backtick inline code work.
        let result = '', index = 0;
        const tokens = /`+|<https?:\/\/[^>\n]*>|https?:\/\/[^\s<>`]+/g;
        for (let match; (match = tokens.exec(content));) {
            result += content.slice(index, match.index);
            let value = match[0];
            if (value.startsWith('`')) {
                const close = content.indexOf(value, tokens.lastIndex);
                const end = close < 0 ? content.length : close + value.length;
                result += content.slice(match.index, end);
                index = tokens.lastIndex = end;
                continue;
            }
            if (!value.startsWith('<')) {
                let tail = /[.,;:!?'"\]]+$/.exec(value)?.[0] ?? '';
                value = value.slice(0, value.length - tail.length);
                while (value.endsWith(')') && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) {
                    value = value.slice(0, -1); tail = ')' + tail;
                }
                result += (transform(value) ?? value) + tail;
            } else result += value;
            index = tokens.lastIndex;
        }
        return result + content.slice(index);
    }
    function rewrite(content, choose) {
        return mapUrls(content, value => {
            const target = parse(value);
            const host = target && choose(target, value);
            return host ? `https://${host}${target.path}` : value;
        });
    }
    // Every link that names a supported post, in order and without repeats.
    function collect(content, limit = 4) {
        const found = new Map();
        mapUrls(content, value => {
            const target = parse(value);
            if (target && !found.has(target.key) && found.size < limit) found.set(target.key, { ...target, url: value });
            return value;
        });
        return [...found.values()];
    }
    // Some providers need a cold scrape before returning media. Share these
    // bounds so the renderer does not time out before the resolver.
    const lookupTimeout = site => site === 'instagram' ? 3500 : ['reddit', 'tiktok', 'facebook', 'threads'].includes(site) ? 2500 : 1800;
    return { sites, providers, parse, rewrite, mapUrls, collect, lookupTimeout };
}
if (typeof module !== 'undefined' && module.exports) module.exports = createSocialLinks();
else window.Lowcord.socialLinks = createSocialLinks();
