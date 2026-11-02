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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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
    // Advance cooldowns explicitly; browser-call wall time must not spend them.
    await page.clock.pauseAt(new Date());
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

test('progress capsule follows the composer and Stop settles active requests', async ({ page }) => {
    await page.evaluate(() => {
        const composer = document.querySelector('.channelTextArea_test');
        composer.style.cssText = 'position:fixed;left:300px;right:100px;bottom:20px;height:60px';
        deletion.messages = [{ id: '100', channel_id: '500', author: { id: '1' } }];
        deletion.del = () => new Promise(resolve => { deletion.release = resolve; });
        deletion.start();
    });
    const bar = page.locator('.lowcord-purge-bar');
    await expect(bar.locator('.lowcord-purge-count')).toHaveText('0 deleted');
    const composer = await page.locator('.channelTextArea_test').boundingBox();
    await expect.poll(async () => {
        const box = await bar.boundingBox();
        return Math.round(box.x + box.width - composer.x - composer.width);
    }).toBe(0);
    await expect.poll(async () => {
        const box = await bar.boundingBox();
        return Math.round(composer.y - box.y - box.height);
    }).toBe(12);
    expect(Math.round((await bar.boundingBox()).height)).toBe(28);
    const opened = () => bar.locator('.lowcord-purge-more').evaluate(node => node.getBoundingClientRect().height);
    expect(await opened()).toBe(0);
    expect(await bar.locator('.lowcord-toast-badge').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await bar.hover();
    await expect.poll(opened).toBeGreaterThan(10);
    await expect.poll(async () => Math.round((await bar.boundingBox()).width)).toBe(340);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(bar).toContainText('Stopping…');
    await expect(bar.getByRole('button')).toBeDisabled();
    await page.evaluate(async () => { deletion.release(); await deletion.done; });
    await expect(bar).toHaveCount(0);
});

async function reactionFixture(page, { guild = false } = {}) {
    await page.evaluate(guild => {
        document.querySelector('.channelTextArea_test').style.cssText = 'position:fixed;bottom:16px;left:16px;width:calc(100vw - 32px)';
        deletion.target = { channelId: '500', channelName: 'Fixture', ...(guild ? { guildId: '900', guildName: 'Server' } : {}) };
        deletion.scope = guild ? 'server' : 'channel';
        deletion.reactionDeletes = [];
        deletion.pages = [];
        // One indexed own message newer than the reactions: cleanup must scan
        // beyond that boundary and past a full history page of other authors.
        deletion.messages = [{ id: '2000', channel_id: '500', author: { id: '1' } }];
        deletion.records = Array.from({ length: 101 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '2' },
            reactions: i === 100 ? [
                { me: true, emoji: { name: '👍', id: null } },
                { me: true, emoji: { name: 'party', id: '123' } },
                { me: false, emoji: { name: '💛', id: null } },
                { me: false, me_burst: true, emoji: { name: '🔥', id: null } }
            ] : [] }));
        if (guild) deletion.records.push(...['501', '503'].map((channel_id, i) => ({ id: String(800 - i), channel_id, author: { id: '2' },
            reactions: [{ me: true, emoji: { name: '✅' } }] })));
        const rest = Lowcord.RestAPI, get = rest.get, del = rest.del;
        rest.get = async request => {
            const { url, query } = request;
            if (url === '/guilds/900/channels') return { body: [{ id: '500', type: 0 }, { id: '501', type: 0 }] };
            if (url === '/guilds/900/threads/active') return { body: { threads: [{ id: '503', type: 11 }] } };
            if (url.endsWith('/messages')) {
                deletion.pages.push({ url, query });
                if (deletion.historyGate) await deletion.historyGate;
                const channelId = url.split('/')[2];
                if (deletion.denied && channelId === '501') throw { status: 403 };
                return { body: deletion.records.filter(m => m.channel_id === channelId && BigInt(m.id) < BigInt(query.before)).slice(0, 100) };
            }
            return get(request);
        };
        rest.del = async request => {
            if (!request.url.includes('/reactions/')) return del(request);
            if (deletion.reactionGate) await deletion.reactionGate;
            if (deletion.retryReaction && !deletion.retried) {
                deletion.retried = true;
                throw { status: 429, body: { retry_after: 0.001, global: true } };
            }
            deletion.reactionDeletes.push(request.url);
            return { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.001' } };
        };
    }, guild);
}

