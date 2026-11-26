import { test, expect } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";
test.beforeEach(async ({ page }) => {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        const store = (name, members) => Object.assign(new ({ [name]: class { static displayName = name; } }[name])(), members, { addChangeListener() {}, removeChangeListener() {} });
        const users = { u1: { id: "u1", username: "rivera", globalName: "Alex Rivera" }, u2: { id: "u2", username: "kim" } };
        const channels = { 301: { id: "301", type: 1, recipients: ["u1"] }, 201: { id: "201", type: 0, name: "general", guild_id: "111" }, 202: { id: "202", type: 0, name: "gear-swap", guild_id: "111" }, 401: { id: "401", type: 2, name: "Lounge", guild_id: "111" } };
        window.mentions = {};
        const fakes = [
            store("UserStore", { getCurrentUser: () => ({ id: "self", premiumType: 0 }), getUser: id => users[id] }),
            store("ChannelStore", { getChannel: id => channels[id], getSortedPrivateChannels: () => [channels[301]] }),
            store("GuildStore", { getGuild: id => id === "111" ? { id: "111", name: "Climbing club" } : null, getGuilds: () => ({ 111: { id: "111", name: "Climbing club" } }) }),
            store("GuildChannelStore", { getChannels: () => ({ SELECTABLE: [{ channel: channels[201] }, { channel: channels[202] }], VOCAL: [{ channel: channels[401] }] }) }),
            store("ReadStateStore", { hasUnread: id => Boolean(window.mentions[id]), getMentionCount: id => window.mentions[id] ?? 0 }),
        ];
        const modules = Object.fromEntries(fakes.map((fake, index) => [`s${index}`, { exports: fake }]));
        modules.nav = { exports: function go(path) { /* transitionTo - */ history.pushState(null, "", path); } };
        modules.dispatcher = { exports: { dispatch() {}, subscribe() {}, unsubscribe() {} } };
        webpackChunkdiscord_app[0][2]({ c: modules });
        history.replaceState(null, "", "/channels/111/201");
        document.body.insertAdjacentHTML("afterbegin", `
            <div class="base_t"><div class="bar_t" style="position:relative;height:32px"><div class="title_t">Climbing club</div><div class="leading_t"></div><div class="trailing_t" style="position:absolute;right:0;width:60px"></div></div></div>
            <nav><a href="/channels/@me/301" data-list-item-id="private-channels___d1">Alex Rivera</a><a href="/channels/111/202" data-list-item-id="channels___c2">gear-swap</a></nav>`);
        // Discord's menu shows up a moment after the right-click.
        addEventListener("contextmenu", event => {
            event.preventDefault();
            setTimeout(() => document.body.insertAdjacentHTML("beforeend", `<div role="menu" id="user-context">
                <div role="group"><div role="menuitem" id="user-context-mark-channel-read" class="item_m"><div class="label_m">Mark As Read</div></div></div>
                <div role="separator"></div>
                <div role="group"><div role="menuitem" id="user-context-profile" class="item_m"><div class="label_m">Profile</div></div></div></div>`), 10);
        });
        addEventListener("keydown", event => { if (event.key === "Escape") document.querySelector("#user-context")?.remove(); });
    });
    for (const file of ["command-palette", "tabs"]) await page.addScriptTag({ url: `/injection/${file}.js` });
    await page.addStyleTag({ url: "/injection/ui-extras.css" });
});

const state = page => page.evaluate(() => ({ path: location.pathname, ...Lowcord.tabs.state }));

test("Open in New Tab from a right-click adds a tab beside the current one", async ({ page }) => {
    await expect(page.locator(".lowcord-tabs-new")).toBeVisible();
    await expect(page.locator(".lowcord-tab")).toHaveCount(0);
    await page.getByText("Alex Rivera").click({ button: "right" });
    const item = page.locator("#lowcord-open-tab");
    await expect(item).toHaveText("Open in New Tab");
    // First in the group after Mark As Read.
    expect(await item.evaluate(node => node.nextElementSibling?.id)).toBe("user-context-profile");
    await item.click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { selected: true })).toContainText("Alex Rivera");
    expect((await state(page)).path).toBe("/channels/@me/301");
    await expect(page.locator(".title_t")).toBeHidden();
});

