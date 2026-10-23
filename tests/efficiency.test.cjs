const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pickerFixture, gifFixture, gifFrames } = require('./fixtures/efficiency.cjs');

test('GIF tables are allocated on demand and dictionary resets preserve the original bytes', () => {
    let allocations = 0;
    class Codes extends Int16Array { constructor(...args) { super(...args); allocations++; } }
    class Stamps extends Int32Array { constructor(...args) { super(...args); allocations++; } }
    const window = gifFixture(readFileSync(resolve('src-tauri/injection/gif.js'), 'utf8'), { Int16Array: Codes, Int32Array: Stamps });
    assert.equal(allocations, 0);
    const frames = gifFrames();
    for (let repeat = 0; repeat < 2; repeat++) {
        const output = window.Lowcord.gif.encodeFrames(frames);
        // Captured from the original encoder, across random, striped and solid
        // frames, multiple dictionary clears, and all GIF code-size boundaries.
        assert.equal(createHash('sha256').update(Buffer.concat(output)).digest('hex'),
            '4115eea5b641b447881b50c0a661daaf55ca1ffb3d0e0254116ea1612817f002');
        assert.equal(allocations, 2 * (repeat + 1));
    }
});

for (const provider of ['reddit', 'redgifs']) {
    test(`${provider}: a full live capability table avoids scans, stays bounded, and rejects expired or foreign tokens`, async () => {
        let now = 10_000_000, visits = 0;
        const maps = [];
        class Clock extends Date { static now() { return now; } }
        class TrackedMap extends Map {
            constructor(...args) { super(...args); maps.push(this); }
            *[Symbol.iterator]() {
                for (const entry of super[Symbol.iterator]()) { if (this === maps[0]) visits++; yield entry; }
            }
        }
        const fixture = pickerFixture(resolve('.'), provider, { Date: Clock, Map: TrackedMap });
        try {
            const first = (await fixture.page(1)).items[0];
            await assert.rejects(fixture.service.prepare(2, first.key, 20_000_000), { code: 'expired' });
            for (let page = 2; page <= 180; page++) await fixture.page(page);
            assert.equal(maps[0].size, 4096);
            assert.equal(visits, 0);
            assert.equal(maps[0].has(first.key), false);
            const recent = (await fixture.page(181)).items[0];
            now += 30 * 60_000;
            await fixture.page(182); // Equality remains valid: expiry uses <.
            assert.equal(maps[0].has(recent.key), true);
            assert.equal(visits, 0);
            now++;
            await assert.rejects(fixture.service.prepare(1, recent.key, 20_000_000), { code: 'expired' });
            await fixture.page(183);
            assert.equal(visits, 4096);
            assert.equal(maps[0].has(recent.key), false);
            assert.equal(maps[0].size, fixture.count * 2);
            visits = 0; await fixture.page(184); assert.equal(visits, 0);
        } finally { await fixture.service.close(); }
    });

    test(`${provider}: a backwards clock still tracks the earliest new expiry`, async () => {
        let now = 10_000_000;
        const maps = [];
        class Clock extends Date { static now() { return now; } }
        class TrackedMap extends Map { constructor(...args) { super(...args); maps.push(this); } }
        const fixture = pickerFixture(resolve('.'), provider, { Date: Clock, Map: TrackedMap });
        try {
            const original = (await fixture.page(1)).items[0];
            now -= 30_000;
            const earlier = (await fixture.page(2)).items[0];
            now += 30 * 60_000 + 1;
            await fixture.page(3);
            assert.equal(maps[0].has(earlier.key), false);
            assert.equal(maps[0].has(original.key), true);
        } finally { await fixture.service.close(); }
    });
}