test('reaction cleanup scans beyond own-message search boundaries and only removes own emoji reactions', async ({ page }) => {
    await reactionFixture(page);
    const result = await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel', { reactions: true }));
    expect(result).toMatchObject({ deleted: 1, reactionsRemoved: 2, reactionsSkipped: 1, failed: false });
    expect(await page.evaluate(() => deletion.reactionDeletes)).toEqual([
        `/channels/500/messages/900/reactions/${encodeURIComponent('👍')}/@me`,
        `/channels/500/messages/900/reactions/${encodeURIComponent('party:123')}/@me`
    ]);
    expect(await page.evaluate(() => deletion.pages.length)).toBe(2);
    expect(await page.evaluate(() => deletion.deletes)).toEqual(['/channels/500/messages/2000']);
    await expect(page.locator('.lowcord-toast')).toContainText('removed 2 reactions');
});

test('reaction cleanup respects server scope, active threads and rate limits', async ({ page }) => {
    await reactionFixture(page, { guild: true });
    await page.evaluate(() => { deletion.retryReaction = true; });
    const result = await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'server', { reactions: true }));
    expect(result).toMatchObject({ reactionsRemoved: 4, failed: false });
    expect(await page.evaluate(() => deletion.retried)).toBe(true);
    expect(await page.evaluate(() => new Set(deletion.reactionDeletes.map(url => url.split('/')[2])).size)).toBe(3);
});

test('channel cleanup does not remove reactions from other server channels or newer messages', async ({ page }) => {
    await reactionFixture(page, { guild: true });
    await page.evaluate(() => deletion.records.unshift({ id: '9999999999999999999', channel_id: '500', author: { id: '2' }, reactions: [{ me: true, emoji: { name: '👍' } }] }));
    const result = await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel', { reactions: true }));
    expect(result).toMatchObject({ reactionsRemoved: 2, failed: false });
    expect(await page.evaluate(() => deletion.reactionDeletes.every(url => url.startsWith('/channels/500/')))).toBe(true);
});

test('message-only cleanup makes no reaction requests', async ({ page }) => {
    await reactionFixture(page);
    const result = await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'));
    expect(result).toMatchObject({ deleted: 1, reactionsRemoved: 0 });
    expect(await page.evaluate(() => deletion.reactionDeletes)).toEqual([]);
});

test('Stop settles an active reaction removal and prevents the next request', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => {
        deletion.reactionGate = new Promise(resolve => { deletion.releaseReaction = resolve; });
        deletion.done = Lowcord.massDelete.start(deletion.target, 'channel', { reactions: true }).then(value => { deletion.result = value; });
    });
    await expect(page.locator('.lowcord-purge-bar')).toContainText('Removing reactions');
    await page.locator('.lowcord-purge-bar').hover();
    await page.locator('.lowcord-purge-bar').getByRole('button', { name: 'Stop' }).click();
    await page.evaluate(async () => { deletion.releaseReaction(); await deletion.done; });
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ stopped: true, reactionsRemoved: 1 });
    expect(await page.evaluate(() => deletion.reactionDeletes.length)).toBe(1);
});

test('unavailable reaction histories report incomplete cleanup', async ({ page }) => {
    await reactionFixture(page, { guild: true });
    await page.evaluate(() => { deletion.denied = true; });
    const result = await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'server', { reactions: true }));
    expect(result).toMatchObject({ incomplete: true, reactionsRemoved: 3 });
    await expect(page.locator('.lowcord-toast')).toContainText('Some channel histories could not be checked');
});

test('switching accounts while history loads stops reaction removal', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => {
        deletion.historyGate = new Promise(resolve => { deletion.releaseHistory = resolve; });
        deletion.done = Lowcord.massDelete.start(deletion.target, 'channel', { reactions: true }).then(value => { deletion.result = value; });
    });
    await expect.poll(() => page.evaluate(() => deletion.pages.length)).toBe(1);
    await page.evaluate(async () => {
        const store = Lowcord.store;
        Lowcord.store = name => name === 'UserStore' ? { getCurrentUser: () => ({ id: 'different' }) } : store(name);
        deletion.releaseHistory(); await deletion.done;
    });
    expect(await page.evaluate(() => deletion.result.stopped)).toBe(true);
    expect(await page.evaluate(() => deletion.reactionDeletes)).toEqual([]);
});

