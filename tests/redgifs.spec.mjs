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
                if (options.mode === 'creators' && !options.creator) return { creators: [{ id: 'neutral_creator', name: 'Neutral Creator', videos: 12, followers: 34, verified: true }], more: page < 2 };
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
    expect(await page.evaluate(() => redgifsFixture.searches.at(-1))).toEqual({ query: '', page: 2, mode: 'videos', nicheId: 'neutral-animation' });
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

async function dragPickerControl(page, name, dx, dy) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
}

test('picker drag and resize persist, preserve chat drafts and reset without changing saved media', async ({ page }) => {
    await open(page);
    const picker = page.getByRole('dialog', { name: 'RedGIFs picker', exact: true });
    const before = await picker.boundingBox();
    await dragPickerControl(page, 'Move RedGIFs picker', -400, -40);
    await expect.poll(async () => (await picker.boundingBox()).x).toBe(before.x - 400);
    expect((await picker.boundingBox()).y).toBe(before.y - 40);
    await dragPickerControl(page, 'Resize RedGIFs picker', 60, 40);
    await expect.poll(async () => (await picker.boundingBox()).width).toBe(480);
    const moved = await picker.boundingBox();
    expect(moved.height).toBe(720);
    expect(await page.evaluate(() => redgifsFixture.posts)).toEqual([]);
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveText('draft stays here');
    const stored = await page.evaluate(() => JSON.parse(Lowcord.storage.getItem('lowcord.redgifs.layout.v1')));
    expect(stored).toEqual({ x: moved.x, y: moved.y, width: moved.width, height: moved.height });
    await page.getByRole('button', { name: 'Close RedGIFs', exact: true }).click();
    await open(page);
    expect(await picker.boundingBox()).toEqual(moved);
    await page.getByRole('button', { name: 'Picker options', exact: true }).click();
    await page.getByRole('button', { name: 'Reset picker size and position', exact: true }).click();
    await expect.poll(async () => (await picker.boundingBox()).width).toBe(420);
    expect(await page.evaluate(() => Lowcord.storage.getItem('lowcord.redgifs.layout.v1'))).toBeNull();
});

