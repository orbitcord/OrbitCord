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

// ----- Click to reply ----------------------------------------------------
// chat-appearance.js marks the rows, as in a DM with bubbles on.
async function bubbles(page) {
    await page.evaluate(() => {
        const timeline = document.getElementById("reply-timeline");
        timeline.setAttribute("data-list-id", "chat-messages");
        document.head.insertAdjacentHTML("beforeend", `<style>
            #reply-timeline { list-style: none; margin: 0; padding: 0; }
            .media_t { display: block; width: 120px; height: 60px; background: #444; }
            .reactions_t { display: flex; }
            .buttons_t { pointer-events: auto; }
            .reaction_t { padding: 4px; }
            .buttonContainer_t { z-index: 5; }</style>`);
        for (const id of ["1", "2", "3", "5", "6"]) {
            document.querySelector(`[id="chat-messages-100-${id}"] > div`).innerHTML = `<div class="contents_t"><div class="header_t"><span class="username_t" role="button">Name ${id}</span></div>
                <div id="message-content-${id}" class="markup_t messageContent_t"><span class="text_t">Message ${id} words to select</span>
                    <a href="#link-${id}">link</a> <span class="mention_t interactive_t" role="button">@someone</span>
                    <img class="emoji_t" alt=":)" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
                    <span class="spoilerContent_t" role="button"><span>secret</span></span> <code class="inlineCode_t">code</code>
                    <time datetime="2024-01-01">today</time></div></div>
                <div id="message-accessories-${id}" class="container_t"><div id="message-reactions-${id}" class="reactions_t" role="group">
                    <div></div><div><div class="reaction_t reactionMe_t"><div class="reactionInner_t" role="button">👍 1</div></div></div>
                    <span><div class="reactionBtn_t" role="button" aria-label="Add reaction ${id}">+</div></span></div>
                    ${id === "2" ? '<div class="linkPreview_t">Preview 2</div>' : ""}</div>
                <div class="buttonContainer_t"><div class="buttons_t"><div class="buttonsInner_t"><button aria-label="More ${id}">…</button></div></div></div>`;
        }
        // Message 4 is media with a caption bubble.
        document.querySelector('[id="chat-messages-100-4"] > div').innerHTML = `<div class="contents_t"><div id="message-content-4" class="markup_t messageContent_t">Caption 4</div></div>
            <div id="message-accessories-4"><div class="sticker_t media_t" aria-label="Sticker 4"></div></div>`;
        window.__lowcordChatAppearance.setEnabled(true);
    });
    await expect(page.locator('[id="chat-messages-100-1"] > [data-lowcord-bubble="incoming"]')).toHaveCount(1);
    await expect(page.locator('[id="chat-messages-100-2"] > [data-lowcord-bubble="outgoing"]')).toHaveCount(1);
    await expect(page.locator('[id="chat-messages-100-4"] > [data-lowcord-media][data-lowcord-caption]')).toHaveCount(1);
    // System messages get no bubble.
    await expect(page.locator('[id="chat-messages-100-3"] > [data-lowcord-bubble]')).toHaveCount(0);
}
const text = (page, id) => page.locator(`[id="message-content-${id}"] > .text_t`);
// The reply starts after a short double-click window; give it time to (not)
// happen. No reply may have been created even briefly.
async function expectNoReply(page) {
    await page.waitForTimeout(450);
    await expect(target(page)).toHaveText("none");
    expect(await page.evaluate(() => replyFixture.actions)).not.toContain("CREATE_PENDING_REPLY");
}
async function resetReply(page) {
    await page.evaluate(() => { getSelection().removeAllRanges(); replyFixture.cancel(); replyFixture.actions.length = 0; });
}

