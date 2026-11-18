import { test, expect } from "@playwright/test";

const shortcut = process.platform === "darwin" ? "Meta+Shift+K" : "Control+Shift+K";
test.beforeEach(async ({ page }) => {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        const store = (name, members) => Object.assign(new ({ [name]: class { static displayName = name; } }[name])(), members, { addChangeListener() {}, removeChangeListener() {} });
        const users = { u1: { id: "u1", username: "rivera", globalName: "Alex Rivera" }, u2: { id: "u2", username: "kim" } };
        const fakes = [
            store("UserStore", { getCurrentUser: () => ({ id: "self", premiumType: 0 }), getUser: id => users[id] }),
            store("ChannelStore", { getSortedPrivateChannels: () => [{ id: "d1", recipients: ["u1"] }, { id: "d2", recipients: ["u1", "u2"], name: "" }] }),
            store("GuildStore", { getGuilds: () => ({ g1: { id: "g1", name: "Climbing club" } }) }),
            store("GuildChannelStore", { getChannels: () => ({ SELECTABLE: [{ channel: { id: "c1", type: 0, name: "general" } }, { channel: { id: "c2", type: 0, name: "gear-swap" } }],
                VOCAL: [{ channel: { id: "v1", type: 2, name: "Lounge" } }] }) }),
            store("ReadStateStore", { hasUnread: () => false }),
        ];
        const modules = Object.fromEntries(fakes.map((fake, index) => [`s${index}`, { exports: fake }]));
        modules.nav = { exports: function go(path) { /* transitionTo - */ window.navigated = path; } };
        window.dispatched = [];
        modules.dispatcher = { exports: { dispatch: action => window.dispatched.push(action), subscribe() {}, unsubscribe() {} } };
        webpackChunkdiscord_app[0][2]({ c: modules });
    });
    for (const file of ["read-all", "command-palette"]) await page.addScriptTag({ url: `/injection/${file}.js` });
    await page.addStyleTag({ url: "/injection/ui-extras.css" });
});

test("the shortcut opens the palette, finds a channel and opens it", async ({ page }) => {
    await page.keyboard.press(shortcut);
    const input = page.getByRole("combobox", { name: "Search chats and actions" });
    await expect(input).toBeFocused();
    await input.fill("gen");
    await expect(page.getByRole("option").first()).toContainText("#general");
    await expect(page.getByRole("option").last()).toContainText("Search Discord's quick switcher");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
    expect(await page.evaluate(() => window.navigated)).toBe("/channels/g1/c1");
});

test("DMs are found by display name and the arrow keys move the selection", async ({ page }) => {
    await page.keyboard.press(shortcut);
    await page.keyboard.type("alex");
    const options = page.getByRole("option");
    await expect(options.first()).toContainText("Alex Rivera");
    await expect(options.nth(1)).toContainText("Alex Rivera, kim");
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.navigated)).toBe("/channels/@me/d2");
});

test("extensions can be switched from the palette, and the last result asks Discord's switcher", async ({ page }) => {
    await page.keyboard.press(shortcut);
    await page.keyboard.type("turn off split");
    await expect(page.getByRole("option").first()).toHaveText(/Turn off Split long messages/);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => Lowcord.extensions.enabled("splitMessages"))).toBe(false);
    await page.keyboard.press(shortcut);
    await page.keyboard.type("photos of rope");
    await page.getByRole("option").last().click();
    expect(await page.evaluate(() => window.dispatched)).toEqual([{ type: "QUICKSWITCHER_SHOW", query: "photos of rope", queryMode: null }]);
});

test("escape and the shortcut close it, and it stays out of the way when turned off", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await page.keyboard.press(shortcut);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press(shortcut);
    await expect(dialog).toBeVisible();
    await page.keyboard.press(shortcut);
    await expect(dialog).toHaveCount(0);
    // Discord's own Cmd/Ctrl+K is left alone, and so is the palette's shortcut when it's off.
    const plain = shortcut.replace("Shift+K", "k");
    await page.keyboard.press(plain);
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => Lowcord.extensions.set("commandPalette", false));
    await page.keyboard.press(shortcut);
    await expect(dialog).toHaveCount(0);
    const reached = await page.evaluate(shortcut => new Promise(resolve => {
        document.addEventListener("keydown", event => resolve(event.key === "k" && !event.defaultPrevented), { once: true });
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: shortcut.startsWith("Meta"), ctrlKey: shortcut.startsWith("Control"), bubbles: true }));
    }), shortcut);
    expect(reached).toBe(true);
    await expect(dialog).toHaveCount(0);
});