test('confirmation reaction option is opt-in and passes its selection to cleanup', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => {
        const store = Lowcord.store;
        Lowcord.store = name => ({ SelectedChannelStore: { getChannelId: () => '500' },
            ChannelStore: { getChannel: () => ({ id: '500', recipients: [] }) } })[name] ?? store(name);
        Lowcord.massDelete.confirm();
    });
    const dialog = page.getByRole('dialog', { name: 'Delete your messages?' });
    await expect(dialog.getByRole('checkbox', { name: 'Also remove my reactions' })).not.toBeChecked();
    await dialog.getByRole('checkbox', { name: 'Also remove my reactions' }).check();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => page.evaluate(() => deletion.reactionDeletes.length)).toBe(2);
    await expect(page.locator('.lowcord-purge-bar')).toHaveCount(0);
    await page.evaluate(() => Lowcord.massDelete.confirm());
    await expect(dialog.getByRole('checkbox', { name: 'Also remove my reactions' })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('repeat message cleanup reuses completed history checks and still finds new unindexed messages', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => {
        deletion.messages = [];
        deletion.records = Array.from({ length: 350 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '2' } }));
    });
    await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'));
    expect(await page.evaluate(() => deletion.pages.length)).toBe(4);
    await page.evaluate(() => {
        const id = (BigInt(deletion.pages[0].query.before) + 1n).toString();
        deletion.records.unshift({ id, channel_id: '500', author: { id: '1' } });
        deletion.pages = [];
    });
    const result = await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'));
    expect(result).toMatchObject({ deleted: 1, failed: false });
    expect(await page.evaluate(() => deletion.pages.length)).toBe(1);
});

test('history verification shows channel and message progress while no deletions are pending', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => {
        deletion.messages = [];
        deletion.historyGate = new Promise(resolve => { deletion.releaseHistory = resolve; });
        deletion.done = Lowcord.massDelete.start(deletion.target, 'channel');
    });
    await expect.poll(() => page.evaluate(() => deletion.pages.length)).toBe(1);
    await expect(page.locator('.lowcord-purge-bar')).toContainText('Checking message history');
    await expect(page.locator('.lowcord-purge-bar')).toContainText('0 of 1 chats checked');
    await expect(page.locator('.lowcord-purge-bar')).not.toContainText('Looking for more');
    await page.evaluate(async () => { deletion.releaseHistory(); await deletion.done; });
});

test('history pages use available read quota instead of a fixed delay', async ({ page }) => {
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await reactionFixture(page);
    await page.evaluate(() => {
        deletion.messages = [];
        deletion.records = Array.from({ length: 350 }, (_, i) => ({ id: String(1000 - i), channel_id: '500', author: { id: '2' } }));
        Lowcord.massDelete.pacing.search = 250;
        const get = Lowcord.RestAPI.get;
        Lowcord.RestAPI.get = async request => ({ ...await get(request), headers: { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset-after': '1' } });
        deletion.done = Lowcord.massDelete.start(deletion.target, 'channel').then(result => { deletion.result = result; });
    });
    await page.clock.runFor(10);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ deleted: 0, failed: false });
    expect(await page.evaluate(() => deletion.pages.length)).toBe(4);
});

test('reaction cleanup bypasses completed message history checks', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => { deletion.messages = []; });
    await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'));
    await page.evaluate(() => { deletion.pages = []; });
    const result = await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel', { reactions: true }));
    expect(result).toMatchObject({ reactionsRemoved: 2, failed: false });
    expect(await page.evaluate(() => deletion.pages.length)).toBe(2);
});

test('failed history checks are not reused as completed scans', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => {
        deletion.messages = [];
        const get = Lowcord.RestAPI.get;
        let pages = 0;
        Lowcord.RestAPI.get = async request => {
            if (request.url.endsWith('/messages') && ++pages === 2) throw { status: 403 };
            return get(request);
        };
    });
    expect(await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'))).toMatchObject({ incomplete: true });
    await page.evaluate(() => { deletion.pages = []; });
    expect(await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'))).toMatchObject({ incomplete: false });
    expect(await page.evaluate(() => deletion.pages.length)).toBe(2);
});

test('completed history checks belong only to the account that ran them', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => { deletion.messages = []; });
    await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'));
    await page.evaluate(() => {
        deletion.pages = [];
        const store = Lowcord.store;
        Lowcord.store = name => name === 'UserStore' ? { getCurrentUser: () => ({ id: '99' }) } : store(name);
    });
    await page.evaluate(() => Lowcord.massDelete.start(deletion.target, 'channel'));
    expect(await page.evaluate(() => deletion.pages.length)).toBe(2);
});

test('history paging waits for an exhausted read quota to reset', async ({ page }) => {
    await page.clock.install(); await page.clock.pauseAt(new Date());
    await reactionFixture(page);
    await page.evaluate(() => {
        deletion.messages = [];
        const get = Lowcord.RestAPI.get;
        Lowcord.RestAPI.get = async request => ({ ...await get(request), headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '.12' } });
        deletion.done = Lowcord.massDelete.start(deletion.target, 'channel').then(result => { deletion.result = result; });
    });
    await page.clock.runFor(119);
    expect(await page.evaluate(() => deletion.pages.length)).toBe(1);
    expect(await page.evaluate(() => deletion.result)).toBeUndefined();
    await page.clock.runFor(10);
    expect(await page.evaluate(() => deletion.pages.length)).toBe(2);
    expect(await page.evaluate(() => deletion.result)).toMatchObject({ failed: false });
});

