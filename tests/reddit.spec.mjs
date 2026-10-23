import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        const fixture = window.redditFixture = { channel: '100', prepares: [], uploads: [], posts: [] };
        const selected = { getChannelId: () => fixture.channel, addChangeListener() {}, removeChangeListener() {} };
        const store = window.Lowcord.store;
        window.Lowcord.store = name => ({ SelectedChannelStore: selected, UserStore: { getCurrentUser: () => ({ premiumType: 2 }) } })[name] || store(name);
        Object.defineProperty(window.Lowcord, 'CloudUpload', { value: class {
            constructor({ file }) { this.file = file; this.handlers = {}; this.filename = file.name; this.uploadedFilename = `native/${file.name}`; }
            on(type, fn) { this.handlers[type] = fn; }
            async upload() { fixture.uploads.push(this.file.name); this.handlers.complete(); }
        } });
        Object.defineProperty(window.Lowcord, 'RestAPI', { value: { post: async request => {
            if (fixture.holdPost) await new Promise(resolve => { fixture.releasePost = resolve; });
            fixture.posts.push(request); return { body: { id: 'sent' } };
        } } });
        const image = { id: 'img1', key: 'k-img', kind: 'image', title: 'A photo', subreddit: 'pics', nsfw: true, poster: '/media/sample.png' };
        const gallery = { id: 'gal1', key: 'k-gal', kind: 'gallery', title: 'Two things', subreddit: 'pics', count: 2, animated: 1, poster: '/media/sample.png',
            items: [{ index: 0, type: 'image', animated: false, src: '/media/sample.png', thumb: '/media/sample.png' },
                { index: 1, type: 'video', animated: true, src: '/media/sample.mp4', thumb: null }] };
        window.__LOWCORD_NATIVE__ = { reddit: async (action, ...args) => {
            if (action === 'search') return { items: [image, gallery], after: null, account: null };
            if (action === 'prepare') {
                const [key, limit, selection] = args;
                fixture.prepares.push({ key, limit, selection });
                const files = key === 'k-gal' ? (selection ?? [0, 1]).map(index => ({ url: index ? '/media/sample.mp4' : '/media/sample.png',
                    name: `reddit-gal1-${index + 1}.${index ? 'mp4' : 'png'}`, type: index ? 'video/mp4' : 'image/png' }))
                    : [{ url: '/media/sample.png', name: 'reddit-img1.png', type: 'image/png' }];
                return { handle: key, files, quality: 'Original' };
            }
            return null;
        } };
        document.querySelector('main').replaceChildren();
        const composer = document.createElement('div');
        composer.className = 'channelTextArea_test';
        composer.style = 'position:fixed;bottom:20px;left:250px;right:30px;';
        composer.innerHTML = '<div class="buttons_test"></div><div contenteditable="true" role="textbox" aria-label="Message composer"></div>';
        document.querySelector('main').append(composer);
    });
    await page.addStyleTag({ url: '/injection/reddit.css' });
    await page.addScriptTag({ url: '/injection/reddit.js' });
    await page.evaluate(() => window.Lowcord.reddit.open());
    await expect(page.getByRole('dialog', { name: 'Reddit picker' })).toBeVisible();
});
const label = locator => locator.evaluate(node => getComputedStyle(node, '::after').content);

test('a sent post says Sent, not Sending, and NSFW posts are not spoilered by default', async ({ page }) => {
    await page.evaluate(() => { redditFixture.holdPost = true; });
    const photo = page.getByRole('button', { name: /^Send image from r\/pics/ });
    await photo.click();
    await expect.poll(() => page.evaluate(() => typeof redditFixture.releasePost)).toBe('function');
    await expect.poll(() => label(photo)).toBe('"Sending…"');
    await page.evaluate(() => redditFixture.releasePost());
    await expect.poll(() => label(photo)).toBe('"Sent"');
    await expect(photo).toBeDisabled();
    await expect(page.locator('.lowcord-reddit-queue')).toBeHidden();
    expect(await page.evaluate(() => redditFixture.uploads)).toEqual(['reddit-img1.png']);
});

test('the spoiler option marks NSFW posts', async ({ page }) => {
    await page.getByRole('button', { name: 'Picker options' }).click();
    await page.getByLabel('Send NSFW and spoiler posts as spoilers').check();
    await page.getByRole('button', { name: /^Send image from r\/pics/ }).click();
    await expect.poll(() => page.evaluate(() => redditFixture.uploads)).toEqual(['SPOILER_reddit-img1.png']);
});

test('a gallery opens a viewer where GIFs play and only picked items are sent', async ({ page }) => {
    await page.getByRole('button', { name: /^Open gallery of 2/ }).click();
    const viewer = page.getByRole('group', { name: 'Gallery: Two things' });
    await expect(viewer.getByText('1 / 2')).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Send all 2' })).toBeEnabled();
    await expect(viewer.getByRole('option', { name: 'Item 1' , exact: true })).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('ArrowRight');
    await expect(viewer.getByText('2 / 2')).toBeVisible();
    await expect.poll(() => viewer.locator('video').evaluate(video => !video.paused && video.muted && video.loop)).toBe(true);
    await viewer.getByRole('button', { name: 'Select', exact: true }).click();
    await viewer.getByRole('button', { name: 'Send 1 selected' }).click();
    await expect.poll(() => page.evaluate(() => redditFixture.posts.length)).toBe(1);
    await expect(viewer.getByRole('button', { name: 'Sent', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    expect(await page.evaluate(() => redditFixture.prepares.at(-1).selection)).toEqual([1]);
    expect(await page.evaluate(() => redditFixture.uploads)).toEqual(['reddit-gal1-2.mp4']);
    const tile = page.getByRole('button', { name: /^Open gallery of 2/ });
    await expect.poll(() => label(tile)).toBe('"Sent"');
    await expect(tile).toBeEnabled();
    await tile.click();
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Reddit picker' })).toBeVisible();
});

test('right-clicking a gallery item sends just that item and keeps the gallery open', async ({ page }) => {
    await page.getByRole('button', { name: /^Open gallery of 2/ }).click();
    const viewer = page.getByRole('group', { name: 'Gallery: Two things' });
    await viewer.getByRole('option', { name: 'Item 1', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send this image' }).click();
    await expect.poll(() => page.evaluate(() => redditFixture.posts.length)).toBe(1);
    expect(await page.evaluate(() => redditFixture.prepares.at(-1).selection)).toEqual([0]);
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Sent', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await page.getByRole('button', { name: /^Open gallery of 2/ }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Send all 2' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
});
