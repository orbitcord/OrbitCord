import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        const fixture = window.redgifsFixture = { channel: '100', searches: [], prepares: [], uploads: [], posts: [], cancels: 0, listeners: new Set() };
        const selected = { getChannelId: () => fixture.channel,
            addChangeListener: fn => fixture.listeners.add(fn), removeChangeListener: fn => fixture.listeners.delete(fn) };
        const store = window.Lowcord.store;
        window.Lowcord.store = name => ({ SelectedChannelStore: selected, UserStore: { getCurrentUser: () => ({ premiumType: 2 }) } })[name] || store(name);
        Object.defineProperty(window.Lowcord, 'CloudUpload', { value: class {
            constructor({ file }, channel) {
                this.file = file; this.channel = channel; this.handlers = {};
                this.filename = file.name; this.uploadedFilename = `native/${file.name}`;
            }
            on(type, fn) { this.handlers[type] = fn; }
            cancel() { fixture.cancelledUpload = true; }
            async upload() {
                fixture.uploads.push({ name: this.file.name, type: this.file.type, bytes: Array.from(new Uint8Array(await this.file.arrayBuffer())), channel: this.channel });
                fixture.progress = (...args) => this.handlers.progress(...args);
                if (fixture.slowUpload) { fixture.uploadDone = () => this.handlers.complete(); return; }
                this.handlers[fixture.uploadError ? 'error' : 'complete']();
            }
        } });
        Object.defineProperty(window.Lowcord, 'RestAPI', { value: { post: async request => {
            if (fixture.postError) throw Error('server failure');
            fixture.posts.push(request);
            return { body: { id: 'sent' } };
        } } });
        window.__LOWCORD_NATIVE__ = {
            redgifsSearch: async (query, page, options = {}) => {
                fixture.searches.push({ query, page, ...options });
                if (fixture.slowQuery === query) await new Promise(resolve => { fixture.searchDone = resolve; });
                if (fixture.searchError) return { error: 'rate-limited' };
                if (options.mode === 'niches') return { niches: [{ id: 'neutral-animation', name: 'Neutral animation', videos: 128, subscribers: 2400 },
                    { id: 'neutral-art', name: 'Neutral art', videos: 32, subscribers: 400 }], more: false };
                return { items: Array.from({ length: fixture.count || 3 }, (_, index) => ({ id: `${query || 'feed'}${page}${index}`, key: `key${page}${index}`,
                    author: `fixture${page}${index}`, duration: 12, width: index === 0 ? 360 : 640, height: index === 0 ? 640 : 360, preview: '/media/sample.mp4', poster: '/media/sample.png' })), more: page < 5 };
            },
            redgifsPrepare: async (key, limit) => {
                fixture.prepares.push({ key, limit });
                if (fixture.slowPrepare) await new Promise(resolve => { fixture.prepareDone = resolve; });
                if (fixture.prepareErrorOnce) { const error = fixture.prepareErrorOnce; delete fixture.prepareErrorOnce; return { error }; }
                if (fixture.prepareError) return { error: fixture.prepareError };
                const data = new Uint8Array(await (await fetch('/media/sample.mp4')).arrayBuffer());
                return { handle: key, url: '/media/sample.mp4', size: data.length, name: 'fixture-video.mp4', type: 'video/mp4', quality: 'SD' };
            },
            redgifsRelease: async () => {},
            redgifsCancel: async () => { fixture.cancels++; },
        };
        document.querySelector('main').replaceChildren();
        const composer = document.createElement('div');
        composer.className = 'channelTextArea_test';
        composer.style = 'position:fixed;bottom:20px;left:250px;right:30px;';
        composer.innerHTML = '<div class="buttons_test"></div><div contenteditable="true" role="textbox" aria-label="Message composer">draft stays here</div>';
        document.querySelector('main').append(composer);
    });
    await page.addStyleTag({ url: '/injection/redgifs.css' });
    await page.addScriptTag({ url: '/injection/redgifs.js' });
});