test('a stale search cursor stops instead of cycling through the same results', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const get = Lowcord.RestAPI.get;
        Lowcord.RestAPI.get = async request => request.url.endsWith('/search')
            ? { body: { messages: [[{ id: '100', channel_id: '500', author: { id: '1' } }]] } }
            : get(request);
        return Lowcord.massDelete.start({ channelId: '500', channelName: 'Fixture' }, 'channel');
    });
    expect(result).toMatchObject({ deleted: 1, failed: true });
    expect(await page.evaluate(() => deletion.deletes)).toEqual(['/channels/500/messages/100']);
    await expect(page.locator('.lowcord-purge-bar')).toHaveCount(0);
});

test('scope rows, reaction choice and actions fit desktop and narrow dialogs', async ({ page }) => {
    await page.evaluate(() => {
        const store = Lowcord.store;
        Lowcord.store = name => ({
            SelectedChannelStore: { getChannelId: () => '500' },
            ChannelStore: { getChannel: () => ({ id: '500', name: 'general', guild_id: '900' }) },
            GuildStore: { getGuild: () => ({ name: 'Test server' }) },
        })[name] ?? store(name);
        Lowcord.massDelete.confirm();
    });
    const dialog = page.getByRole('dialog', { name: 'Delete your messages?' });
    const rows = dialog.locator('.lowcord-purge-options > label');
    const first = await rows.nth(0).boundingBox(), second = await rows.nth(1).boundingBox();
    expect(second.y).toBeGreaterThan(first.y);
    expect(first.width).toBe(second.width);
    await expect(dialog).not.toContainText('cannot be undone');
    const buttons = dialog.locator('.lowcord-dialog-actions button');
    const note = dialog.locator('.lowcord-purge-note');
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(note).toBeHidden();
    await dialog.getByRole('checkbox').check();
    await expect(note).toBeVisible();
    await dialog.getByRole('checkbox').uncheck();
    await expect(note).toBeHidden();
    await dialog.getByRole('radio', { name: /All of Test server/ }).check();
    await page.screenshot({ path: '/tmp/lowcord-delete-dialog-b.png' });
    await buttons.nth(1).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('radio', { name: /All of Test server/ })).toBeFocused();
    await page.setViewportSize({ width: 360, height: 600 });
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
});

test('keyboard focus opens the delete banner without a pointer', async ({ page }) => {
    await page.evaluate(() => {
        deletion.messages = [{ id: '100', channel_id: '500', author: { id: '1' } }];
        deletion.del = () => new Promise(resolve => { deletion.release = resolve; });
        deletion.start();
    });
    const bar = page.locator('.lowcord-purge-bar');
    const stop = bar.getByRole('button', { name: 'Stop' });
    await expect(bar).toBeVisible();
    await stop.focus();
    await expect.poll(() => bar.locator('.lowcord-purge-more').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(10);
    await expect.poll(async () => (await stop.boundingBox()).width).toBeGreaterThan(30);
    await page.keyboard.press('Enter');
    await expect(bar).toContainText('Stopping…');
    await page.evaluate(async () => { deletion.release(); await deletion.done; });
});

test('reaction progress separates counts and keeps long scope names inside the banner', async ({ page }) => {
    await reactionFixture(page);
    await page.evaluate(() => {
        document.querySelector('.channelTextArea_test').style.cssText = 'position:fixed;left:300px;right:32px;bottom:24px;height:60px';
        deletion.historyGate = new Promise(resolve => { deletion.releaseHistory = resolve; });
        deletion.done = Lowcord.massDelete.start({ ...deletion.target, channelName: '#a-long-channel-name-for-checking-layout' }, 'channel', { reactions: true });
    });
    const bar = page.locator('.lowcord-purge-bar');
    await expect(bar.locator('.lowcord-purge-count')).toHaveText(/^\d+ deleted · \d+ reactions?$/);
    await bar.hover();
    await expect.poll(async () => (await bar.boundingBox()).height).toBeLessThan(80);
    await page.screenshot({ path: '/tmp/lowcord-delete-progress-b.png' });
    await page.setViewportSize({ width: 360, height: 600 });
    await page.evaluate(() => { document.querySelector('.channelTextArea_test').style.left = '16px'; });
    await bar.hover();
    await expect.poll(async () => (await bar.boundingBox()).x >= 16).toBe(true);
    await expect.poll(() => bar.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(bar.getByRole('button', { name: 'Stop' })).toBeInViewport();
    await bar.getByRole('button', { name: 'Stop' }).click();
    await page.evaluate(async () => { deletion.releaseHistory(); await deletion.done; });
    await expect(bar).toHaveCount(0);
});
