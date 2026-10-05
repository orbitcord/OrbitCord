import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { createSocialResolver } = require('../electron/social-resolver.cjs');
const { frameKind, musicVolume, youtubeControls } = require('../electron/embed-plugins.cjs');
const html = '<meta property="og:video" content="https://media.example/video.mp4">';
const response = (body = html, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
});

test('social paste is immediate, undoable, scoped to chat, and preserves explicit URLs', async ({ page }) => {
    await page.evaluate(() => {
        const editor = document.createElement('div');
        editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox'); editor.id = 'composer';
        document.querySelector('.channelTextArea_test').append(editor);
    });
    await page.locator('#composer').focus();
    await page.evaluate(() => {
        const data = new DataTransfer(); data.setData('text/plain', 'https://x.com/user/status/123');
        document.getElementById('composer').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(page.locator('#composer')).toHaveText('https://fxtwitter.com/user/status/123');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('#composer')).toHaveText('');
    const values = await page.evaluate(() => [
        'https://mobile.twitter.com/u/status/123?s=20',
        '(https://www.instagram.com/reel/ABC_1/?igsh=track).',
        'https://www.instagram.com/p/ABC/?img_index=2',
        '`https://x.com/u/status/123` <https://x.com/u/status/123>',
        '```js\nhttps://instagram.com/p/ABC/\n```',
        '``https://x.com/u/status/123`` https://fixupx.com/u/status/123',
        'https://x.com.evil.example/u/status/123 https://instagram.com/profile https://x.com/u',
        'https://x.com@evil.example/u/status/123 https://x.com:444/u/status/123',
    ].map(text => Lowcord.extensions.socialContent(text)));
    expect(values).toEqual([
        'https://fxtwitter.com/u/status/123',
        '(https://hhinstagram.com/reel/ABC_1/).',
        'https://hhinstagram.com/p/ABC/?img_index=2',
        '`https://x.com/u/status/123` <https://x.com/u/status/123>',
        '```js\nhttps://instagram.com/p/ABC/\n```',
        '``https://x.com/u/status/123`` https://fixupx.com/u/status/123',
        'https://x.com.evil.example/u/status/123 https://instagram.com/profile https://x.com/u',
        'https://x.com@evil.example/u/status/123 https://x.com:444/u/status/123',
    ]);
});

test('XHR, fetch Request, edits and multipart use checked fallback; disabling keeps originals', async ({ page }) => {
    const requests = [];
    await page.route('**/api/v9/channels/987654/messages**', async route => {
        requests.push(route.request().postData()); await route.fulfill({ json: { ok: true } });
    });
    await page.evaluate(async () => {
        window.__LOWCORD_NATIVE__ = { resolveSocialLink: async () => 'https://vxtwitter.com/u/status/123' };
        const content = 'https://x.com/u/status/123';
        await new Promise(resolve => {
            const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/v9/channels/987654/messages');
            xhr.onload = resolve; xhr.send(JSON.stringify({ content, nonce: '1' }));
        });
        await fetch(new Request(`${location.origin}/api/v9/channels/987654/messages/5`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
        }));
        const form = new FormData(); form.append('payload_json', JSON.stringify({ content }));
        await fetch('/api/v9/channels/987654/messages', { method: 'POST', body: form });
        Lowcord.extensions.set('socialEmbeds', false);
        await fetch('/api/v9/channels/987654/messages', { method: 'POST', body: JSON.stringify({ content }) });
    });
    expect(JSON.parse(requests[0])).toEqual({ content: 'https://vxtwitter.com/u/status/123', nonce: '1' });
    expect(JSON.parse(requests[1]).content).toBe('https://vxtwitter.com/u/status/123');
    expect(requests[2]).toContain('https://vxtwitter.com/u/status/123');
    expect(JSON.parse(requests[3]).content).toBe('https://x.com/u/status/123');
});

