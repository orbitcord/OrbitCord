import { test, expect } from "@playwright/test";

// Fakes the Discord stores each feature reads, then loads the feature scripts.
test.beforeEach(async ({ page }) => {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        const store = (name, members) => {
            const listeners = new Set();
            const Store = { [name]: class { static displayName = name; } }[name];
            const instance = Object.assign(new Store(), members, {
                addChangeListener: fn => listeners.add(fn), removeChangeListener: fn => listeners.delete(fn),
                emit: () => [...listeners].forEach(fn => fn()), listeners });
            return instance;
        };
        window.sent = []; window.posts = []; window.unread = new Set(["c1", "c2"]);
        window.presence = { a: "online", b: "idle", c: "offline" };
        window.voice = { state: "RTC_CONNECTED", channel: "vc1" };
        window.fakes = {
            UserStore: store("UserStore", { getCurrentUser: () => window.fixtureUser ?? { id: "self", premiumType: 0 } }),
            SelectedChannelStore: store("SelectedChannelStore", { getChannelId: () => "chan", getVoiceChannelId: () => window.voice.channel }),
            PendingReplyStore: store("PendingReplyStore", { getPendingReply: () => null }),
            UploadAttachmentStore: store("UploadAttachmentStore", { getUploads: () => [] }),
            GuildStore: store("GuildStore", { getGuilds: () => ({ g1: { id: "g1" } }) }),
            GuildChannelStore: store("GuildChannelStore", { getChannels: () => ({ SELECTABLE: [{ channel: { id: "c1", type: 0 } }, { channel: { id: "c2", type: 0 } }, { channel: { id: "c3", type: 0 } }] }) }),
            ReadStateStore: store("ReadStateStore", { hasUnread: id => window.unread.has(id), lastMessageId: id => `m${id}` }),
            GuildReadStateStore: store("GuildReadStateStore", { hasUnread: () => window.unread.size > 0 }),
            UserGuildSettingsStore: store("UserGuildSettingsStore", { isMuted: () => false, isChannelMuted: () => false }),
            RelationshipStore: store("RelationshipStore", { getFriendIDs: () => ["a", "b", "c"] }),
            PresenceStore: store("PresenceStore", { getStatus: id => window.presence[id] }),
            RTCConnectionStore: store("RTCConnectionStore", { getState: () => window.voice.state, getChannelId: () => window.voice.channel }),
        };
        const modules = Object.fromEntries(Object.values(window.fakes).map((fake, index) => [`s${index}`, { exports: fake }]));
        modules.actions = { exports: { sendMessage: async (channel, message) => { window.sent.push(message.content); return {}; }, editMessage() {}, getSendMessageOptionsForReply() {} } };
        modules.rest = { exports: { get() {}, put() {}, patch() {}, del() {}, post: async request => { window.posts.push(request); } } };
        modules.nav = { exports: function go(path) { /* transitionTo - */ window.navigated = path; } };
        webpackChunkdiscord_app[0][2]({ c: modules });
    });
    // Both are off by default; these tests turn them on.
    await page.evaluate(() => { Lowcord.extensions.set("readAll", true); Lowcord.extensions.set("onlineFriendCount", true); });
    for (const file of ["split-messages", "read-all", "call-timer", "online-friends"]) await page.addScriptTag({ url: `/injection/${file}.js` });
    await page.addStyleTag({ url: "/injection/ui-extras.css" });
});

const sidebar = `<nav aria-label="Servers sidebar"><div class="listItem_t" id="home"><div data-list-item-id="guildsnav___home">Home</div></div>
    <div class="listItem_t" id="server">Server</div></nav>`;
const addSidebar = page => page.evaluate(html => document.body.insertAdjacentHTML("beforeend", html), sidebar);
const setExtension = (page, id, value) => page.evaluate(([id, value]) => Lowcord.extensions.set(id, value), [id, value]);

async function composer(page, text) {
    await page.evaluate(text => {
        document.body.insertAdjacentHTML("beforeend", '<div class="channelTextArea_t"><div role="textbox" contenteditable="true" tabindex="0" id="editor"></div></div>');
        const editor = {
            children: text.split("\n").map(line => ({ type: "line", children: [{ text: line }] })), selection: null,
            apply(op) {
                if (op.type === "remove_node") this.children.splice(op.path[0], 1);
                if (op.type === "insert_node") this.children.splice(op.path[0], 0, op.node);
            },
        };
        window.slate = editor;
        document.getElementById("editor")["__reactFiber$test"] = { memoizedProps: { editor }, return: null };
    }, text);
    await page.locator("#editor").focus();
}

