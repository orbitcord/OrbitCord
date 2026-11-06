// Small, allowlisted HTTPS fetches for the page, and the full-quality image
// rewrite. Pure helpers: main.cjs supplies net.fetch.
const HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'i.scdn.co', 'media.tenor.com', 'c.tenor.com', 'static.klipy.com', 'tenor.googleapis.com',
    'translate.googleapis.com', 'lh3.googleusercontent.com', 'i.ytimg.com', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']);
const DEFAULT_MAX = 8 * 1024 * 1024, HARD_MAX = 64 * 1024 * 1024;

function remoteUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname)) throw new Error('Host not allowed');
    return url;
}

async function fetchRemote(value, options, fetchImpl) {
    const url = remoteUrl(value);
    const { range, as = 'bytes' } = options ?? {};
    if (!['bytes', 'text', 'dataUrl'].includes(as)) throw new Error('Invalid format');
    const requested = options?.maxBytes === undefined ? DEFAULT_MAX : options.maxBytes;
    if (!Number.isFinite(requested) || requested <= 0) throw new Error('Invalid size limit');
    const maxBytes = Math.min(requested, HARD_MAX);
    const headers = {};
    if (range !== undefined) {
        if (!Array.isArray(range) || range.length !== 2 || !range.every(n => Number.isSafeInteger(n) && n >= 0) || range[1] < range[0]) throw new Error('Invalid range');
        headers.Range = `bytes=${range[0]}-${range[1]}`;
    }
    const response = await fetchImpl(url.href, { headers, credentials: 'omit', redirect: 'error' }).catch(() => { throw new Error('Request failed'); });
    if (Number(response.headers.get('content-length')) > maxBytes && response.status !== 206) { response.body?.cancel?.().catch(() => {}); throw new Error('Response too large'); }
    const chunks = [];
    let total = 0;
    if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
            const { done, value: chunk } = await reader.read().catch(() => { throw new Error('Request failed'); });
            if (done) break;
            total += chunk.length;
            if (total > maxBytes) { reader.cancel().catch(() => {}); throw new Error('Response too large'); }
            chunks.push(chunk);
        }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const type = response.headers.get('content-type') ?? '';
    const body = as === 'text' ? new TextDecoder().decode(bytes)
        : as === 'dataUrl' ? `data:${type.split(';')[0] || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}` : bytes;
    return { status: response.status, headers: { 'content-type': type, 'content-length': response.headers.get('content-length') ?? '',
        'content-range': response.headers.get('content-range') ?? '' }, body };
}

// media.discordapp.net/attachments/... -> cdn.discordapp.com/attachments/...,
// keeping the signature parameters. Returns null when the URL is not eligible.
function fullQualityUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'media.discordapp.net' || !url.pathname.startsWith('/attachments/')
        || !/\.(?:png|jpe?g|webp|gif|avif)$/i.test(url.pathname)) return null;
    const next = new URL(`https://cdn.discordapp.com${url.pathname}`);
    for (const key of ['ex', 'is', 'hm']) if (url.searchParams.has(key)) next.searchParams.set(key, url.searchParams.get(key));
    return next.href;
}

module.exports = { fetchRemote, fullQualityUrl, remoteUrl, HOSTS };
