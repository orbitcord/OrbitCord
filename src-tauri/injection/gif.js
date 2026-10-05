// Turns a GIF post's MP4 back into an animated GIF file. Chromium decodes the
// video; frames are drawn one at a time, mapped to one shared palette and
// written as they are made, so memory stays bounded to a couple of frames.
// Each frame stores only the box of pixels that changed, the rest transparent.
(() => {
    const transparent = 255;
    // Largest first; each step trades size and smoothness for a smaller file.
    const steps = [{ size: 480, fps: 15 }, { size: 360, fps: 12 }, { size: 270, fps: 10 }, { size: 200, fps: 8 }];

    class Bytes {
        constructor() { this.data = new Uint8Array(1 << 16); this.length = 0; }
        reserve(extra) {
            if (this.length + extra <= this.data.length) return;
            let size = this.data.length * 2;
            while (size < this.length + extra) size *= 2;
            const data = new Uint8Array(size);
            data.set(this.data.subarray(0, this.length));
            this.data = data;
        }
        byte(value) { this.reserve(1); this.data[this.length++] = value; }
        word(value) { this.byte(value & 255); this.byte(value >> 8 & 255); }
        bytes(values) { this.reserve(values.length); this.data.set(values, this.length); this.length += values.length; }
        text(value) { for (const char of value) this.byte(char.charCodeAt(0)); }
        result() { return this.data.slice(0, this.length); }
    }

    // Median cut over a 15-bit colour histogram, to 255 colours (255 is transparent).
    function palette(histogram) {
        const colors = [];
        for (let key = 0; key < histogram.length; key++) if (histogram[key]) colors.push(key);
        const channel = (key, axis) => key >> (10 - axis * 5) & 31;
        const box = list => {
            const low = [31, 31, 31], high = [0, 0, 0];
            let count = 0;
            for (const key of list) {
                count += histogram[key];
                for (let axis = 0; axis < 3; axis++) {
                    const value = channel(key, axis);
                    if (value < low[axis]) low[axis] = value;
                    if (value > high[axis]) high[axis] = value;
                }
            }
            const ranges = high.map((value, axis) => value - low[axis]);
            const axis = ranges.indexOf(Math.max(...ranges));
            return { list, count, axis, score: ranges[axis] * count };
        };
        const boxes = colors.length ? [box(colors)] : [];
        while (boxes.length < 255) {
            let index = -1;
            for (let i = 0; i < boxes.length; i++) if (boxes[i].list.length > 1 && (index < 0 || boxes[i].score > boxes[index].score)) index = i;
            if (index < 0) break;
            const { list, axis, count } = boxes[index];
            list.sort((a, b) => channel(a, axis) - channel(b, axis));
            let seen = 0, cut = 1;
            for (; cut < list.length - 1; cut++) { seen += histogram[list[cut - 1]]; if (seen * 2 >= count) break; }
            boxes.splice(index, 1, box(list.slice(0, cut)), box(list.slice(cut)));
        }
        const table = new Uint8Array(768);
        boxes.forEach(({ list, count }, index) => {
            const sum = [0, 0, 0];
            for (const key of list) for (let axis = 0; axis < 3; axis++) sum[axis] += (channel(key, axis) * 8 + 4) * histogram[key];
            for (let axis = 0; axis < 3; axis++) table[index * 3 + axis] = Math.round(sum[axis] / count);
        });
        return { table, length: Math.max(1, boxes.length) };
    }
    // Nearest palette entry per 15-bit colour, filled as colours appear.
    function mapper({ table, length }) {
        const cache = new Int16Array(32768).fill(-1);
        return key => {
            let index = cache[key];
            if (index >= 0) return index;
            const r = (key >> 10) * 8 + 4, g = (key >> 5 & 31) * 8 + 4, b = (key & 31) * 8 + 4;
            let best = Infinity;
            for (let i = 0; i < length; i++) {
                const dr = r - table[i * 3], dg = g - table[i * 3 + 1], db = b - table[i * 3 + 2];
                const distance = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
                if (distance < best) { best = distance; index = i; }
            }
            cache[key] = index;
            return index;
        };
    }

    // GIF LZW with 8-bit minimum code size, written as 255-byte sub-blocks.
    const codes = new Int16Array(1 << 20), stamps = new Int32Array(1 << 20);
    let generation = 0;
    function lzw(pixels, out) {
        const clear = 256, end = 257;
        let size = 9, limit = 511, next = 258, reset = false;
        let bits = 0, count = 0;
        const block = new Uint8Array(255);
        let filled = 0;
        const flush = () => { if (!filled) return; out.byte(filled); out.bytes(block.subarray(0, filled)); filled = 0; };
        const emit = code => {
            bits |= code << count; count += size;
            while (count >= 8) { block[filled++] = bits & 255; bits >>>= 8; count -= 8; if (filled === 255) flush(); }
            if (reset) { size = 9; limit = 511; reset = false; }
            else if (next > limit) { size++; limit = size === 12 ? 4096 : (1 << size) - 1; }
        };
        out.byte(8);
        generation++;
        emit(clear);
        let prefix = pixels[0];
        for (let i = 1; i < pixels.length; i++) {
            const pixel = pixels[i], key = prefix << 8 | pixel;
            if (stamps[key] === generation) { prefix = codes[key]; continue; }
            emit(prefix);
            if (next < 4096) { stamps[key] = generation; codes[key] = next++; }
            else { generation++; next = 258; reset = true; emit(clear); }
            prefix = pixel;
        }
        emit(prefix);
        emit(end);
        if (count > 0) { block[filled++] = bits & 255; if (filled === 255) flush(); }
        flush();
        out.byte(0);
    }

    function load(bytes) {
        const video = document.createElement("video");
        const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
        Object.assign(video, { muted: true, playsInline: true, preload: "auto", src: url });
        return new Promise((resolve, reject) => {
            video.addEventListener("loadeddata", () => resolve(video), { once: true });
            video.addEventListener("error", () => reject(new Error("Undecodable video")), { once: true });
        }).catch(error => { URL.revokeObjectURL(url); throw error; }).then(video => ({ video, close: () => { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); } }));
    }
    function seek(video, time) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Seek timed out")), 5000);
            video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
            video.currentTime = time;
        });
    }

    async function encode(video, { size, fps }, limit) {
        const scale = Math.min(1, size / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
        const canvas = document.createElement("canvas");
        Object.assign(canvas, { width, height });
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const duration = Math.min(video.duration, 60);
        const count = Math.max(1, Math.min(900, Math.round(duration * fps)));
        const frame = async index => {
            await seek(video, Math.min(index / fps, Math.max(0, video.duration - 0.001)));
            context.drawImage(video, 0, 0, width, height);
            return context.getImageData(0, 0, width, height).data;
        };
        // The palette comes from a handful of frames across the clip.
        const histogram = new Uint32Array(32768);
        for (let sample = 0; sample < Math.min(8, count); sample++) {
            const rgba = await frame(Math.floor(sample * count / Math.min(8, count)));
            for (let i = 0; i < rgba.length; i += 4) histogram[(rgba[i] >> 3) << 10 | (rgba[i + 1] >> 3) << 5 | rgba[i + 2] >> 3]++;
        }
        const colors = palette(histogram), nearest = mapper(colors);
        const out = new Bytes();
        out.text("GIF89a"); out.word(width); out.word(height);
        out.byte(0xf7); out.byte(0); out.byte(0);
        out.bytes(colors.table);
        out.byte(0x21); out.byte(0xff); out.byte(11); out.text("NETSCAPE2.0"); out.byte(3); out.byte(1); out.word(0); out.byte(0);
        let previous = null;
        const current = new Uint8Array(width * height);
        for (let index = 0; index < count; index++) {
            const rgba = await frame(index);
            for (let i = 0, p = 0; p < current.length; i += 4, p++) current[p] = nearest((rgba[i] >> 3) << 10 | (rgba[i + 1] >> 3) << 5 | rgba[i + 2] >> 3);
            // Only the box of changed pixels is written; unchanged ones are transparent.
            let left = 0, top = 0, right = width - 1, bottom = height - 1;
            if (previous) {
                left = width; top = height; right = -1; bottom = -1;
                for (let y = 0; y < height; y++) for (let x = 0, p = y * width; x < width; x++, p++) {
                    if (current[p] === previous[p]) continue;
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    bottom = y;
                }
                if (right < 0) { left = right = top = bottom = 0; }
            }
            const boxWidth = right - left + 1, boxHeight = bottom - top + 1;
            const pixels = new Uint8Array(boxWidth * boxHeight);
            for (let y = 0, q = 0; y < boxHeight; y++) for (let x = 0; x < boxWidth; x++, q++) {
                const p = (top + y) * width + left + x;
                pixels[q] = previous && current[p] === previous[p] ? transparent : current[p];
            }
            const delay = Math.round((index + 1) * 100 / fps) - Math.round(index * 100 / fps);
            out.byte(0x21); out.byte(0xf9); out.byte(4); out.byte(previous ? 1 << 2 | 1 : 1 << 2); out.word(delay); out.byte(transparent); out.byte(0);
            out.byte(0x2c); out.word(left); out.word(top); out.word(boxWidth); out.word(boxHeight); out.byte(0);
            lzw(pixels, out);
            if (out.length > limit) return null;
            previous = previous ?? new Uint8Array(current.length);
            previous.set(current);
        }
        out.byte(0x3b);
        return out.length <= limit ? out.result() : null;
    }

    // Resolves to GIF bytes no larger than `limit`, or null if none fit.
    async function fromVideo(bytes, limit) {
        const { video, close } = await load(bytes);
        try {
            if (!video.videoWidth || !Number.isFinite(video.duration)) return null;
            // Long clips start smaller, as the largest step could not fit anyway.
            for (const step of steps.slice(video.duration > 20 ? 1 : 0)) {
                const data = await encode(video, step, limit);
                if (data) return data;
            }
            return null;
        } finally { close(); }
    }
    window.Lowcord.gif = { fromVideo };
})();
