const { randomBytes } = require('node:crypto');
const { createServer } = require('node:http');

// Reddit sign-in runs in the person's own browser, where they are usually
// already signed in. OrbitCord registers as a Reddit "installed app" (no client
// secret) and listens once on a fixed loopback port for the redirect, because
// Reddit only accepts the exact redirect URI the app was registered with.
// Only the refresh token is kept, encrypted by the caller's store; access
// tokens live in memory for their hour.
//
// To build with sign-in enabled, register an installed app at
// https://www.reddit.com/prefs/apps with the redirect URI below and put its
// client ID in CLIENT_ID (or ORBITCORD_REDDIT_CLIENT_ID for development).
const CLIENT_ID = '';
const PORT = 65010;
const CALLBACK = '/reddit_callback';
const SCOPES = ['identity', 'read', 'mysubreddits', 'history'];
const fail = code => Object.assign(new Error(code), { code });
const escape = value => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(title)}</title><style>:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}
body{display:grid;place-items:center;min-height:90vh;margin:0 16px;text-align:center}h1{font-size:1.4em;margin:0 0 .3em}p{margin:0;opacity:.75}</style>
<main><h1>${escape(title)}</h1><p>${escape(body)}</p></main>`;

function createRedditAuth({ clientId = process.env.ORBITCORD_REDDIT_CLIENT_ID || CLIENT_ID, port = PORT, host = '127.0.0.1',
    userAgent, openExternal, store, fetch: request = fetch, timeout = 5 * 60_000 } = {}) {
    const redirect = `http://${host}:${port}${CALLBACK}`;
    const basic = `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`;
    let refreshToken = null, loaded = false, access = null, refreshing = null, pending = null;

    async function load() {
        if (loaded) return refreshToken;
        loaded = true;
        const saved = await store.read().catch(() => null);
        refreshToken = typeof saved === 'string' && /^[\w.-]{8,512}$/.test(saved) ? saved : null;
        return refreshToken;
    }
    async function tokenRequest(form) {
        const response = await request('https://www.reddit.com/api/v1/access_token', { method: 'POST',
            headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
            body: new URLSearchParams(form).toString(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || typeof data.access_token !== 'string' || data.error) {
            throw fail(response.status === 429 ? 'rate-limited' : response.status >= 500 ? `http-${response.status}`
                : data?.error === 'invalid_grant' || response.status === 400 || response.status === 401 ? 'invalid-grant' : 'auth-failed');
        }
        access = { token: data.access_token, expires: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 - 60_000 };
        return data;
    }
    // A valid access token, or null when signed out. A refresh token Reddit
    // no longer accepts (revoked, or the app was removed) signs out.
    async function token() {
        if (access && access.expires > Date.now()) return access.token;
        if (!await load()) return null;
        refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
            .then(() => access.token, async error => {
                if (error.code !== 'invalid-grant') throw error;
                await forget(); return null;
            }).finally(() => { refreshing = null; });
        return refreshing;
    }
    // Reddit answered 401 with this token: drop it and refresh once.
    function expire(value) { if (access?.token === value) access = null; }

    function authorizeURL(state) {
        return `https://www.reddit.com/api/v1/authorize?${new URLSearchParams({ client_id: clientId, response_type: 'code', state,
            redirect_uri: redirect, duration: 'permanent', scope: SCOPES.join(' ') })}`;
    }
    // Resolves true when signed in, false when the person declined. Calling it
    // again while waiting opens the same page again instead of a second listener.
    function login() {
        if (!clientId) return Promise.reject(fail('not-configured'));
        if (pending) { void openExternal(pending.url); return pending.done; }
        const state = randomBytes(24).toString('base64url');
        const url = authorizeURL(state);
        let server, timer, cancel;
        const done = new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return; settled = true;
                clearTimeout(timer); server.close();
                if (pending?.done === done) pending = null;
                if (error) reject(error); else resolve(value);
            };
            cancel = () => finish(fail('cancelled'));
            server = createServer((req, res) => {
                const answer = (status, title, body) => {
                    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close', 'referrer-policy': 'no-referrer',
                        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
                    res.end(page(title, body));
                };
                let query;
                try { query = new URL(req.url, redirect); } catch { query = null; }
                // Anything but the callback carrying our state is ignored, so a
                // stray request from another page cannot end or hijack sign-in.
                if (req.method !== 'GET' || query?.pathname !== CALLBACK || query.searchParams.get('state') !== state) {
                    answer(404, 'Not found', 'This address only finishes OrbitCord\'s Reddit sign-in.'); return;
                }
                const error = query.searchParams.get('error'), code = query.searchParams.get('code');
                if (error || !code) {
                    answer(200, 'Reddit sign-in cancelled', 'You can close this tab and return to OrbitCord.');
                    finish(error === 'access_denied' ? null : fail('auth-failed'), false); return;
                }
                tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect }).then(async data => {
                    if (typeof data.refresh_token !== 'string' || !/^[\w.-]{8,512}$/.test(data.refresh_token)) throw fail('auth-failed');
                    refreshToken = data.refresh_token; loaded = true;
                    await store.write(refreshToken).catch(() => {});
                    answer(200, 'Signed in to Reddit', 'You can close this tab and return to OrbitCord.');
                    finish(null, true);
                }).catch(error => {
                    answer(200, 'Reddit sign-in failed', 'Return to OrbitCord and try again.');
                    finish(error.code ? error : fail('auth-failed'));
                });
            });
            server.once('error', error => finish(fail(error.code === 'EADDRINUSE' ? 'auth-port-busy' : 'auth-failed')));
            server.listen(port, host, () => {
                timer = setTimeout(() => finish(fail('auth-timeout')), timeout);
                void openExternal(url);
            });
        });
        pending = { url, done, cancel };
        return done;
    }
    async function forget() {
        const old = refreshToken;
        refreshToken = null; loaded = true; access = null;
        await store.clear().catch(() => {});
        return old;
    }
    async function logout() {
        const old = await forget();
        // Revoking is a courtesy to Reddit; signing out never waits on it failing.
        if (old) await request('https://www.reddit.com/api/v1/revoke_token', { method: 'POST',
            headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
            body: new URLSearchParams({ token: old, token_type_hint: 'refresh_token' }).toString(),
            signal: AbortSignal.timeout(5000) }).then(response => response.body?.cancel(), () => {});
    }
    async function close() { pending?.done.catch(() => {}); pending?.cancel(); }
    return { token, expire, login, logout, forget, close, get redirect() { return redirect; } };
}
module.exports = { createRedditAuth, PORT, CALLBACK, SCOPES };