test('pending XHR abort and reuse cannot send a stale message', async ({ page }) => {
    const requests = [];
    await page.route('**/api/v9/channels/987654/messages*', async route => {
        requests.push(JSON.parse(route.request().postData())); await route.fulfill({ json: {} });
    });
    await page.evaluate(async () => {
        let finish;
        window.cancelledLookups = 0;
        window.__LOWCORD_NATIVE__ = { resolveSocialLink: () => new Promise(resolve => { finish = resolve; }) };
        const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/v9/channels/987654/messages');
        xhr.onabort = () => window.cancelledLookups++;
        xhr.send(JSON.stringify({ content: 'https://x.com/u/status/123' }));
        xhr.abort();
        xhr.open('POST', '/api/v9/channels/987654/messages');
        const done = new Promise(resolve => { xhr.onload = resolve; });
        xhr.send(JSON.stringify({ content: 'new message' }));
        finish('https://fxtwitter.com/u/status/123');
        await done;
    });
    expect(requests).toEqual([{ content: 'new message' }]);
    expect(await page.evaluate(() => window.cancelledLookups)).toBe(1);
});

test('provider and volume controls save, reload, and hide when disabled', async ({ page }) => {
    await page.evaluate(() => window.__lowcordOpenSettings('extensions'));
    await page.getByLabel('X / Twitter provider').selectOption('vxtwitter.com');
    await page.getByLabel('Instagram provider').selectOption('eeinstagram.com');
    await page.getByLabel('Embed volume').fill('25');
    await page.reload(); await page.waitForFunction(() => window.fixtureReady);
    expect(await page.evaluate(() => Lowcord.extensions.options)).toEqual({ musicVolume: 25, twitterProvider: 'vxtwitter.com', instagramProvider: 'eeinstagram.com',
        blueskyProvider: 'auto', redditProvider: 'auto', tiktokProvider: 'auto', twitchProvider: 'auto', tumblrProvider: 'auto',
        facebookProvider: 'auto', threadsProvider: 'auto', pixivProvider: 'auto' });
    expect(await page.evaluate(() => Lowcord.extensions.socialContent('https://x.com/u/status/1 https://instagram.com/p/ABC/')))
        .toBe('https://vxtwitter.com/u/status/1 https://eeinstagram.com/p/ABC/');
    await page.evaluate(() => window.__lowcordOpenSettings('extensions'));
    await page.getByRole('switch', { name: /Fix music embeds/ }).uncheck();
    await expect(page.getByLabel('Embed volume')).toBeVisible();
});

test('resolver validates real post metadata, tries an independent backup, caches and fails open', async () => {
    const calls = [];
    const resolver = createSocialResolver(async (url, init) => {
        calls.push({ url, init });
        return url.includes('fxtwitter') ? response('unavailable', 503) : response();
    });
    expect(await resolver.resolve('https://x.com/u/status/123', 'auto')).toBe('https://vxtwitter.com/u/status/123');
    expect(await resolver.resolve('https://x.com/u/status/123', 'auto')).toBe('https://vxtwitter.com/u/status/123');
    expect(calls).toHaveLength(2);
    expect(calls[0].init.credentials).toBe('omit');
    expect(calls[0].init.redirect).toBe('error');
    expect(await resolver.resolve('https://x.com/u/status/123', 'fxtwitter.com')).toBe('https://fxtwitter.com/u/status/123');
    expect(await resolver.resolve('https://evil.example/u/status/123', 'auto')).toBe('https://evil.example/u/status/123');
    expect(calls).toHaveLength(2);
    await expect(resolver.resolve('https://x.com/u/status/123', 'evil.example')).rejects.toThrow('Invalid embed provider');
    const failed = createSocialResolver(async () => response('<html>No post metadata</html>'));
    expect(await failed.resolve('https://instagram.com/p/ABC/', 'auto')).toBe('https://www.instagram.com/p/ABC/');
    const stalled = createSocialResolver(() => new Promise(() => {}));
    const start = Date.now();
    expect(await stalled.resolve('https://x.com/u/status/123', 'auto')).toBe('https://x.com/u/status/123');
    expect(Date.now() - start).toBeLessThan(2500);
});

