const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createVideoAttachments, CHUNK, MAX_SOURCE } = require('../electron/video-attachments.cjs');
const { compressVideo, compressImage, compressGif, editVideo, checkEdit, editGraph } = require('../electron/video-compress.cjs');

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

const edit = { transpose: 1, hflip: false, vflip: true, width: 90, height: 160, mute: false, clips: [{ start: 0, end: 1 }],
    crop: { x: 3, y: 35, width: 85, height: 90 }, boxes: [{ x: 0, y: 40, width: 20, height: 20 }] };
const probe = (path, entries) => require('node:child_process').execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', path]).toString().trim();
test('video edits are checked numbers, and the filter graph is built from them', () => {
    const one = editGraph(checkEdit(edit, 1), [true]);
    assert.equal(one.graph, '[0:v]scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p[v0];'
        + '[0:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a0];[v0][a0]concat=n=1:v=1:a=1[joined][sound];'
        + '[joined]transpose=1,vflip,drawbox=x=0:y=40:w=20:h=20:color=black:t=fill,crop=84:90:3:35,setsar=1,format=yuv420p[out]');
    assert.equal(one.sound, true);
    // Two clips, the second silent: it gets silence of its trimmed length. Muted: no audio at all.
    const two = editGraph(checkEdit({ ...edit, clips: [{ start: 0, end: 1 }, { start: .5, end: 2 }] }, 2), [true, false]);
    assert.match(two.graph, /fps=30.*anullsrc=r=48000:cl=stereo,atrim=duration=1\.500\[a1\];\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1/);
    assert.equal(editGraph(checkEdit({ ...edit, mute: true }, 1), [true]).sound, false);
    for (const bad of [null, { ...edit, transpose: '1,hflip' }, { ...edit, transpose: 4 }, { ...edit, hflip: 1 }, { ...edit, width: 1.5 }, { ...edit, mute: 'yes' },
        { ...edit, crop: { x: 50, y: 0, width: 41, height: 10 } }, { ...edit, crop: { x: 0, y: 0, width: 0, height: 10 } },
        { ...edit, boxes: [{ x: 0, y: 0, width: '20', height: 20 }] }, { ...edit, boxes: Array(65).fill({ x: 0, y: 0, width: 1, height: 1 }) },
        { ...edit, clips: [] }, { ...edit, clips: Array(6).fill({ start: 0, end: 1 }) }, { ...edit, clips: [{ start: 1, end: 1.05 }] },
        { ...edit, clips: [{ start: '0', end: 1 }] }, { ...edit, clips: [{ start: 0, end: Infinity }] }])
        assert.throws(() => checkEdit(bad, bad?.clips?.length), { code: 'invalid-edit' });
    assert.throws(() => checkEdit(edit, 2), { code: 'invalid-edit' }); // one clip per file
});
test('an edit job takes one file per clip, needs no size budget, and returns the edited MP4', async t => {
    const seen = [];
    const videoEdit = async (inputs, directory, signal, value) => {
        seen.push([await Promise.all(inputs.map(input => readFile(input))), value]); signal.throwIfAborted();
        const output = join(directory, 'edited.mp4'); await writeFile(output, mp4); return output;
    };
    const { service } = await fixture(t, fakeCompress, { videoEdit });
    const joined = { ...edit, clips: [{ start: 0, end: 1 }, { start: 0, end: 2 }] };
    await assert.rejects(service.begin(1, { sizes: [10, 5], kind: 'edit', edit: { ...joined, transpose: 'x' } }), { code: 'invalid-edit' });
    await assert.rejects(service.begin(1, { sizes: [10], kind: 'edit', edit: joined }), { code: 'invalid-edit' });
    await assert.rejects(service.begin(1, { sizes: [MAX_SOURCE, 1], kind: 'edit', edit: joined }), { code: 'invalid-input' });
    const { id } = await service.begin(1, { sizes: [10, 5], kind: 'edit', edit: joined });
    // A chunk may not run past its clip's file.
    await assert.rejects(service.append(1, id, new Uint8Array(11)), { code: 'invalid-chunk' });
    await service.append(1, id, new Uint8Array(10).fill(1));
    await service.append(1, id, new Uint8Array(5).fill(2));
    assert.deepEqual(await service.finish(1, id), { size: mp4.length, type: 'video/mp4', extension: 'mp4' });
    assert.deepEqual(seen[0][0].map(bytes => [...new Set(bytes)]), [[1], [2]]);
    assert.deepEqual(seen[0][1], joined);
    await service.cancel(1, id);
});
test('FFmpeg trims, rotates, covers and crops a real video', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'attachment-edit-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(__dirname, 'fixtures/media/sample.webm');
    const output = await editVideo([source], directory, new AbortController().signal, { ...edit, clips: [{ start: .2, end: .7 }] });
    assert.equal(probe(output, 'stream=codec_type,width,height'), 'video,84,90\\naudio'.replace('\\n', '\n'));
    assert.ok(Math.abs(Number(probe(output, 'format=duration')) - .5) < .15);
    const pixels = require('node:child_process').execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    // Box (0,40)-(20,60) lands at (0,5)-(17,25) of the crop.
    assert.ok(pixels[10 * 84 + 5] < 24, 'covered area is black');
});
test('FFmpeg joins differently sized clips into the first frame, and can drop the sound', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'attachment-join-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const media = join(__dirname, 'fixtures/media');
    const plain = { transpose: null, hflip: false, vflip: false, width: 160, height: 90, boxes: [], crop: { x: 0, y: 0, width: 160, height: 90 } };
    const clips = [{ start: 0, end: .5 }, { start: 0, end: .5 }];
    // A square clip with no sound: letterboxed into 160×90 and filled with silence.
    const square = join(directory, 'square.mp4');
    require('node:child_process').execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', square]);
    const joined = await editVideo([join(media, 'sample.webm'), square], directory, new AbortController().signal, { ...plain, mute: false, clips });
    assert.equal(probe(joined, 'stream=codec_type,width,height'), 'video,160,90\naudio');
    assert.ok(Math.abs(Number(probe(joined, 'format=duration')) - 1) < .2);
    const last = require('node:child_process').execFileSync('ffmpeg', ['-v', 'error', '-sseof', '-0.1', '-i', joined, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const pixel = (x, y) => [...last.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
    assert.ok(pixel(80, 45)[0] > 200 && pixel(80, 45)[1] < 60, 'the square clip fills the middle');
    assert.ok(pixel(5, 45).every(value => value < 24), 'with black bars at the sides');
    const quiet = await editVideo([join(media, 'sample.mp4')], directory, new AbortController().signal, { ...plain, mute: true, clips: [clips[0]] });
    assert.equal(probe(quiet, 'stream=codec_type'), 'video');
});
