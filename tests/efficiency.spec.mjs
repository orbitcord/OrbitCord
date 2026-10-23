import { test, expect } from '@playwright/test';

test('concurrent GIF conversions share one lazy dictionary and release it after success or a size-limit failure', async ({ page }) => {
    await page.addInitScript(() => {
        window.encoderAllocations = 0;
        for (const name of ['Int16Array', 'Int32Array']) {
            const Original = window[name];
            window[name] = class extends Original {
                constructor(...args) {
                    super(...args);
                    if (args[0] === 1 << 20) window.encoderAllocations++;
                }
            };
        }
    });
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
    expect(await page.evaluate(() => encoderAllocations)).toBe(0);
    const proof = await page.evaluate(async () => {
        const mp4 = new Uint8Array(await (await fetch('/media/dash-video.mp4')).arrayBuffer());
        const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join(',');
        const outputs = await Promise.all(Array.from({ length: 3 }, () => Lowcord.gif.fromVideo(mp4, 8 * 1024 * 1024)));
        const shared = encoderAllocations;
        const hashes = await Promise.all(outputs.map(hash));
        const limited = await Lowcord.gif.fromVideo(mp4, 64);
        const afterFailure = encoderAllocations;
        const again = await Lowcord.gif.fromVideo(mp4, 8 * 1024 * 1024);
        return { shared, hashes, limited, afterFailure, finalAllocations: encoderAllocations, againHash: await hash(again) };
    });
    expect(proof.shared).toBe(2);
    expect(new Set(proof.hashes).size).toBe(1);
    expect(proof.limited).toBeNull();
    expect(proof.afterFailure).toBe(4);
    expect(proof.finalAllocations).toBe(6);
    expect(proof.againHash).toBe(proof.hashes[0]);
});
