const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchNetwork } = require('../electron/network-watch.cjs');

const wifi = { en0: [{ address: '192.168.1.20', internal: false }], lo0: [{ address: '127.0.0.1', internal: true }] };
const vpn = { ...wifi, utun4: [{ address: '10.8.0.2', internal: false }] };

test('an added or removed VPN address and a wake from sleep each signal once', () => {
    const changes = [], powerMonitor = new EventEmitter();
    let current = vpn;
    const watch = watchNetwork({ powerMonitor, onChange: reason => changes.push(reason), interfaces: () => current });
    try {
        assert.equal(watch.check(), false);
        current = wifi;
        assert.equal(watch.check(), true);
        assert.equal(watch.check(), false);
        current = { ...wifi, lo0: [{ address: '::1', internal: true }] };
        assert.equal(watch.check(), false, 'loopback changes are ignored');
        current = vpn;
        powerMonitor.emit('resume');
        assert.equal(watch.check(), false, 'resume already took the new addresses');
        assert.deepEqual(changes, ['network', 'resume']);
    } finally { watch.stop(); }
    assert.equal(powerMonitor.listenerCount('resume'), 0);
});

test('a failing interface lookup keeps the last addresses', () => {
    const changes = [];
    let fail = false;
    const watch = watchNetwork({ onChange: reason => changes.push(reason), interfaces: () => { if (fail) throw new Error('EPERM'); return wifi; } });
    try {
        fail = true;
        assert.equal(watch.check(), false);
        fail = false;
        assert.equal(watch.check(), false);
        assert.deepEqual(changes, []);
    } finally { watch.stop(); }
});