test("middle-click opens in the background, and the keyboard switches, closes and reopens", async ({ page }) => {
    await page.getByText("gear-swap").click({ button: "middle" });
    await expect(page.getByRole("tab")).toHaveCount(2);
    expect((await state(page)).path).toBe("/channels/111/201");
    await page.keyboard.press(`${mod}+2`);
    await expect(page.getByRole("tab", { selected: true })).toContainText("gear-swap");
    expect((await state(page)).path).toBe("/channels/111/202");
    await page.keyboard.press("Control+Tab");
    await expect(page.getByRole("tab", { selected: true })).toContainText("general");
    await page.keyboard.press(`${mod}+w`);
    await expect(page.getByRole("tab")).toHaveCount(0);
    expect((await state(page)).path).toBe("/channels/111/202");
    await page.keyboard.press(`${mod}+Shift+t`);
    await expect(page.getByRole("tab", { selected: true })).toContainText("general");
});

test("the + picker searches chats and pages, and navigating moves the active tab", async ({ page }) => {
    await page.locator(".lowcord-tabs-new").click();
    const input = page.getByRole("combobox", { name: "Open in a new tab" });
    await expect(input).toBeFocused();
    await expect(page.locator(".lowcord-tabs-picker-group").first()).toHaveText("Pages");
    await input.fill("shop");
    await expect(page.getByRole("option").first()).toContainText("Shop");
    await page.keyboard.press("Enter");
    expect((await state(page)).path).toBe("/shop");
    await expect(page.getByRole("tab", { selected: true })).toContainText("Shop");
    // Following a link inside a tab moves that tab.
    await page.evaluate(() => Lowcord.transitionTo("/channels/111/202"));
    await expect(page.getByRole("tab", { selected: true })).toContainText("gear-swap");
    // Going to a path open in another tab selects that tab.
    await page.evaluate(() => Lowcord.transitionTo("/channels/111/201"));
    await expect(page.getByRole("tab", { selected: true })).toContainText("general");
    expect((await state(page)).tabs.map(tab => tab.path)).toEqual(["/channels/111/201", "/channels/111/202"]);
});

test("mentions show on tabs and message links open at the message", async ({ page }) => {
    await page.evaluate(() => Lowcord.tabs.open("/channels/111/202/901", { background: true }));
    await page.evaluate(() => { window.mentions[202] = 3; });
    await page.evaluate(() => Lowcord.tabs.open("/channels/@me/301", { background: true }));
    await expect(page.locator('.lowcord-tab:has-text("gear-swap") .lowcord-tab-badge')).toHaveText("3");
    await expect(page.locator('.lowcord-tab:has-text("gear-swap")')).toHaveAttribute("title", /saved message/);
});

test("workspaces keep their own tabs", async ({ page }) => {
    await page.evaluate(() => Lowcord.tabs.open("/channels/@me/301", { background: true }));
    await page.evaluate(() => Lowcord.tabs.saveSpace("Climbing"));
    await page.evaluate(() => Lowcord.tabs.open("/shop"));
    expect((await state(page)).tabs).toHaveLength(3);
    await page.locator(".lowcord-tabs-space").click();
    await page.getByRole("option", { name: /Main/ }).click();
    const main = await state(page);
    expect(main.workspace).toBe("Main");
    expect(main.tabs.map(tab => tab.path)).toEqual(["/channels/111/201", "/channels/@me/301"]);
    // Saved state survives turning the extension off and on.
    await page.waitForTimeout(400);
    await page.evaluate(() => { Lowcord.extensions.set("tabs", false); Lowcord.extensions.set("tabs", true); });
    expect((await state(page)).workspaces).toEqual(["Main", "Climbing"]);
});
