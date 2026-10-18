import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        window.mediaDownloads = [];
        window.__LOWCORD_NATIVE__ = { downloadMedia: async url => {
            if (window.failDownload) throw new Error('Failed');
            mediaDownloads.push(url);
        } };
        document.querySelector('main').innerHTML = `<section id="chat-messages-700-1">
            <div id="message-accessories-1" style="display:flex;gap:12px">
                <div id="first"><video preload="none" width="180" height="100" src="/media/sample.mp4?ex=123&amp;signature=a%2Bb"></video><span id="controls">Player controls</span></div>
                <div id="second"><video preload="none" width="180" height="100"><source src="/media/sample.webm?token=second"></video></div>
            </div><div id="message-content-1"><a id="direct" href="https://example.com/movie.mp4?key=signed%2Fvalue">Direct video link</a>
            <a id="page-link" href="https://example.com/watch/123">Web page</a></div></section>`;
        window.addEventListener('contextmenu', event => {
            event.preventDefault();
            requestAnimationFrame(() => {
                document.querySelector('#message')?.remove();
                document.body.insertAdjacentHTML('beforeend', '<div id="message" role="menu" style="position:fixed;left:500px;top:100px"><div id="message-copy-text" role="menuitem" class="item_test" tabindex="-1"><span class="label_test">Copy Text</span></div></div>');
            });
        });
        document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('#message')?.remove(); });
    });
});

const download = page => page.getByRole('menuitem', { name: 'Download video…', exact: true });

test('downloads the selected video or direct link with signed parameters intact', async ({ page }) => {
    await page.locator('#first video').click({ button: 'right' });
    await expect(download(page)).toHaveCount(1);
    await download(page).click();
    await expect(page.locator('#message')).toHaveCount(0);
    expect(await page.evaluate(() => mediaDownloads)).toEqual(['http://127.0.0.1:4318/media/sample.mp4?ex=123&signature=a%2Bb']);
    await page.locator('#second video').click({ button: 'right' });
    await expect(download(page)).toBeVisible();
    // Retarget an already-open message menu without retaining its old URL.
    await page.locator('#first video').click({ button: 'right' });
    await expect(download(page)).toBeVisible();
    await page.locator('#second video').click({ button: 'right' });
    await download(page).press('Enter');
    await page.locator('#direct').click({ button: 'right' });
    await download(page).click();
    expect(await page.evaluate(() => mediaDownloads.slice(1))).toEqual(['http://127.0.0.1:4318/media/sample.webm?token=second', 'https://example.com/movie.mp4?key=signed%2Fvalue']);
    await page.locator('#page-link').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Copy Text', exact: true })).toBeVisible();
    await expect(download(page)).toHaveCount(0);
});

test('supports inline media tokens, skips MSE/manifests, and is independent of Copy Media Link', async ({ page }) => {
    await page.evaluate(() => Lowcord.extensions.set('copyMediaLink', false));
    for (const source of ['blob:https://discord.com/example', 'https://example.com/video.m3u8?sig=1', 'https://example.com/video.mpd']) {
        await page.locator('#first video').evaluate((video, source) => { video.src = source; }, source);
        await page.locator('#controls').click({ button: 'right' });
        await expect(page.getByRole('menuitem', { name: 'Copy Text', exact: true })).toBeVisible();
        await expect(download(page)).toHaveCount(0);
        await page.keyboard.press('Escape');
    }
    const source = 'lowcord-media://media/0123456789abcdef01234567';
    await page.locator('#first video').evaluate((video, source) => { video.src = source; }, source);
    await page.locator('#controls').click({ button: 'right' });
    await download(page).click();
    expect(await page.evaluate(() => mediaDownloads)).toEqual([source]);
    await page.evaluate(() => Lowcord.extensions.set('downloadVideos', false));
    await page.locator('#controls').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Copy Text', exact: true })).toBeVisible();
    await expect(download(page)).toHaveCount(0);
});

test('download failures are visible and a later retry works', async ({ page }) => {
    await page.evaluate(() => { window.failDownload = true; });
    await page.locator('#first video').click({ button: 'right' }); await download(page).click();
    await expect(page.locator('.lowcord-toast')).toContainText('Couldn’t download this video');
    await page.evaluate(() => { window.failDownload = false; });
    await page.locator('#first video').click({ button: 'right' }); await download(page).click();
    expect(await page.evaluate(() => mediaDownloads.length)).toBe(1);
});