test('frame filters never run plugins on unrelated or lookalike origins', () => {
    expect(frameKind('https://www.youtube.com/embed/123')).toBe('youtube');
    expect(frameKind('https://www.youtube-nocookie.com/embed/123')).toBe('youtube');
    expect(frameKind('https://open.spotify.com/embed/track/123')).toBe('music');
    expect(frameKind('https://embed.music.apple.com/us/album/test/123')).toBe('music');
    for (const url of ['https://www.youtube.com.evil.com/embed/123', 'https://evil.com/?youtube.com/embed/123',
        'http://www.youtube.com/embed/123', 'https://open.spotify.com/track/123', 'https://www.youtube.com/watch?v=123']) expect(frameKind(url)).toBeNull();
});

test('compact YouTube volume remains reachable over the bottom controls while hovering and dragging', async ({ page }) => {
    await page.setContent(await readFile('tests/fixtures/youtube-volume.html', 'utf8'));
    await page.getByRole('button', { name: 'Mute', exact: true }).hover();
    // Reproduce the upstream overlap: the lower slider is visible, but its
    // hit target is the bottom controls instead of the range input.
    expect(await page.evaluate(() => document.elementFromPoint(336, 160).className)).toBe('player-controls-bottom');
    await page.addScriptTag({ content: `(${youtubeControls.toString()})();` });
    await page.addScriptTag({ content: `(${youtubeControls.toString()})();` });
    await expect(page.locator('#lowcord-youtube-controls')).toHaveCount(1);
    const input = page.getByRole('slider', { name: 'Volume' });
    await page.mouse.move(336, 160, { steps: 16 });
    expect(await page.evaluate(() => document.elementFromPoint(336, 160).className)).toBe('ytdVolumeControlsNativeSlider');
    await expect(input).toBeVisible();
    await page.mouse.down();
    await page.mouse.move(336, 190, { steps: 8 });
    await expect(input).toBeVisible();
    await page.mouse.up();
    expect(Number(await input.inputValue())).toBeLessThan(30);
    expect(await page.locator('video').evaluate(e => e.volume)).toBeLessThan(0.3);
    await page.mouse.move(200, 120);
    await expect(input).toBeHidden();
    // Normal hover can reopen the slider after the user leaves it.
    await page.getByRole('button', { name: 'Mute', exact: true }).hover();
    await page.mouse.move(336, 160, { steps: 16 });
    await expect(input).toBeVisible();
});

test('music volume covers detached Audio and DOM media and restores on disable', async ({ page }) => {
    await page.evaluate(source => { window.installMusicVolume = (0, eval)(`(${source})`); }, musicVolume.toString());
    const volumes = await page.evaluate(async () => {
        const audio = new Audio(); const video = document.createElement('video'); document.body.append(video);
        window.installMusicVolume({ enabled: true, volume: 0.25 });
        void audio.play().catch(() => {}); void video.play().catch(() => {});
        const first = [audio.volume, video.volume];
        window.__lowcordMusicVolume.set({ enabled: true, volume: 0.6 });
        const second = [audio.volume, video.volume];
        window.__lowcordMusicVolume.set({ enabled: false, volume: 0.6 });
        return [first, second, [audio.volume, video.volume]];
    });
    expect(volumes).toEqual([[0.25, 0.25], [0.6, 0.6], [1, 1]]);
});

test('bundled AdGuard strips ad metadata and cleans up when disabled', async ({ page }) => {
    const script = await readFile('electron/vendor/adguard-youtube.js', 'utf8');
    await page.evaluate(() => { window.__lowcordAdguardEnabled = true; window.priorParse = JSON.parse; });
    await page.addScriptTag({ content: script });
    expect(await page.evaluate(async () => {
        const value = await new Response('{"nested":{"adPlacements":[1],"adSlots":[2],"playerAds":[3],"videoDetails":{"id":"keep"}}}').json();
        return value;
    })).toEqual({ nested: { adPlacements: [], adSlots: [], playerAds: [], videoDetails: { id: 'keep' } } });
    await page.evaluate(() => window.__lowcordAdguard.set(false));
    expect(await page.evaluate(() => ({ restored: JSON.parse === window.priorParse, ads: JSON.parse('{"playerAds":[1]}').playerAds })))
        .toEqual({ restored: true, ads: [1] });
});
