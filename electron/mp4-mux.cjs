// Joins one video-only and one audio-only fragmented MP4 (Reddit's DASH and
// CMAF files) into a single fragmented MP4, without re-encoding. Fragments are
// copied as-is; only track IDs, sequence numbers and durations are rewritten.
// Anything unexpected throws, so callers can fall back to the video alone.

function boxes(buffer, start = 0, end = buffer.length) {
    const list = [];
    for (let offset = start; offset + 8 <= end;) {
        let size = buffer.readUInt32BE(offset), header = 8;
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        if (size === 1) { size = Number(buffer.readBigUInt64BE(offset + 8)); header = 16; }
        else if (size === 0) size = end - offset;
        if (size < header || offset + size > end) throw new Error(`Malformed ${type} box`);
        list.push({ type, start: offset, header, end: offset + size });
        offset += size;
    }
    return list;
}
const child = (buffer, box, type) => boxes(buffer, box.start + box.header, box.end).find(item => item.type === type);
const children = (buffer, box) => boxes(buffer, box.start + box.header, box.end);
function box(type, ...parts) {
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8); header.write(type, 4, 'latin1');
    return Buffer.concat([header, body]);
}

function fragmentInfo(buffer, moof, defaultDuration) {
    const trafs = children(buffer, moof).filter(item => item.type === 'traf');
    if (trafs.length !== 1) throw new Error('Expected one track fragment');
    const traf = trafs[0], tfhd = child(buffer, traf, 'tfhd'), tfdt = child(buffer, traf, 'tfdt');
    if (!tfhd || !tfdt) throw new Error('Missing fragment header');
    const flags = buffer.readUInt32BE(tfhd.start + 8) & 0xffffff;
    // An absolute base offset would point into the original file.
    if (flags & 0x1) throw new Error('Unsupported base data offset');
    let field = tfhd.start + 16;
    if (flags & 0x2) field += 4;
    const sampleDuration = flags & 0x8 ? buffer.readUInt32BE(field) : defaultDuration;
    const time = buffer[tfdt.start + 8] === 1 ? Number(buffer.readBigUInt64BE(tfdt.start + 12)) : buffer.readUInt32BE(tfdt.start + 12);
    let span = 0;
    for (const trun of children(buffer, traf).filter(item => item.type === 'trun')) {
        const trunFlags = buffer.readUInt32BE(trun.start + 8) & 0xffffff;
        const count = buffer.readUInt32BE(trun.start + 12);
        let cursor = trun.start + 16 + (trunFlags & 0x1 ? 4 : 0) + (trunFlags & 0x4 ? 4 : 0);
        const stride = [0x100, 0x200, 0x400, 0x800].filter(bit => trunFlags & bit).length * 4;
        for (let sample = 0; sample < count; sample++, cursor += stride) {
            span += trunFlags & 0x100 ? buffer.readUInt32BE(cursor) : sampleDuration;
        }
    }
    return { tfhd, time, span };
}

function parseFile(buffer) {
    const top = boxes(buffer);
    const ftyp = top.find(item => item.type === 'ftyp');
    const moov = top.find(item => item.type === 'moov');
    if (!ftyp || !moov) throw new Error('Not an MP4 file');
    const traks = children(buffer, moov).filter(item => item.type === 'trak');
    if (traks.length !== 1) throw new Error('Expected one track');
    const trak = traks[0];
    const mdia = child(buffer, trak, 'mdia'), mdhd = mdia && child(buffer, mdia, 'mdhd');
    if (!mdhd) throw new Error('Missing media header');
    const mdhdVersion = buffer[mdhd.start + 8];
    const timescale = buffer.readUInt32BE(mdhd.start + (mdhdVersion === 1 ? 28 : 20));
    const mvex = child(buffer, moov, 'mvex'), trex = mvex && child(buffer, mvex, 'trex');
    if (!trex) throw new Error('Not a fragmented MP4');
    const defaultDuration = buffer.readUInt32BE(trex.start + 20);
    const fragments = [];
    let duration = 0;
    for (let index = 0; index < top.length; index++) {
        const moof = top[index];
        if (moof.type !== 'moof') continue;
        const mdat = top[index + 1];
        if (mdat?.type !== 'mdat') throw new Error('Fragment without media data');
        const { tfhd, time, span } = fragmentInfo(buffer, moof, defaultDuration);
        duration = Math.max(duration, time + span);
        fragments.push({ moof, mdat, tfhd, time: time / timescale });
    }
    if (!fragments.length) throw new Error('No media fragments');
    return { buffer, ftyp, moov, trak, trex, timescale, duration, fragments };
}