async function open(page) {
    await page.locator('.lowcord-actions-button').click();
    await page.getByRole('menuitem', { name: 'RedGIFs', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'RedGIFs picker' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(3);
}
const status = page => page.locator('.lowcord-redgifs-status');
const tile = page => page.getByRole('button', { name: /Send video by/ }).first();
async function preview(page) {
    await tile(page).hover();
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(1);
    await expect(tile(page)).toHaveAttribute('data-previewing', 'true');
}

test('composer opens portrait feed; search and pagination work; hover only previews one video', async ({ page }) => {
    await open(page);
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).fill('neutral query');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(3);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(6);
    await preview(page);
    expect(await tile(page).evaluate(node => {
        const image = node.querySelector('img'); const box = node.getBoundingClientRect();
        return { imageFit: getComputedStyle(image).objectFit, portrait: box.height > box.width,
            videoFit: getComputedStyle(node.querySelector('video')).objectFit };
    })).toEqual({ imageFit: 'contain', portrait: true, videoFit: 'contain' });
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(1);
    await expect(page.locator('.lowcord-redgifs video')).toBeVisible();
    await expect(tile(page)).toBeEnabled();
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
    expect(await page.evaluate(() => redgifsFixture.searches)).toEqual([{ query: '', page: 1, mode: 'videos' },
        { query: 'neutral query', page: 1, mode: 'videos' }, { query: 'neutral query', page: 2, mode: 'videos' }]);
    await page.screenshot({ path: '/tmp/lowcord-redgifs-picker.png' });
});

test('hover moves one muted preview between clips and leaving releases it without sending', async ({ page }) => {
    await open(page);
    expect(await page.locator('.lowcord-redgifs video').count()).toBe(0);
    await preview(page);
    expect(await page.locator('.lowcord-redgifs video').evaluate(video => ({ muted: video.muted, loop: video.loop, controls: video.controls })))
        .toEqual({ muted: true, loop: true, controls: false });
    const second = page.getByRole('button', { name: /Send video by/ }).nth(1);
    await second.hover();
    await expect(second.locator('video')).toHaveCount(1);
    await expect(second).toHaveAttribute('data-previewing', 'true');
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(1);
    await expect(tile(page).locator('video')).toHaveCount(0);
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).hover();
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    expect(await page.evaluate(() => [redgifsFixture.prepares.length, redgifsFixture.posts.length])).toEqual([0, 0]);
});

test('hover timer shows elapsed and actual duration, advances during playback and resets on leave', async ({ page }) => {
    await open(page); await preview(page);
    const timer = tile(page).locator('.lowcord-redgifs-duration');
    // API fixture says 12 seconds; decoded source is 2 seconds and wins.
    await expect(timer).toHaveText(/0:0[01] \/ 0:02/);
    await expect(timer).toHaveText('0:01 / 0:02');
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).hover();
    await expect(timer).toHaveText('0:02');
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
});

test('horizontal hover movement scrubs both directions, updates timer/progress and resumes playback', async ({ page }) => {
    await open(page); await preview(page);
    const box = await tile(page).boundingBox();
    const video = page.locator('.lowcord-redgifs video');
    const total = await video.evaluate(node => node.duration);
    await page.mouse.move(box.x + box.width * .85, box.y + box.height / 2);
    await expect.poll(() => video.evaluate(node => node.currentTime)).toBeGreaterThan(total * .7);
    await expect(tile(page).locator('.lowcord-redgifs-duration')).toHaveText('0:01 / 0:02');
    await page.mouse.move(box.x + box.width * .15, box.y + box.height / 2);
    await expect.poll(() => video.evaluate(node => node.currentTime)).toBeLessThan(total * .35);
    await expect(tile(page).locator('.lowcord-redgifs-duration')).toHaveText('0:00 / 0:02');
    await expect.poll(() => video.evaluate(node => node.paused)).toBe(false);
    expect(await tile(page).evaluate(node => Number(node.style.getPropertyValue('--lowcord-redgifs-progress')))).toBeGreaterThan(0);
    expect(await page.evaluate(() => [redgifsFixture.prepares.length, redgifsFixture.posts.length])).toEqual([0, 0]);
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).hover();
    await expect(video).toHaveCount(0);
    expect(await tile(page).evaluate(node => node.style.getPropertyValue('--lowcord-redgifs-progress'))).toBe('');
});

