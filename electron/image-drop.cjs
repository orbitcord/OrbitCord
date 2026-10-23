// Browser drags provide a URL, not a File. Fetch the original without sharing
// Discord's cookies; Discord still owns preview, validation and upload.
const maximumBytes = 50 * 1024 * 1024;
const types = { 'image/png': 'png', 'image/apng': 'apng', 'image/jpeg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp',
    'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
    'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif' };
const failure = code => Object.assign(new Error(code), { code });

function imageUrl(value) {
    if (typeof value !== 'string' || value.length > 16384) throw failure('invalid-url');
    let url;
    try { url = new URL(value); } catch { throw failure('invalid-url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('invalid-url');
    return url;
}
function filename(url, type) {
    let name;
    try { name = decodeURIComponent(url.pathname.split('/').pop()); } catch {}
    name = (name || 'image').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'image';
    const extension = types[type];
    if (!name.toLowerCase().endsWith(`.${extension}`) && !(type === 'image/jpeg' && /\.jpe?g$/i.test(name)))
        name = name.replace(/\.[a-z0-9]{1,5}$/i, '') + `.${extension}`;
    return name;
}
async function downloadImage(value, { fetchPage = fetch } = {}) {
    let url = imageUrl(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let reader;
    try {
        let response;
        for (let redirects = 0; ; redirects++) {
            response = await fetchPage(url.href, { credentials: 'omit', redirect: 'manual', signal: controller.signal,
                headers: { accept: 'image/*' } });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            await response.body?.cancel();
            if (redirects >= 5 || !response.headers.get('location')) throw failure('download-failed');
            url = imageUrl(new URL(response.headers.get('location'), url).href);
        }
        if (!response.ok) throw failure('download-failed');
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (!Object.hasOwn(types, type) || !response.body) throw failure('not-image');
        if (Number(response.headers.get('content-length')) > maximumBytes) throw failure('too-large');
        reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            size += chunk.byteLength;
            if (size > maximumBytes) throw failure('too-large');
            chunks.push(chunk);
        }
        if (!size) throw failure('not-image');
        const bytes = Buffer.concat(chunks, size);
        return { name: filename(url, type), type, data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    } finally {
        clearTimeout(timer);
        controller.abort();
        await reader?.cancel().catch(() => {});
    }
}
module.exports = { downloadImage };
