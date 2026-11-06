const { mkdtemp, mkdir, readdir, rm } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { once } = require('node:events');

// Private, disposable files, not a persistent download history. Finished
// entries stay at the old three-video limit; active readers lease their files.
function createMediaCache({ directory = tmpdir(), maximum = 3 } = {}) {
    const entries = new Map(), pending = new Map(), streams = new Set();
    let root, closed = false, running = 0;
    const queue = [];
    async function folder() {
        if (!root) root = (async () => {
            await mkdir(directory, { recursive: true });
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                const match = /^orbitcord-media-(\d+)-/.exec(entry.name);
                if (!entry.isDirectory() || !match || Number(match[1]) === process.pid) continue;
                try { process.kill(Number(match[1]), 0); }
                catch (error) { if (error.code === 'ESRCH') await rm(join(directory, entry.name), { recursive: true, force: true }).catch(() => {}); }
            }
            return mkdtemp(join(directory, `orbitcord-media-${process.pid}-`));
        })();
        return root;
    }
    async function discard(entry) {
        entry.evicted = true;
        if (!entry.readers) await rm(entry.directory, { recursive: true, force: true }).catch(() => {});
    }
    async function get(key, produce) {
        if (closed) throw new Error('Media cache closed');
        if (entries.has(key)) return entries.get(key);
        if (pending.has(key)) return pending.get(key).work;
        const controller = new AbortController();
        const work = (async () => {
            if (running >= 2) await new Promise(resolve => queue.push(resolve));
            else running++;
            let directory;
            try {
                controller.signal.throwIfAborted();
                directory = await mkdtemp(join(await folder(), 'clip-'));
                controller.signal.throwIfAborted();
                const result = await produce(directory, controller.signal);
                controller.signal.throwIfAborted();
                const entry = { ...result, directory, readers: 0, evicted: false };
                entries.set(key, entry);
                while (entries.size > maximum) {
                    const oldest = entries.keys().next().value;
                    const removed = entries.get(oldest); entries.delete(oldest);
                    await discard(removed);
                }
                return entry;
            } catch (error) {
                if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
                throw error;
            } finally {
                pending.delete(key);
                if (queue.length) queue.shift()(); else running--;
            }
        })();
        pending.set(key, { controller, work });
        return work;
    }
    function response(entry, request) {
        const size = entry.size;
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
        let start = 0, end = size - 1, status = 200;
        if (match && (match[1] || match[2])) {
            start = Math.max(0, match[1] ? Number(match[1]) : size - Number(match[2]));
            end = Math.min(end, match[1] && match[2] ? Number(match[2]) : end);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
                return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
            }
            status = 206;
        }
        const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(Math.max(0, end - start + 1)),
            ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) };
        if (!size || request.method === 'HEAD') return new Response(null, { status, headers });
        entry.readers++;
        const stream = createReadStream(entry.path, { start, end, highWaterMark: 64 * 1024 });
        streams.add(stream);
        const cancel = () => stream.destroy();
        request.signal.addEventListener('abort', cancel, { once: true });
        stream.once('close', () => {
            streams.delete(stream); request.signal.removeEventListener('abort', cancel);
            entry.readers--;
            if (entry.evicted) void discard(entry);
        });
        // Readable.toWeb defaults can otherwise interpret the queue budget as
        // a count of chunks, prefetching an entire large movie into memory.
        const body = Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
        if (request.signal.aborted) cancel();
        return new Response(body, { status, headers });
    }
    let closing;
    function close() {
        return closing ??= (async () => {
            closed = true;
            for (const item of pending.values()) item.controller.abort();
            const readers = [...streams].map(stream => {
                const done = stream.closed ? Promise.resolve() : once(stream, 'close').catch(() => {});
                stream.destroy(); return done;
            });
            await Promise.allSettled([...readers, ...[...pending.values()].map(item => item.work)]);
            entries.clear();
            const directory = root && await root.catch(() => null);
            if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        })();
    }
    return { get, response, close };
}
module.exports = { createMediaCache };