test('keyboard focus previews, Enter sends once, and sent clip is marked and locked', async ({ page }) => {
    await open(page);
    await tile(page).focus();
    await expect(tile(page).locator('video')).toHaveCount(1);
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
    await tile(page).press('Enter');
    await expect(status(page)).toContainText('Video sent.');
    await expect(tile(page)).toHaveAttribute('data-sent', '');
    await expect(tile(page)).toBeDisabled();
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    expect(await page.evaluate(() => [redgifsFixture.prepares.length, redgifsFixture.posts.length])).toEqual([1, 1]);
});

test('scroll and new searches release the hover stream', async ({ page }) => {
    await open(page); await preview(page);
    await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = 40; });
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    await tile(page).focus();
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).fill('new topic');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
});

test('hiding the app releases playback and cannot restart a hover stream', async ({ page }) => {
    await open(page); await preview(page);
    await page.clock.install();
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    await tile(page).focus();
    await page.clock.runFor(300);
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
});

test('topic search submits on Enter; niche search opens its videos and returns to the niche list', async ({ page }) => {
    await open(page);
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).fill('animation');
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).press('Enter');
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('Videos for animation');
    await page.getByRole('tab', { name: 'Niches', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Niches', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Browse niche Neutral animation', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Browse niche Neutral animation', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('Neutral animation');
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(3);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(6);
    expect(await page.evaluate(() => redgifsFixture.searches.at(-1))).toEqual({ query: 'animation', page: 2, mode: 'videos', nicheId: 'neutral-animation' });
    await page.getByRole('button', { name: 'Back to niches' }).click();
    await expect(page.getByRole('button', { name: /Browse niche/ })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Back to niches' })).toBeHidden();
    await page.screenshot({ path: '/tmp/lowcord-redgifs-niches.png' });
});

test('picker stays 16px from window bottom-right across composer movement and resize', async ({ page }) => {
    await open(page);
    const gap = () => page.locator('.lowcord-redgifs').evaluate(node => {
        const box = node.getBoundingClientRect(); return { right: innerWidth - box.right, bottom: innerHeight - box.bottom, top: box.top, left: box.left };
    });
    expect(await gap()).toMatchObject({ right: 16, bottom: 16 });
    await page.evaluate(() => { document.querySelector('.channelTextArea_test').style.bottom = '200px'; });
    expect(await gap()).toMatchObject({ right: 16, bottom: 16 });
    await page.setViewportSize({ width: 520, height: 400 });
    expect(await gap()).toEqual({ right: 16, bottom: 16, top: 16, left: 84 });
    await preview(page);
    await tile(page).scrollIntoViewIfNeeded();
    await expect(tile(page)).toBeVisible();
});

test('late topic response cannot overwrite a newer search or niche mode', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.slowQuery = 'old topic'; });
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).fill('old topic');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!redgifsFixture.searchDone)).toBe(true);
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).fill('new topic');
    await page.getByRole('tab', { name: 'Niches', exact: true }).click();
    await expect(page.getByRole('button', { name: /Browse niche/ })).toHaveCount(2);
    await page.evaluate(() => redgifsFixture.searchDone());
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('Niches for new topic');
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(0);
});

