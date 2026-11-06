const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { sanitizeNativeImage } = require('../electron/native-image.cjs');
const { sanitizeImage } = require('../electron/privacy-files.cjs');
const { imageCorpus } = require('./helpers/image-corpus.cjs');
const executable = resolve('src-tauri/target/release', `lowcord-native${process.platform === 'win32' ? '.exe' : ''}`);
const native = bytes => sanitizeNativeImage(executable, bytes);
test('Rust output matches all existing JS sanitizer behavior cases', async () => {
    for (const { name, bytes } of imageCorpus()) {
        const expected = sanitizeImage(bytes), actual = await native(bytes);
        if (expected.bytes) expected.bytes = Buffer.from(expected.bytes);
        assert.deepEqual(actual, expected, name);
    }
});
test('truncation, corrupt lengths, orientation and CRC errors retain safe failure semantics', async () => {
    let seed = 123456;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (const { bytes } of imageCorpus().filter(c => sanitizeImage(c.bytes).status === 'processed')) {
        for (let i = 0; i < 12; i++) {
            const input = Buffer.from(bytes.subarray(0, i < 6 ? Math.max(1, random(bytes.length)) : bytes.length));
            if (i >= 6) input[random(input.length)] ^= 1 << random(8);
            const expected = sanitizeImage(input), actual = await native(input);
            if (expected.bytes) expected.bytes = Buffer.from(expected.bytes);
            assert.deepEqual(actual, expected);
        }
    }
});
test('invalid input, missing binary, cancellation and timeouts reject', async () => {
    await assert.rejects(native(new Uint8Array()), /Invalid image/);
    await assert.rejects(native(new Uint8Array(64 * 1024 * 1024 + 1)), /Invalid image/);
    await assert.rejects(sanitizeNativeImage('/missing/lowcord-native', Buffer.from('x')));
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(sanitizeNativeImage(executable, Buffer.from('x'), { signal: controller.signal }), /cancelled/);
    await assert.rejects(sanitizeNativeImage(executable, Buffer.alloc(32 * 1024 * 1024), { timeout: 1 }), /timed out/);
});
