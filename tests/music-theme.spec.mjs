import { test, expect } from "@playwright/test";

test("music theme derives a readable dark palette from art", async ({ page }) => {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    const result = await page.evaluate(() => {
        const themes = window.__lowcordThemes;
        const data = new Uint8ClampedArray(32 * 32 * 4);
        for (let i = 0; i < data.length; i += 4) data.set([220, 40, 60, 255], i);
        const colors = themes.musicColors(data);
        const grey = themes.musicColors(new Uint8ClampedArray(32 * 32 * 4).fill(128));
        return { colors, grey, spotify: themes.musicArtURL({ assets: { large_image: "spotify:ab67616d0000b273abc" } }),
            blocked: themes.musicArtURL({ assets: { large_image: "https://evil.example/a.png" } }),
            external: themes.musicArtURL({ assets: { large_image: "mp:external/h/https/i.ytimg.com/vi/x/hq.jpg" } }) };
    });
    expect(result.colors.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.grey.accent).toBe("#9aa3f0");
    expect(result.spotify).toBe("https://i.scdn.co/image/ab67616d0000b273abc");
    expect(result.blocked).toBeNull();
    expect(result.external).toContain("https://media.discordapp.net/external/h/https/i.ytimg.com");
    expect(result.colors.colors.length).toBeGreaterThanOrEqual(2);
    expect(result.colors.colors.every(color => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    await page.evaluate(() => window.__lowcordThemes.set({ id: "music", music: { background: "#2a1218", accent: "#ff5d73", colors: ["#5c1a26", "#1a2a5c", "#2a1218"] } }));
    // The album colors become a gradient through Discord's custom-theme layer.
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("custom-theme-background"))).toBe(true);
    const gradient = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--custom-theme-background").trim());
    expect(gradient).toContain("linear-gradient(135deg");
    expect(gradient).toContain("#5c1a26");
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-lowcord-animations"))).toBe(true);
});
