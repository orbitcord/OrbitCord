// Local, bounded inspection. Never extract archives, execute content or use a
// remote scanning service. A result describes checks performed, not malware safety.
const { open } = require('node:fs/promises');
const MAX_IMAGE = 64 * 1024 * 1024;
const MAX_DIRECTORY = 8 * 1024 * 1024;
const dangerous = /\.(?:exe|com|scr|msi|msp|msix|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|jar|app|command|sh|desktop|dmg|pkg|deb|rpm|appimage|pif|cpl|scf|sct|chm|xll|docm|xlsm|pptm|workflow|action)$/i;
// Risky to open directly, but routine inside source and website archives.
const scripted = /\.(?:html?|xhtml|mht|mhtml|pyw?)$/i;
const archive = /\.(?:zip|zipx|7z|rar|tar|gz|bz2|xz|iso|img|vhdx?)$/i;
const imageTypes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const text = (b, start, end) => b.toString('latin1', start, end);
const malformed = () => { throw new Error('Malformed or unsupported image'); };

function format(bytes) {
    if (bytes[0] === 255 && bytes[1] === 216) return 'jpeg';
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
    if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 12) === 'WEBP') return 'webp';
    if (/^GIF8[79]a$/.test(text(bytes, 0, 6))) return 'gif';
    if (text(bytes, 0, 2) === 'MZ') return 'executable';
    if (bytes.subarray(0, 4).equals(Buffer.from('7f454c46', 'hex'))) return 'executable';
    if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(bytes.subarray(0, 4).toString('hex'))) return 'executable';
    if (text(bytes, 0, 4) === 'PK\x03\x04' || text(bytes, 0, 4) === 'PK\x05\x06') return 'zip';
    if (text(bytes, 0, 5) === '%PDF-') return 'pdf';
    if (text(bytes, 4, 8) === 'ftyp') return 'mp4';
    if (bytes.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
    if (text(bytes, 0, 4) === 'OggS') return 'ogg';
    if (text(bytes, 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
    if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 12) === 'WAVE') return 'wav';
    return isText(bytes) ? 'text' : null;
}

// Printable UTF-8 with no control bytes besides whitespace. The header may end
// inside a multi-byte character, so a cut-off final sequence is tolerated.
const utf8 = new TextDecoder('utf-8', { fatal: true });
function isText(bytes) {
    if (!bytes.length) return false;
    for (const byte of bytes) if (byte < 9 || byte > 13 && byte < 32 || byte === 127) return false;
    for (let trim = 0; trim < 4 && trim < bytes.length; trim++) {
        try { utf8.decode(bytes.subarray(0, bytes.length - trim)); return true; } catch {}
    }
    return false;
}
function orientation(tiff) {
    if (tiff.length < 8) return 1;
    const little = text(tiff, 0, 2) === 'II';
    if (!little && text(tiff, 0, 2) !== 'MM') return 1;
    const short = at => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
    const long = at => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
    if (short(2) !== 42) return 1;
    const offset = long(4);
    if (offset > tiff.length - 2) return 1;
    const count = short(offset);
    if (count > 4096 || offset + 2 + count * 12 > tiff.length) return 1;
    for (let i = 0; i < count; i++) {
        const at = offset + 2 + i * 12;
        if (short(at) === 0x112 && short(at + 2) === 3 && long(at + 4) === 1) {
            const value = short(at + 8);
            return value >= 1 && value <= 8 ? value : 1;
        }
    }
    return 1;
}
function orientationOnly(value) {
    const tiff = Buffer.from('49492a0008000000010012010300010000000100000000000000', 'hex');
    tiff.writeUInt16LE(value, 18);
    return tiff;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    return value >>> 0;
});
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(name, value) {
    const out = Buffer.alloc(value.length + 12);
    out.writeUInt32BE(value.length); out.write(name, 4, 4, 'ascii'); value.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
    return out;
}