test.describe("click to reply", () => {
    test.beforeEach(async ({ page }) => {
        await bubbles(page);
        await page.evaluate(() => { document.activeElement.blur(); replyFixture.actions.length = 0; });
    });

    test("a single click replies natively, focuses the composer, and keeps an existing reply to the same message", async ({ page }) => {
        await text(page, "1").click();
        await expect(target(page)).toHaveText("1");
        await expect(composer(page)).toBeFocused();
        expect(await page.evaluate(() => [replyFixture.pending.shouldMention, replyFixture.pending.showMentionToggle])).toEqual([true, true]);
        // Own messages don't ping; padding inside the bubble counts too.
        await page.locator('[id="chat-messages-100-2"] > div').click({ position: { x: 30, y: 3 } });
        await expect(target(page)).toHaveText("2");
        expect(await page.evaluate(() => replyFixture.pending.shouldMention)).toBe(false);
        await page.evaluate(() => { replyFixture.pending.shouldMention = true; replyFixture.actions.length = 0; document.activeElement.blur(); });
        await text(page, "2").click();
        await expect(composer(page)).toBeFocused();
        await expect(target(page)).toHaveText("2");
        expect(await page.evaluate(() => [replyFixture.actions, replyFixture.pending.shouldMention])).toEqual([[], true]);
        // A caption bubble replies to its media message.
        await page.getByText("Caption 4").click();
        await expect(target(page)).toHaveText("4");
    });

    test("empty space around reactions replies; reaction pills and other accessories don't", async ({ page }) => {
        const reactions = page.locator('[id="message-reactions-1"]');
        const box = await reactions.boundingBox();
        await reactions.click({ position: { x: box.width - 4, y: box.height / 2 } });
        await expect(target(page)).toHaveText("1");
        await resetReply(page);
        // The gap between the text and the reaction row.
        await page.locator('[id="message-accessories-1"]').evaluate(node => node.style.setProperty("padding-top", "6px", "important"));
        await page.locator('[id="message-accessories-1"]').click({ position: { x: 40, y: 2 } });
        await expect(target(page)).toHaveText("1");
        await resetReply(page);
        const row = page.locator('[id="chat-messages-100-1"]');
        for (const part of [row.locator(".reaction_t"), row.getByRole("button", { name: "Add reaction 1" }), page.getByText("Preview 2")]) {
            await part.click({ position: { x: 1, y: 1 } });
            await expectNoReply(page);
        }
    });

    test("links, mentions, emojis, spoilers, code, times, reactions, the toolbar and media keep their own clicks", async ({ page }) => {
        const row = page.locator('[id="chat-messages-100-1"]');
        for (const part of [row.getByRole("link", { name: "link" }), row.getByText("@someone"), row.getByAltText(":)"), row.getByText("secret"),
            row.getByText("code", { exact: true }), row.getByText("today"), row.getByText("👍 1"),
            row.getByRole("button", { name: "More 1" }), page.getByLabel("Sticker 4")]) {
            await part.click();
            await expectNoReply(page);
        }
        // Beside the media, outside its caption bubble.
        await page.locator('[id="chat-messages-100-4"] > div').click({ position: { x: 400, y: 50 } });
        await expectNoReply(page);
    });

    test("selecting or dragging text, double and triple clicks never reply", async ({ page }) => {
        const words = text(page, "1");
        await words.dblclick();
        expect(await page.evaluate(() => String(getSelection()))).not.toBe("");
        await expectNoReply(page);
        await words.click({ clickCount: 3 });
        await expectNoReply(page);
        // A double click at an ordinary pace never replies, even briefly.
        await page.evaluate(() => getSelection().removeAllRanges());
        const middle = await words.boundingBox();
        await page.mouse.click(middle.x + 20, middle.y + middle.height / 2);
        await page.waitForTimeout(80);
        await page.mouse.click(middle.x + 20, middle.y + middle.height / 2, { clickCount: 2 });
        await expectNoReply(page);
        await page.evaluate(() => getSelection().removeAllRanges());
        await words.click();
        await expect(target(page)).toHaveText("1");
        // Clicking away an existing selection only clears it.
        await resetReply(page);
        await page.evaluate(() => getSelection().selectAllChildren(document.querySelector('[id="message-content-2"]')));
        await text(page, "2").click();
        await expectNoReply(page);
        // A drag that selects text.
        const box = await words.boundingBox();
        await page.mouse.move(box.x + 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
        await page.mouse.up();
        expect(await page.evaluate(() => String(getSelection()))).not.toBe("");
        await expectNoReply(page);
        // A slow double click takes back the reply its first click started.
        await resetReply(page);
        await page.evaluate(() => replyFixture.manualReply("2"));
        const point = [box.x + 20, box.y + box.height / 2];
        await page.mouse.click(...point);
        await expect(target(page)).toHaveText("1");
        await page.mouse.down({ clickCount: 2 });
        await page.mouse.up({ clickCount: 2 });
        await expect(target(page)).toHaveText("2");
        // Even when the reply bar moved another message under the pointer.
        await resetReply(page);
        await page.mouse.click(...point);
        await expect(target(page)).toHaveText("1");
        const other = await text(page, "2").boundingBox();
        await page.mouse.move(other.x + 20, other.y + other.height / 2);
        await page.mouse.down({ clickCount: 2 });
        await page.mouse.up({ clickCount: 2 });
        await expect(target(page)).toHaveText("none");
    });

    test("right, middle and modifier clicks never reply", async ({ page }) => {
        const words = text(page, "1");
        await words.click({ button: "right" });
        await expectNoReply(page);
        await words.click({ button: "middle" });
        await expectNoReply(page);
        for (const modifier of ["Shift", "Alt", "Control", "Meta"]) {
            await words.click({ modifiers: [modifier] });
            await page.evaluate(() => getSelection().removeAllRanges());
            await expectNoReply(page);
        }
    });

    test("system, pending, failed and ephemeral messages can't be replied to", async ({ page }) => {
        await page.evaluate(() => { replyFixture.messages["2"].state = "SEND_FAILED"; });
        for (const id of ["3", "5", "6", "2"]) {
            await text(page, id).click();
            await expectNoReply(page);
        }
    });

    test("editing, dialogs, other timelines and other channels never reply", async ({ page }) => {
        await page.locator('[id="message-content-1"]').evaluate(node => node.insertAdjacentHTML("afterend", '<div role="textbox" contenteditable="true" aria-label="Edit message"></div>'));
        await text(page, "1").click();
        await expectNoReply(page);
        await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true" id="modal-fixture">Dialog</div>'));
        await text(page, "2").click();
        await expectNoReply(page);
        await page.evaluate(() => document.getElementById("modal-fixture").remove());
        // Search results and pins render message rows outside the chat list.
        await page.evaluate(() => {
            const list = document.createElement("ul");
            list.className = "searchResults_t";
            list.append(document.getElementById("chat-messages-100-2"));
            document.querySelector("main").prepend(list);
        });
        await text(page, "2").click();
        await expectNoReply(page);
        await page.evaluate(() => replyFixture.switchChannel());
        await page.locator('[id="chat-messages-100-1"] [role="textbox"]').evaluate(node => node.remove());
        await text(page, "1").click();
        await expectNoReply(page);
    });

    test("no permission to send, no composer, bubbles off or the extension off never reply", async ({ page }) => {
        await page.evaluate(() => { Lowcord.store("ChannelStore").getChannel("100").guild_id = "9"; });
        await text(page, "1").click();
        await expectNoReply(page);
        await page.evaluate(() => { delete Lowcord.store("ChannelStore").getChannel("100").guild_id; });
        await composer(page).evaluate(node => node.setAttribute("contenteditable", "false"));
        await text(page, "1").click();
        await expectNoReply(page);
        await composer(page).evaluate(node => node.setAttribute("contenteditable", "true"));
        // Any appearance other than bubbles leaves rows unmarked.
        await page.evaluate(() => window.__lowcordChatAppearance.setEnabled(false));
        await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(0);
        await text(page, "1").click();
        await expectNoReply(page);
        await page.evaluate(() => window.__lowcordChatAppearance.setEnabled(true));
        await expect(page.locator('[id="chat-messages-100-2"] > [data-lowcord-bubble]')).toHaveCount(1);
        await page.evaluate(() => Lowcord.extensions.set("clickReply", false));
        await text(page, "2").click();
        await expectNoReply(page);
        await page.evaluate(() => Lowcord.extensions.set("clickReply", true));
        await text(page, "2").click();
        await expect(target(page)).toHaveText("2");
    });
});
