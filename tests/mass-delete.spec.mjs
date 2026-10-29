import { test, expect } from '@playwright/test';

// All requests use this in-page fixture. No Discord account or live deletion.
test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => {
        window.deletion = { messages: [], deletes: [], searches: [], history: [], calls: [] };
        const store = Lowcord.store;
        Lowcord.store = name => name === 'UserStore' ? { getCurrentUser: () => ({ id: '1' }) } : store(name);
        Object.assign(Lowcord.massDelete.pacing, { search: 1, indexing: 1 });
        Object.defineProperty(Lowcord, 'RestAPI', { configurable: true, value: {
            async get({ url, query }) {
                deletion.calls.push({ method: 'GET', url, at: performance.now() });
                if (!url.endsWith('/search')) { deletion.history.push(url); return { body: [] }; }
                deletion.searches.push(query.max_id);
                const hits = deletion.messages.filter(m => BigInt(m.id) <= BigInt(query.max_id)).slice(0, 25);
                return { body: { messages: hits.map(m => [m]) } };
            },
            async del({ url }) {
                deletion.calls.push({ method: 'DELETE', url, at: performance.now() });
                if (deletion.del) return deletion.del(url);
                deletion.deletes.push(url);
                return { headers: { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset-after': '0' } };
            },
        } });
        deletion.start = () => {
            deletion.done = Lowcord.massDelete.start(deletion.target ?? { channelId: '500', channelName: 'Fixture' }, deletion.scope ?? 'channel')
                .then(result => { deletion.result = result; });
        };
    });
});

test('a slow channel does not block deletion from later search pages', async ({ page }) => {
    await page.evaluate(() => {
        deletion.target = { channelId: '500', guildId: '900', guildName: 'Fixture' };
        deletion.scope = 'server';
        deletion.messages = Array.from({ length: 100 }, (_, i) => ({ id: String(10000 - i),
            channel_id: i < 25 ? '500' : '501', author: { id: '1' } }));
        const gate = new Promise(resolve => { deletion.release = resolve; });
        deletion.del = async url => {
            if (url.includes('/500/')) await gate;
            deletion.deletes.push(url);
            return { headers: { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset-after': '0' } };
        };
        deletion.start();
    });
    await expect.poll(() => page.evaluate(() => deletion.deletes.filter(url => url.includes('/501/')).length), { timeout: 2000 }).toBe(75);
    expect(await page.evaluate(() => deletion.deletes.some(url => url.includes('/500/')))).toBe(false);
    await page.evaluate(async () => { deletion.release(); await deletion.done; });
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 100, skipped: 0, failed: false });
    expect(await page.evaluate(() => new Set(deletion.deletes).size)).toBe(100);
});

test('subsecond rate-limit delays do not become a one-second pause', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = [{ id: '100', channel_id: '500', author: { id: '1' } }];
        let attempts = 0;
        deletion.del = async url => {
            if (++attempts === 1) throw { status: 429, body: { retry_after: 0.12 } };
            deletion.deletes.push(url);
            return { headers: { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset-after': '0' } };
        };
        deletion.start();
    });
    await page.clock.runFor(119);
    expect(await page.evaluate(() => deletion.deletes.length)).toBe(0);
    await page.clock.runFor(30);
    expect(await page.evaluate(() => deletion.deletes.length)).toBe(1);
    await page.clock.runFor(5);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 1, failed: false });
});

// Hold requests open to prove both memory and network concurrency stay bounded.
test('lookahead is bounded and Stop settles active requests without draining queued messages', async ({ page }) => {
    await page.evaluate(() => {
        deletion.target = { channelId: '500', guildId: '900', guildName: 'Fixture' };
        deletion.scope = 'server';
        deletion.messages = Array.from({ length: 400 }, (_, i) => ({ id: String(10000 - i),
            channel_id: String(500 + Math.floor(i / 25)), author: { id: '1' } }));
        deletion.active = 0; deletion.maxActive = 0;
        const channels = new Set(); deletion.overlappingChannel = false;
        const gate = new Promise(resolve => { deletion.release = resolve; });
        deletion.del = async url => {
            const channel = url.split('/')[2];
            if (channels.has(channel)) deletion.overlappingChannel = true;
            channels.add(channel);
            deletion.maxActive = Math.max(deletion.maxActive, ++deletion.active);
            await gate;
            deletion.active--; channels.delete(channel); deletion.deletes.push(url);
        };
        deletion.start();
    });
    await expect.poll(() => page.evaluate(() => deletion.searches.length)).toBe(5);
    expect(await page.evaluate(() => deletion.maxActive)).toBe(4);
    await page.evaluate(() => Lowcord.massDelete.stop());
    expect(await page.evaluate(() => Lowcord.massDelete.active)).toBe(true);
    await page.evaluate(async () => { deletion.release(); await deletion.done; });
    expect(await page.evaluate(() => ({ searches: deletion.searches.length, result: deletion.result,
        active: deletion.active, overlap: deletion.overlappingChannel, history: deletion.history })))
        .toMatchObject({ searches: 5, result: { deleted: 4, stopped: true, failed: false }, active: 0, overlap: false, history: [] });
});