test('collapse releases previews, retains browsing state and lets an active upload finish', async ({ page }) => {
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await open(page);
    await page.getByRole('tab', { name: 'Explore', exact: true }).click();
    await page.getByRole('searchbox').fill('forest');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => Boolean(redgifsFixture.uploadDone))).toBe(true);
    await page.getByRole('button', { name: 'Send video by fixture11', exact: true }).hover();
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(1);
    await page.getByRole('button', { name: 'Collapse RedGIFs picker', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'RedGIFs picker', exact: true });
    expect((await picker.boundingBox()).height).toBe(44);
    expect((await picker.boundingBox()).width).toBe(220);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    expect(await page.evaluate(() => Lowcord.redgifs.busy())).toBe(true);
    await page.getByRole('textbox', { name: 'Message composer' }).fill('Still typing while browsing is collapsed');
    await page.evaluate(() => redgifsFixture.uploadDone());
    await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
    await page.getByRole('button', { name: 'Restore RedGIFs picker', exact: true }).click();
    await expect(page.getByRole('searchbox')).toHaveValue('forest');
    await expect(page.getByRole('tab', { name: 'Explore', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toHaveText('Still typing while browsing is collapsed');
});

test('keyboard movement and resize remain reachable after window shrink and cancelled drags revert', async ({ page }) => {
    await open(page);
    const picker = page.getByRole('dialog', { name: 'RedGIFs picker', exact: true });
    const move = page.getByRole('button', { name: 'Move RedGIFs picker', exact: true });
    await move.press('Shift+ArrowLeft'); await move.press('ArrowUp');
    expect((await picker.boundingBox()).x).toBe(524);
    await page.getByRole('button', { name: 'Resize RedGIFs picker', exact: true }).press('ArrowLeft');
    expect((await picker.boundingBox()).width).toBe(410);
    const before = await picker.boundingBox(), grip = await move.boundingBox();
    await page.mouse.move(grip.x + 8, grip.y + 8); await page.mouse.down();
    await page.mouse.move(grip.x - 90, grip.y + 50);
    await page.keyboard.press('Escape'); await page.mouse.up();
    expect(await picker.boundingBox()).toEqual(before);
    await expect(picker).not.toHaveAttribute('data-gesture');
    await page.setViewportSize({ width: 360, height: 520 });
    const small = await picker.boundingBox();
    expect(small.x).toBeGreaterThanOrEqual(16); expect(small.y).toBeGreaterThanOrEqual(16);
    expect(small.x + small.width).toBeLessThanOrEqual(344);
    expect(small.y + small.height).toBeLessThanOrEqual(504);
    await page.getByRole('button', { name: 'Collapse RedGIFs picker', exact: true }).click();
    await move.press('Shift+ArrowRight'); await move.press('Shift+ArrowDown');
    const collapsed = await picker.boundingBox();
    expect(collapsed.x + collapsed.width).toBeLessThanOrEqual(344);
    expect(collapsed.y + collapsed.height).toBeLessThanOrEqual(504);
    await page.getByRole('button', { name: 'Restore RedGIFs picker', exact: true }).click();
    await page.setViewportSize({ width: 1000, height: 800 });
    await move.press('Home');
    expect(await picker.boundingBox()).toEqual({ x: 564, y: 104, width: 420, height: 680 });
});

test('movable creator picker matches the selected floating layout and retains its grid after resizing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
        const search = __LOWCORD_NATIVE__.redgifsSearch;
        __LOWCORD_NATIVE__.redgifsSearch = async (query, page, options) => options.mode === 'creators' && !options.creator
            ? { creators: ['wildframes', 'coastalnotes', 'trailandlight', 'foresthour', 'skyarchive', 'riverfilms', 'tinywild', 'nordicviews', 'mossandstone', 'oceanloops', 'goldenhour', 'fieldnotes']
                .map((id, index) => ({ id, name: id, followers: 1200 + index * 54, videos: 86 + index, verified: false })), more: false }
            : search(query, page, options);
        const scene = document.createElement('div');
        scene.style = 'position:absolute;inset:0;z-index:-1;display:flex;font:14px system-ui';
        scene.innerHTML = '<aside style="width:200px;padding:20px;background:#202024"><strong>Weekend Club</strong><p># general</p><p># trail-plans</p><p># photos</p></aside><div style="flex:1;padding:30px 30px 80px 200px"><h3># general</h3><p><strong>Nora</strong></p><p>Finally picked a hike for this weekend! The views at the top look incredible.</p><p><strong>Alex</strong></p><p>That looks amazing! Want to meet at the trailhead around eight?</p></div>';
        document.body.append(scene);
    });
    await open(page);
    await page.getByRole('tab', { name: 'Creators', exact: true }).click();
    await dragPickerControl(page, 'Move RedGIFs picker', -540, 16);
    await dragPickerControl(page, 'Resize RedGIFs picker', -60, -100);
    const picker = page.getByRole('dialog', { name: 'RedGIFs picker', exact: true });
    await expect.poll(async () => (await picker.boundingBox()).height).toBe(580);
    expect((await picker.boundingBox()).width).toBe(360);
    const rows = await page.locator('.lowcord-redgifs-creator').evaluateAll(items => items.slice(0, 3).map(item => item.getBoundingClientRect().y));
    expect(rows[0]).toBe(rows[1]); expect(rows[2]).toBeGreaterThan(rows[0]);
    await page.screenshot({ path: '/tmp/lowcord-redgifs-movable.png' });
    await picker.screenshot({ path: '/tmp/lowcord-redgifs-movable-panel.png' });
    await page.getByRole('button', { name: 'Collapse RedGIFs picker', exact: true }).click();
    await page.screenshot({ path: '/tmp/lowcord-redgifs-collapsed.png' });
    await page.getByRole('button', { name: 'Restore RedGIFs picker', exact: true }).click();
    await page.setViewportSize({ width: 360, height: 520 });
    await picker.screenshot({ path: '/tmp/lowcord-redgifs-movable-narrow.png' });
    expect(errors).toEqual([]);
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
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('Popular niches');
    await expect(page.getByRole('searchbox')).toHaveValue('');
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