test('click sends actual MP4 bytes as an attachment and preserves the composer draft', async ({ page }) => {
    await open(page); await preview(page);
    await tile(page).click();
    await expect(status(page)).toContainText('Video sent.');
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveText('draft stays here');
    const actual = await page.evaluate(() => ({ uploads: redgifsFixture.uploads, posts: redgifsFixture.posts, limit: redgifsFixture.prepares[0].limit }));
    expect(actual.limit).toBe(20_000_000);
    expect(actual.uploads).toHaveLength(1);
    expect(actual.uploads[0]).toMatchObject({ name: 'fixture-video.mp4', type: 'video/mp4', channel: '100' });
    expect(String.fromCharCode(...actual.uploads[0].bytes.slice(4, 8))).toBe('ftyp');
    expect(actual.posts).toHaveLength(1);
    expect(actual.posts[0]).toMatchObject({ url: '/channels/100/messages', body: { content: '', enforce_nonce: true,
        attachments: [{ filename: 'fixture-video.mp4', uploaded_filename: 'native/fixture-video.mp4' }] } });
    await expect(tile(page)).toBeDisabled();
});

test('preparation and upload errors allow retry without posting a link', async ({ page }) => {
    await open(page); await preview(page);
    await page.evaluate(() => { redgifsFixture.prepareError = 'ffmpeg-missing'; });
    await tile(page).click();
    await expect(status(page)).toContainText('Install FFmpeg');
    await page.evaluate(() => { redgifsFixture.prepareError = null; redgifsFixture.uploadError = true; });
    await tile(page).click();
    await expect(status(page)).toHaveText('Upload failed. Try again.');
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
    await page.evaluate(() => { redgifsFixture.uploadError = false; });
    await tile(page).click();
    await expect(status(page)).toContainText('Video sent.');
});

test('switching channels while preparing closes the picker and never uploads or sends', async ({ page }) => {
    await open(page); await preview(page);
    await page.evaluate(() => { redgifsFixture.slowPrepare = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => !!redgifsFixture.prepareDone)).toBe(true);
    await page.evaluate(() => {
        redgifsFixture.channel = '200'; for (const fn of redgifsFixture.listeners) fn(); redgifsFixture.prepareDone();
    });
    await expect(page.getByRole('dialog', { name: 'RedGIFs picker' })).toHaveCount(0);
    expect(await page.evaluate(() => [redgifsFixture.uploads.length, redgifsFixture.posts.length, redgifsFixture.cancels])).toEqual([0, 0, 2]);
});

test('closing during upload cancels it; completion cannot post into another channel', async ({ page }) => {
    await open(page); await preview(page);
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => !!redgifsFixture.uploadDone)).toBe(true);
    await page.getByRole('button', { name: 'Close RedGIFs' }).click();
    await page.evaluate(() => redgifsFixture.uploadDone());
    expect(await page.evaluate(() => redgifsFixture.cancelledUpload)).toBe(true);
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
});

test('reopening keeps browsing interactive while a newly queued clip waits for cancelled cleanup', async ({ page }) => {
    await open(page); await preview(page);
    await page.evaluate(() => { redgifsFixture.slowPrepare = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => !!redgifsFixture.prepareDone)).toBe(true);
    await page.getByRole('button', { name: 'Close RedGIFs' }).click();
    await open(page); await preview(page);
    await expect(tile(page)).toBeEnabled();
    await tile(page).click();
    await expect(tile(page)).toHaveAttribute('data-queued', '');
    expect(await page.evaluate(() => redgifsFixture.prepares.length)).toBe(1);
    await page.evaluate(() => { redgifsFixture.slowPrepare = false; redgifsFixture.prepareDone(); });
    await expect(status(page)).toContainText('Video sent.');
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
});

test('background upload leaves scrolling, previews, topic searches and niches interactive', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => !!redgifsFixture.uploadDone)).toBe(true);
    const second = page.getByRole('button', { name: /Send video by/ }).nth(1);
    await expect(second).toBeEnabled();
    await second.hover();
    await expect(second).toHaveAttribute('data-previewing', 'true');
    await page.getByRole('searchbox', { name: 'Search RedGIFs' }).fill('another topic');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('Videos for another topic');
    await preview(page);
    await page.getByRole('tab', { name: 'Niches', exact: true }).click();
    await expect(page.getByRole('button', { name: /Browse niche/ })).toHaveCount(2);
    await expect(page.locator('.lowcord-redgifs-queue')).toContainText('Uploading 0%');
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
    await page.evaluate(() => redgifsFixture.uploadDone());
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
    await expect(page.locator('.lowcord-redgifs-queue')).toBeHidden();
});

