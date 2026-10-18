import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        let active = null;
        const pip = window.pipFixture = { requests: [], exits: 0, fail: false, toasts: [] };
        Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
        Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => active });
        HTMLVideoElement.prototype.requestPictureInPicture = async function () {
            pip.requests.push({ id: this.id, disabled: this.disablePictureInPicture, time: this.currentTime, volume: this.volume });
            if (pip.fail) throw new DOMException('Blocked', 'NotAllowedError');
            active = this; this.dispatchEvent(new Event('enterpictureinpicture')); return {};
        };
        document.exitPictureInPicture = async () => {
            pip.exits++; const previous = active; active = null; previous?.dispatchEvent(new Event('leavepictureinpicture'));
        };
        Lowcord.extensions.toast = text => pip.toasts.push(text);
        document.querySelector('main').innerHTML = `<section id="chat-messages-dm-1" style="margin:30px;width:320px">
            <video id="dm-video" controls muted preload="auto" width="320" height="180" src="/media/sample.mp4"></video>
            </section><section id="chat-messages-server-2" style="margin:30px;width:320px">
            <video id="server-video" controls muted preload="auto" width="320" height="180" src="/media/sample.webm"></video></section>
            <textarea aria-label="Draft"></textarea>`;
    });
    await page.addStyleTag({ url: '/injection/picture-in-picture.css' });
    await page.addScriptTag({ url: '/injection/picture-in-picture.js' });
    await expect.poll(() => page.locator('#dm-video').evaluate(node => node.readyState)).toBeGreaterThanOrEqual(2);
});

test('DM and server videos share a pop-out control without changing attachment layout or playback', async ({ page }) => {
    const before = await page.locator('#dm-video').boundingBox();
    await page.locator('#dm-video').evaluate(video => { video.currentTime = .5; video.volume = .4; video.disablePictureInPicture = true; });
    await page.locator('#dm-video').hover();
    const button = page.getByRole('button', { name: 'Picture-in-picture', exact: true });
    await expect(button).toBeVisible();
    const geometry = await button.evaluate(node => {
        const button = node.getBoundingClientRect(), glyph = node.querySelector('svg').getBoundingClientRect();
        const video = document.querySelector('#dm-video').getBoundingClientRect();
        return { width: button.width, height: button.height, insetTop: button.top - video.top, insetRight: video.right - button.right,
            centerX: glyph.x + glyph.width / 2 - (button.x + button.width / 2),
            centerY: glyph.y + glyph.height / 2 - (button.y + button.height / 2) };
    });
    expect(geometry).toEqual({ width: 28, height: 28, insetTop: 8, insetRight: 8, centerX: 0, centerY: 0 });
    await page.screenshot({ path: '/tmp/lowcord-picture-in-picture-control.png' });
    await button.click();
    await expect.poll(() => page.evaluate(() => pipFixture.requests)).toEqual([{ id: 'dm-video', disabled: false, time: .5, volume: .4 }]);
    await expect(page.getByRole('button', { name: 'Exit picture-in-picture', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('#dm-video').evaluate(video => video.disablePictureInPicture)).toBe(false);
    expect(await page.locator('#dm-video').boundingBox()).toEqual(before);
    expect(await page.locator('video').count()).toBe(2);
    await page.getByRole('button', { name: 'Exit picture-in-picture', exact: true }).click();
    await expect.poll(() => page.evaluate(() => pipFixture.exits)).toBe(1);
    expect(await page.locator('#dm-video').evaluate(video => video.disablePictureInPicture)).toBe(true);
    await page.locator('#server-video').hover(); await button.click();
    await expect.poll(() => page.evaluate(() => pipFixture.requests.at(-1).id)).toBe('server-video');
    await expect(page.locator('.lowcord-pip-button')).toHaveCount(1);
});

test('shortcut skips typing, errors allow retry, and disabling cleans up and exits', async ({ page }) => {
    await page.locator('#dm-video').hover();
    await page.keyboard.press('Alt+p');
    await expect.poll(() => page.evaluate(() => pipFixture.requests.length)).toBe(1);
    await page.getByRole('textbox', { name: 'Draft' }).focus();
    await page.keyboard.press('Alt+p');
    expect(await page.evaluate(() => pipFixture.exits)).toBe(0);
    await page.evaluate(() => Lowcord.extensions.set('pictureInPicture', false));
    await expect(page.locator('.lowcord-pip-button')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => pipFixture.exits)).toBe(1);
    await page.locator('#dm-video').hover();
    await expect(page.locator('.lowcord-pip-button')).toHaveCount(0);
    await page.evaluate(() => { Lowcord.extensions.set('pictureInPicture', true); pipFixture.fail = true; });
    await page.locator('#server-video').hover();
    await page.getByRole('button', { name: 'Picture-in-picture', exact: true }).click();
    await expect.poll(() => page.evaluate(() => pipFixture.toasts.length)).toBe(1);
    await page.evaluate(() => { pipFixture.fail = false; });
    await page.getByRole('button', { name: 'Picture-in-picture', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit picture-in-picture', exact: true })).toBeEnabled();
});

test('viewer videos work; removed sources, GIF loops and RedGIFs picker previews do not leave controls', async ({ page }) => {
    await page.locator('#dm-video').hover();
    await expect(page.locator('.lowcord-pip-button')).toBeVisible();
    await page.evaluate(() => document.querySelectorAll('[id^="chat-messages-"]').forEach(node => node.remove()));
    await expect(page.locator('.lowcord-pip-button')).toHaveCount(0);
    await page.evaluate(() => {
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
        dialog.innerHTML = '<video id="viewer" controls muted width="320" height="180" src="/media/sample.mp4"></video>';
        document.body.append(dialog);
    });
    await page.locator('#viewer').hover();
    await expect(page.locator('.lowcord-pip-button')).toBeVisible();
    await page.locator('#viewer').evaluate(video => { video.controls = false; video.autoplay = true; video.loop = true; });
    await page.mouse.move(900, 700); await page.locator('#viewer').hover();
    await expect(page.locator('.lowcord-pip-button')).toHaveCount(0);
    await page.locator('#viewer').evaluate(video => { video.controls = true; video.parentElement.className = 'lowcord-redgifs'; });
    await page.mouse.move(900, 700); await page.locator('#viewer').hover();
    await expect(page.locator('.lowcord-pip-button')).toHaveCount(0);
});
