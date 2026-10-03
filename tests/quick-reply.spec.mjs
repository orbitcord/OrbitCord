import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    await page.evaluate(() => {
        window.__lowcordChatAppearance.setEnabled(false);
        const listeners = new Map();
        const fixture = window.replyFixture = { channelId: "100", pending: null, sent: [], actions: [] };
        const channel = { id: "100", type: 1 };
        const messages = Object.fromEntries([
            ["1", { id: "1", author: { id: "other" }, type: 0, state: "SENT" }],
            ["2", { id: "2", author: { id: "self" }, type: 0, state: "SENT" }],
            ["3", { id: "3", author: { id: "other" }, type: 3 }],
            ["4", { id: "4", author: { id: "other" }, type: 19, state: "SENT", stickerItems: [{ id: "7" }] }],
            ["5", { id: "5", author: { id: "self" }, type: 0, state: "SENDING" }],
            ["6", { id: "6", author: { id: "other" }, type: 0, flags: 64 }],
        ]);
        fixture.messages = messages;
        const stores = {
            SelectedChannelStore: { getChannelId: () => fixture.channelId },
            ChannelStore: { getChannel: id => id === "100" ? channel : { id, type: 1 } },
            MessageStore: { getMessage: (id, messageId) => id === "100" ? messages[messageId] : null },
            UserStore: { getCurrentUser: () => ({ id: "self" }) },
            PendingReplyStore: { getPendingReply: id => fixture.pending?.channel.id === id ? fixture.pending : null },
        };
        for (const [name, store] of Object.entries(stores)) {
            const Store = class {};
            Store.displayName = name;
            Object.setPrototypeOf(store, Store.prototype);
            listeners.set(name, new Set());
            store.addChangeListener = fn => listeners.get(name).add(fn);
        }
        const dispatch = action => {
            fixture.actions.push(action.type);
            if (action.type === "CREATE_PENDING_REPLY") fixture.pending = action;
            if (action.type === "DELETE_PENDING_REPLY") fixture.pending = null;
            for (const listener of listeners.get("PendingReplyStore")) listener();
            document.querySelector("#reply-target").textContent = fixture.pending?.message.id ?? "none";
        };
        const dispatcher = { dispatch, subscribe() {}, unsubscribe() {} };
        // Same action signature observed in Discord's module cache. The
        // production lookup must discover it through the webpack runtime.
        const createReply = ({ channel, message, shouldMention, showMentionToggle }) =>
            dispatch({ type:"CREATE_PENDING_REPLY", channel, message, shouldMention, showMentionToggle });
        fixture.manualReply = id => createReply({ channel, message: messages[id], shouldMention: false });
        fixture.cancel = () => dispatch({ type: "DELETE_PENDING_REPLY", channelId: fixture.channelId });
        fixture.switchChannel = () => {
            fixture.channelId = "200";
            for (const listener of listeners.get("SelectedChannelStore")) listener();
        };
        document.querySelector("main").insertAdjacentHTML("beforeend", `
            <ol id="reply-timeline">${Object.keys(messages).map(id => `<li id="chat-messages-100-${id}"><div data-list-item-id="chat-messages___100-${id}">Message ${id}</div></li>`).join("")}
                <li id="chat-messages-200-7"><div>Other channel</div></li></ol>
            <div class="channelTextArea_test"><output id="reply-target">none</output>
                <div contenteditable="true" role="textbox" aria-label="Message composer"></div></div>
            <input aria-label="Search fixture">`);
        document.querySelector('[aria-label="Message composer"]').addEventListener("keydown", event => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            fixture.sent.push({ content: event.target.textContent, reference: fixture.pending?.message.id });
            event.target.textContent = "";
            fixture.cancel();
        });
        window.webpackChunkdiscord_app[0][2]({ c: { fixture: { exports: { ...stores, dispatcher, createReply } } } });
    });
    await expect.poll(() => page.evaluate(() => !!Lowcord.store("MessageStore"))).toBe(true);
    await page.getByRole("textbox", { name: "Message composer" }).focus();
});

const composer = page => page.getByRole("textbox", { name: "Message composer" });
const target = page => page.locator("#reply-target");

test("cycle loaded text and media replies, skip non-replyable rows, and cancel at the newest", async ({ page }) => {
    for (const [key, id] of [["Shift+ArrowUp", "4"], ["Shift+ArrowUp", "2"], ["Shift+ArrowUp", "1"],
        ["Shift+ArrowUp", "1"], ["Shift+ArrowDown", "2"], ["Shift+ArrowDown", "4"]]) {
        await page.keyboard.press(key);
        await expect(target(page)).toHaveText(id);
        await expect(page.locator(`[id="chat-messages-100-${id}"]`)).toHaveAttribute("data-lowcord-quick-reply", "true");
        await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(1);
        await expect(composer(page)).toBeFocused();
    }
    await page.keyboard.press("Shift+ArrowDown");
    await expect(target(page)).toHaveText("none");
    await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(0);
    expect(await page.evaluate(() => replyFixture.sent)).toEqual([]);
});

test("native send keeps the selected reply reference and clears the highlight", async ({ page }) => {
    await page.keyboard.press("Shift+ArrowUp");
    await composer(page).fill("My reply");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => replyFixture.sent)).toEqual([{ content: "My reply", reference: "4" }]);
    await expect(target(page)).toHaveText("none");
    await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(0);
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("4");
});

test("Escape cancels without discarding the draft; arrows retain text selection while typing", async ({ page }) => {
    await page.keyboard.press("Shift+ArrowUp");
    await composer(page).fill("Keep this draft");
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("4");
    await page.keyboard.press("Escape");
    await expect(target(page)).toHaveText("none");
    await expect(composer(page)).toHaveText("Keep this draft");
    await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(0);
});

test("manual replies are respected and switching channels or deleting a row clears stale highlights", async ({ page }) => {
    await page.evaluate(() => replyFixture.manualReply("2"));
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("1");
    await page.evaluate(() => replyFixture.manualReply("4"));
    await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(0);
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("2");
    await page.evaluate(() => document.getElementById("chat-messages-100-2").remove());
    await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(0);
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("4");
    await page.evaluate(() => replyFixture.switchChannel());
    await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(0);
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("4");
});

test("disabled extension, other editors, completion menus, modifiers and IME keep their shortcuts", async ({ page }) => {
    await page.getByRole("textbox", { name: "Search fixture" }).focus();
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("none");
    await composer(page).focus();
    for (const key of ["ArrowUp", "ArrowDown", "Shift+ArrowDown", "Control+Shift+ArrowUp", "Alt+Shift+ArrowUp", "Meta+Shift+ArrowUp"]) {
        await page.keyboard.press(key);
        await expect(target(page)).toHaveText("none");
    }
    await composer(page).evaluate(node => node.setAttribute("aria-expanded", "true"));
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("none");
    await composer(page).evaluate(node => {
        node.removeAttribute("aria-expanded");
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, isComposing: true, bubbles: true }));
    });
    await expect(target(page)).toHaveText("none");
    await page.keyboard.press("Shift+ArrowUp");
    await page.evaluate(() => Lowcord.extensions.set("quickReply", false));
    await expect(page.locator("[data-lowcord-quick-reply]")).toHaveCount(0);
    await page.evaluate(() => replyFixture.cancel());
    await page.keyboard.press("Shift+ArrowUp");
    await expect(target(page)).toHaveText("none");
});