function stripJpeg(bytes) {
    const parts = [bytes.subarray(0, 2)];
    let at = 2, ended = false;
    while (at < bytes.length) {
        const start = at;
        if (bytes[at++] !== 255) malformed();
        while (bytes[at] === 255) at++;
        const marker = bytes[at++];
        if (marker === 0xd9) { parts.push(Buffer.from([255, marker])); ended = true; break; }
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { parts.push(bytes.subarray(start, at)); continue; }
        if (at + 2 > bytes.length) malformed();
        const length = bytes.readUInt16BE(at), end = at + length;
        if (length < 2 || end > bytes.length) malformed();
        const payload = bytes.subarray(at + 2, end);
        if (marker === 0xe1 && text(payload, 0, 6) === 'Exif\0\0') {
            const value = orientation(payload.subarray(6));
            if (value !== 1) {
                const minimal = Buffer.concat([Buffer.from('Exif\0\0'), orientationOnly(value)]);
                const header = Buffer.from([255, 0xe1, 0, minimal.length + 2]);
                parts.push(header, minimal);
            }
        } else if (marker === 0xe0) {
            // JFIF thumbnails can contain pixels from an earlier crop. Keep
            // rendering fields only, with the embedded thumbnail removed.
            if (payload.length >= 14 && text(payload, 0, 5) === 'JFIF\0') {
                const minimal = Buffer.from(payload.subarray(0, 14)); minimal[12] = minimal[13] = 0;
                parts.push(Buffer.from([255, 0xe0, 0, 16]), minimal);
            }
        } else if (marker === 0xe2) {
            if (text(payload, 0, 12) === 'ICC_PROFILE\0') parts.push(bytes.subarray(start, end));
        } else if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe && (!(marker >= 0xe3 && marker <= 0xef) || marker === 0xee && text(payload, 0, 5) === 'Adobe')) {
            // Retain JFIF / Adobe rendering and ICC profiles; remove EXIF, XMP,
            // IPTC and comments. ICC profiles are explicitly outside this claim.
            parts.push(bytes.subarray(start, end));
        }
        at = end;
        if (marker === 0xda) {
            const entropy = at;
            while (at < bytes.length) {
                if (bytes[at] !== 255) { at++; continue; }
                let next = at + 1;
                while (bytes[next] === 255) next++;
                if (bytes[next] === 0 || bytes[next] >= 0xd0 && bytes[next] <= 0xd7) { at = next + 1; continue; }
                break;
            }
            parts.push(bytes.subarray(entropy, at));
        }
    }
    if (!ended) malformed();
    return Buffer.concat(parts);
}
function stripPng(bytes) {
    const parts = [bytes.subarray(0, 8)];
    const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT']);
    let at = 8, image = false, first = true;
    while (at + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(at), end = at + length + 12;
        if (end > bytes.length) malformed();
        const kind = text(bytes, at + 4, at + 8);
        if (first && (kind !== 'IHDR' || length !== 13)) malformed();
        first = false;
        if (bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(at + 4, end - 4))) malformed();
        if (kind === 'eXIf') {
            const value = orientation(bytes.subarray(at + 8, end - 4));
            if (value !== 1) parts.push(pngChunk('eXIf', orientationOnly(value)));
        } else if (keep.has(kind)) parts.push(bytes.subarray(at, end));
        else if (kind[0] === kind[0].toUpperCase()) malformed();
        if (kind === 'IDAT') image = true;
        if (kind === 'IEND') { if (!image || length) malformed(); return Buffer.concat(parts); }
        at = end;
    }
    malformed();
}
function stripWebp(bytes) {
    const end = bytes.readUInt32LE(4) + 8;
    if (end !== bytes.length) malformed();
    const parts = [bytes.subarray(0, 12)];
    let at = 12, image = false, extended;
    while (at + 8 <= end) {
        const kind = text(bytes, at, at + 4), size = bytes.readUInt32LE(at + 4), next = at + 8 + size + (size & 1);
        if (next > end) malformed();
        if (kind === 'VP8X') {
            if (size !== 10) malformed();
            const chunk = Buffer.from(bytes.subarray(at, next)); chunk[8] &= ~0x0c; parts.push(chunk); extended = chunk;
        } else if (kind === 'EXIF') {
            const payload = bytes.subarray(at + 8, at + 8 + size), hasPrefix = text(payload, 0, 6) === 'Exif\0\0';
            const value = orientation(hasPrefix ? payload.subarray(6) : payload);
            if (value !== 1) {
                if (!extended) malformed();
                const minimal = hasPrefix ? Buffer.concat([Buffer.from('Exif\0\0'), orientationOnly(value)]) : orientationOnly(value);
                const chunk = Buffer.alloc(8 + minimal.length + (minimal.length & 1)); chunk.write('EXIF'); chunk.writeUInt32LE(minimal.length, 4); minimal.copy(chunk, 8);
                parts.push(chunk); extended[8] |= 0x08;
            }
        } else if (['VP8 ', 'VP8L', 'ALPH', 'ICCP', 'ANIM', 'ANMF'].includes(kind)) parts.push(bytes.subarray(at, next));
        if (['VP8 ', 'VP8L', 'ANMF'].includes(kind)) image = true;
        at = next;
    }
    if (at !== end || !image) malformed();
    const out = Buffer.concat(parts); out.writeUInt32LE(out.length - 8, 4); return out;
}
function stripGif(bytes) {
    if (bytes.length < 14) malformed();
    let at = 13 + (bytes[10] & 0x80 ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0);
    if (at > bytes.length) malformed();
    const parts = [bytes.subarray(0, at)]; let image = false;
    const blocks = () => {
        while (at < bytes.length) {
            const length = bytes[at++];
            if (!length) return;
            at += length; if (at > bytes.length) malformed();
        }
        malformed();
    };
    while (at < bytes.length) {
        const start = at, kind = bytes[at++];
        if (kind === 0x3b) { if (!image) malformed(); parts.push(bytes.subarray(start, at)); return Buffer.concat(parts); }
        if (kind === 0x2c) {
            if (at + 9 > bytes.length) malformed();
            const packed = bytes[at + 8]; at += 9;
            if (packed & 0x80) at += 3 * (2 ** ((packed & 7) + 1));
            if (at >= bytes.length) malformed();
            at++; blocks(); parts.push(bytes.subarray(start, at)); image = true;
        } else if (kind === 0x21) {
            const label = bytes[at++], app = label === 0xff ? text(bytes, at + 1, at + 12) : '';
            blocks();
            if (label === 0xf9 || label === 0xff && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(app)) parts.push(bytes.subarray(start, at));
            else if (label === 0x01) malformed(); // Plain-text extension is rendered content.
        } else malformed();
    }
    malformed();
}
function sanitizeImage(value) {
    if (!(value instanceof Uint8Array) || value.byteLength > MAX_IMAGE) return { status: 'unsupported', reason: 'Images up to 64 MiB are supported.' };
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength), kind = format(bytes);
    if (!imageTypes[kind]) return { status: 'unsupported', reason: 'Supported: JPEG, PNG/APNG, WebP and GIF. Other files are unchanged.' };
    try {
        const output = ({ jpeg: stripJpeg, png: stripPng, webp: stripWebp, gif: stripGif })[kind](bytes);
        return { status: 'processed', type: imageTypes[kind], bytes: new Uint8Array(output), changed: !output.equals(bytes),
            note: 'EXIF, XMP, IPTC and comments removed where present. Orientation, animation and color profiles retained; profiles and visible pixels are not scrubbed.' };
    } catch { return { status: 'uninspectable', reason: 'Could not safely parse this image. The original was not changed.' }; }
}

