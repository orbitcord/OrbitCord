const { mkdtemp, open, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { createMediaCache } = require('./media-cache.cjs');

// Cache only bytes the player actually consumes. No tee, background download,
// or full-video memory buffer. Partial ranges are reusable on the next hover.
function createPreviewCache({ directory, maximumBytes = 128 * 1024 * 1024 } = {}) {
    const files = createMediaCache({ directory });
    const entries = new Map(), pending = new Set(), opening = new Set();
    let reserved = 0, closed = false;
    const keyFor = (url, request) => `${url}\n${request.headers.get('range') || ''}`;
    async function discard(entry) {
        reserved -= entry.size; entry.evicted = true;
        if (!entry.readers) await rm(entry.directory, { recursive: true, force: true });
    }
    async function match(url, request) {
        if (closed || request.method !== 'GET') return null;
        const key = keyFor(url, request), entry = entries.get(key);
        if (!entry) return null;
        entries.delete(key); entries.set(key, entry);
        const response = files.response(entry, new Request(request.url, { signal: request.signal }));
        return new Response(response.body, { status: entry.status, headers: entry.headers });
    }
    async function capture(url, request, response) {
        let settled;
        const started = new Promise(resolve => { settled = resolve; });
        opening.add(started);
        try { return await startCapture(url, request, response); }
        finally { opening.delete(started); settled(); }
    }
    async function startCapture(url, request, response) {
        const size = Number(response.headers.get('content-length'));
        if (closed || request.method !== 'GET' || !Number.isSafeInteger(size) || size <= 0 || size > maximumBytes) return response;
        while (entries.size && reserved + size > maximumBytes) {
            const candidate = [...entries].find(([, entry]) => !entry.readers);
            if (!candidate) break;
            const [key, entry] = candidate;
            entries.delete(key); await discard(entry);
        }
        if (reserved + size > maximumBytes) return response;
        reserved += size;
        let folder, file;
        try {
            folder = await mkdtemp(join(directory, 'orbitcord-preview-'));
            file = await open(join(folder, 'media'), 'w');
        } catch { reserved -= size; if (folder) await rm(folder, { recursive: true, force: true }); return response; }
        const reader = response.body.getReader();
        let written = 0, finished = false, settle;
        const done = new Promise(resolve => { settle = resolve; });
        const item = { done, cancel: () => finish(false) }; pending.add(item);
        async function finish(keep) {
            if (finished) return done;
            finished = true;
            request.signal.removeEventListener('abort', aborted);
            try {
                if (!keep) await reader.cancel().catch(() => {});
                await file.close();
                const key = keyFor(url, request), old = entries.get(key);
                if (keep && !closed && written === size && !old?.readers) {
                    if (old) { entries.delete(key); await discard(old); }
                    entries.set(key, { path: join(folder, 'media'), directory: folder, size,
                        readers: 0, evicted: false, status: response.status, headers: new Headers(response.headers) });
                } else { reserved -= size; await rm(folder, { recursive: true, force: true }); }
            } finally { pending.delete(item); settle(); }
        }
        const aborted = () => void finish(false);
        request.signal.addEventListener('abort', aborted, { once: true });
        if (closed || request.signal.aborted) { await finish(false); return new Response(null, { status: 499 }); }
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    const part = await reader.read();
                    if (finished) { controller.close(); return; }
                    if (part.done) { await finish(true); controller.close(); return; }
                    written += part.value.byteLength;
                    if (written > size) { await finish(false); controller.error(new Error('Invalid media length')); return; }
                    await file.writeFile(part.value);
                    controller.enqueue(part.value);
                } catch (error) { await finish(false); controller.error(error); }
            },
            cancel() { return finish(false); },
        }, { highWaterMark: 64 * 1024, size: part => part.byteLength });
        return new Response(body, { status: response.status, headers: response.headers });
    }
    async function close() {
        closed = true;
        await Promise.allSettled([...opening]);
        await Promise.allSettled([...pending].map(item => item.cancel()));
        await Promise.allSettled([...pending].map(item => item.done));
        await files.close();
        await Promise.allSettled([...entries.values()].map(discard)); entries.clear();
    }
    return { match, capture, close };
}
module.exports = { createPreviewCache };