test('clicked videos queue in order with one transfer at a time and no duplicate enqueues', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    const tiles = page.getByRole('button', { name: /Send video by/ });
    await tiles.nth(0).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.uploads.length)).toBe(1);
    await tiles.nth(1).click(); await tiles.nth(2).click();
    await tiles.nth(0).dispatchEvent('click');
    await expect(page.locator('.lowcord-redgifs-queue')).toContainText('Waiting · #2');
    expect(await page.evaluate(() => redgifsFixture.prepares.length)).toBe(1);
    await expect(tiles.nth(1)).toHaveAttribute('data-queued', '');
    for (let count = 2; count <= 3; count++) {
        await page.evaluate(() => redgifsFixture.uploadDone());
        await expect.poll(() => page.evaluate(() => redgifsFixture.uploads.length)).toBe(count);
    }
    await page.evaluate(() => redgifsFixture.uploadDone());
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(3);
    expect(await page.evaluate(() => redgifsFixture.prepares.map(job => job.key))).toEqual(['key10', 'key11', 'key12']);
    expect(await page.evaluate(() => redgifsFixture.posts.map(post => post.url))).toEqual(Array(3).fill('/channels/100/messages'));
    await expect(tiles.nth(0)).toHaveAttribute('data-sent', '');
    await expect(tiles.nth(1)).toHaveAttribute('data-sent', '');
    await expect(tiles.nth(2)).toHaveAttribute('data-sent', '');
});

test('failed queued transfer is retryable and does not block the next video', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.slowPrepare = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => !!redgifsFixture.prepareDone)).toBe(true);
    const second = page.getByRole('button', { name: /Send video by/ }).nth(1);
    await second.click();
    await page.evaluate(() => {
        redgifsFixture.slowPrepare = false; redgifsFixture.prepareErrorOnce = 'ffmpeg-missing'; redgifsFixture.prepareDone();
    });
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
    await expect(tile(page)).toBeEnabled();
    await expect(second).toHaveAttribute('data-sent', '');
    expect(await page.evaluate(() => redgifsFixture.prepares.length)).toBe(2);
});

test('queue is bounded to ten jobs and closing clears pending sends', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.count = 24; redgifsFixture.slowPrepare = true; });
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect.poll(() => page.getByRole('button', { name: /Send video by/ }).count()).toBeGreaterThan(2);
    for (let i = 0; i < 4; i++) {
        await page.locator('.lowcord-redgifs-grid').evaluate(node => {
            for (const button of node.querySelectorAll('.lowcord-redgifs-thumb')) button.click();
        });
        await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop += 700; });
        await page.waitForTimeout(40);
    }
    await expect(page.locator('.lowcord-redgifs-job')).toHaveCount(10);
    await expect(page.locator('.lowcord-redgifs-queue')).toContainText('Waiting · #9');
    expect(await page.evaluate(() => redgifsFixture.prepares.length)).toBe(1);
    await page.getByRole('button', { name: 'Close RedGIFs' }).click();
    await page.evaluate(() => redgifsFixture.prepareDone());
    expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(0);
});