async function inspectAttachment({ name, size, read }) {
    const reasons = [], entries = [];
    const add = message => { if (!reasons.includes(message)) reasons.push(message); };
    name = typeof name === 'string' ? name.slice(0, 512) : '';
    let complete = true, kind;
    if (!Number.isSafeInteger(size) || size < 1) return { status: 'uninspectable', reasons: ['Empty or invalid file.'], entries };
    if (dangerous.test(name)) add('This file type can run code or install software.');
    else if (scripted.test(name)) add('This file can run scripts when opened.');
    if (/[\u202a-\u202e\u2066-\u2069]/.test(name)) add('The filename contains direction-changing characters that can disguise its extension.');
    if (/\.(?:png|jpe?g|gif|pdf|txt|mp4|docx?)\s*\.[^.]+$/i.test(name) && dangerous.test(name)) add('A double extension makes this file look like a document or media file.');
    const readExact = async (start, count) => {
        if (start < 0 || count < 0 || start + count > size || count > MAX_DIRECTORY) throw new Error('Invalid file range');
        const value = Buffer.from(await read(start, count));
        if (value.length !== count) throw new Error('Incomplete file');
        return value;
    };
    try {
        const header = await readExact(0, Math.min(size, 512)); kind = format(header);
        if (kind === 'executable') add('The file contains an executable signature.');
        const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
        const expected = ({ png: 'png', apng: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', pdf: 'pdf', zip: 'zip' })[ext];
        if (expected && expected !== kind) add('The file content does not match its filename extension.');
        if (kind === 'zip') {
            const tailSize = Math.min(size, 65_557), tail = await readExact(size - tailSize, tailSize);
            let eocd = -1;
            for (let i = tail.length - 22; i >= 0; i--) {
                if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
            }
            if (eocd < 0) throw new Error('Missing archive directory');
            const count = tail.readUInt16LE(eocd + 10), length = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
            if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || tail.readUInt16LE(eocd + 8) !== count
                || count === 65535 || count > 10_000 || length > MAX_DIRECTORY || offset + length > size - tailSize + eocd) throw new Error('Unsupported archive directory');
            const directory = await readExact(offset, length); let at = 0;
            for (let i = 0; i < count; i++) {
                if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid archive entry');
                const flags = directory.readUInt16LE(at + 8), compression = directory.readUInt16LE(at + 10);
                const compressed = directory.readUInt32LE(at + 20), expanded = directory.readUInt32LE(at + 24);
                const names = directory.readUInt16LE(at + 28), extra = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32);
                const next = at + 46 + names + extra + comment;
                if (next > directory.length || compressed === 0xffffffff || expanded === 0xffffffff) throw new Error('Unsupported archive entry');
                const entry = directory.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + names);
                const normalized = entry.replace(/\\/g, '/');
                if (dangerous.test(entry) || normalized.split('/').some(part => /\.app$/i.test(part)) || /(?:^|\/)vbaProject\.bin$/i.test(normalized)) {
                    add('The archive contains files that can run code.'); if (entries.length < 50) entries.push(entry.slice(0, 300));
                }
                if (normalized.split('/').includes('..') || /^\/|^[a-z]:/i.test(normalized)) add('The archive contains paths that could escape its extraction folder.');
                if (flags & 1 || compression === 99) { complete = false; add('Encrypted archive contents cannot be inspected.'); }
                if (archive.test(entry)) { complete = false; add('Nested archives were not opened.'); }
                if (expanded > 1024 ** 3 || expanded > Math.max(1, compressed) * 1000) add('The archive includes unusually large expanded content.');
                at = next;
            }
            if (at !== directory.length) throw new Error('Incomplete archive directory');
        } else if (archive.test(name)) { complete = false; add('This archive format is not supported for content inspection.'); }
        else if (!kind) { complete = false; add('This file format could not be identified.'); }
    } catch { complete = false; add('Unable to inspect all file contents.'); }
    return { status: reasons.some(reason => /run code|run scripts|executable|double extension|direction-changing|does not match|escape|unusually large/.test(reason)) ? 'warning' : complete ? 'checked' : 'uninspectable',
        reasons, entries, kind, complete, note: 'Local format and ZIP directory checks only. Not an antivirus scan.' };
}
async function inspectPath(path, name) {
    const native = require('./native-media.cjs');
    if (native.enabled()) return (await native.service().call('inspect', {path,name})).value;
    const file = await open(path, 'r');
    try {
        const { size } = await file.stat();
        return await inspectAttachment({ name, size, read: async (start, count) => {
            const bytes = Buffer.alloc(count); const result = await file.read(bytes, 0, count, start); return bytes.subarray(0, result.bytesRead);
        } });
    } finally { await file.close(); }
}
module.exports = { sanitizeImage, inspectAttachment, inspectPath, crc32, pngChunk, MAX_IMAGE };