test('mixed-case rate-limit headers pause the channel until its quota resets', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = [200, 100].map(id => ({ id: String(id), channel_id: '500', author: { id: '1' } }));
        deletion.del = async url => {
            deletion.deletes.push(url);
            return { headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.12' } };
        };
        deletion.start();
    });
    await page.clock.runFor(119);
    expect(await page.evaluate(() => deletion.deletes.length)).toBe(1);
    await page.clock.runFor(30);
    expect(await page.evaluate(() => deletion.deletes.length)).toBe(2);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 2, failed: false });
});

test('a global Retry-After header pauses discovery as well as deletion', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = Array.from({ length: 30 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '1' } }));
        let attempts = 0;
        deletion.del = async url => {
            if (++attempts === 1) {
                deletion.limitedAt = performance.now();
                throw { status: 429, body: { global: true }, headers: { 'Retry-After': '0.12' } };
            }
            deletion.deletes.push(url);
            return { headers: { 'x-ratelimit-remaining': '100', 'x-ratelimit-reset-after': '0' } };
        };
        deletion.start();
    });
    await page.clock.runFor(119);
    expect(await page.evaluate(() => deletion.searches.length)).toBe(1);
    expect(await page.evaluate(() => deletion.deletes.length)).toBe(0);
    await page.clock.runFor(40);
    expect(await page.evaluate(() => deletion.calls.filter(call => call.at > deletion.limitedAt + 1 && call.at < deletion.limitedAt + 120))).toEqual([]);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 30, failed: false });
});

test('indexing follows a supplied retry delay instead of always waiting three seconds', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        const get = Lowcord.RestAPI.get;
        let attempts = 0;
        Lowcord.RestAPI.get = async request => {
            if (request.url.endsWith('/search') && ++attempts === 1) return { status: 202, body: { retry_after: 0.12 } };
            return get(request);
        };
        deletion.start();
    });
    await page.clock.runFor(119);
    expect(await page.evaluate(() => deletion.result)).toBeUndefined();
    await page.clock.runFor(30);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 0, failed: false });
});

test('Stop interrupts a long cooldown and leaves no delayed requests behind', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = [{ id: '100', channel_id: '500', author: { id: '1' } }];
        deletion.del = async () => { throw { status: 429, body: { global: true, retry_after: 30 } }; };
        deletion.start();
    });
    await page.clock.runFor(1);
    await page.evaluate(async () => { Lowcord.massDelete.stop(); await deletion.done; });
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 0, stopped: true, failed: false });
    const calls = await page.evaluate(() => deletion.calls.length);
    await page.clock.runFor(31_000);
    expect(await page.evaluate(() => deletion.calls.length)).toBe(calls);
    expect(await page.evaluate(() => Lowcord.massDelete.active)).toBe(false);
});

test('missing retry information uses the fallback instead of retrying immediately', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = [{ id: '100', channel_id: '500', author: { id: '1' } }];
        let attempts = 0;
        deletion.del = async url => {
            if (++attempts === 1) throw { status: 429, body: {} };
            deletion.deletes.push(url);
        };
        deletion.start();
    });
    await page.clock.runFor(1999);
    expect(await page.evaluate(() => deletion.deletes.length)).toBe(0);
    await page.clock.runFor(10);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 1, failed: false });
});

