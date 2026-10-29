// Synthetic requests only. Compare snapshots with:
// node scripts/bench-mass-delete.mjs /path/to/mass-delete.js
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';

const source = await readFile(process.argv[2] ?? new URL('../src-tauri/injection/mass-delete.js', import.meta.url), 'utf8');
for (const mode of ['pipeline', 'retry']) {
    const messages = Array.from({ length: 100 }, (_, index) => ({ id: String(10_000 - index),
        channel_id: index < 25 ? '500' : '501', author: { id: '1' } }));
    let attempts = 0, firstOtherChannelMs = null, deleted = 0;
    const began = performance.now();
    const Lowcord = {
        store: name => name === 'UserStore' ? { getCurrentUser: () => ({ id: '1' }) } : null,
        extensions: { ui: () => ({ append() {}, remove() {}, setAttribute() {} }), toast() {}, addComposerAction() {} },
        RestAPI: {
            async get({ url, query }) {
                if (!url.endsWith('/search')) return { body: [] };
                const hits = mode === 'retry' ? deleted ? [] : [messages[0]]
                    : messages.filter(message => BigInt(message.id) <= BigInt(query.max_id));
                return { body: { messages: hits.slice(0, 25).map(message => [message]) } };
            },
            async del({ url }) {
                if (mode === 'retry' && ++attempts === 1) throw { status: 429, body: { retry_after: 0.12 } };
                if (mode === 'pipeline') await new Promise(resolve => setTimeout(resolve, url.includes('/500/') ? 35 : 1));
                deleted++;
                if (url.includes('/501/') && firstOtherChannelMs === null) firstOtherChannelMs = performance.now() - began;
                return { headers: { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset-after': '0' } };
            },
        },
    };
    runInNewContext(source, { window: { Lowcord }, document: { body: { append() {} } }, console, performance, setTimeout, clearTimeout });
    if (mode === 'retry') Lowcord.massDelete.pacing.search = 1;
    const result = await Lowcord.massDelete.start({ channelId: '500', channelName: 'Fixture',
        guildId: mode === 'pipeline' ? '900' : null }, mode === 'pipeline' ? 'server' : 'channel');
    console.log(JSON.stringify({ mode, elapsedMs: Math.round(performance.now() - began),
        firstOtherChannelMs: firstOtherChannelMs === null ? null : Math.round(firstOtherChannelMs), deleted: result.deleted }));
}

// Simulated time keeps large-DM benchmarks fast and repeatable. These quotas
// are fixture inputs, not assumptions about Discord's real limits.
const { setImmediate: nextTurn } = await import('node:timers/promises');
for (const mode of ['dm-latency', 'dm-quota', 'dm-no-headers']) {
    let now = 0, sequence = 0, remaining = mode === 'dm-quota' ? 5 : 60, resetAt = 1000;
    let deleted = 0, rateLimited = 0, searches = 0, active = 0, maxActive = 0;
    const limit = remaining, timers = new Map();
    const schedule = (callback, ms) => {
        const id = ++sequence;
        timers.set(id, { at: now + Math.max(1, Math.ceil(ms)), callback });
        return id;
    };
    const delay = ms => new Promise(resolve => schedule(resolve, ms));
    const messages = Array.from({ length: 1200 }, (_, i) => ({ id: String(20_000 - i), channel_id: '500', author: { id: '1' } }));
    const Lowcord = {
        store: name => name === 'UserStore' ? { getCurrentUser: () => ({ id: '1' }) } : null,
        extensions: { ui: () => ({ append() {}, remove() {}, setAttribute() {} }), toast() {}, addComposerAction() {} },
        RestAPI: {
            async get({ url, query }) {
                if (!url.endsWith('/search')) return { body: [] };
                searches++;
                return { body: { messages: messages.filter(m => BigInt(m.id) <= BigInt(query.max_id)).slice(0, 25).map(m => [m]) } };
            },
            async del() {
                if (now >= resetAt) { remaining = limit; resetAt = now + 1000; }
                if (!remaining) { rateLimited++; throw { status: 429, body: { retry_after: (resetAt - now) / 1000 } }; }
                const left = --remaining, reset = resetAt;
                maxActive = Math.max(maxActive, ++active);
                await delay(100);
                active--; deleted++;
                if (mode === 'dm-no-headers') return;
                return { headers: { 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset-after': String(Math.max(0, reset - now) / 1000) } };
            },
        },
    };
    runInNewContext(source, { window: { Lowcord }, document: { body: { append() {} } }, console,
        performance: { now: () => now }, setTimeout: schedule, clearTimeout: id => timers.delete(id) });
    let result;
    const done = Lowcord.massDelete.start({ channelId: '500', channelName: 'Fixture' }, 'channel').then(value => { result = value; });
    while (!result) {
        await nextTurn();
        if (result) break;
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || now > 1_000_000) throw new Error(`DM benchmark stalled: ${mode}`);
        timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    await done;
    console.log(JSON.stringify({ mode, simulatedMs: now, deleted, searches, maxActive, rateLimited }));
}
