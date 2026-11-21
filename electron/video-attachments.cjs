const { randomBytes } = require('node:crypto');
const { mkdtemp, open, stat, rm, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { compressVideo, compressImage, compressGif, editVideo, checkEdit, MAX_CLIPS } = require('./video-compress.cjs');

const CHUNK = 1024 * 1024, MAX_SOURCE = 2 * 1024 ** 3;
const fail = code => Object.assign(new Error(code), { code });

// The page sends File bytes, never paths. Tokens belong to one trusted window;
// ordered chunks avoid buffering the original movie in the renderer or IPC.
function createVideoAttachments({ tempRoot = tmpdir(), compress = compressVideo, imageCompress = compressImage, gifCompress = compressGif, videoEdit = editVideo } = {}) {
    const jobs = new Map();
    let closed = false, root;
    async function folder() {
        return root ??= (async () => {
            for (const entry of await readdir(tempRoot, { withFileTypes: true })) {
                const match = /^orbitcord-upload-(\d+)-/.exec(entry.name);
                if (!entry.isDirectory() || !match || Number(match[1]) === process.pid) continue;
                try { process.kill(Number(match[1]), 0); }
                catch (error) { if (error.code === 'ESRCH') await rm(join(tempRoot, entry.name), { recursive: true, force: true }); }
            }
            return mkdtemp(join(tempRoot, `orbitcord-upload-${process.pid}-`));
        })();
    }
    function touch(job) {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => void cancel(job.owner, job.id), 20 * 60_000);
        job.timer.unref?.();
    }
    function get(owner, id) {
        const job = jobs.get(id);
        if (!job || job.owner !== owner || job.controller.signal.aborted || closed) throw fail('expired');
        touch(job);
        return job;
    }
    async function step(job, run) {
        if (job.work) throw fail('busy');
        const work = Promise.resolve().then(() => { job.controller.signal.throwIfAborted(); return run(); });
        job.work = work;
        try { return await work; } finally { job.work = null; }
    }
    async function cancel(owner, id) {
        const selected = [...jobs.values()].filter(job => job.owner === owner && (id === undefined || job.id === id));
        await Promise.all(selected.map(job => job.cleanup ??= (async () => {
            job.controller.abort(fail('cancelled'));
            clearTimeout(job.timer);
            await job.work?.catch(() => {});
            await job.file?.close().catch(() => {});
            await job.output?.close().catch(() => {});
            if (job.directory) await rm(job.directory, { recursive: true, force: true }).catch(() => {});
            if (jobs.get(job.id) === job) jobs.delete(job.id);
        })()));
    }
    async function begin(owner, options) {
        const { limit, kind = 'video', edit } = options ?? {};
        // An edit (Edit photos on a video) takes one file per clip, sent in
        // order, and has no size target, only the source cap.
        const sizes = kind === 'edit' ? options.sizes : [options?.size];
        const size = Array.isArray(sizes) ? sizes.reduce((sum, value) => sum + value, 0) : NaN;
        if (kind === 'edit') {
            if (!Array.isArray(sizes) || !sizes.length || sizes.length > MAX_CLIPS || !sizes.every(value => Number.isSafeInteger(value) && value > 0) || size > MAX_SOURCE) throw fail('invalid-input');
            checkEdit(edit, sizes.length);
        } else if (!['video', 'image', 'gif'].includes(kind) || ![20_000_000, 100_000_000].includes(limit) || !Number.isSafeInteger(size) || size < limit || size > MAX_SOURCE) throw fail('invalid-input');
        if (closed) throw fail('expired');
        if (jobs.size >= 4 || [...jobs.values()].some(job => job.owner === owner)) throw fail('busy');
        const id = randomBytes(18).toString('hex');
        const job = { id, owner, size, sizes, limit, kind, edit, written: 0, part: 0, partWritten: 0, state: 'writing', controller: new AbortController() };
        jobs.set(id, job); touch(job);
        try {
            await step(job, async () => {
                job.directory = await mkdtemp(join(await folder(), 'video-'));
                job.inputs = sizes.map((_, index) => join(job.directory, `input-${index}.video`));
                job.input = job.inputs[0];
                job.file = await open(job.input, 'wx', 0o600);
                job.controller.signal.throwIfAborted();
            });
            return { id };
        } catch (error) { await cancel(owner, id); throw error; }
    }
    async function append(owner, id, bytes) {
        const job = get(owner, id);
        // A chunk never spans two clips' files.
        if (job.state !== 'writing' || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK || job.partWritten + bytes.length > job.sizes[job.part]) throw fail('invalid-chunk');
        return step(job, async () => {
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesWritten } = await job.file.write(bytes, offset, bytes.length - offset, job.partWritten + offset);
                if (!bytesWritten) throw fail('write-failed');
                offset += bytesWritten;
            }
            job.written += bytes.length; job.partWritten += bytes.length;
            if (job.partWritten === job.sizes[job.part] && job.part + 1 < job.sizes.length) {
                await job.file.close(); job.file = null;
                job.part++; job.partWritten = 0;
                job.file = await open(job.inputs[job.part], 'wx', 0o600);
            }
        });
    }
    async function finish(owner, id) {
        const job = get(owner, id);
        if (job.state !== 'writing' || job.written !== job.size) throw fail('incomplete-input');
        return step(job, async () => {
            job.state = 'encoding';
            await job.file.close(); job.file = null;
            if (job.kind === 'edit') {
                const path = await videoEdit(job.inputs, job.directory, job.controller.signal, job.edit);
                job.controller.signal.throwIfAborted();
                if (path !== join(job.directory, 'edited.mp4')) throw fail('invalid-output');
                const info = await stat(path);
                if (!info.isFile() || info.size < 12 || info.size > MAX_SOURCE) throw fail('invalid-output');
                job.output = await open(path, 'r');
                const header = Buffer.alloc(12); await job.output.read(header, 0, 12, 0);
                if (header.toString('ascii', 4, 8) !== 'ftyp') throw fail('invalid-output');
                await Promise.all(job.inputs.map(input => rm(input, { force: true })));
                job.outputSize = info.size; job.state = 'ready';
                return { size: info.size, type: 'video/mp4', extension: 'mp4' };
            }
            const source = await open(job.input, 'r');
            const prefix = Buffer.alloc(Math.min(job.size, 64 * 1024));
            try { await source.read(prefix, 0, prefix.length, 0); } finally { await source.close(); }
            const gif = /^GIF8[79]a/.test(prefix.toString('ascii', 0, 6));
            if (job.kind === 'gif' && !gif) throw fail('invalid-input');
            const animated = gif
                || prefix.toString('ascii', 8, 12) === 'WEBP' && prefix.includes(Buffer.from('ANIM'))
                || prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && prefix.includes(Buffer.from('acTL'));
            const image = job.kind === 'image' && !animated;
            const extension = gif ? 'gif' : image ? 'png' : 'mp4', type = gif ? 'image/gif' : image ? 'image/png' : 'video/mp4';
            const path = await (gif ? gifCompress : image ? imageCompress : compress)(job.input, job.directory, job.limit, job.controller.signal, { general: true });
            job.controller.signal.throwIfAborted();
            // Encoders may be injected in tests, but no encoder gets to escape
            // this job directory or return an oversized/incomplete attachment.
            if (path !== join(job.directory, `compressed.${extension}`)) throw fail('invalid-output');
            const info = await stat(path);
            if (!info.isFile() || info.size < 12 || info.size >= job.limit) throw fail('too-large');
            job.output = await open(path, 'r');
            const header = Buffer.alloc(12); await job.output.read(header, 0, 12, 0);
            if (gif ? !/^GIF8[79]a/.test(header.toString('ascii', 0, 6)) : image ? !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
                : header.toString('ascii', 4, 8) !== 'ftyp') throw fail('invalid-output');
            await rm(job.input); // original is no longer needed
            job.outputSize = info.size; job.state = 'ready';
            return { size: info.size, type, extension };
        });
    }
    async function read(owner, id, offset) {
        const job = get(owner, id);
        if (job.state !== 'ready' || !Number.isSafeInteger(offset) || offset < 0 || offset >= job.outputSize) throw fail('invalid-read');
        return step(job, async () => {
            const bytes = Buffer.alloc(Math.min(CHUNK, job.outputSize - offset));
            const { bytesRead } = await job.output.read(bytes, 0, bytes.length, offset);
            if (bytesRead !== bytes.length) throw fail('incomplete-output');
            return new Uint8Array(bytes);
        });
    }
    async function close() {
        closed = true;
        await Promise.all([...new Set([...jobs.values()].map(job => job.owner))].map(owner => cancel(owner)));
        const directory = root && await root.catch(() => null);
        if (directory) await rm(directory, { recursive: true, force: true });
    }
    return { begin, append, finish, read, cancel, close };
}
module.exports = { createVideoAttachments, CHUNK, MAX_SOURCE };
