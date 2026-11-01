const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, apply } = require('../src-tauri/injection/privacy-media.js');

const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length + 8); head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
};
const full = (type, ...parts) => box(type, Buffer.alloc(4), ...parts);
const dated = (type, rest = 12) => { const b = Buffer.alloc(8 + rest); b.fill(7, 0, 8); return full(type, b); };
const uint = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((value, i) => b.writeUInt32BE(value, i * 4)); return b; };
const handler = kind => full('hdlr', Buffer.alloc(4), kind, Buffer.alloc(16));
const reader = bytes => async (offset, length) => new Uint8Array(bytes.subarray(offset, offset + length));
const clean = async bytes => {
    const patches = await plan(reader(bytes), bytes.length);
    return patches && Buffer.from(await apply(new Blob([bytes]), patches).arrayBuffer());
};
function movie({ gps = 'GPS +51.5-0.1/', samples = 'SENSOR-A|SENSOR-B' } = {}) {
    const ftyp = box('ftyp', 'isom', uint(0), 'isom');
    const build = offset => box('moov', dated('mvhd', 90),
        box('udta', box('\xa9xyz', gps)), box('meta', full('hdlr', Buffer.alloc(20)), box('ilst', 'iPhone 15')),
        box('trak', dated('tkhd', 70), box('udta', 'track note'), box('mdia', dated('mdhd'), handler('vide'), box('minf', 'video table'))),
        box('trak', dated('tkhd', 70), box('mdia', dated('mdhd'), handler('meta'), box('minf', box('stbl',
            full('stsz', uint(0, 2, 8, 9)), full('stsc', uint(1, 1, 2, 1)), full('stco', uint(1, offset)))))));
    const size = build(0).length, offset = ftyp.length + size + 8 + 'PICTURE'.length;
    return Buffer.concat([ftyp, build(offset), box('mdat', 'PICTURE', samples, 'AUDIO')]);
}

test('MP4 metadata boxes, dates and sensor samples are gone while size and media bytes stay', async () => {
    const source = movie(), output = await clean(source);
    assert.equal(output.length, source.length);
    for (const secret of ['GPS +51.5', 'iPhone 15', 'track note', 'SENSOR-A', 'SENSOR-B']) assert.equal(output.includes(Buffer.from(secret)), false, secret);
    for (const kept of ['PICTURE', 'AUDIO', 'video table', 'ftyp', 'vide']) assert.equal(output.includes(Buffer.from(kept)), true, kept);
    assert.equal(output.includes(Buffer.alloc(8, 7)), false);
    assert.equal(output.indexOf('PICTURE'), source.indexOf('PICTURE'));
});
test('a 64-bit box and a box running to the end of the file are handled', async () => {
    const head = Buffer.alloc(16); head.writeUInt32BE(1); head.write('uuid', 4); head.writeBigUInt64BE(BigInt(16 + 6), 8);
    const open = Buffer.alloc(8); open.write('mdat', 4);
    const source = Buffer.concat([movie(), head, Buffer.from('SECRET'), open, Buffer.from('tail')]);
    const output = await clean(source);
    assert.equal(output.includes(Buffer.from('SECRET')), false);
    assert.equal(output.readBigUInt64BE(source.indexOf('uuid') + 4), 22n);
    assert.equal(output.includes(Buffer.from('tail')), true);
});
test('files that are not ISO media return null, so they upload as other formats do', async () => {
    for (const bytes of [Buffer.from('original bytes'), Buffer.from([4, 5]), Buffer.alloc(0)]) assert.equal(await plan(reader(bytes), bytes.length), null);
});
test('a recognised file that cannot be cleaned is refused rather than passed through', async () => {
    const truncated = movie(); truncated.writeUInt32BE(truncated.length * 2, 0);
    await assert.rejects(plan(reader(truncated), truncated.length));
    const compressed = Buffer.concat([box('ftyp', 'qt  ', uint(0)), box('moov', box('cmov', 'zlib')), box('mdat', 'x')]);
    await assert.rejects(plan(reader(compressed), compressed.length));
    const outside = Buffer.from(movie()); outside.writeUInt32BE(1, outside.indexOf('stco') + 12);
    await assert.rejects(plan(reader(outside), outside.length));
    const fragmented = Buffer.concat([movie(), box('moof', 'x')]);
    await assert.rejects(plan(reader(fragmented), fragmented.length));
});
test('HEIF zeroes the Exif and XMP items and keeps the picture', async () => {
    const infe = (id, type) => { const b = Buffer.alloc(9 + type.length); b.writeUInt16BE(id); b.write(type, 4); return full('infe', b).fill(2, 8, 9); };
    const location = (id, offset, length) => { const b = Buffer.alloc(14); b.writeUInt16BE(id, 0); b.writeUInt16BE(1, 4); b.writeUInt32BE(offset, 6); b.writeUInt32BE(length, 10); return b; };
    const ftyp = box('ftyp', 'heic', uint(0), 'mif1heic');
    const build = (exif, picture) => { const b = Buffer.alloc(2); b.writeUInt16BE(3);
        const head = Buffer.from([0x44, 0x00, 0, 3]);
        return full('meta', handler('pict'), full('iinf', b, infe(1, 'hvc1'), infe(2, 'Exif'), infe(3, 'mime')),
            full('iloc', head, location(1, picture, 7), location(2, exif, 11), location(3, exif + 11, 6))); };
    const size = build(0, 0).length, start = ftyp.length + size + 8;
    const source = Buffer.concat([ftyp, build(start + 7, start), box('mdat', 'PICTURE', 'GPS-SECRET!', '<xmp/>')]);
    const output = await clean(source);
    assert.equal(output.includes(Buffer.from('GPS-SECRET')), false);
    assert.equal(output.includes(Buffer.from('<xmp/>')), false);
    assert.equal(output.includes(Buffer.from('PICTURE')), true);
    assert.equal(output.length, source.length);
});