test('favorites, pinned niches and background preference persist after Discord deletes localStorage', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
        redgifsFixture.toasts = [];
        Lowcord.extensions.toast = (...args) => redgifsFixture.toasts.push(args);
        delete window.localStorage;
    });
    await page.getByRole('button', { name: 'Save favorite fixture10', exact: true }).click();
    await page.getByRole('tab', { name: 'Niches', exact: true }).click();
    await page.getByRole('button', { name: 'Save pinned niche Neutral animation', exact: true }).click();
    await page.getByRole('button', { name: 'Picker options', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Keep uploading when picker closes' }).check();
    const saved = await page.evaluate(() => JSON.parse(Lowcord.storage.getItem('lowcord.redgifs.saved.v1')));
    expect(saved).toEqual({ favorites: [{ id: 'feed10', author: 'fixture10' }],
        niches: [{ id: 'neutral-animation', name: 'Neutral animation' }], creators: [], background: true });
    expect(await page.evaluate(() => redgifsFixture.toasts)).toEqual([]);
});

test('favorites do not inherit topic searches, and removing one updates the collection immediately', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
        __LOWCORD_NATIVE__.redgifsResolve = async id => ({ id, key: 'fresh', author: 'fixture10', preview: '/media/sample.mp4' });
    });
    await page.getByRole('button', { name: 'Save favorite fixture10', exact: true }).click();
    await page.getByRole('searchbox').fill('animation');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
    await expect(page.getByRole('searchbox')).toHaveValue('');
    await expect(tile(page)).toBeVisible();
    await page.getByRole('button', { name: 'Remove favorite fixture10', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-card')).toHaveCount(0);
    await expect(status(page)).toContainText('No saved videos');
    await page.getByRole('tab', { name: 'Trending', exact: true }).click();
    await expect(page.getByRole('searchbox')).toHaveValue('animation');
});

test('favorites list the newest saved video first without reordering stored favorites', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
        __LOWCORD_NATIVE__.redgifsResolve = async id => ({ id, key: 'fresh', author: `fixture${id.slice(4)}`, preview: '/media/sample.mp4', poster: '/media/sample.png' });
    });
    for (const name of ['fixture10', 'fixture11', 'fixture12']) await page.getByRole('button', { name: `Save favorite ${name}`, exact: true }).click();
    await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-favorite-author')).toHaveText(['@fixture12', '@fixture11', '@fixture10']);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lowcord.redgifs.saved.v1')));
    expect(stored.favorites.map(item => item.id)).toEqual(['feed10', 'feed11', 'feed12']);
});

