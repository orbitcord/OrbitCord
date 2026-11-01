// Removes metadata from MP4, MOV and HEIF files without re-encoding. Boxes are
// overwritten in place, never moved, so every offset stays valid, and the result
// is built from slices of the original file: a 2 GB video stays on disk.
(() => {
    const maxMetadata = 64 * 1024 ** 2, maxRanges = 200_000, maxZeroed = 256 * 1024 ** 2;
    const fail = () => { throw new Error('Unsupported media structure'); };
    const name = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const free = new Uint8Array([102, 114, 101, 101]);
    const starts = new Set(['ftyp', 'styp', 'moov', 'mdat', 'wide', 'free', 'skip', 'meta']);
    const kept = new Set(['ftyp', 'styp', 'moov', 'mdat', 'moof', 'mfra', 'sidx', 'ssix', 'prft', 'wide']);
    const movieKept = new Set(['mvhd', 'trak', 'mvex', 'iods', 'ctab']);
    // Sound and picture, plus text the viewer can see. Everything else, such as
    // GPS and camera sensor tracks, is removed along with its samples.
    const tracksKept = new Set(['vide', 'soun', 'sbtl', 'subt', 'clcp', 'text', 'tmcd']);
    const dated = new Set(['mvhd', 'tkhd', 'mdhd']);
    const hidden = new Set(['udta', 'meta', 'uuid']);

    function boxAt(bytes, at, end) {
        if (end - at < 8) fail();
        const data = view(bytes);
        let size = data.getUint32(at), header = 8;
        if (size === 1) {
            if (end - at < 16) fail();
            size = Number(data.getBigUint64(at + 8)); header = 16;
        } else if (size === 0) size = end - at;
        if (size < header || at + size > end) fail();
        return { type: name(bytes, at + 4), at, header, end: at + size };
    }
    function children(bytes, start, end) {
        const list = [];
        for (let at = start; at < end;) { const box = boxAt(bytes, at, end); list.push(box); at = box.end; }
        return list;
    }
    const child = (bytes, box, type, skip = 0) => children(bytes, box.at + box.header + skip, box.end).find(item => item.type === type);

    // Null when this is not an ISO media file at all, so it uploads as any other
    // unsupported format. Once it is recognised, a problem must stop the upload.
    async function topLevel(read, size) {
        const list = [];
        for (let at = 0; at < size;) {
            const head = await read(at, Math.min(16, size - at));
            if (!at && (head.length < 8 || !starts.has(name(head, 4)))) return null;
            if (head.length < 8) fail();
            const data = view(head);
            let length = data.getUint32(0), header = 8;
            if (length === 1) {
                if (head.length < 16) fail();
                length = Number(data.getBigUint64(8)); header = 16;
            } else if (length === 0) length = size - at;
            if (length < header || at + length > size) fail();
            list.push({ type: name(head, 4), at, header, end: at + length });
            at += length;
        }
        return list;
    }
    async function load(read, box) {
        if (box.end - box.at > maxMetadata) fail();
        return read(box.at, box.end - box.at);
    }
    function collector(boxes) {
        const edits = [], zero = [];
        const media = boxes.filter(box => box.type === 'mdat').map(box => [box.at + box.header, box.end]);
        return { edits, zero, media,
            write: (offset, bytes) => edits.push({ offset, length: bytes.length, bytes }),
            blank(box, base = 0) {
                edits.push({ offset: base + box.at + 4, length: 4, bytes: free });
                if (box.end > box.at + box.header) zero.push([base + box.at + box.header, base + box.end]);
            },
            finish() {
                zero.sort((a, b) => a[0] - b[0]);
                const merged = [];
                for (const [start, end] of zero) {
                    const last = merged.at(-1);
                    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
                }
                const patches = [...edits, ...merged.map(([offset, end]) => ({ offset, length: end - offset }))].sort((a, b) => a.offset - b.offset);
                for (let i = 1; i < patches.length; i++) if (patches[i - 1].offset + patches[i - 1].length > patches[i].offset) fail();
                if (patches.length > maxRanges || merged.reduce((sum, [start, end]) => sum + end - start, 0) > maxZeroed) fail();
                return patches;
            } };
    }
    function sampleRanges(bytes, table, media, zero) {
        const data = view(bytes), find = type => children(bytes, table.at + table.header, table.end).find(box => box.type === type);
        const stsz = find('stsz'), stsc = find('stsc'), stco = find('stco'), co64 = find('co64'), chunks = stco ?? co64;
        if (!stsz || !stsc || !chunks) fail();
        const payload = box => box.at + box.header + 4;
        const fixed = data.getUint32(payload(stsz)), samples = data.getUint32(payload(stsz) + 4);
        const entries = data.getUint32(payload(stsc)), count = data.getUint32(payload(chunks));
        if (payload(stsz) + 8 + (fixed ? 0 : samples * 4) > stsz.end || payload(stsc) + 4 + entries * 12 > stsc.end
            || payload(chunks) + 4 + count * (stco ? 4 : 8) > chunks.end || count + samples > maxRanges * 8) fail();
        let sample = 0, entry = 0;
        for (let chunk = 1; chunk <= count; chunk++) {
            while (entry + 1 < entries && data.getUint32(payload(stsc) + 4 + (entry + 1) * 12) <= chunk) entry++;
            const perChunk = entries ? data.getUint32(payload(stsc) + 4 + entry * 12 + 4) : 0;
            let length = 0;
            for (let i = 0; i < perChunk && sample < samples; i++, sample++) length += fixed || data.getUint32(payload(stsz) + 8 + sample * 4);
            const at = payload(chunks) + 4 + (chunk - 1) * (stco ? 4 : 8);
            const offset = stco ? data.getUint32(at) : Number(data.getBigUint64(at));
            if (!length) continue;
            if (!media.some(([start, end]) => offset >= start && offset + length <= end)) fail();
            zero.push([offset, offset + length]);
        }
        if (sample !== samples) fail();
    }
    function cleanDates(bytes, box, base, write) {
        const at = box.at + box.header, version = bytes[at];
        if (version > 1 || at + 20 > box.end) fail();
        write(base + at + 4, new Uint8Array(version ? 16 : 8));
    }
    function cleanMovie(bytes, base, patch, fragmented) {
        const movie = boxAt(bytes, 0, bytes.length);
        for (const box of children(bytes, movie.header, movie.end)) {
            if (box.type === 'cmov') fail();
            if (box.type === 'mvhd') cleanDates(bytes, box, base, patch.write);
            if (box.type !== 'trak') { if (!movieKept.has(box.type)) patch.blank(box, base); continue; }
            const mdia = child(bytes, box, 'mdia'), hdlr = mdia && child(bytes, mdia, 'hdlr');
            if (!hdlr || hdlr.at + hdlr.header + 12 > hdlr.end) fail();
            if (!tracksKept.has(name(bytes, hdlr.at + hdlr.header + 8))) {
                if (fragmented) fail();
                const minf = child(bytes, mdia, 'minf'), stbl = minf && child(bytes, minf, 'stbl');
                if (!stbl) fail();
                sampleRanges(bytes, stbl, patch.media, patch.zero);
                patch.blank(box, base);
                continue;
            }
            for (const item of children(bytes, box.at + box.header, box.end)) {
                if (item.type === 'tkhd') cleanDates(bytes, item, base, patch.write);
                if (hidden.has(item.type)) patch.blank(item, base);
            }
            for (const item of children(bytes, mdia.at + mdia.header, mdia.end)) {
                if (dated.has(item.type)) cleanDates(bytes, item, base, patch.write);
                if (hidden.has(item.type)) patch.blank(item, base);
            }
        }
    }
    // HEIF stores pictures and metadata as numbered items. The Exif and XMP item
    // bytes are zeroed; orientation lives in the image properties and is kept.
    function cleanItems(bytes, base, patch) {
        const meta = boxAt(bytes, 0, bytes.length), data = view(bytes);
        const parts = children(bytes, meta.header + 4, meta.end), find = type => parts.find(box => box.type === type);
        const iinf = find('iinf'), iloc = find('iloc'), idat = find('idat');
        if (!iinf || !iloc) fail();
        const hiddenItems = new Set();
        const infoVersion = bytes[iinf.at + iinf.header];
        for (const box of children(bytes, iinf.at + iinf.header + (infoVersion ? 8 : 6), iinf.end)) {
            const at = box.at + box.header, version = bytes[at];
            if (box.type !== 'infe' || version < 2 || version > 3) fail();
            const id = version === 2 ? data.getUint16(at + 4) : data.getUint32(at + 4), type = name(bytes, at + (version === 2 ? 8 : 10));
            if (['Exif', 'mime', 'uri '].includes(type)) hiddenItems.add(id);
        }
        const number = (at, width) => width === 0 ? 0 : width === 4 ? data.getUint32(at) : width === 8 ? Number(data.getBigUint64(at)) : width === 2 ? data.getUint16(at) : fail();
        const start = iloc.at + iloc.header, version = bytes[start];
        if (version > 2) fail();
        const offsetSize = bytes[start + 4] >> 4, lengthSize = bytes[start + 4] & 15, baseSize = bytes[start + 5] >> 4, indexSize = version ? bytes[start + 5] & 15 : 0;
        let at = start + 6;
        const items = version < 2 ? data.getUint16(at) : data.getUint32(at);
        at += version < 2 ? 2 : 4;
        for (let item = 0; item < items; item++) {
            const id = version < 2 ? data.getUint16(at) : data.getUint32(at);
            at += version < 2 ? 2 : 4;
            const method = version ? data.getUint16(at) & 15 : 0;
            if (version) at += 2;
            at += 2;
            const origin = number(at, baseSize); at += baseSize;
            const extents = data.getUint16(at); at += 2;
            for (let extent = 0; extent < extents; extent++) {
                at += indexSize;
                const offset = origin + number(at, offsetSize); at += offsetSize;
                const length = number(at, lengthSize); at += lengthSize;
                if (!hiddenItems.has(id) || !length) continue;
                if (method === 1 && idat) {
                    const from = base + idat.at + idat.header + offset;
                    if (from + length > base + idat.end) fail();
                    patch.zero.push([from, from + length]);
                } else if (method === 0 && patch.media.some(([from, to]) => offset >= from && offset + length <= to)) patch.zero.push([offset, offset + length]);
                else if (method === 0 && offset >= base + meta.header && offset + length <= base + meta.end) patch.zero.push([offset, offset + length]);
                else fail();
            }
        }
        if (at > iloc.end) fail();
    }
    async function plan(read, size) {
        const boxes = await topLevel(read, size);
        if (!boxes?.length) return null;
        const movie = boxes.filter(box => box.type === 'moov'), items = boxes.filter(box => box.type === 'meta');
        if (movie.length > 1 || items.length > 1 || !movie.length && !items.length) fail();
        // HEIF sequences hold a movie and items; removing either would lose content.
        if (movie.length && items.length && boxes[0].type === 'ftyp'
            && /^(?:hei|hev|mif|msf|avi)/.test(name(await read(8, 4), 0))) fail();
        const patch = collector(boxes), fragmented = boxes.some(box => box.type === 'moof');
        for (const box of boxes) {
            if (box.type === 'free' || box.type === 'skip') { if (box.end > box.at + box.header) patch.zero.push([box.at + box.header, box.end]); }
            else if (!kept.has(box.type) && (movie.length || box !== items[0])) patch.blank(box);
        }
        try {
            if (movie.length) cleanMovie(await load(read, movie[0]), movie[0].at, patch, fragmented);
            else cleanItems(await load(read, items[0]), items[0].at, patch);
        } catch (error) { if (error instanceof RangeError) fail(); throw error; }
        return patch.finish();
    }
    const zeros = new Uint8Array(1024 ** 2);
    function filler(length) {
        const parts = [];
        for (; length > 0; length -= zeros.length) parts.push(zeros.subarray(0, Math.min(length, zeros.length)));
        return new Blob(parts);
    }
    function apply(blob, patches) {
        const parts = [];
        let at = 0;
        for (const { offset, length, bytes } of patches) {
            if (offset > at) parts.push(blob.slice(at, offset));
            parts.push(bytes ?? filler(length));
            at = offset + length;
        }
        if (at < blob.size) parts.push(blob.slice(at));
        return new Blob(parts);
    }
    const api = { plan, apply };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.LowcordPrivacyMedia = api;
})();
