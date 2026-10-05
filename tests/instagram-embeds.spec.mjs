import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const links = require('../electron/social-links.cjs');
const { createSocialResolver } = require('../electron/social-resolver.cjs');
const post = 'https://www.instagram.com/p/DeGKl6BCDmm/';
const path = '/p/DeGKl6BCDmm/';
const metadata = '<meta property="og:image" content="https://hhinstagram.com/proxy/image/DeGKl6BCDmm">';
const pageResponse = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

test('Instagram auto uses current providers when vx is private and ee cannot find the post', async () => {
    const calls = [];
    const resolver = createSocialResolver(async (url, init) => {
        calls.push({ url, init });
        if (url.includes('hhinstagram.com')) return pageResponse(metadata);
        if (url.includes('vxinstagram.com')) return pageResponse('<title>Private Site</title>', 401);
        return pageResponse('<meta property="og:description" content="Post not found">');
    });
    expect(await resolver.resolve(post)).toBe(`https://hhinstagram.com${path}`);
    expect(await resolver.resolve(post)).toBe(`https://hhinstagram.com${path}`);
    expect(calls.filter(({ url }) => url.includes('hhinstagram.com'))).toHaveLength(1);
    expect(calls.every(({ init }) => init.credentials === 'omit')).toBe(true);
});

test('Instagram accepts a media redirect using only a HEAD check on the Instagram CDN', async () => {
    const calls = [];
    const media = 'https://scontent.cdninstagram.com/v/t51.82787-15/photo.jpg?token=public';
    const resolver = createSocialResolver(async (url, init) => {
        calls.push({ url, init });
        if (url === media) return new Response(null, { headers: { 'content-type': 'image/jpeg' } });
        if (url.includes('zzinstagram.com')) return new Response(null, { status: 302, headers: { location: media } });
        return pageResponse('Unavailable', 503);
    });
    expect(await resolver.resolve(post)).toBe(`https://zzinstagram.com${path}`);
    expect(calls.find(({ url }) => url === media).init.method).toBe('HEAD');
});

test('Instagram follows a canonical www redirect but rejects login and unrelated redirects', async () => {
    const calls = [];
    const resolver = createSocialResolver(async url => {
        calls.push(url);
        if (url === `https://www.hhinstagram.com${path}`) return pageResponse(metadata);
        if (url === `https://hhinstagram.com${path}`) return new Response(null, { status: 301,
            headers: { location: `https://www.hhinstagram.com${path}` } });
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/image.jpg' } });
    });
    expect(await resolver.resolve(post)).toBe(`https://hhinstagram.com${path}`);
    expect(calls).toContain(`https://www.hhinstagram.com${path}`);
    expect(calls.some(url => url.includes('evil.example'))).toBe(false);
    const unavailable = createSocialResolver(async () => new Response(null, { status: 302,
        headers: { location: 'https://www.instagram.com/accounts/login/' } }));
    expect(await unavailable.resolve(post)).toBe(post);
});

test('Instagram allows cold providers more than 1.8 seconds and still has a send deadline', async () => {
    const resolver = createSocialResolver(async url => {
        if (!url.includes('hhinstagram.com')) return pageResponse('Unavailable', 503);
        await new Promise(resolve => setTimeout(resolve, 1950));
        return pageResponse(metadata);
    });
    expect(await resolver.resolve(post)).toBe(`https://hhinstagram.com${path}`);
    const stalled = createSocialResolver(() => new Promise(() => {}));
    const start = Date.now();
    expect(await stalled.resolve(post)).toBe(post);
    expect(Date.now() - start).toBeLessThan(4000);
});

test('new Instagram providers parse and remain available as manual choices', async () => {
    for (const host of ['hhinstagram.com', 'zzinstagram.com']) {
        expect(links.parse(`https://${host}${path}`)).toEqual({ site: 'instagram', path, original: false,
            canonical: `https://www.instagram.com${path}`, key: 'instagram:/p/degkl6bcdmm' });
        const manual = createSocialResolver(() => { throw new Error('Manual choice must not be probed'); });
        expect(await manual.resolve(post, host)).toBe(`https://${host}${path}`);
    }
});

test('Instagram paste and send use the working provider, preserving code and suppressed links', async ({ page }) => {
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
    const requests = [];
    await page.route('**/api/v9/channels/987654/messages', async route => {
        requests.push(JSON.parse(route.request().postData()));
        await route.fulfill({ json: {} });
    });
    const pasted = await page.evaluate(async post => {
        window.__LOWCORD_NATIVE__ = { resolveSocialLink: async () => {
            await new Promise(resolve => setTimeout(resolve, 2200));
            return 'https://hhinstagram.com/p/DeGKl6BCDmm/';
        } };
        const pasted = Lowcord.extensions.socialContent(post);
        const content = `${pasted} \`${post}\` <${post}>`;
        await fetch('/api/v9/channels/987654/messages', { method: 'POST', body: JSON.stringify({ content }) });
        return pasted;
    }, post);
    expect(pasted).toBe(`https://hhinstagram.com${path}`);
    expect(requests[0].content).toBe(`https://hhinstagram.com${path} \`${post}\` <${post}>`);
    await page.evaluate(() => window.__lowcordOpenSettings('extensions'));
    await page.getByLabel('Instagram provider').selectOption('zzinstagram.com');
    await page.reload();
    await page.waitForFunction(() => window.fixtureReady);
    expect(await page.evaluate(() => Lowcord.extensions.options.instagramProvider)).toBe('zzinstagram.com');
});