test('creators can be saved from the directory and creator view, then opened from Favorites', async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Creators', exact: true }).click();
    await page.getByRole('button', { name: 'Save favorite creator Neutral Creator', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove favorite creator Neutral Creator', exact: true })).toHaveAttribute('aria-pressed', 'true');
    let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lowcord.redgifs.saved.v1')));
    expect(stored.creators).toEqual([{ id: 'neutral_creator', name: 'Neutral Creator', verified: true, followers: 34, videos: 12 }]);
    await page.getByRole('button', { name: 'Browse creator Neutral Creator', exact: true }).click();
    const pill = page.locator('.lowcord-redgifs-creator-save');
    await expect(pill).toHaveText('Saved');
    await pill.click();
    await expect(pill).toHaveText('Save');
    await expect(pill).toHaveAttribute('aria-label', 'Save favorite creator Neutral Creator');
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('lowcord.redgifs.saved.v1')));
    expect(stored.creators).toEqual([]);
    await pill.click();
    await expect(pill).toHaveText('Saved');

    await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
    const kinds = page.getByRole('group', { name: 'Saved type' });
    await expect(kinds.getByRole('button', { name: 'Clips 0', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await kinds.getByRole('button', { name: 'Creators 1', exact: true }).click();
    await expect(page.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search saved creators');
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('1 saved creator');
    await expect(page.locator('.lowcord-redgifs-creators')).toHaveCount(1);
    await page.locator('.lowcord-redgifs').screenshot({ path: '/tmp/lowcord-redgifs-favorite-creators.png' });
    await page.evaluate(() => { redgifsFixture.searches = []; });
    await page.getByRole('button', { name: 'Browse creator Neutral Creator', exact: true }).click();
    await expect(page.getByRole('button', { name: /Send video by/ })).toHaveCount(3);
    expect(await page.evaluate(() => redgifsFixture.searches)).toEqual([{ query: '', page: 1, mode: 'creators', creator: 'neutral_creator' }]);
    await expect(page.getByRole('tab', { name: 'Favorites', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(kinds).toBeHidden();
    await expect(pill).toHaveText('Saved');
    await page.locator('.lowcord-redgifs').screenshot({ path: '/tmp/lowcord-redgifs-favorite-creator-view.png' });
    await page.getByRole('button', { name: 'Back to favorites', exact: true }).click();
    await expect(kinds.getByRole('button', { name: 'Creators 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Remove favorite creator Neutral Creator', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-card')).toHaveCount(0);
    await expect(status(page)).toContainText('No saved creators yet');
    await expect(kinds.getByRole('button', { name: 'Creators 0', exact: true })).toBeVisible();
});

test.describe('saved creators', () => {
    test.use({ storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:4318', localStorage: [{
        name: 'lowcord.redgifs.saved.v1', value: JSON.stringify({ favorites: [], creators: [{ id: 'oldest_creator', name: 'Oldest' },
            { id: 'middle_creator', name: 'Middle', followers: 5 }, { id: 'newest_creator', name: 'Newest', verified: true }, { id: 'bad id!', name: 'Rejected' }] }),
    }] }] } });

    test('list newest first, filter by search and keep searches separate from clips', async ({ page }) => {
        await open(page);
        await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
        await page.getByRole('button', { name: 'Creators 3', exact: true }).click();
        await expect(page.locator('.lowcord-redgifs-creator-name strong')).toHaveText(['@newest_creator', '@middle_creator', '@oldest_creator']);
        await expect(page.getByRole('button', { name: 'Browse creator Middle', exact: true })).toContainText('5 followers');
        await page.getByRole('searchbox').fill('mid');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('1 saved creator matching this search');
        await page.getByRole('button', { name: 'Clips 0', exact: true }).click();
        await expect(page.getByRole('searchbox')).toHaveValue('');
        await page.getByRole('button', { name: 'Creators 3', exact: true }).click();
        await expect(page.getByRole('searchbox')).toHaveValue('mid');
        expect(await page.evaluate(() => redgifsFixture.searches.some(search => search.mode === 'favorites'))).toBe(false);
    });
});

test('failed favorites stay removable and retryable without hiding healthy favorites', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Save favorite fixture10', exact: true }).click();
    await page.getByRole('button', { name: 'Save favorite fixture11', exact: true }).click();
    await page.evaluate(() => {
        __LOWCORD_NATIVE__.redgifsResolve = async id => {
            if (id === 'feed10' && !redgifsFixture.recovered) throw new Error('network failure');
            return { id, key: 'fresh', author: id === 'feed10' ? 'fixture10' : 'fixture11', preview: '/media/sample.mp4' };
        };
    });
    await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send video by fixture11', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry favorite fixture10', exact: true })).toBeVisible();
    await page.evaluate(() => { redgifsFixture.recovered = true; });
    await page.getByRole('button', { name: 'Retry favorite fixture10', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send video by fixture10', exact: true })).toBeVisible();
});

test('compact creator grid keeps rows aligned through pagination, narrow windows and keyboard browsing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
        const search = __LOWCORD_NATIVE__.redgifsSearch;
        redgifsFixture.creatorPages = 0;
        __LOWCORD_NATIVE__.redgifsSearch = async (query, page, options) => {
            if (options.mode !== 'creators' || options.creator) return search(query, page, options);
            redgifsFixture.creatorPages = page;
            const names = ['wildframes', 'coastalnotes', 'trailandlight', 'foresthour', 'skyarchive', 'riverfilms', 'tinywild', 'nordicviews', 'mossandstone', 'oceanloops', 'goldenhour', 'fieldnotes', 'cloudwatch', 'pinefilms'];
            return { creators: Array.from({ length: page === 4 ? 7 : 24 }, (_, index) => {
                const rank = (page - 1) * 24 + index;
                const id = names[rank] || (rank === 14 ? 'a_very_long_creator_handle_that_needs_truncation' : `creator${rank}`);
                return { id, name: id, followers: rank === 14 ? null : 24800 + rank * 123, videos: rank === 14 ? null : 132 + rank, verified: rank % 3 === 0 };
            }), more: page < 4 };
        };
    });
    await open(page);
    await page.getByRole('tab', { name: 'Creators', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('Trending creators');
    const metrics = () => page.locator('.lowcord-redgifs-creators').evaluate(grid => {
        const boxes = [...grid.querySelectorAll('.lowcord-redgifs-creator')].map(node => node.getBoundingClientRect());
        const viewport = grid.parentElement.getBoundingClientRect();
        return { rows: boxes.slice(0, 3).map(box => box.y), height: boxes[0].height,
            visible: boxes.filter(box => box.top >= viewport.top && box.bottom <= viewport.bottom).length,
            overflow: grid.scrollWidth > grid.clientWidth || [...grid.querySelectorAll('button')].some(node => node.scrollWidth > node.clientWidth) };
    });
    let boxes = await metrics();
    expect(boxes.rows[0]).toBe(boxes.rows[1]);
    expect(boxes.rows[2]).toBeGreaterThan(boxes.rows[0]);
    expect(boxes.height).toBe(72);
    expect(boxes.visible).toBeGreaterThanOrEqual(12);
    expect(boxes.overflow).toBe(false);
    await expect(page.locator('.lowcord-redgifs-monogram').first()).toHaveCSS('width', '28px');
    await expect(page.getByRole('button', { name: 'Browse creator wildframes', exact: true }).getByRole('img', { name: 'Verified' })).toBeVisible();
    await page.locator('.lowcord-redgifs').screenshot({ path: '/tmp/lowcord-redgifs-creators-compact.png' });
    await page.setViewportSize({ width: 360, height: 520 });
    await expect.poll(async () => (await metrics()).overflow).toBe(false);
    await page.locator('.lowcord-redgifs').screenshot({ path: '/tmp/lowcord-redgifs-creators-compact-narrow.png' });
    for (const count of [2, 3, 4]) {
        await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect.poll(() => page.evaluate(() => redgifsFixture.creatorPages)).toBeGreaterThanOrEqual(count);
        await expect(page.locator('.lowcord-redgifs-results')).toHaveAttribute('aria-busy', 'false');
    }
    await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.getByRole('button', { name: 'Browse creator creator78', exact: true })).toBeVisible();
    expect(await page.locator('.lowcord-redgifs-creator').count()).toBeLessThan(36);
    await expect(page.getByRole('button', { name: 'Browse creator wildframes', exact: true })).toHaveCount(0);
    await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = 0; });
    const first = page.getByRole('button', { name: 'Browse creator wildframes', exact: true });
    await expect(first).toBeVisible();
    await first.focus(); await first.press('Enter');
    await expect(page.locator('.lowcord-redgifs-creators')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send video by fixture10', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to creators', exact: true }).click();
    await expect(first).toBeVisible();
    expect(errors).toEqual([]);
});

