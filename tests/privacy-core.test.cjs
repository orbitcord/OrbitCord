const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ExpiryQueue } = require('../src-tauri/injection/privacy-core.js');
function fixture(saved) {
    let now = 1000, persisted;
    const removed = [];
    const queue = new ExpiryQueue({ owner: '1', load: () => saved, now: () => now,
        save: state => { persisted = JSON.parse(JSON.stringify(state)); }, remove: async message => { removed.push(message.id); } });
    return { queue, removed, now: value => { now = value; }, get saved() { return persisted; } };
}
const rule = { id: 'r', scope: 'channel', target: '10', hours: 1, attachmentsOnly: false };
const message = { id: '100', channel_id: '10', author: { id: '1' }, timestamp: 1001, content: 'Never persist this secret' };
test('expiry tracks only own new messages in explicit scopes and stores no content', async () => {
    const f = fixture(); f.queue.addRule(rule);
    assert.equal(f.queue.observe({ ...message, author: { id: '2' } }), false);
    assert.equal(f.queue.observe({ ...message, timestamp: 999 }), false);
    assert.equal(f.queue.observe({ ...message, channel_id: '11' }), false);
    assert.equal(f.queue.observe(message), true); assert.equal(f.queue.observe(message), false);
    assert.equal(JSON.stringify(f.saved).includes('secret'), false);
    f.now(3_601_000); await f.queue.tick(); assert.deepEqual(f.removed, []);
    f.now(3_601_001); await f.queue.tick(); assert.deepEqual(f.removed, ['100']);
});
test('preserved messages and removed rules survive reload without deletion', async () => {
    const f = fixture(); f.queue.addRule(rule); f.queue.observe(message); f.queue.preserve('100');
    const reopened = fixture(f.saved); reopened.now(9_000_000); await reopened.queue.tick(); assert.deepEqual(reopened.removed, []);
    reopened.queue.preserve('100', false); reopened.queue.removeRule('r'); await reopened.queue.tick(); assert.deepEqual(reopened.removed, []);
    assert.equal(fixture({ ...f.saved, owner: '2' }).queue.state.rules.length, 0);
});
test('rate limiting defers cleanup and persists retry deadlines', async () => {
    const f = fixture(); f.queue.addRule(rule); f.queue.observe(message); f.now(4_000_000);
    let calls = 0; f.queue.remove = async () => { calls++; throw { status: 429, body: { retry_after: 5, global: true } }; };
    await f.queue.tick(); await f.queue.tick(); assert.equal(calls, 1);
    assert.equal(f.saved.messages[0].retryAt, 4_005_000);
    f.now(4_005_001); await f.queue.tick(); assert.equal(calls, 2);
});
test('attachment rules delete the whole message only when an attachment is present', () => {
    const f = fixture(); f.queue.addRule({ ...rule, attachmentsOnly: true });
    assert.equal(f.queue.observe(message), false);
    assert.equal(f.queue.observe({ ...message, attachments: [{ id: 'a' }] }), true);
});
test('ownership/permission failure preserves the message rather than repeatedly deleting', async () => {
    const f = fixture(); f.queue.addRule(rule); f.queue.observe(message); f.now(4_000_000);
    f.queue.remove = async () => { throw { code: 'ownership' }; }; await f.queue.tick();
    assert.equal(f.saved.messages[0].preserved, true);
});
test('storage failure pauses expiry before any deletion can run', async () => {
    const f = fixture(); f.queue.addRule(rule);
    f.queue.save = () => { throw new Error('Disk full'); };
    assert.throws(() => f.queue.observe(message), /Disk full/);
    f.now(4_000_000); await assert.rejects(() => f.queue.tick(), /storage/);
    assert.deepEqual(f.removed, []);
});
test('the remover receives the matching rule so attachment rules can keep text', async () => {
    let received;
    const f = fixture(); f.queue.addRule({ ...rule, attachmentsOnly: true });
    f.queue.remove = async (_message, _owner, value) => { received = value; };
    f.queue.observe({ ...message, attachments: [{ id: '1' }] }); f.now(4_000_000); await f.queue.tick();
    assert.equal(received.attachmentsOnly, true); assert.equal(f.queue.state.messages.length, 0);
});
test('the privacy report stores whitelisted totals in batches and can be reset', async () => {
    const { PrivacyReport } = require('../src-tauri/injection/privacy-core.js');
    const saves = [];
    const report = new PrivacyReport({ load: () => ({ since: 5, totals: { links: 2, secret: 9 } }), save: value => saves.push(JSON.parse(JSON.stringify(value))), now: () => 50, delay: 5 });
    report.add('links', 3); report.add('analytics'); report.add('unknown'); report.add('links', 0);
    assert.deepEqual(saves, []);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(saves.length, 1);
    assert.equal(saves[0].since, 5);
    assert.equal(saves[0].totals.links, 5);
    assert.equal(saves[0].totals.analytics, 1);
    assert.equal('secret' in saves[0].totals, false);
    report.reset();
    assert.equal(saves[1].since, 50);
    assert.equal(saves[1].totals.links, 0);
});