// tkhd, mdhd and mvhd store their duration after version-dependent fields.
function setDuration(buffer, item, value) {
    const version = buffer[item.start + 8];
    const offset = item.start + 12 + (version === 1 ? 16 : 8) + (item.type === 'tkhd' ? (version === 1 ? 8 : 4) : 4);
    if (version === 1) buffer.writeBigUInt64BE(BigInt(Math.round(value)), offset);
    else buffer.writeUInt32BE(Math.min(0xffffffff, Math.round(value)), offset);
}
function trackCopy(file, id, movieScale) {
    const buffer = Buffer.from(file.buffer.subarray(file.trak.start, file.trak.end));
    const trak = { ...file.trak, start: 0, end: buffer.length };
    const tkhd = child(buffer, trak, 'tkhd');
    const mdia = child(buffer, trak, 'mdia');
    const mdhd = child(buffer, mdia, 'mdhd');
    buffer.writeUInt32BE(id, tkhd.start + (buffer[tkhd.start + 8] === 1 ? 28 : 20));
    setDuration(buffer, tkhd, file.duration / file.timescale * movieScale);
    setDuration(buffer, mdhd, file.duration);
    return buffer;
}

function movieParts(video, audio) {
    const mvhdBox = child(video.buffer, video.moov, 'mvhd');
    const mvhd = Buffer.from(video.buffer.subarray(mvhdBox.start, mvhdBox.end));
    const movieScale = mvhd.readUInt32BE(mvhd[8] === 1 ? 28 : 20);
    const seconds = Math.max(video.duration / video.timescale, audio.duration / audio.timescale);
    setDuration(mvhd, { type: 'mvhd', start: 0 }, seconds * movieScale);
    mvhd.writeUInt32BE(3, mvhd.length - 4); // next_track_ID
    const trex = (file, id) => {
        const copy = Buffer.from(file.buffer.subarray(file.trex.start, file.trex.end));
        copy.writeUInt32BE(id, 12);
        return copy;
    };
    const mehd = Buffer.alloc(8); mehd.writeUInt32BE(Math.round(seconds * movieScale), 4);
    const moov = box('moov', mvhd, trackCopy(video, 1, movieScale), trackCopy(audio, 2, movieScale),
        box('mvex', box('mehd', mehd), trex(video, 1), trex(audio, 2)));
    return [Buffer.from(video.buffer.subarray(video.ftyp.start, video.ftyp.end)), moov];
}
function orderedFragments(video, audio) {
    return [...video.fragments.map(item => ({ ...item, file: video, id: 1 })),
        ...audio.fragments.map(item => ({ ...item, file: audio, id: 2 }))].sort((a, b) => a.time - b.time || a.id - b.id);
}
function mux(videoBuffer, audioBuffer) {
    const video = parseFile(videoBuffer), audio = parseFile(audioBuffer);
    const parts = movieParts(video, audio);
    const ordered = orderedFragments(video, audio);
    let sequence = 1;
    for (const fragment of ordered) {
        const { buffer } = fragment.file;
        const moof = Buffer.from(buffer.subarray(fragment.moof.start, fragment.moof.end));
        const local = { type: 'moof', start: 0, header: 8, end: moof.length };
        const mfhd = child(moof, local, 'mfhd');
        if (mfhd) moof.writeUInt32BE(sequence, mfhd.start + 12);
        moof.writeUInt32BE(fragment.id, fragment.tfhd.start - fragment.moof.start + 12);
        sequence++;
        // Sample offsets are relative to the moof, so each pair moves as a unit.
        parts.push(moof, buffer.subarray(fragment.mdat.start, fragment.mdat.end));
    }
    return Buffer.concat(parts);
}
// Disk parsing reads only MP4 headers. mdat payloads are copied in fixed-size
// chunks, so a large movie never becomes a JS Buffer on the playback path.
async function readAt(handle, position, length) {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) throw new Error('Truncated MP4');
        offset += bytesRead;
    }
    return buffer;
}
async function diskBoxes(handle, signal) {
    const end = (await handle.stat()).size, list = [];
    for (let offset = 0; offset + 8 <= end;) {
        signal?.throwIfAborted();
        const head = await readAt(handle, offset, Math.min(16, end - offset));
        let size = head.readUInt32BE(0), header = 8;
        const type = head.toString('latin1', 4, 8);
        if (size === 1) { if (head.length < 16) throw new Error('Truncated MP4'); size = Number(head.readBigUInt64BE(8)); header = 16; }
        else if (size === 0) size = end - offset;
        if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw new Error(`Malformed ${type} box`);
        list.push({ type, start: offset, end: offset + size, header });
        offset += size;
    }
    return list;
}
async function readMetadata(handle, item) {
    if (item.end - item.start > 16 * 1024 * 1024) throw new Error('Oversized MP4 metadata');
    return readAt(handle, item.start, item.end - item.start);
}
async function diskFile(handle, signal) {
    const top = await diskBoxes(handle, signal), ftyp = top.find(item => item.type === 'ftyp'), moov = top.find(item => item.type === 'moov');
    if (!ftyp || !moov) throw new Error('Not an MP4 file');
    const buffer = Buffer.concat([await readMetadata(handle, ftyp), await readMetadata(handle, moov)]);
    // Reuse the exact track/header parser; fragment descriptors are read below.
    const head = boxes(buffer), movie = head.find(item => item.type === 'moov');
    const trak = children(buffer, movie).filter(item => item.type === 'trak');
    if (trak.length !== 1) throw new Error('Expected one track');
    const mdia = child(buffer, trak[0], 'mdia'), mdhd = mdia && child(buffer, mdia, 'mdhd');
    const mvex = child(buffer, movie, 'mvex'), trex = mvex && child(buffer, mvex, 'trex');
    if (!mdhd || !trex) throw new Error('Not a fragmented MP4');
    const timescale = buffer.readUInt32BE(mdhd.start + (buffer[mdhd.start + 8] === 1 ? 28 : 20));
    if (!timescale) throw new Error('Invalid MP4 timescale');
    const defaultDuration = buffer.readUInt32BE(trex.start + 20), fragments = [];
    let duration = 0;
    for (let i = 0; i < top.length; i++) {
        const moof = top[i]; if (moof.type !== 'moof') continue;
        signal?.throwIfAborted();
        const mdat = top[i + 1]; if (mdat?.type !== 'mdat') throw new Error('Fragment without media data');
        const data = await readMetadata(handle, moof);
        const local = boxes(data)[0], info = fragmentInfo(data, local, defaultDuration);
        duration = Math.max(duration, info.time + info.span);
        fragments.push({ moof, mdat, tfhdOffset: info.tfhd.start, time: info.time / timescale });
    }
    if (!fragments.length) throw new Error('No media fragments');
    return { handle, buffer, ftyp: head.find(item => item.type === 'ftyp'), moov: movie, trak: trak[0], trex, timescale, duration, fragments };
}
async function muxToFile(videoPath, audioPath, outputPath, { signal } = {}) {
    const { open, rm } = require('node:fs/promises');
    const handles = [];
    let output, created = false, size = 0;
    try {
        signal?.throwIfAborted();
        const videoHandle = await open(videoPath, 'r'); handles.push(videoHandle);
        const audioHandle = await open(audioPath, 'r'); handles.push(audioHandle);
        const video = await diskFile(videoHandle, signal), audio = await diskFile(audioHandle, signal);
        output = await open(outputPath, 'wx', 0o600); created = true; handles.push(output);
        const write = async buffer => {
            let offset = 0;
            while (offset < buffer.length) {
                signal?.throwIfAborted();
                const { bytesWritten } = await output.write(buffer, offset, buffer.length - offset);
                if (!bytesWritten) throw new Error('MP4 write failed');
                offset += bytesWritten; size += bytesWritten;
            }
        };
        for (const part of movieParts(video, audio)) await write(part);
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let sequence = 1;
        for (const fragment of orderedFragments(video, audio)) {
            const moof = await readMetadata(fragment.file.handle, fragment.moof);
            const mfhd = child(moof, boxes(moof)[0], 'mfhd');
            if (mfhd) moof.writeUInt32BE(sequence, mfhd.start + 12);
            sequence++;
            moof.writeUInt32BE(fragment.id, fragment.tfhdOffset + 12);
            await write(moof);
            for (let offset = fragment.mdat.start; offset < fragment.mdat.end;) {
                signal?.throwIfAborted();
                const { bytesRead } = await fragment.file.handle.read(chunk, 0, Math.min(chunk.length, fragment.mdat.end - offset), offset);
                if (!bytesRead) throw new Error('Truncated media data');
                await write(chunk.subarray(0, bytesRead)); offset += bytesRead;
            }
        }
        return { size };
    } catch (error) {
        await Promise.allSettled(handles.map(handle => handle.close())); handles.length = 0;
        if (created) await rm(outputPath, { force: true }).catch(() => {});
        throw error;
    } finally { await Promise.allSettled(handles.map(handle => handle.close())); }
}
module.exports = { mux, muxToFile };