test('search failure offers retry; Escape releases preview and restores composer focus', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.searchError = true; });
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(status(page)).toContainText('limiting requests');
    await page.evaluate(() => { redgifsFixture.searchError = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(3);
    await preview(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'RedGIFs picker' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeFocused();
    expect(await page.evaluate(() => redgifsFixture.cancels)).toBe(2);
});

test('disabling picker closes it and removes its action; feed stays bounded', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.count = 24; });
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    for (let i = 0; i < 4; i++) {
        // Exercise the manual fallback without scrollIntoView also triggering
        // automatic pagination and exhausting the five-page fixture early.
        await page.getByRole('button', { name: 'Load more' }).evaluate(button => button.click());
        await expect(page.locator('.lowcord-redgifs-results')).toHaveAttribute('aria-busy', 'false');
    }
    expect(await page.getByRole('button', { name: /Send video by/ }).count()).toBeLessThanOrEqual(12);
    await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = 0; });
    await expect(page.getByRole('button', { name: 'Send video by fixture10', exact: true })).toBeVisible();
    await page.evaluate(() => Lowcord.extensions.set('redgifsPicker', false));
    await expect(page.getByRole('dialog', { name: 'RedGIFs picker' })).toHaveCount(0);
    await page.locator('.lowcord-actions-button').click();
    await expect(page.getByRole('menuitem', { name: 'RedGIFs', exact: true })).toHaveCount(0);
});

test('queue shows progress, pauses waiting jobs, removes a waiting clip, and retries failures', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.uploads.length)).toBe(1);
    await page.evaluate(() => redgifsFixture.progress(1000, 4000));
    await expect(page.locator('.lowcord-redgifs-queue')).toContainText('Uploading 25% → Chat 100');
    await page.evaluate(() => redgifsFixture.progress({ loaded: 3, total: 4 }));
    await expect(page.locator('.lowcord-redgifs-queue')).toContainText('Uploading 75% → Chat 100');
    await page.getByRole('button', { name: 'Pause queue', exact: true }).click();
    await page.getByRole('button', { name: /Send video by/ }).nth(1).click();
    await page.getByRole('button', { name: /Send video by/ }).nth(2).click();
    const rows = page.locator('.lowcord-redgifs-job');
    await expect(rows).toHaveCount(3);
    await page.getByRole('button', { name: 'Show upload queue', exact: true }).click();
    await page.screenshot({ path: '/tmp/lowcord-redgifs-queue.png' });
    await rows.nth(2).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await page.evaluate(() => { redgifsFixture.slowUpload = false; redgifsFixture.uploadDone(); });
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
    expect(await page.evaluate(() => redgifsFixture.prepares.length)).toBe(1);
    await page.evaluate(() => { redgifsFixture.prepareErrorOnce = 'ffmpeg-missing'; });
    await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
    await expect(rows).toContainText('Failed');
    await rows.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(2);
    const nonces = await page.evaluate(() => redgifsFixture.posts.map(post => post.body.nonce));
    expect(new Set(nonces).size).toBe(2);
});

test('optional background jobs survive closing, capture destination, reopen, and keep sleep blocked', async ({ page }) => {
    await page.addScriptTag({ url: '/injection/background.js' });
    await open(page);
    await page.getByRole('button', { name: 'Picker options', exact: true }).click();
    const setting = page.getByRole('checkbox', { name: 'Keep uploading when picker closes' });
    await expect(setting).not.toBeChecked(); await setting.check();
    await page.getByRole('button', { name: 'Picker options', exact: true }).click();
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.uploads.length)).toBe(1);
    await page.getByRole('button', { name: 'Close RedGIFs' }).click();
    await page.evaluate(() => { redgifsFixture.channel = '200'; for (const listener of redgifsFixture.listeners) listener(); });
    expect(await page.evaluate(() => Lowcord.redgifs.busy())).toBe(true);
    expect(await page.evaluate(() => window.__lowcordBusy())).toBe(true);
    expect(await page.evaluate(() => redgifsFixture.cancelledUpload)).toBeUndefined();
    await page.evaluate(() => Lowcord.redgifs.open());
    await expect(page.locator('.lowcord-redgifs-queue')).toContainText('Chat 100');
    await page.evaluate(() => redgifsFixture.uploadDone());
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
    expect(await page.evaluate(() => redgifsFixture.posts[0].url)).toBe('/channels/100/messages');
    await expect.poll(() => page.evaluate(() => Lowcord.redgifs.busy())).toBe(false);
    await page.getByRole('button', { name: 'Picker options', exact: true }).click();
    await expect(setting).toBeChecked();
});

