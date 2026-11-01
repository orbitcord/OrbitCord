const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { sanitizeImage, inspectAttachment, pngChunk } = require('../electron/privacy-files.cjs');
const inspect = (bytes, name) => inspectAttachment({ name, size: bytes.length, read: async (at, count) => bytes.subarray(at, at + count) });
function zip(names, { encrypted = false, nested = false } = {}) {
    const chunks = [], locals = [];
    for (const name of names) {
        const bytes = Buffer.from(name), local = Buffer.alloc(30 + bytes.length), entry = Buffer.alloc(46 + bytes.length);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(bytes.length, 26); bytes.copy(local, 30);
        entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(encrypted ? 1 : 0, 8);
        entry.writeUInt16LE(bytes.length, 28); bytes.copy(entry, 46); chunks.push(entry); locals.push(local);
    }
    const local = Buffer.concat(locals), directory = Buffer.concat(chunks), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(local.length, 16);
    return Buffer.concat([local, directory, end]);
}
test('PNG strips metadata and trailing payload, preserving image and color chunks byte-for-byte', () => {
    const source = readFileSync('tests/fixtures/media/sample.png');
    const chunk = pngChunk('tEXt', Buffer.from('Author\0Private Person GPS 12,34'));
    const input = Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33), Buffer.from('private trailing data')]);
    const result = sanitizeImage(input);
    assert.equal(result.status, 'processed');
    assert.equal(Buffer.from(result.bytes).includes(Buffer.from('Private Person')), false);
    assert.deepEqual(Buffer.from(result.bytes), source);
});
test('malformed CRC and truncated supported images never receive a processed result', () => {
    const png = readFileSync('tests/fixtures/media/sample.png');
    const corrupt = Buffer.from(png); corrupt[30] ^= 255;
    assert.equal(sanitizeImage(corrupt).status, 'uninspectable');
    assert.equal(sanitizeImage(png.subarray(0, -5)).status, 'uninspectable');
    assert.equal(sanitizeImage(Buffer.from([255, 216, 255, 225, 255, 255])).status, 'uninspectable');
});
test('JPEG retains only orientation from EXIF and preserves entropy bytes', () => {
    const tiff = Buffer.from('49492a0008000000010012010300010000000600000000000000', 'hex');
    const metadata = Buffer.concat([Buffer.from('Exif\0\0'), tiff, Buffer.from('SECRET GPS')]);
    const marker = (kind, value) => { const b = Buffer.alloc(value.length + 4); b[0] = 255; b[1] = kind; b.writeUInt16BE(value.length + 2, 2); value.copy(b, 4); return b; };
    const entropy = Buffer.from([1, 2, 255, 0, 3, 255, 208, 4]);
    const source = Buffer.concat([Buffer.from([255, 216]), marker(225, metadata), marker(254, Buffer.from('Private comment')), marker(218, Buffer.alloc(0)), entropy, Buffer.from([255, 217])]);
    const result = sanitizeImage(source), output = Buffer.from(result.bytes);
    assert.equal(result.status, 'processed');
    assert.equal(output.includes(Buffer.from('SECRET')), false);
    assert.equal(output.includes(Buffer.from('Private')), false);
    assert.equal(output.includes(tiff), true);
    assert.equal(output.includes(entropy), true);
});
test('WebP removes EXIF/XMP, adjusts RIFF flags/length and retains animation data', () => {
    const chunk = (name, bytes) => { const b = Buffer.alloc(8 + bytes.length + (bytes.length & 1)); b.write(name); b.writeUInt32LE(bytes.length, 4); bytes.copy(b, 8); return b; };
    const extended = Buffer.alloc(10); extended[0] = 0x0e;
    const body = Buffer.concat([chunk('VP8X', extended), chunk('ANIM', Buffer.alloc(6)), chunk('ANMF', Buffer.from('animation payload')), chunk('EXIF', Buffer.from('secret')), chunk('XMP ', Buffer.from('secret'))]);
    const header = Buffer.from('524946460000000057454250', 'hex'); header.writeUInt32LE(body.length + 4, 4);
    const output = Buffer.from(sanitizeImage(Buffer.concat([header, body])).bytes);
    assert.equal(output.readUInt32LE(4), output.length - 8);
    assert.equal(output[20], 2);
    assert.equal(output.includes(Buffer.from('secret')), false);
    assert.equal(output.includes(Buffer.from('animation payload')), true);
});
test('GIF comments are removed without changing frame/loop data', () => {
    const source = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 6]), Buffer.from('secret'), Buffer.from([0])]);
    const output = sanitizeImage(Buffer.concat([source.subarray(0, -1), comment, source.subarray(-1)]));
    assert.equal(output.status, 'processed'); assert.deepEqual(Buffer.from(output.bytes), source);
});
test('unsupported files are unchanged and explicitly unsupported', () => {
    assert.equal(sanitizeImage(Buffer.from('not an image')).status, 'unsupported');
});
test('JPEG embedded thumbnails and non-color APP2 data are removed', () => {
    const jfif = Buffer.concat([Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 1, 1]), Buffer.from('SECRET THUMBNAIL')]);
    const segment = (marker, value) => { const out = Buffer.alloc(value.length + 4); out[0] = 255; out[1] = marker; out.writeUInt16BE(value.length + 2, 2); value.copy(out, 4); return out; };
    const input = Buffer.concat([Buffer.from([255, 216]), segment(0xe0, jfif), segment(0xe2, Buffer.from('SECRET FLASHPIX')), segment(0xda, Buffer.alloc(0)), Buffer.from([1, 2, 255, 217])]);
    const output = sanitizeImage(input);
    assert.equal(output.status, 'processed'); assert.equal(Buffer.from(output.bytes).includes(Buffer.from('SECRET')), false);
    assert.equal(Buffer.from(output.bytes).includes(Buffer.from('JFIF')), true);
});
test('disguised executables and direction-changing file names explain the risk', async () => {
    const result = await inspect(Buffer.from('MZnotreallyaphoto'), 'invoice.pdf.exe');
    assert.equal(result.status, 'warning'); assert.ok(result.reasons.some(r => /double extension/.test(r)));
    assert.equal((await inspect(Buffer.from('MZpayload'), 'photo.png')).status, 'warning');
    assert.equal((await inspect(Buffer.from('data'), 'photo\u202egnp.exe')).status, 'warning');
});
test('ZIP inspection reports scripts and traversal without extracting entries', async () => {
    const result = await inspect(zip(['images/photo.png', 'run.ps1', '../outside.txt']), 'photos.zip');
    assert.equal(result.status, 'warning'); assert.deepEqual(result.entries, ['run.ps1']);
    assert.ok(result.reasons.some(r => /escape/.test(r)));
});
test('ZIP inspection identifies app bundles and Office macro payloads', async () => {
    const result = await inspect(zip(['Photo.app/Contents/MacOS/Photo', 'word/vbaProject.bin']), 'photos.zip');
    assert.equal(result.status, 'warning'); assert.equal(result.entries.length, 2);
});
test('encrypted, nested and unsupported archives never imply complete inspection', async () => {
    const encrypted = await inspect(zip(['file.txt'], { encrypted: true }), 'protected.zip');
    assert.equal(encrypted.status, 'uninspectable'); assert.equal(encrypted.complete, false);
    assert.equal((await inspect(zip(['inside.zip']), 'outer.zip')).complete, false);
    assert.equal((await inspect(Buffer.from('Rar!'), 'files.rar')).status, 'uninspectable');
    assert.equal((await inspect(Buffer.from('PK\x03\x04broken'), 'broken.zip')).status, 'uninspectable');
});
test('ZIP directory reads and entry counts are bounded', async () => {
    const source = zip(['file.txt']); source.writeUInt32LE(20_000_000, source.length - 10);
    let maximum = 0;
    const result = await inspectAttachment({ name: 'huge.zip', size: source.length, read: async (at, count) => { maximum = Math.max(maximum, count); return source.subarray(at, at + count); } });
    assert.equal(result.status, 'uninspectable'); assert.ok(maximum < 100_000);
});
test('plain text is identified; scripts and disk images are never reported clean', async () => {
    assert.equal((await inspect(Buffer.from('name,city\nAda,London\n'), 'people.csv')).status, 'checked');
    assert.equal((await inspect(Buffer.from('café notes\n'), 'notes.txt')).status, 'checked');
    assert.equal((await inspect(Buffer.from('<html><script>alert(1)</script>'), 'invoice.html')).status, 'warning');
    assert.equal((await inspect(Buffer.from([0, 1, 2, 3, 4]), 'backup.vhdx')).status, 'uninspectable');
    assert.equal((await inspect(Buffer.from('plain words'), 'photo.png')).status, 'warning');
    // Web pages and scripts are routine inside source archives.
    assert.equal((await inspect(zip(['site/index.html', 'tool.py']), 'site.zip')).status, 'checked');
});
