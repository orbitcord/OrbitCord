const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createVideoAttachments, CHUNK, MAX_SOURCE } = require('../electron/video-attachments.cjs');
const { compressVideo, compressImage, compressGif } = require('../electron/video-compress.cjs');

async function fixture(t, compress, extra = {}) {
    const tempRoot = await mkdtemp(join(tmpdir(), 'attachment-test-'));
    const service = createVideoAttachments({ tempRoot, compress, ...extra });
    t.after(async () => { await service.close(); await rm(tempRoot, { recursive: true, force: true }); });
    return { service, tempRoot };
}
async function fill(service, owner, id, size) {
    let offset = 0;
    while (offset < size) {
        const bytes = new Uint8Array(Math.min(CHUNK, size - offset));
        await service.append(owner, id, bytes); offset += bytes.length;
    }
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(CHUNK + 25)]);
const fakeCompress = async (_input, directory, limit, signal, options) => {
    assert.equal(options.general, true); assert.equal(limit, 20_000_000); signal.throwIfAborted();
    const output = join(directory, 'compressed.mp4'); await writeFile(output, mp4); return output;
};

test('attachment chunks enforce owner, budget, order and complete MP4 output; release removes both files', async t => {
    const { service, tempRoot } = await fixture(t, fakeCompress);
    const size = 20_000_000;
    const { id } = await service.begin(1, { size, limit: size });
    await assert.rejects(service.append(2, id, new Uint8Array(10)), { code: 'expired' });
    await assert.rejects(service.finish(1, id), { code: 'incomplete-input' });
    await assert.rejects(service.append(1, id, new Uint8Array(CHUNK + 1)), { code: 'invalid-chunk' });
    await assert.rejects(service.append(1, id, '../file'), { code: 'invalid-chunk' });
    await fill(service, 1, id, size);
    await assert.rejects(service.append(1, id, new Uint8Array(1)), { code: 'invalid-chunk' });
    assert.deepEqual(await service.finish(1, id), { size: mp4.length, type: 'video/mp4', extension: 'mp4' });
    await assert.rejects(service.read(2, id, 0), { code: 'expired' });
    await assert.rejects(service.read(1, id, -1), { code: 'invalid-read' });
    await assert.rejects(service.read(1, id, mp4.length), { code: 'invalid-read' });
    const first = await service.read(1, id, 0), second = await service.read(1, id, CHUNK);
    assert.equal(first.length, CHUNK);
    assert.deepEqual(Buffer.concat([first, second]), mp4);
    await service.cancel(2, id); // another window cannot release it
    assert.equal((await service.read(1, id, 0)).length, CHUNK);
    await service.cancel(1, id);
    await assert.rejects(service.read(1, id, 0), { code: 'expired' });
    const root = join(tempRoot, (await readdir(tempRoot))[0]);
    assert.deepEqual(await readdir(root), []);
});

test('attachment service rejects arbitrary budgets and oversized sources, bounds jobs and cancels pending creation', async t => {
    const { service } = await fixture(t, fakeCompress);
    for (const options of [{size:MAX_SOURCE + 1,limit:20_000_000}, {size:40_000_000,limit:1}, {size:1,limit:100_000_000}, {size:NaN,limit:20_000_000}, {size:20_000_000,limit:20_000_000,kind:'document'}])
        await assert.rejects(service.begin(1, options), { code: 'invalid-input' });
    const pending = service.begin(1, { size: 20_000_001, limit: 20_000_000 });
    const rejected = assert.rejects(pending, { code: 'cancelled' });
    await service.cancel(1); await rejected;
    const { id } = await service.begin(1, { size: 100_000_001, limit: 100_000_000 });
    await assert.rejects(service.begin(1, { size: 20_000_001, limit: 20_000_000 }), { code: 'busy' });
    await service.cancel(1, id);
});

