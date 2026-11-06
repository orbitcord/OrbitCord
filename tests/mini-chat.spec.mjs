import { test, expect } from "@playwright/test";

const ids = ["100000000000000001", "100000000000000002", "100000000000000003", "100000000000000004"];

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => window.Lowcord.storage.removeItem("lowcord.minichat.v1"));
    await stub(page);
});

async function stub(page) {
    await page.evaluate(ids => {
        const stores = {
            ChannelStore: { getChannel: id => ({ id, type: 1 }) },
            UserStore: { getCurrentUser: () => ({ id: "self" }), getUser: () => null },
            MessageStore: { getMessages: () => null },
        };
        for (const [name, store] of Object.entries(stores)) {
            const Store = class {};
            Store.displayName = name;
            Object.setPrototypeOf(store, Store.prototype);
            store.addChangeListener = () => {};
        }
        window.webpackChunkdiscord_app[0][2]({ c: { fixture: { exports: { ...stores } } } });
        document.querySelector("main").insertAdjacentHTML("afterbegin",
            `<ul aria-label="Direct Messages">${ids.map((id, index) => `<li><a href="/channels/@me/${id}">Friend ${index + 1}</a></li>`).join("")}</ul>`);
    }, ids);
    await expect.poll(() => page.evaluate(() => !!Lowcord.store("ChannelStore"))).toBe(true);
}

async function pin(page, name) {
    await page.getByRole("link", { name }).hover();
    await page.getByRole("button", { name: "Pop out as mini chat" }).dispatchEvent("click");
}

test("pinning turns the hover card into a mini chat that stays, stacks leftwards and keeps three", async ({ page }) => {
    await pin(page, "Friend 1");
    const panel = page.locator(".lowcord-minichat");
    await expect(panel).toHaveCount(1);
    await expect(page.locator(".lowcord-dm-card:not(.lowcord-minichat)")).toHaveCount(0);
    const { width, height } = page.viewportSize();
    await expect.poll(async () => { const box = await panel.boundingBox(); return [Math.round(box.x + box.width), Math.round(box.y + box.height)]; }).toEqual([width - 16, height - 16]);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await expect(panel).toHaveCount(1);
    await pin(page, "Friend 2");
    await pin(page, "Friend 3");
    await expect(page.locator(".lowcord-minichat")).toHaveCount(3);
    const [a, b] = await page.locator(".lowcord-minichat").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
    expect(b).toBeLessThan(a);
    await pin(page, "Friend 4");
    await expect(page.locator(".lowcord-minichat")).toHaveCount(3);
    const saved = await page.evaluate(() => JSON.parse(Lowcord.storage.getItem("lowcord.minichat.v1")).chats.map(chat => chat.id));
    expect(saved).toEqual(ids.slice(1));
});

test("a mini chat drags by its header, minimises, remembers its place and closes", async ({ page }) => {
    await pin(page, "Friend 1");
    const panel = page.locator(".lowcord-minichat");
    const header = panel.locator("header");
    await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBe(340);
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
    const from = await header.boundingBox();
    await page.mouse.move(from.x + 60, from.y + 16);
    await page.mouse.down();
    await page.mouse.move(from.x - 140, from.y - 120, { steps: 4 });
    await page.mouse.up();
    const moved = await panel.boundingBox();
    expect(Math.abs(moved.x - (from.x - 200))).toBeLessThan(3);
    expect(Math.abs(moved.y - (from.y - 136))).toBeLessThan(3);
    await panel.getByRole("button", { name: "Minimise" }).click();
    await expect(panel).toHaveAttribute("data-collapsed", "");
    expect((await panel.boundingBox()).height).toBeLessThan(80);
    const chat = await page.evaluate(() => JSON.parse(Lowcord.storage.getItem("lowcord.minichat.v1")).chats[0]);
    expect(chat).toMatchObject({ id: ids[0], min: true });
    expect(Math.abs(chat.x - moved.x)).toBeLessThan(1);
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(Lowcord.storage.getItem("lowcord.minichat.v1")).chats)).toEqual([]);
});

test("saved chats are restored, ignoring ids that are not snowflakes", async ({ page }) => {
    await page.evaluate(ids => Lowcord.storage.setItem("lowcord.minichat.v1", JSON.stringify({ chats: [
        { id: ids[0], x: 100, y: 80, w: 300, h: 400 }, { id: "../etc", w: 10 }, { id: ids[1], min: true }] })), ids);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await stub(page);
    await expect(page.locator(".lowcord-minichat")).toHaveCount(2);
    const box = await page.locator(".lowcord-minichat").first().boundingBox();
    expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([100, 80, 300, 400]);
});
