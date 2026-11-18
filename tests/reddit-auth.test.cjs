const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { createRedditAuth, CALLBACK, SCOPES } = require('../electron/reddit-auth.cjs');

const freePort = () => new Promise((resolve, reject) => {
    const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const { port } = server.address(); server.close(() => resolve(port));
    });
});
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// The "browser" is a callback that receives the authorize URL, the way the
// default browser would, and then plays the person's part.
async function fixture(t, { browser, saved = null, token } = {}) {
    const port = await freePort();
    const stored = { value: saved }, opened = [], requests = [];
    const auth = createRedditAuth({ clientId: 'fixture-client', port, userAgent: 'test:orbitcord:1', timeout: 2000,
        store: { read: async () => stored.value, write: async value => { stored.value = value; }, clear: async () => { stored.value = null; } },
        openExternal: async url => { opened.push(new URL(url)); await browser?.(new URL(url)); },
        fetch: async (url, init) => {
            const body = new URLSearchParams(init.body);
            requests.push({ url: new URL(url), init, body });
            return token ? token(new URL(url), body) : json({ access_token: `access-${requests.length}`, refresh_token: 'refresh-fixture', expires_in: 3600 });
        } });
    t.after(() => auth.close());
    return { auth, stored, opened, requests, port };
}
// Visits the redirect as Reddit would send the browser back.
const visit = (authorize, params) => {
    const redirect = new URL(authorize.searchParams.get('redirect_uri'));
    for (const [key, value] of Object.entries(params)) redirect.searchParams.set(key, value);
    return fetch(redirect);
};

test('signing in opens Reddit in the browser and picks up the redirect on loopback', async t => {
    let browsing;
    const { auth, stored, opened, requests, port } = await fixture(t, { browser: url => browsing = (async () => {
        // A stray request without the state is refused and does not end sign-in.
        assert.equal((await visit(url, { code: 'stolen' })).status, 404);
        return visit(url, { code: 'fixture-code', state: url.searchParams.get('state') });
    })() });
    assert.equal(await auth.login(), true);
    const page = await browsing;
    const [url] = opened;
    assert.equal(url.origin + url.pathname, 'https://www.reddit.com/api/v1/authorize');
    assert.equal(url.searchParams.get('client_id'), 'fixture-client');
    assert.equal(url.searchParams.get('duration'), 'permanent');
    assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
    assert.equal(url.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}${CALLBACK}`);
    assert.ok(url.searchParams.get('state').length >= 32);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Signed in to Reddit/);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.href, 'https://www.reddit.com/api/v1/access_token');
    assert.equal(requests[0].init.headers.authorization, `Basic ${Buffer.from('fixture-client:').toString('base64')}`);
    assert.deepEqual(Object.fromEntries(requests[0].body), { grant_type: 'authorization_code', code: 'fixture-code', redirect_uri: auth.redirect });
    assert.equal(stored.value, 'refresh-fixture');
    assert.equal(await auth.token(), 'access-1');
    // The listener is gone once sign-in ends.
    await assert.rejects(fetch(`${auth.redirect}?code=x`));
});

test('declining on Reddit signs nobody in', async t => {
    const { auth, stored } = await fixture(t, { browser: url => visit(url, { error: 'access_denied', state: url.searchParams.get('state') }) });
    assert.equal(await auth.login(), false);
    assert.equal(stored.value, null);
    assert.equal(await auth.token(), null);
});

test('logging in again while waiting reopens the same page', async t => {
    const { auth, opened } = await fixture(t);
    const first = auth.login();
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = auth.login();
    assert.equal(first, second);
    assert.equal(opened.length, 2);
    assert.equal(opened[0].href, opened[1].href);
    await visit(opened[0], { code: 'c', state: opened[0].searchParams.get('state') });
    assert.equal(await first, true);
});

test('a saved refresh token is used, and one Reddit revoked signs out', async t => {
    const kept = await fixture(t, { saved: 'refresh-saved' });
    assert.equal(await kept.auth.token(), 'access-1');
    assert.deepEqual(Object.fromEntries(kept.requests[0].body), { grant_type: 'refresh_token', refresh_token: 'refresh-saved' });
    assert.equal(await kept.auth.token(), 'access-1');
    kept.auth.expire('access-1');
    assert.equal(await kept.auth.token(), 'access-2');

    const revoked = await fixture(t, { saved: 'refresh-saved', token: () => json({ error: 'invalid_grant' }, 400) });
    assert.equal(await revoked.auth.token(), null);
    assert.equal(revoked.stored.value, null);
});

test('logging out forgets and revokes the token', async t => {
    const { auth, stored, requests } = await fixture(t, { saved: 'refresh-saved' });
    await auth.token();
    await auth.logout();
    assert.equal(stored.value, null);
    assert.equal(await auth.token(), null);
    const revoke = requests.at(-1);
    assert.equal(revoke.url.pathname, '/api/v1/revoke_token');
    assert.deepEqual(Object.fromEntries(revoke.body), { token: 'refresh-saved', token_type_hint: 'refresh_token' });
});

test('sign-in reports a missing client ID, a busy port and a timeout', async t => {
    await assert.rejects(createRedditAuth({ clientId: '', store: {}, openExternal() {} }).login(), { code: 'not-configured' });
    const port = await freePort();
    const blocker = createServer().listen(port, '127.0.0.1');
    t.after(() => blocker.close());
    await new Promise(resolve => blocker.once('listening', resolve));
    const busy = createRedditAuth({ clientId: 'x', port, store: {}, openExternal() {} });
    await assert.rejects(busy.login(), { code: 'auth-port-busy' });
    const slow = createRedditAuth({ clientId: 'x', port: await freePort(), timeout: 50, store: {}, openExternal() {} });
    await assert.rejects(slow.login(), { code: 'auth-timeout' });
});
