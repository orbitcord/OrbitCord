const links = require('./social-links.cjs');

// A post-specific check avoids mistaking a reachable homepage for a working
// embed. No Discord credentials, cookies, or message text leave the app.
function createSocialResolver(fetchPage = fetch) {
    const cache = new Map(), pending = new Map();
    async function check(host, target, signal) {
        try {
            let url = new URL(`https://${host}${target.path}`), response, media = false;
            const isMedia = url => target.site === 'instagram' && url.protocol === 'https:'
                && !url.username && !url.password && !url.port
                && /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname);
            // Follow only known provider posts and Instagram's media CDN. A
            // media redirect is checked with HEAD, never downloading the file.
            for (let redirects = 0; redirects <= 3; redirects++) {
                response = await fetchPage(url.href, {
                    method: media ? 'HEAD' : 'GET',
                    headers: { 'user-agent': 'Discordbot/2.0', accept: media ? 'image/*,video/*' : 'text/html' },
                    redirect: target.site === 'instagram' ? 'manual' : 'error', credentials: 'omit', signal,
                });
                if (![301, 302, 303, 307, 308].includes(response.status)) break;
                const location = response.headers.get('location');
                await response.body?.cancel().catch(() => {});
                if (!location || redirects === 3) return false;
                url = new URL(location, url);
                media = isMedia(url);
                const next = links.parse(url.href);
                if (!media && !(url.protocol === 'https:' && next?.site === target.site && next.path === target.path
                    && links.providers[target.site].includes(url.hostname.replace(/^www\./, '')))) return false;
            }
            if (media) return response.ok && /^(?:image|video)\//i.test(response.headers.get('content-type') ?? '');
            if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return false;
            // Bound memory as well as time; do not download media or execute HTML.
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let html = '', size = 0;
            try {
                while (size < 256 * 1024) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    html += decoder.decode(value, { stream: true });
                    if (/<meta\b(?=[^>]*(?:property|name)\s*=\s*["']og:(?:video(?::url|:secure_url)?|image(?::url|:secure_url)?)["'])(?=[^>]*content\s*=\s*["']https:\/\/)[^>]*>/i.test(html)) return true;
                }
            } finally { await reader.cancel().catch(() => {}); }
        } catch {}
        return false;
    }
    async function resolve(value, preference = 'auto') {
        const target = links.parse(value);
        if (!target) return value;
        const hosts = links.providers[target.site];
        if (preference !== 'auto' && !hosts.includes(preference)) throw new Error('Invalid embed provider');
        const key = `${target.site}:${target.path}:${preference}`;
        const hit = cache.get(key);
        if (hit?.until > Date.now()) return hit.value;
        if (pending.has(key)) return pending.get(key);
        // Manual providers intentionally bypass probing. Auto mode races the
        // independent services and has a hard upper bound before sending.
        if (preference !== 'auto') return `https://${preference}${target.path}`;
        if (pending.size >= 8) return value;
        const work = (async () => {
            const controller = new AbortController();
            let timer;
            const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), links.lookupTimeout(target.site)); });
            let host;
            try {
                const checks = hosts.map(async host => {
                    if (await check(host, target, controller.signal)) return host;
                    throw new Error('No embed');
                });
                host = await Promise.race([Promise.any(checks).catch(() => null), timeout]);
            } finally { clearTimeout(timer); controller.abort(); }
            // Fall back to the original service if all providers are unavailable.
            const result = host ? `https://${host}${target.path}` : target.canonical;
            if (cache.size >= 128) cache.delete(cache.keys().next().value);
            cache.set(key, { value: result, until: Date.now() + (host ? 10 * 60_000 : 30_000) });
            return result;
        })().finally(() => pending.delete(key));
        pending.set(key, work);
        return work;
    }
    return { resolve };
}
module.exports = { createSocialResolver };