test('a 1200-message DM overlaps request latency only within reported quota', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = Array.from({ length: 1200 }, (_, i) => ({ id: String(20000 - i), channel_id: '500', author: { id: '1' } }));
        deletion.active = 0; deletion.maxActive = 0; deletion.rateLimited = 0;
        let remaining = 60, resetAt = performance.now() + 1000;
        deletion.del = async url => {
            const now = performance.now();
            if (now >= resetAt) { remaining = 60; resetAt = now + 1000; }
            if (!remaining) { deletion.rateLimited++; throw { status: 429, body: { retry_after: (resetAt - now) / 1000 } }; }
            const left = --remaining, reset = resetAt;
            deletion.maxActive = Math.max(deletion.maxActive, ++deletion.active);
            await new Promise(resolve => setTimeout(resolve, 100));
            deletion.active--; deletion.deletes.push(url);
            return { headers: { 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset-after': String(Math.max(0, reset - performance.now()) / 1000) } };
        };
        deletion.start();
    });
    await page.clock.runFor(45_000);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 1200, skipped: 0, failed: false });
    expect(await page.evaluate(() => ({ unique: new Set(deletion.deletes).size, active: deletion.maxActive, rateLimited: deletion.rateLimited })))
        .toEqual({ unique: 1200, active: 3, rateLimited: 0 });
});

test('DM rounds handle out-of-order quota responses without exceeding the bucket', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = Array.from({ length: 30 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '1' } }));
        deletion.rateLimited = 0; deletion.active = 0; deletion.maxActive = 0;
        let remaining = 5, resetAt = performance.now() + 1000;
        deletion.del = async url => {
            const now = performance.now();
            if (now >= resetAt) { remaining = 5; resetAt = now + 1000; }
            if (!remaining) { deletion.rateLimited++; throw { status: 429, body: { retry_after: (resetAt - now) / 1000 } }; }
            const left = --remaining, reset = resetAt;
            deletion.maxActive = Math.max(deletion.maxActive, ++deletion.active);
            await new Promise(resolve => setTimeout(resolve, [100, 40, 10][Number(url.split('/').pop()) % 3]));
            deletion.active--; deletion.deletes.push(url);
            return { headers: { 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset-after': String(Math.max(0, reset - performance.now()) / 1000) } };
        };
        deletion.start();
    });
    await page.clock.runFor(7000);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 30, failed: false });
    expect(await page.evaluate(() => deletion.rateLimited)).toBe(0);
    expect(await page.evaluate(() => deletion.maxActive)).toBe(3);
});

test('DM deletion stays sequential when quota headers are missing', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = Array.from({ length: 40 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '1' } }));
        deletion.active = 0; deletion.maxActive = 0;
        deletion.del = async url => {
            deletion.maxActive = Math.max(deletion.maxActive, ++deletion.active);
            await new Promise(resolve => setTimeout(resolve, 100));
            deletion.active--; deletion.deletes.push(url);
        };
        deletion.start();
    });
    await page.clock.runFor(4010);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 40, failed: false });
    expect(await page.evaluate(() => deletion.maxActive)).toBe(1);
});

test('Stop waits for the active DM round and does not start another', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = Array.from({ length: 40 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '1' } }));
        deletion.active = 0;
        deletion.del = async url => {
            deletion.active++;
            await new Promise(resolve => setTimeout(resolve, 100));
            deletion.active--; deletion.deletes.push(url);
            return { headers: { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset-after': '0' } };
        };
        deletion.start();
    });
    await page.clock.runFor(101);
    expect(await page.evaluate(() => deletion.active)).toBe(3);
    await page.evaluate(() => Lowcord.massDelete.stop());
    expect(await page.evaluate(() => Lowcord.massDelete.active)).toBe(true);
    await page.clock.runFor(200);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 4, stopped: true, failed: false });
    const calls = await page.evaluate(() => deletion.calls.length);
    await page.clock.runFor(3000);
    expect(await page.evaluate(() => deletion.calls.length)).toBe(calls);
});

test('a throttled DM falls back to sequential deletion after its active round', async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => {
        deletion.messages = Array.from({ length: 40 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '1' } }));
        deletion.active = 0; deletion.maxAfterCooldown = 0;
        let attempts = 0;
        deletion.del = async url => {
            if (++attempts === 2) {
                deletion.limitedAt = performance.now();
                throw { status: 429, body: { retry_after: 0.12 } };
            }
            deletion.active++;
            if (performance.now() >= deletion.limitedAt + 120) deletion.maxAfterCooldown = Math.max(deletion.maxAfterCooldown, deletion.active);
            await new Promise(resolve => setTimeout(resolve, 50));
            deletion.active--; deletion.deletes.push(url);
            return { headers: { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset-after': '0' } };
        };
        deletion.start();
    });
    await page.clock.runFor(2500);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 40, failed: false });
    expect(await page.evaluate(() => deletion.maxAfterCooldown)).toBe(1);
    expect(await page.evaluate(() => new Set(deletion.deletes).size)).toBe(40);
});
