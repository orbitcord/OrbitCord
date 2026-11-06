const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const win = { Lowcord: {} };
new Function('window', fs.readFileSync(path.join(__dirname, '../src-tauri/injection/zip-preview.js'), 'utf8'))(win);
const zip = win.Lowcord.zipPreview;

function crc32(data) { return zlib.crc32 ? zlib.crc32(data) : 0; }
// Builds a zip: items are { name (Buffer|string), data, store, utf8 }.
function build(items, { zip64 = false, comment = '' } = {}) {
    const chunks = [], central = [];
    let offset = 0;
    for (const item of items) {
        const name = Buffer.isBuffer(item.name) ? item.name : Buffer.from(item.name);
        const raw = Buffer.from(item.data ?? '');
        const body = item.store || item.name.toString().endsWith('/') ? raw : zlib.deflateRawSync(raw);
        const method = body === raw ? 0 : 8, flags = item.utf8 ? 0x800 : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
        chunks.push(local, name, body);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(method, 10);
        entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += 30 + name.length + body.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 10); end.writeUInt16LE(items.length, 8);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
    return Buffer.concat([...chunks, directory, end, Buffer.from(comment)]);
}
const ranger = buffer => async (start, end) => new Uint8Array(buffer.subarray(start, end + 1));

test('reads folders, files, sizes, UTF-8 and CP437 names from the central directory', async () => {
    const archive = build([
        { name: 'docs/', data: '' },
        { name: 'docs/readme.txt', data: 'hello hello hello hello' },
        { name: 'src/main.js', data: 'console.log(1)', store: true },
        { name: 'café.txt', data: 'x', utf8: true },
        { name: Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]), data: 'y' }, // CP437 e-acute
    ], { comment: 'trailing archive comment' });
    const { entries, truncated } = await zip.readDirectory(ranger(archive), archive.length);
    assert.equal(truncated, false);
    assert.deepEqual(entries.map(entry => entry.name), ['docs/', 'docs/readme.txt', 'src/main.js', 'café.txt', 'é.txt']);
    assert.equal(entries[1].size, 23); assert.equal(entries[1].method, 8); assert.equal(entries[2].method, 0);
    assert.equal(entries[0].directory, true);
    const tree = zip.buildTree(entries);
    assert.deepEqual([...tree.dirs.keys()], ['docs', 'src']);
    assert.deepEqual(tree.files.map(file => file.base), ['café.txt', 'é.txt']);
    assert.deepEqual(tree.dirs.get('docs').files.map(file => file.base), ['readme.txt']);
});
test('inflates deflated entries and returns stored ones as they are', async () => {
    const archive = build([{ name: 'a.txt', data: 'hello hello hello hello' }, { name: 'b.txt', data: 'stored', store: true }]);
    const { entries } = await zip.readDirectory(ranger(archive), archive.length);
    assert.equal(Buffer.from(await zip.readEntry(ranger(archive), entries[0])).toString(), 'hello hello hello hello');
    assert.equal(Buffer.from(await zip.readEntry(ranger(archive), entries[1])).toString(), 'stored');
});
test('refuses encrypted entries, oversized files and non-zip data', async () => {
    await assert.rejects(zip.readEntry(async () => new Uint8Array(), { encrypted: true }), /Encrypted/);
    await assert.rejects(zip.readEntry(async () => new Uint8Array(), { size: 3 * 1024 * 1024, compressed: 10, method: 8 }), /Too large/);
    await assert.rejects(zip.readDirectory(ranger(Buffer.alloc(100)), 100), /Not a zip/);
});
test('follows the ZIP64 end-of-directory locator', async () => {
    const base = build([{ name: 'big.bin', data: 'abc', store: true }]);
    const eocdAt = base.length - 22;
    const dirSize = base.readUInt32LE(eocdAt + 12), dirOffset = base.readUInt32LE(eocdAt + 16);
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32);
    record.writeBigUInt64LE(BigInt(dirSize), 40); record.writeBigUInt64LE(BigInt(dirOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(eocdAt), 8); locator.writeUInt32LE(1, 16);
    const end = Buffer.from(base.subarray(eocdAt)); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
    const archive = Buffer.concat([base.subarray(0, eocdAt), record, locator, end]);
    const { entries } = await zip.readDirectory(ranger(archive), archive.length);
    assert.equal(entries[0].name, 'big.bin');
});