test('Explore and Creators browse independently, creator pagination and back navigation retain the search', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await open(page);
    await page.getByRole('tab', { name: 'Explore', exact: true }).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.searches.at(-1))).toEqual({ query: '', page: 1, mode: 'explore' });
    await tile(page).focus();
    await expect(tile(page).locator('video')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Creators', exact: true }).click();
    await expect(page.locator('.lowcord-redgifs video')).toHaveCount(0);
    await page.getByRole('searchbox').fill('neutral');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Browse creator Neutral Creator', exact: true })).toContainText('34 followers');
    await expect(page.getByRole('button', { name: 'Browse creator Neutral Creator', exact: true })).toContainText('12 videos');
    await page.screenshot({ path: '/tmp/lowcord-redgifs-creators.png' });
    await page.getByRole('button', { name: 'Browse creator Neutral Creator', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Creators', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(tile(page)).toBeVisible();
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    expect(await page.evaluate(() => redgifsFixture.searches)).toContainEqual({ query: '', page: 2, mode: 'creators', creator: 'neutral_creator' });
    await page.getByRole('button', { name: 'Back to creators', exact: true }).click();
    await expect(page.getByRole('searchbox')).toHaveValue('neutral');
    await expect(page.getByRole('button', { name: 'Browse creator Neutral Creator', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save favorite creator Neutral Creator', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Creators', exact: true }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Niches', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'Niches', exact: true }).press('End');
    await expect(page.getByRole('tab', { name: 'Favorites', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'Favorites', exact: true }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Trending', exact: true })).toBeFocused();
    expect(errors).toEqual([]);
});

test('upload queue expands upward with matching chevrons, and tabs fit a narrow window', async ({ page }) => {
    await open(page);
    await page.setViewportSize({ width: 360, height: 520 });
    const layout = await page.getByRole('tablist').evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(layout.content).toBeLessThanOrEqual(layout.width);
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    const toggle = page.locator('.lowcord-redgifs-queue-toggle');
    await expect(toggle).toBeVisible();
    expect(await toggle.locator('svg').last().evaluate(node => getComputedStyle(node).transform)).toBe('matrix(-1, 0, 0, -1, 0, 0)');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await toggle.locator('svg').last().evaluate(node => getComputedStyle(node).transform)).toBe('none');
    const row = await page.locator('.lowcord-redgifs-queue-list').boundingBox();
    const bar = await page.locator('.lowcord-redgifs-queue-bar').boundingBox();
    expect(row.y + row.height).toBeLessThanOrEqual(bar.y);
    await page.screenshot({ path: '/tmp/lowcord-redgifs-queue-up.png' });
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
        expect(bounds.fraction).toBeGreaterThan(viewport.height < 500 ? .69 : .82);
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
    await page.getByRole('tab', { name: 'Trending', exact: true }).click();
    await page.evaluate(() => { redgifsFixture.slowUpload = true; });
    await tile(page).click();
    await expect.poll(() => page.evaluate(() => redgifsFixture.uploads.length)).toBe(1);
    await expect(page.getByRole('button', { name: 'Show upload queue', exact: true })).toHaveAttribute('aria-expanded', 'false');
    expect((await page.locator('.lowcord-redgifs-queue').boundingBox()).height).toBeLessThanOrEqual(36);
    const fraction = await page.locator('.lowcord-redgifs').evaluate(node => node.querySelector('.lowcord-redgifs-results').clientHeight / node.clientHeight);
    // The dedicated draggable title bar adds a row above search.
    expect(fraction).toBeGreaterThan(.77);
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

test.describe('compact Favorites gallery', () => {
    test.use({ storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:4318', localStorage: [{
        name: 'lowcord.redgifs.saved.v1', value: JSON.stringify({ favorites: Array.from({ length: 80 }, (_, index) => ({ id: `saved${index}`, author: `creator${index}` })) }),
    }] }] } });

    test.beforeEach(async ({ page }) => {
        await page.evaluate(() => {
            redgifsFixture.resolvedCount = 0;
            __LOWCORD_NATIVE__.redgifsResolve = async id => {
                redgifsFixture.resolvedCount++;
                return { id, key: `fresh${id}`, author: `creator${id.slice(5)}`,
                    width: Number(id.slice(5)) % 2 ? 640 : 360, height: Number(id.slice(5)) % 2 ? 360 : 640,
                    duration: 2, preview: '/media/sample.mp4', poster: '/media/sample.png' };
            };
        });
        await open(page);
        await page.getByRole('tab', { name: 'Favorites', exact: true }).click();
        await expect(page.locator('.lowcord-redgifs-results')).toHaveAttribute('aria-busy', 'false');
    });

    test('three compact columns, captions and saved count fit normal and narrow windows', async ({ page }) => {
        await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('80 saved');
        const measure = () => page.locator('.lowcord-redgifs-favorites').evaluate(grid => {
            const tiles = [...grid.querySelectorAll('.lowcord-redgifs-thumb')].map(tile => tile.getBoundingClientRect());
            const viewport = grid.parentElement.getBoundingClientRect();
            return { first: tiles.slice(0, 4).map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height })),
                visible: tiles.filter(box => box.top >= viewport.top && box.bottom <= viewport.bottom).length,
                intersecting: tiles.filter(box => box.top < viewport.bottom && box.bottom > viewport.top).length,
                overflow: grid.scrollWidth > grid.clientWidth };
        });
        let metrics = await measure();
        expect(metrics.visible).toBeGreaterThanOrEqual(9);
        expect(metrics.intersecting).toBeGreaterThanOrEqual(12);
        for (const box of metrics.first) expect(box.width / box.height).toBeCloseTo(9 / 8, 2);
        expect(metrics.first[0].y).toBe(metrics.first[1].y); expect(metrics.first[1].y).toBe(metrics.first[2].y);
        expect(metrics.first[3].y).toBeGreaterThan(metrics.first[0].y);
        await expect(page.locator('.lowcord-redgifs-favorite-author').first()).toHaveText('@creator79');
        expect(await tile(page).locator('img').evaluate(node => getComputedStyle(node).objectFit)).toBe('cover');
        await page.locator('.lowcord-redgifs').screenshot({ path: '/tmp/lowcord-redgifs-favorites-grid.png' });
        await page.setViewportSize({ width: 360, height: 520 });
        await expect.poll(async () => Math.max(...(await measure()).first.map(box => Math.abs(box.width / box.height - 9 / 8)))).toBeLessThan(.01);
        metrics = await measure();
        expect(metrics.overflow).toBe(false);
        expect(metrics.first[0].width).toBeLessThan(100);
        for (const box of metrics.first) expect(box.width / box.height).toBeCloseTo(9 / 8, 2);
        await page.locator('.lowcord-redgifs').screenshot({ path: '/tmp/lowcord-redgifs-favorites-narrow.png' });
        await page.getByRole('tab', { name: 'Trending', exact: true }).click();
        await expect(page.locator('.lowcord-redgifs-favorites')).toHaveCount(0);
        await expect(page.locator('.lowcord-redgifs-favorite-author')).toHaveCount(0);
        expect((await tile(page).boundingBox()).height).toBeGreaterThan(250);
    });

    test('one inline preview scrubs, sends once, and stars remove without sending', async ({ page }) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await preview(page);
        expect(await tile(page).locator('video').evaluate(node => getComputedStyle(node).objectFit)).toBe('contain');
        const box = await tile(page).boundingBox();
        await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2);
        await expect.poll(() => tile(page).locator('video').evaluate(node => node.currentTime)).toBeGreaterThan(1.2);
        await page.getByRole('button', { name: 'Send video by creator78', exact: true }).focus();
        await expect(page.locator('.lowcord-redgifs video')).toHaveCount(1);
        await page.getByRole('button', { name: 'Send video by creator78', exact: true }).press('Enter');
        await expect.poll(() => page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
        await expect(page.getByRole('button', { name: 'Send video by creator78', exact: true })).toHaveAttribute('data-sent', '');
        await page.getByRole('button', { name: 'Remove favorite creator79', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Send video by creator79', exact: true })).toHaveCount(0);
        await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('79 saved');
        expect(await page.evaluate(() => redgifsFixture.posts.length)).toBe(1);
        await page.getByRole('searchbox').fill('creator7');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await expect(page.locator('.lowcord-redgifs-heading')).toHaveText('10 saved matching this search');
        await expect(page.locator('.lowcord-redgifs-thumb')).toHaveCount(10);
        expect(errors).toEqual([]);
    });

    test('pagination virtualizes complete rows and restores earlier favorites after scrolling', async ({ page }) => {
        for (const count of [48, 72, 80]) {
            await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = node.scrollHeight; });
            await expect.poll(() => page.evaluate(() => redgifsFixture.resolvedCount)).toBeGreaterThanOrEqual(count);
            await expect(page.locator('.lowcord-redgifs-results')).toHaveAttribute('aria-busy', 'false');
        }
        await expect(page.getByRole('button', { name: 'Load more', exact: true })).toBeHidden();
        await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(page.getByRole('button', { name: 'Send video by creator0', exact: true })).toBeVisible();
        expect(await page.locator('.lowcord-redgifs-card').count()).toBeLessThan(36);
        await expect(page.getByRole('button', { name: 'Send video by creator79', exact: true })).toHaveCount(0);
        await page.locator('.lowcord-redgifs-results').evaluate(node => { node.scrollTop = 0; });
        await expect(page.getByRole('button', { name: 'Send video by creator79', exact: true })).toBeVisible();
        const firstRow = await page.locator('.lowcord-redgifs-thumb').evaluateAll(tiles => tiles.slice(0, 3).map(tile => tile.getBoundingClientRect().y));
        expect(new Set(firstRow).size).toBe(1);
    });
});
