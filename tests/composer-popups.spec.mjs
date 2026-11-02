import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/extensions');
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        document.querySelector('.channelTextArea_test').style.cssText =
            'position:fixed;left:300px;right:80px;bottom:20px;height:60px';
    });
});

async function aligned(page, selector) {
    await expect.poll(async () => {
        const composer = await page.locator('.channelTextArea_test').boundingBox();
        const box = await page.locator(selector).boundingBox();
        return box && Math.round(box.x + box.width - composer.x - composer.width);
    }).toBe(0);
}

test('banners and process controls stack at the composer right edge', async ({ page }) => {
    await page.evaluate(() => {
        const { ui, mountComposerPopup, toast } = Lowcord.extensions;
        mountComposerPopup(ui('div', { className: 'lowcord-purge-bar' }, 'Deleting messages', ui('button', {}, 'Stop')));
        toast('Metadata removed');
    });
    await aligned(page, '.lowcord-purge-bar');
    await aligned(page, '.lowcord-toast');
    const composer = await page.locator('.channelTextArea_test').boundingBox();
    const toast = await page.locator('.lowcord-toast').boundingBox();
    const purge = await page.locator('.lowcord-purge-bar').boundingBox();
    expect(Math.round(composer.y - toast.y - toast.height)).toBe(12);
    expect(Math.round(toast.y - purge.y - purge.height)).toBe(8);
    expect(purge.width).toBeLessThan(toast.width);
    await page.locator('.channelTextArea_test .lowcord-actions-button').click();
    const trigger = await page.locator('.channelTextArea_test .lowcord-actions-button').boundingBox();
    const menu = await page.locator('.lowcord-actions').boundingBox();
    expect(Math.abs(menu.x + menu.width / 2 - trigger.x - trigger.width / 2)).toBeLessThan(1);
    expect(Math.round(composer.y - menu.y - menu.height)).toBe(12);
    await page.keyboard.press('Escape');
    await expect(page.locator('.lowcord-actions')).toHaveCount(0);
});

test('alignment follows resizing, replacement composers and narrow windows', async ({ page }) => {
    await page.evaluate(() => { window.statusPopup = Lowcord.extensions.progress('Compressing video…', 'Preparing your attachment'); });
    await aligned(page, '.lowcord-toast');
    await page.setViewportSize({ width: 700, height: 700 });
    await aligned(page, '.lowcord-toast');
    await page.evaluate(() => {
        const previous = document.querySelector('.channelTextArea_test');
        const next = previous.cloneNode(true);
        next.style.cssText = 'position:fixed;left:220px;right:24px;bottom:24px;height:100px';
        previous.replaceWith(next);
    });
    await aligned(page, '.lowcord-toast');
    await page.setViewportSize({ width: 400, height: 600 });
    await page.evaluate(() => {
        document.querySelector('.channelTextArea_test').style.left = '16px';
        statusPopup.update('Compressing a very long attachment name…', 'This detail should wrap within the available composer width.');
    });
    await aligned(page, '.lowcord-toast');
    await expect.poll(async () => {
        const composer = await page.locator('.channelTextArea_test').boundingBox();
        const box = await page.locator('.lowcord-toast').boundingBox();
        return box.x >= composer.x;
    }).toBe(true);
    const composer = await page.locator('.channelTextArea_test').boundingBox();
    const box = await page.locator('.lowcord-toast').boundingBox();
    expect(Math.round(composer.y - box.y - box.height)).toBe(12);
    await page.evaluate(() => statusPopup.end());
    await expect(page.locator('.lowcord-composer-popups')).toHaveCount(0);
});

test('notices use a safe right edge without a composer and can reopen after cleanup', async ({ page }) => {
    await page.evaluate(() => {
        document.querySelector('.channelTextArea_test').remove();
        Lowcord.extensions.toast('Complete');
    });
    const box = await page.locator('.lowcord-toast').boundingBox();
    expect(Math.round(box.x + box.width)).toBe(984);
    await page.evaluate(() => document.querySelector('.lowcord-toast').remove());
    await expect(page.locator('.lowcord-composer-popups')).toHaveCount(0);
    await page.evaluate(() => Lowcord.extensions.toast('Complete again'));
    await expect(page.locator('.lowcord-toast')).toBeVisible();
});