test('favorites store only IDs/basic metadata and refresh media when opened; niches can be pinned', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
        redgifsFixture.resolved = [];
        __LOWCORD_NATIVE__.redgifsResolve = async id => { redgifsFixture.resolved.push(id); return { id, key: 'fresh', author: 'saved fixture',
            width: 360, height: 640, duration: 2, preview: '/media/sample.mp4', poster: '/media/sample.png' }; };
    });
    await page.getByRole('button', { name: 'Save favorite fixture10', exact: true }).click();
    await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send video by saved fixture', exact: true })).toBeVisible();
    expect(await page.evaluate(() => redgifsFixture.resolved)).toEqual(['feed10']);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lowcord.redgifs.saved.v1')));
    expect(stored.favorites).toEqual([{ id: 'feed10', author: 'fixture10' }]);
    expect(JSON.stringify(stored)).not.toMatch(/\.mp4|key|preview|poster/);
    await page.getByRole('tab', { name: 'Niches', exact: true }).click();
    await page.getByRole('button', { name: 'Save pinned niche Neutral animation', exact: true }).click();
    await page.getByRole('button', { name: '# Neutral animation', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('Neutral animation');
});

test('near-bottom scrolling fetches one next page and returning to top restores earlier clips', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.count = 24; });
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => page.evaluate(() => redgifsFixture.searches.filter(x => x.page === 2).length)).toBe(1);
    expect(await page.locator('.lowcord-redgifs-thumb').count()).toBeLessThan(16);
    await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = 0; });
    await expect(page.getByRole('button', { name: 'Send video by fixture10', exact: true })).toBeVisible();
    expect(await page.evaluate(() => redgifsFixture.searches.filter(x => x.page === 2).length)).toBe(1);
});

test('rapid scrub movement retains the latest target until the current seek completes', async ({ page }) => {
    await open(page); await preview(page);
    const metrics = await tile(page).evaluate(async button => {
        const video = button.querySelector('video'), box = button.getBoundingClientRect();
        let seeking = true, writes = [];
        const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        Object.defineProperty(video, 'seeking', { configurable: true, get: () => seeking });
        Object.defineProperty(video, 'currentTime', { configurable: true, get: () => time.get.call(video), set: value => { writes.push(value); time.set.call(video, value); } });
        for (let i = 0; i < 25; i++) {
            button.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + box.width * (i + 1) / 30, pointerType: 'mouse' }));
            await new Promise(requestAnimationFrame);
        }
        const during = writes.length;
        seeking = false; video.dispatchEvent(new Event('seeked'));
        const after = writes.length, last = writes.at(-1);
        delete video.seeking; delete video.currentTime;
        return { during, after, last, target: video.duration * 25 / 30 };
    });
    expect(metrics.during).toBe(0); expect(metrics.after).toBe(1);
    expect(metrics.last).toBeCloseTo(metrics.target, 1);
});

test('duplicate prevention is scoped to the destination chat', async ({ page }) => {
    await open(page); await tile(page).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
    await page.getByRole('button', { name: 'Close RedGIFs' }).click();
    await page.evaluate(() => { redgifsFixture.channel = '200'; Lowcord.redgifs.open(); });
    await expect(tile(page)).toBeEnabled(); await tile(page).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(2);
    expect(await page.evaluate(() => redgifsFixture.posts.map(post => post.url))).toEqual(['/channels/100/messages', '/channels/200/messages']);
});

test('cancelling an active queue job stops its upload and allows the next job to run', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.uploads.length)).toBe(1);
    await page.getByRole('button', { name: /Send video by/ }).nth(1).click();
    await page.evaluate(() => { redgifsFixture.slowUpload = false; });
    await page.getByRole('button', { name: 'Show upload queue', exact: true }).click();
    await page.locator('.lowcord-redgifs-job').first().getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
    expect(await page.evaluate(() => redgifsFixture.cancelledUpload)).toBe(true);
    expect(await page.evaluate(() => redgifsFixture.uploads.length)).toBe(2);
    await expect(page.locator('.lowcord-redgifs-job')).toContainText('Cancelled');
});