test("split messages: long text goes out in order within the limit, code fences stay balanced", async ({ page }) => {
    const paragraph = "word ".repeat(150).trim();
    const code = "```js\n" + Array.from({ length: 80 }, (_, i) => `const value${i} = ${i};`).join("\n") + "\n```";
    const text = [paragraph, paragraph, paragraph, code].join("\n\n");
    expect(text.length).toBeGreaterThan(2000);
    await composer(page, text);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.sent.length)).toBeGreaterThan(1);
    await expect.poll(() => page.evaluate(() => window.sent.length), { timeout: 5000 }).toBeGreaterThan(2);
    const sent = await page.evaluate(() => window.sent);
    expect(sent.every(chunk => chunk.length <= 2000)).toBe(true);
    for (const chunk of sent) expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(sent.join("\n").replace(/\n```\n```js\n/g, "\n")).toContain("const value79 = 79;");
    expect(sent[0]).not.toContain("```");
    expect(await page.evaluate(() => window.slate.children.map(node => node.children[0].text).join(""))).toBe("");
});

test("split messages: leaves short text, premium limits and a disabled extension to Discord", async ({ page }) => {
    const text = "x ".repeat(1500);
    await composer(page, text);
    await page.evaluate(() => { window.fixtureUser = { id: "self", premiumType: 2 }; });
    const prevented = () => page.evaluate(() => new Promise(resolve => {
        const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        document.getElementById("editor").dispatchEvent(event);
        resolve(event.defaultPrevented);
    }));
    expect(await prevented()).toBe(false);
    await page.evaluate(() => { window.fixtureUser = { id: "self", premiumType: 0 }; });
    await setExtension(page, "splitMessages", false);
    expect(await prevented()).toBe(false);
    await setExtension(page, "splitMessages", true);
    expect(await prevented()).toBe(true);
});

test("mark all as read: button appears with unread, acks in bulk, and goes away when off", async ({ page }) => {
    await addSidebar(page);
    const button = page.getByRole("button", { name: "Mark all as read" });
    await expect(button).toBeVisible();
    await expect(page.locator("#home + .lowcord-online-friends + .lowcord-readall")).toHaveCount(1);
    await button.click();
    await expect.poll(() => page.evaluate(() => window.posts.length)).toBe(1);
    const post = await page.evaluate(() => window.posts[0]);
    expect(post.url).toBe("/read-states/ack-bulk");
    expect(post.body.read_states).toEqual([
        { channel_id: "c1", message_id: "mc1", read_state_type: 0 }, { channel_id: "c2", message_id: "mc2", read_state_type: 0 }]);
    await expect(page.locator(".lowcord-toast")).toContainText("Marked 2 channels as read");
    await page.evaluate(() => { window.unread.clear(); fakes.ReadStateStore.emit(); });
    await expect(button).toBeHidden();
    await setExtension(page, "readAll", false);
    await expect(page.locator(".lowcord-readall")).toHaveCount(0);
    await page.evaluate(() => window.unread.add("c1"));
    await setExtension(page, "readAll", true);
    await expect(page.getByRole("button", { name: "Mark all as read" })).toBeVisible();
});

test("online friend count: counts non-offline friends, updates on change, opens Friends", async ({ page }) => {
    await addSidebar(page);
    const label = page.locator(".lowcord-online-friends");
    await expect(label).toHaveText("2 Online");
    await expect(page.locator("#home + .lowcord-online-friends")).toHaveCount(1);
    await page.evaluate(() => { window.presence.c = "dnd"; fakes.PresenceStore.emit(); });
    await expect(label).toHaveText("3 Online", { timeout: 3000 });
    await label.click();
    expect(await page.evaluate(() => window.navigated)).toBe("/channels/@me");
    await setExtension(page, "onlineFriendCount", false);
    await expect(label).toHaveCount(0);
    expect(await page.evaluate(() => fakes.PresenceStore.listeners.size)).toBe(0);
    await setExtension(page, "onlineFriendCount", true);
    await expect(label).toHaveText("3 Online");
});

test("call timer: resumes a saved start, formats hours, and stops on disconnect", async ({ page }) => {
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend",
        '<section aria-label="User area"><div class="rtcConnectionStatus_t"><div>Voice Connected</div></div></section>'));
    await page.evaluate(() => {
        Lowcord.storage.setItem("lowcord.callTimer.v1", JSON.stringify({ channelId: "vc1", start: Date.now() - 3_725_000, seen: Date.now() }));
        // A reload: the feature starts again with the saved start in storage.
        Lowcord.extensions.set("callTimer", false); Lowcord.extensions.set("callTimer", true);
    });
    const timer = page.locator(".rtcConnectionStatus_t .lowcord-call-timer");
    await expect(timer).toHaveText(/^1:02:0\d$/);
    const before = await timer.textContent();
    await expect.poll(() => timer.textContent()).not.toBe(before);
    await page.evaluate(() => { window.voice.state = "RTC_DISCONNECTED"; fakes.RTCConnectionStore.emit(); });
    await expect(timer).toHaveCount(0);
    expect(await page.evaluate(() => Lowcord.storage.getItem("lowcord.callTimer.v1"))).toBeNull();
    await page.evaluate(() => { window.voice.state = "RTC_CONNECTED"; fakes.RTCConnectionStore.emit(); });
    await expect(timer).toHaveText(/^0:0\d$/);
    await setExtension(page, "callTimer", false);
    await expect(timer).toHaveCount(0);
});
