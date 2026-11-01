const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createTraces } = require('../electron/traces.cjs');

function setup({ stuck = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'orbitcord-traces-')), calls = [];
    const fake = name => ({ name,
        clearCache: async () => { calls.push(`${name}:cache`); if (stuck) await new Promise(() => {}); },
        clearCodeCaches: async () => calls.push(`${name}:code`),
        clearStorageData: async value => calls.push(`${name}:${value?.storages?.join() ?? 'everything'}`),
        flushStorageData: () => calls.push(`${name}:flush`), getCacheSize: async () => 1000 });
    const open = fake('open'), closed = fake('closed');
    const window = { destroyed: false, isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; },
        webContents: { executeJavaScript: async () => { calls.push('open:token'); return true; } } };
    const traces = createTraces({ file: join(dir, 'traces.json'), sessions: () => [open, closed], windows: () => [{ window, session: open }], limit: 30 });
    return { traces, calls, window, file: join(dir, 'traces.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
test('nothing is cleared on quit unless it was chosen', async () => {
    const { traces, calls, done } = setup();
    await traces.onQuit();
    assert.deepEqual(calls, []);
    done();
});
test('sign-out needs clearing to be on, and choices are saved', async () => {
    const { traces, file, done } = setup();
    assert.deepEqual(await traces.set({ clearOnQuit: false, signOut: true }), { clearOnQuit: false, signOut: false });
    await traces.set({ clearOnQuit: true, signOut: true });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { clearOnQuit: true, signOut: true });
    assert.equal((await traces.status()).cacheBytes, 2000);
    done();
});
test('signing out keeps settings in open windows and fully clears closed accounts', async () => {
    const { traces, calls, window, done } = setup();
    await traces.set({ clearOnQuit: true, signOut: true });
    await traces.onQuit();
    assert.ok(calls.includes('open:token'));
    assert.ok(calls.includes('closed:everything'));
    assert.equal(calls.includes('open:everything'), false);
    assert.ok(calls.indexOf('open:token') < calls.indexOf('open:flush'));
    assert.equal(window.destroyed, true);
    done();
});
test('an update restart clears the cache but keeps the sign-in', async () => {
    const { traces, calls, window, done } = setup();
    await traces.set({ clearOnQuit: true, signOut: true });
    await traces.onQuit({ keepSignIn: true });
    assert.ok(calls.includes('open:cache'));
    assert.equal(calls.includes('open:token'), false);
    assert.equal(window.destroyed, false);
    done();
});
test('a stuck session cannot hold up quitting', async () => {
    const { traces, done } = setup({ stuck: true });
    await traces.set({ clearOnQuit: true, signOut: false });
    await traces.onQuit();
    done();
});