test('appending another page keeps an active preview connected and playing', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { redgifsFixture.slowQuery = ''; });
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!redgifsFixture.searchDone)).toBe(true);
    await preview(page);
    await page.evaluate(() => { delete redgifsFixture.slowQuery; redgifsFixture.searchDone(); });
    await expect(page.getByRole('button', { name: 'Send video by fixture20', exact: true })).toHaveCount(1);
    await expect(page.locator('.lowcord-redgifs-results')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => page.locator('.lowcord-redgifs video').evaluate(video => video.paused)).toBe(false);
    await expect(tile(page)).toHaveAttribute('data-previewing', 'true');
});

test('compact header, niche controls and collapsed uploads leave most space for media', async ({ page }) => {
    await open(page);
    for (const viewport of [{ width: 1000, height: 800 }, { width: 520, height: 400 }]) {
        await page.setViewportSize(viewport);
        const bounds = await page.locator('.lowcord-redgifs').evaluate(node => {
            const box = node.getBoundingClientRect(), header = node.querySelector('header').getBoundingClientRect();
            const results = node.querySelector('.lowcord-redgifs-results').getBoundingClientRect();
            return { header: header.height, fraction: results.height / box.height,
                bottom: box.bottom, right: box.right, scrolls: node.scrollHeight > node.clientHeight };
        });
        expect(bounds.header).toBeLessThanOrEqual(32);
        expect(bounds.fraction).toBeGreaterThan(.77);
        expect(bounds.scrolls).toBe(false);
        expect(viewport.width - bounds.right).toBe(16); expect(viewport.height - bounds.bottom).toBe(16);
    }
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.getByRole('tab', { name: 'Niches', exact: true }).click();
    const stars = await page.locator('.lowcord-redgifs-niche-card').evaluateAll(cards => cards.map(card => {
        const row = card.getBoundingClientRect(), star = card.querySelector('.lowcord-redgifs-star').getBoundingClientRect();
        const glyph = card.querySelector('.lowcord-redgifs-star svg').getBoundingClientRect();
        const arrow = card.querySelector('.lowcord-redgifs-niche > svg').getBoundingClientRect();
        return { centered: Math.abs(star.y + star.height / 2 - row.y - row.height / 2),
            size: star.width, glyph: glyph.width, separated: arrow.right <= star.left, height: row.height };
    }));
    for (const star of stars) {
        expect(star.centered).toBeLessThanOrEqual(1); expect(star.size).toBe(24); expect(star.glyph).toBe(14);
        expect(star.separated).toBe(true); expect(star.height).toBe(56);
    }
    await page.screenshot({ path: '/tmp/lowcord-redgifs-compact-niches.png' });
    await page.getByRole('tab', { name: 'Videos', exact: true }).click();
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.uploads.length)).toBe(1);
    await expect(page.getByRole('button', { name: 'Show upload queue', exact: true })).toHaveAttribute('aria-expanded', 'false');
    expect((await page.locator('.lowcord-redgifs-queue').boundingBox()).height).toBeLessThanOrEqual(36);
    const fraction = await page.locator('.lowcord-redgifs').evaluate(node => node.querySelector('.lowcord-redgifs-results').clientHeight / node.clientHeight);
    expect(fraction).toBeGreaterThan(.8);
    await page.screenshot({ path: '/tmp/lowcord-redgifs-compact-upload.png' });
    await page.getByRole('button', { name: 'Show upload queue', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-job')).toBeVisible();
    expect((await page.locator('.lowcord-redgifs-job').boundingBox()).height).toBeLessThanOrEqual(38);
    await page.getByRole('button', { name: 'Picker options', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Keep uploading when picker closes' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Picker options', exact: true })).toBeFocused();
    await expect(page.getByRole('dialog', { name: 'RedGIFs picker' })).toBeVisible();
});
