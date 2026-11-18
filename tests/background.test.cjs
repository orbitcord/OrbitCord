const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createBackgroundSaver } = require('../electron/background.cjs');

function fakeWindow() {
    const window = new EventEmitter(), contents = new EventEmitter();
    Object.assign(window, { visible: true, isDestroyed: () => false, isVisible: () => window.visible, isMinimized: () => false, webContents: contents });
    Object.assign(contents, { audible: false, pid: 4242, isDestroyed: () => false, send() {}, getURL: () => 'https://discord.com/app',
        isCurrentlyAudible: () => contents.audible, executeJavaScript: async () => false, mainFrame: { framesInSubtree: [] },
        getOSProcessId: () => contents.pid, debugger: { isAttached: () => true, sendCommand: async () => {} } });
    return window;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('efficiency lowers the page process while hidden and restores it when shown', async () => {
    const window = fakeWindow(), calls = [];
    const saver = createBackgroundSaver({ window, userData: mkdtempSync(join(tmpdir(), 'bg-')), trusted: () => true, minute: 60,
        setPriority: async (pid, background) => { calls.push([pid, background]); return true; } });
    assert.equal(saver.get().efficiency, true, 'on by default');
    window.visible = false; window.emit('hide');
    await wait(30);
    assert.deepEqual(calls, [[4242, true]]);
    assert.equal(saver.lowered, 4242);
    window.visible = true; window.emit('show');
    await wait(5);
    assert.deepEqual(calls, [[4242, true], [4242, false]]);
    assert.equal(saver.lowered, 0);
});

test('calls and playing media keep full priority, and turning it off restores priority', async () => {
    const window = fakeWindow(), calls = [];
    const saver = createBackgroundSaver({ window, userData: mkdtempSync(join(tmpdir(), 'bg-')), trusted: () => true, minute: 60,
        setPriority: async (pid, background) => { calls.push([pid, background]); return true; } });
    window.webContents.audible = true;
    window.visible = false; window.emit('minimize');
    await wait(30);
    assert.deepEqual(calls, [], 'audible pages are not lowered');
    window.webContents.audible = false;
    await wait(80);
    assert.deepEqual(calls, [[4242, true]], 'rechecked once the call ends');
    saver.set({ ...saver.get(), efficiency: false });
    await wait(5);
    assert.deepEqual(calls, [[4242, true], [4242, false]]);
    window.emit('hide');
    await wait(30);
    assert.equal(calls.length, 2, 'stays off');
    window.visible = true; window.emit('show');
});

test('rejects invalid efficiency values and keeps older settings files working', () => {
    const window = fakeWindow();
    const saver = createBackgroundSaver({ window, userData: mkdtempSync(join(tmpdir(), 'bg-')), trusted: () => true });
    assert.throws(() => saver.set({ sleep: false, minutes: 15, efficiency: 'yes' }), /Invalid background settings/);
    assert.deepEqual(saver.set({ sleep: true, minutes: 30 }), { sleep: true, minutes: 30, efficiency: true });
});