test('cancellation aborts an encoder and permits a new job without leaving a temporary input', async t => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const { service } = await fixture(t, (_input, _directory, _limit, signal) => new Promise((resolve, reject) => {
        entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const { id } = await service.begin(1, { size: 20_000_000, limit: 20_000_000 });
    await fill(service, 1, id, 20_000_000);
    const finishing = service.finish(1, id), rejected = assert.rejects(finishing, { code: 'cancelled' });
    await started; await service.cancel(1, id); await rejected;
    const next = await service.begin(1, { size: 20_000_000, limit: 20_000_000 });
    await service.cancel(1, next.id);
});

test('encoder output cannot escape the job or exceed its budget', async t => {
    let mode = 'path';
    const { service } = await fixture(t, async (_input, directory) => {
        if (mode === 'path') return join(directory, '..', 'elsewhere.mp4');
        const output = join(directory, 'compressed.mp4');
        await writeFile(output, mode === 'size' ? Buffer.alloc(20_000_000) : 'this is not an mp4');
        return output;
    });
    for (mode of ['path', 'size', 'header']) {
        const { id } = await service.begin(1, { size: 20_000_000, limit: 20_000_000 });
        await fill(service, 1, id, 20_000_000);
        await assert.rejects(service.finish(1, id), { code: mode === 'size' ? 'too-large' : 'invalid-output' });
        await service.cancel(1, id);
    }
});

test('FFmpeg handles local WebM and MP4, serializes concurrent jobs, and honors queued cancellation', async t => {
    const root = await mkdtemp(join(tmpdir(), 'attachment-codec-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { mkdir } = require('node:fs/promises');
    const directories = await Promise.all(['one','two','cancel'].map(async name => { const path = join(root,name); await mkdir(path); return path; }));
    const controller = new AbortController();
    const encode = (file, index, signal = new AbortController().signal) => compressVideo(join(__dirname, 'fixtures/media', file), directories[index], 120_000, signal, { general: true });
    const one = encode('sample.webm', 0), two = encode('sample.mp4', 1), queued = encode('sample.mp4', 2, controller.signal);
    const rejected = assert.rejects(queued, { name: 'AbortError' }); controller.abort();
    const output = await Promise.all([one, two]); await rejected;
    for (const path of output) {
        const bytes = await readFile(path); assert.equal(bytes.toString('ascii',4,8), 'ftyp'); assert.ok(bytes.length < 120_000);
    }
    assert.deepEqual(await readdir(directories[2]), []);
});

test('still-image compression produces a decodable PNG under budget and retains transparency', async t => {
    const { promisify } = require('node:util'); const { execFile } = require('node:child_process');
    const exec = promisify(execFile);
    const directory = await mkdtemp(join(tmpdir(), 'attachment-image-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const input = join(directory, 'transparent.png');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.5:s=32x32,format=rgba', '-frames:v', '1', input]);
    const output = await compressImage(input, directory, 2000, new AbortController().signal);
    const bytes = await readFile(output);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(bytes.length < 2000);
    const { stdout } = await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'crop=1:1:0:0', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    assert.equal(stdout.length, 4); assert.ok(stdout[3] > 100 && stdout[3] < 155, 'transparent pixels must stay transparent');
});

test('GIF attachments use a GIF encoder, validate GIF output, and reject disguised videos', async t => {
    let mode = 'gif';
    const gif = Buffer.from('GIF89a' + 'animation output');
    const { service } = await fixture(t, () => { throw Error('GIF must not use the video encoder'); }, {
        gifCompress: async (_input, directory) => {
            const output = join(directory, 'compressed.gif');
            await writeFile(output, mode === 'gif' ? gif : mp4); return output;
        },
    });
    for (mode of ['gif', 'mp4', 'disguised']) {
        const { id } = await service.begin(1, { size: 20_000_000, limit: 20_000_000, kind: 'gif' });
        const prefix = new Uint8Array(CHUNK);
        if (mode !== 'disguised') prefix.set(Buffer.from('GIF89a'));
        await service.append(1, id, prefix);
        await fill(service, 1, id, 20_000_000 - CHUNK);
        if (mode === 'gif') {
            assert.deepEqual(await service.finish(1, id), { size: gif.length, type: 'image/gif', extension: 'gif' });
            assert.deepEqual(Buffer.from(await service.read(1, id, 0)), gif);
        } else await assert.rejects(service.finish(1, id), { code: mode === 'disguised' ? 'invalid-input' : 'invalid-output' });
        await service.cancel(1, id);
    }
});

test('GIF compression retains transparent pixels and finite loop settings', async t => {
    const { promisify } = require('node:util'); const { execFile } = require('node:child_process');
    const directory = await mkdtemp(join(tmpdir(), 'attachment-gif-alpha-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const input = join(directory, 'transparent.gif');
    const transparent = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const loop = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 3, 0, 0])]);
    await writeFile(input, Buffer.concat([transparent.subarray(0, 19), loop, transparent.subarray(19)]));
    const output = await compressGif(input, directory, 2000, new AbortController().signal);
    const bytes = await readFile(output), marker = bytes.indexOf(Buffer.from('NETSCAPE2.0'));
    assert.ok(marker >= 0); assert.equal(bytes.readUInt16LE(marker + 13), 3);
    const { stdout } = await promisify(execFile)('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    assert.equal(stdout.length, 4); assert.equal(stdout[3], 0);
});
