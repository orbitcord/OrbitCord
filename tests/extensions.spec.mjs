import { test, expect } from "@playwright/test";

// Tests run in parallel against one server, so each uses its own channel id
// and only reads back the requests that carry it.
let channel = 0;
test.beforeEach(async ({ page }, info) => {
    channel = 1000 + info.workerIndex * 1000 + info.repeatEachIndex + Math.floor(Math.random() * 900);
    await page.goto("/extensions");
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
});
const received = async page => (await (await page.request.get("/__received")).json())
    .filter(entry => entry.path.includes(`/${channel}`) || entry.path.includes(`c=${channel}`));
const xhr = (page, method, path, body, type = "application/json") => page.evaluate(([method, path, body, type]) => new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open(method, path);
    if (type) request.setRequestHeader("Content-Type", type);
    request.onreadystatechange = () => { if (request.readyState === 4) resolve(request.status); };
    request.send(body);
}), [method, path, body, type]);
const setExtension = (page, id, value) => page.evaluate(([id, value]) => Lowcord.extensions.set(id, value), [id, value]);
// Message bar actions share one button; with several on, it opens a menu.
async function runAction(page, name, scope = ".buttons_test") {
    await page.locator(`${scope} .lowcord-actions-button`).click();
    await page.getByRole("menu", { name: "Extensions" }).getByRole("menuitem", { name }).click();
}

test("desktop download shortcut is hidden without affecting servers or attachment downloads", async ({ page }) => {
    await page.evaluate(() => {
        const fixture = document.createElement("div");
        fixture.innerHTML = `<nav class="guilds_test"><div data-list-id="guildsnav">
            <div class="listItem_test" id="server-item"><button aria-label="Test server">Server</button></div>
            <div class="listItem_test" id="download-item"><div aria-label="Download Apps" tabindex="0">Download</div></div>
            <div class="downloadApp_test" id="localized-download"><button aria-label="Télécharger les applications">Download</button></div>
        </div></nav><div class="attachment_test"><a href="#download" aria-label="Download Apps">Download</a></div>`;
        document.body.append(fixture);
    });
    await expect(page.locator("#download-item")).toBeHidden();
    await expect(page.locator("#localized-download")).toBeHidden();
    await expect(page.locator("#server-item")).toBeVisible();
    await expect(page.locator('.attachment_test a')).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.locator('[aria-label="Download Apps"]').first()).not.toBeFocused();
});

test("photo uploads require opt-in and extension choices persist", async ({ page }) => {
    const state = await page.evaluate(() => Lowcord.extensions.state);
    expect(state).toMatchObject({
        anonymiseFileNames: true, voiceMessages: true, quickReply: true, clickReply: true, cleanUrls: true, silentTyping: true, noTracking: true,
        youtubeAdblock: true, musicEmbeds: true, socialEmbeds: true, socialCards: true, redditVideoUpload: true, instagramVideoUpload: true, twitterVideoUpload: true,
        socialPhotoUpload: false });
    expect(Object.entries(state).every(([id, value]) => value === (id !== "socialPhotoUpload"))).toBe(true);
    await page.evaluate(() => window.__lowcordOpenSettings("extensions"));
    const photos = page.getByRole("switch", { name: /Photos and carousels as files/ });
    await expect(photos).not.toBeChecked();
    await photos.check();
    await setExtension(page, "silentTyping", false);
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.fixtureReady)).toBe(true);
    expect(await page.evaluate(() => Lowcord.extensions.enabled("silentTyping"))).toBe(false);
    expect(await page.evaluate(() => Lowcord.extensions.enabled("socialPhotoUpload"))).toBe(true);
});

test('extension search filters names and descriptions, preserves toggles, and clears empty results', async ({ page }) => {
    await page.evaluate(() => window.__lowcordOpenSettings('extensions'));
    const dialog = page.getByRole('dialog', { name: 'OrbitCord Settings' });
    const search = dialog.getByRole('searchbox', { name: 'Search extensions' });
    await search.fill('  COMPRESS  MEDIA  ');
    await expect(dialog.getByRole('switch', { name: /Compress media/ })).toBeChecked();
    await search.fill('GIFs FFmpeg');
    await expect(dialog.getByRole('switch')).toHaveCount(1);
    await dialog.getByRole('switch', { name: /Compress media/ }).uncheck();
    await search.fill('FFmpeg');
    await expect(dialog.getByRole('switch', { name: /Compress media/ })).not.toBeChecked();
    await search.fill('extension that does not exist');
    await expect(dialog.getByRole('switch')).toHaveCount(0);
    await expect(dialog.getByRole('status')).toContainText('No extensions found');
    await search.fill('');
    await expect(dialog.getByRole('switch')).toHaveCount(await page.evaluate(() => Lowcord.extensions.catalog.length));
    await expect(dialog.getByRole('switch', { name: /Compress media/ })).not.toBeChecked();
    await expect(dialog.getByRole('slider', { name: 'Embed volume' })).toBeVisible();
    await expect(search).toBeFocused();
});

test("silent typing answers Discord's typing request locally, over XHR and fetch", async ({ page }) => {
    expect(await xhr(page, "POST", `/api/v9/channels/${channel}/typing`, "")).toBe(204);
    expect(await page.evaluate(path => fetch(path, { method: "POST" }).then(r => r.status), `/api/v9/channels/${channel}/typing`)).toBe(204);
    expect(await received(page)).toEqual([]);
    await setExtension(page, "silentTyping", false);
    expect(await xhr(page, "POST", `/api/v9/channels/${channel}/typing`, "")).toBe(200);
    expect((await received(page)).map(entry => entry.path)).toEqual([`/api/v9/channels/${channel}/typing`]);
});

test("no tracking blocks analytics, metrics, crash reports and the desktop RPC probe", async ({ page }) => {
    for (const path of ["/api/v9/science", "/api/v9/metrics/v2", "/api/v10/track", "/error-reporting-proxy/web"]) {
        expect(await xhr(page, "POST", `${path}?c=${channel}`, "{}")).toBe(204);
    }
    expect(await page.evaluate(() => navigator.sendBeacon(`/api/v9/science?c=1`, "{}"))).toBe(true);
    expect(await page.evaluate(() => { try { new WebSocket("ws://127.0.0.1:6463/?v=1"); return "opened"; } catch (error) { return error.name; } })).toBe("SecurityError");
    expect(await page.evaluate(() => fetch("http://127.0.0.1:6464/rpc?v=1", { method: "POST" }).then(() => "sent", error => error.name))).toBe("TypeError");
    expect(await xhr(page, "GET", `/api/v9/channels/${channel}/messages`, null, null)).toBe(200);
    expect((await received(page)).map(entry => entry.path)).toEqual([`/api/v9/channels/${channel}/messages`]);
    await setExtension(page, "noTracking", false);
    expect(await xhr(page, "POST", `/api/v9/science?c=${channel}`, "{}")).toBe(200);
});

test("clean links strips tracking from sent and edited messages, keeping real parameters", async ({ page }) => {
    await setExtension(page, "socialEmbeds", false);
    const content = "look https://www.youtube.com/watch?v=abc123&si=TRACK&t=42 and (https://shop.example/item?id=7&utm_source=x&fbclid=y). "
        + "https://x.com/user/status/1?s=20&t=abc <https://example.com/?gclid=1> https://example.com/plain?q=1";
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content, nonce: "1" }));
    await xhr(page, "PATCH", `/api/v9/channels/${channel}/messages/5`, JSON.stringify({ content: "https://open.spotify.com/track/1?si=abc" }));
    const [sent, edited] = (await received(page)).map(entry => JSON.parse(entry.body));
    expect(sent).toEqual({ nonce: "1", content: "look https://www.youtube.com/watch?v=abc123&t=42 and (https://shop.example/item?id=7). "
        + "https://x.com/user/status/1 <https://example.com/> https://example.com/plain?q=1" });
    expect(edited.content).toBe("https://open.spotify.com/track/1");
    await setExtension(page, "cleanUrls", false);
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content }));
    expect(JSON.parse((await received(page))[2].body).content).toBe(content);
});

test("fake nitro unlocks chat emojis and Nitro-locked stickers, sends them as links, and shows received links natively", async ({ page }) => {
    await page.evaluate(channel => {
        // Shapes observed in Discord's module cache: frozen premium checks,
        // emoji helpers that take an intention and a premium bypass flag, the
        // expression picker's state store, and a dispatcher with interceptors.
        const premium = Object.freeze({ canUseEmojisEverywhere: () => false, canUseAnimatedEmojis: () => false, canUseCustomStickersEverywhere: () => false });
        const reason = ({ intention, bypassPremiumEmojiEntitlement }) => bypassPremiumEmojiEntitlement ? null : `locked:${intention}`;
        const emojiHelpers = { getEmojiUnavailableReason: reason, isEmojiPremiumLocked: options => reason(options) !== null,
            getEmojiUnavailableReasons: options => {
                const disabled = (options.categoryEmojis ?? []).filter(emoji => reason({ ...options, emoji }) !== null).map(emoji => emoji.id);
                return { locked: reason(options) !== null, emojisDisabled: new Set(disabled), emojisPremiumLockedCount: disabled.length };
            },
            // Discord's version checks each emoji without the bypass flag.
            isEmojiCategoryNitroLocked: () => true };
        const intentions = { EmojiIntention: { REACTION: 0, STATUS: 1, CHAT: 3, AUTO_SUGGESTION: 9 }, isExternalEmojiAllowedForIntention: () => true };
        let pickerState = { activeView: "sticker", activeChannelId: String(channel), isNitroLockedSectionVisible: false };
        const picker = () => pickerState;
        picker.getState = () => pickerState;
        picker.setState = update => { pickerState = { ...pickerState, ...(typeof update === "function" ? update(pickerState) : update) }; };
        const fixture = { emojiHelpers, picker, actions: [], picked: [], previews: {}, canExternal: true };
        const interceptors = [];
        const dispatcher = { subscribe() {}, unsubscribe() {}, addInterceptor: fn => interceptors.push(fn),
            dispatch(action) {
                if (interceptors.some(fn => fn(action))) return;
                fixture.actions.push(action);
                if (action.type === "ADD_STICKER_PREVIEW") fixture.previews[action.channelId] = [action.sticker];
            } };
        const stickers = { 7: { id: "7", guild_id: "away", name: "party [cat]", format_type: 4 }, 8: { id: "8", guild_id: "away", name: "wave", format_type: 2 },
            9: { id: "9", guild_id: "home", name: "home", format_type: 1 }, 10: { id: "10", guild_id: "away", name: "lottie", format_type: 3 },
            11: { id: "11", guild_id: "away", name: "lost", format_type: 1, available: false } };
        const stores = {
            UserStore: { getCurrentUser: () => ({ id: "self", premiumType: 0 }) },
            SelectedChannelStore: { getChannelId: () => String(channel) },
            ChannelStore: { getChannel: id => ({ id, guild_id: id === String(channel) ? "home" : null }) },
            EmojiStore: { getCustomEmojiById: id => ({ 111: { guildId: "home" }, 222: { guildId: "home" }, 333: { guildId: "away" }, 555: { guildId: "away", managed: true },
                666: { id: "666", name: "spin", guildId: "away", animated: true }, 888: { id: "888", name: "nod", guildId: "away" } })[id] },
            StickersStore: { getStickerById: id => stickers[id] },
            MessageStore: { getMessage: (channelId, id) => channelId === String(channel) && id === "77"
                ? { id, reactions: [{ emoji: { id: "333", name: "away" }, count: 1, me: false }] } : null },
            PermissionStore: { can: () => fixture.canExternal },
            StickerMessagePreviewStore: { getStickerPreview: id => fixture.previews[id] },
            UploadAttachmentStore: { getUploads: () => [] },
        };
        for (const [name, store] of Object.entries(stores)) {
            const Store = class {};
            Store.displayName = name;
            Object.setPrototypeOf(store, Store.prototype);
        }
        window.fakeNitroFixture = fixture;
        const rest = { get() {}, put() {}, patch() {}, del() {},
            post: ({ url, body }) => fetch(`/api/v9${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) };
        window.webpackChunkdiscord_app[0][2]({ c: { fakeNitro: { exports: { premium, emojiHelpers, intentions, picker, dispatcher, rest, ...stores } } } });
        // Discord's picker markup in both looks: an older greyed-out
        // unsendable node, and a newer darkened one with a lock icon inside a
        // tinted section under a lock divider, with a floating upsell.
        const sticker = (id, locked) => `<div role="gridcell" id="sticker-picker-grid-0-${id}"><div role="button" tabindex="0" data-type="sticker"
            data-id="${id}" data-name="${stickers[id].name}" data-format-type="${stickers[id].format_type}"><div aria-hidden="true">
            <div class="stickerNode_x${locked === "new" ? " stickerLocked_x" : locked ? " stickerUnsendable_x" : ""}"><img data-type="sticker" alt=""></div>
            ${locked === "new" ? '<div class="lockIconContainer_x">🔒</div>' : ""}</div></div></div>`;
        const lockedLook = `<style>.stickerUnsendable_x { filter: grayscale(1); } .stickerLocked_x { filter: brightness(.4); }
            .categorySectionNitroLocked_x { background: linear-gradient(90deg, purple, blue); }</style>`;
        document.querySelector("main").insertAdjacentHTML("beforeend", `${lockedLook}<div id="sticker-picker"><input aria-label="Search stickers">
            <div class="listWrapper_x"><div class="nitroTopDividerContainer_x">🔒</div>
            <div class="categorySectionNitroLocked_x" id="away-section">${sticker(7, true)}${sticker(8, "new")}</div>
            ${sticker(9, false)}<div class="categorySectionNitroLocked_x" id="mixed-section">${sticker(10, "new")}${sticker(11, true)}</div></div>
            <div class="upsellContainer_x upsellContainerFloating_x">Get Nitro</div></div>
            <div class="channelTextArea_x"><div contenteditable="true" role="textbox" aria-label="Fake Nitro composer"></div></div>`);
        document.querySelector("#sticker-picker").addEventListener("click", event => fixture.picked.push(event.target.closest("[data-id]")?.dataset.id));
        document.querySelector("#sticker-picker input").addEventListener("keydown", () => fixture.picked.push("search"));
        // Discord's submit: the draft's text and sticker preview go out together.
        const editor = document.querySelector('[aria-label="Fake Nitro composer"]');
        editor.addEventListener("keydown", event => {
            if (event.key !== "Enter") return;
            const preview = fixture.previews[channel] ?? [];
            delete fixture.previews[channel];
            void fetch(`/api/v9/channels/${channel}/messages`, { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: editor.textContent, sticker_ids: preview.map(item => item.id) }) });
            editor.textContent = "";
        });
    }, channel);
    await expect.poll(() => page.evaluate(() => fakeNitroFixture.emojiHelpers.getEmojiUnavailableReason({ intention: 3 }))).toBe(null);
    // Chat and reactions are unlocked; statuses and the rest keep Discord's answer.
    expect(await page.evaluate(() => [3, 9, 0, 1].map(intention => fakeNitroFixture.emojiHelpers.getEmojiUnavailableReason({ intention }))))
        .toEqual([null, null, null, "locked:1"]);
    expect(await page.evaluate(() => [fakeNitroFixture.emojiHelpers.isEmojiPremiumLocked({ intention: 3 }),
        fakeNitroFixture.emojiHelpers.getEmojiUnavailableReasons({ intention: 1 }).locked])).toEqual([false, true]);
    // A server's section in the picker loses its locked look and upsell.
    expect(await page.evaluate(() => [3, 0, 1].map(intention => fakeNitroFixture.emojiHelpers.isEmojiCategoryNitroLocked({ intention }))))
        .toEqual([false, false, true]);

    // Stickers OrbitCord can send lose the locked look in both of Discord's styles;
    // a section keeps it while any of its stickers stays locked.
    const look = () => page.evaluate(() => {
        const style = selector => document.querySelector(selector) && getComputedStyle(document.querySelector(selector));
        const filter = id => style(`[data-id="${id}"][role="button"] [class*="stickerNode_"]`)?.filter ?? null;
        const shown = selector => style(selector) ? style(selector).display !== "none" : null;
        return { filters: ["7", "8", "10", "11"].map(filter), lockIcons: ["8", "10"].map(id => shown(`[data-id="${id}"] [class*="lockIconContainer_"]`)),
            sections: ["#away-section", "#mixed-section"].map(id => style(id)?.backgroundImage !== "none"),
            divider: shown('[class*="nitroTopDividerContainer_"]'), upsell: shown('[class*="upsellContainerFloating_"]') };
    });
    await expect.poll(look).toEqual({ filters: ["none", "none", "brightness(0.4)", "grayscale(1)"], lockIcons: [false, true],
        sections: [false, true], divider: true, upsell: true });


    const content = "hi <:wave:111> <a:dance:222> <:away:333> <:twitch:555> `<:code:333>` <:unknown:444>";
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content }));
    expect(JSON.parse((await received(page))[0].body).content).toBe("hi <:wave:111> [dance](https://cdn.discordapp.com/emojis/222.gif?size=48&name=dance) "
        + "[away](https://cdn.discordapp.com/emojis/333.webp?size=48&name=away) <:twitch:555> `<:code:333>` [unknown](https://cdn.discordapp.com/emojis/444.webp?size=48&name=unknown)");

    // With an empty draft, a locked sticker sends at once through Discord's draft.
    await page.locator('[data-id="7"][role="button"]').click();
    await expect.poll(async () => (await received(page)).length).toBe(2);
    expect(JSON.parse((await received(page))[1].body)).toEqual({ content: "[party cat](https://media.discordapp.net/stickers/7.gif?size=160)", sticker_ids: [] });
    expect(await page.evaluate(() => fakeNitroFixture.picker.getState().activeView)).toBe(null);
    // With text, it joins the draft; Enter in search picks the highlighted one.
    await page.evaluate(() => { document.querySelector('[aria-label="Fake Nitro composer"]').textContent = "look"; });
    await page.evaluate(() => document.querySelector('[data-id="8"][role="button"]').classList.add("stickerInspected_x"));
    await page.getByRole("textbox", { name: "Search stickers" }).press("Enter");
    expect(await page.evaluate(id => fakeNitroFixture.previews[id]?.map(item => item.id), String(channel))).toEqual(["8"]);
    expect((await received(page)).length).toBe(2);
    await page.getByRole("textbox", { name: "Fake Nitro composer" }).press("Enter");
    await expect.poll(async () => (await received(page)).length).toBe(3);
    expect(JSON.parse((await received(page))[2].body)).toEqual({ content: "look\n[wave](https://media.discordapp.net/stickers/8.png?size=160)", sticker_ids: [] });
    // Sendable, Lottie, unavailable and server-disallowed stickers stay Discord's.
    for (const id of ["9", "10", "11"]) await page.locator(`[data-id="${id}"][role="button"]`).click();
    await page.evaluate(() => { fakeNitroFixture.canExternal = false; });
    await page.locator('[data-id="7"][role="button"]').click();
    expect(await page.evaluate(() => fakeNitroFixture.picked)).toEqual(["9", "10", "11", "7"]);

    // Received Fake Nitro links show as the emoji or sticker they stand for.
    const link = id => `https://cdn.discordapp.com/emojis/${id}`;
    const shown = await page.evaluate(([link]) => {
        const message = { id: "900", author: { id: "self" }, sticker_items: [],
            content: `hey [dance](${link}222.gif?size=48&name=dance) ${link}333.webp?size=48&name=away ${link}999.png \`[x](${link}1.webp)\`\n`
                + "[party cat](https://media.discordapp.net/stickers/7.gif?size=160) [a [b]](https://cdn.discordapp.com/emojis/5.webp)",
            embeds: [{ type: "image", url: `${link}222.gif?size=48&name=dance` }, { type: "image", url: `${link}333.webp?size=48&name=away` },
                { type: "image", url: `${link}999.png` }, { type: "article", url: "https://example.com/" }] };
        Lowcord.Dispatcher.dispatch({ type: "MESSAGE_CREATE", message });
        // Discord fills in link previews with a later update that may lack content.
        const update = { id: "900", embeds: [{ type: "image", url: `${link}222.gif?size=48&name=dance` }, { type: "article", url: "https://example.com/" }] };
        Lowcord.Dispatcher.dispatch({ type: "MESSAGE_UPDATE", message: update });
        return { message, update };
    }, [link(""), channel]);
    expect(shown.message.content).toBe(`hey <a:dance:222> <:away:333> ${link(999)}.png \`[x](${link(1)}.webp)\`\n [a [b]](${link(5)}.webp)`);
    expect(shown.message.sticker_items).toEqual([{ id: "7", name: "party [cat]", format_type: 4 }]);
    expect(shown.message.embeds.map(embed => embed.url)).toEqual([`${link(999)}.png`, "https://example.com/"]);
    expect(shown.update.embeds.map(embed => embed.url)).toEqual(["https://example.com/"]);
    // The edit box doesn't show the sticker, so an edit keeps its link.
    await xhr(page, "PATCH", `/api/v9/channels/${channel}/messages/900`, JSON.stringify({ content: "edited" }));
    expect(JSON.parse((await received(page))[3].body).content).toBe("edited\n[party cat](https://media.discordapp.net/stickers/7.gif?size=160)");

    // With only unlocked sections left, the lock divider and upsell go too.
    await page.evaluate(() => { fakeNitroFixture.canExternal = true; document.querySelector("#mixed-section").remove(); });
    await expect.poll(async () => { const { sections, divider, upsell } = await look(); return { sections, divider, upsell }; })
        .toEqual({ sections: [false, true], divider: false, upsell: false });

    // Turned off, Discord's checks, messages and picker are its own.
    await setExtension(page, "fakeNitro", false);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-id="7"][role="button"] [class*="stickerNode_"]')).filter)).toBe("grayscale(1)");
    expect(await page.evaluate(() => fakeNitroFixture.emojiHelpers.isEmojiCategoryNitroLocked({ intention: 3 }))).toBe(true);
    expect(await page.evaluate(() => fakeNitroFixture.emojiHelpers.getEmojiUnavailableReason({ intention: 3 }))).toBe("locked:3");
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content }));
    expect(JSON.parse((await received(page))[4].body).content).toBe(content);
    await page.evaluate(() => { fakeNitroFixture.canExternal = true; });
    await page.locator('[data-id="8"][role="button"]').click();
    expect(await page.evaluate(() => fakeNitroFixture.picked.at(-1))).toBe("8");

    await setExtension(page, "fakeNitro", true);
    // Discord refuses a new reaction with a locked emoji but lets one join an
    // existing reaction. Joining, a usable emoji and a Unicode one react for
    // real; any other locked emoji goes as a reply that doesn't ping.
    const react = emoji => xhr(page, "PUT", `/api/v9/channels/${channel}/messages/77/reactions/${encodeURIComponent(emoji)}/@me`, null, null);
    for (const emoji of ["away:333", "wave:111", "👍", "spin:666"]) expect(await react(emoji)).toBe(emoji === "spin:666" ? 204 : 200);
    await expect.poll(async () => (await received(page)).length).toBe(9);
    const reactions = (await received(page)).slice(5);
    expect(reactions.slice(0, 3).map(entry => [entry.method, decodeURIComponent(entry.path.split("/reactions/")[1])]))
        .toEqual([["PUT", "away:333/@me"], ["PUT", "wave:111/@me"], ["PUT", "👍/@me"]]);
    expect(JSON.parse(reactions[3].body)).toMatchObject({ content: "[spin](https://cdn.discordapp.com/emojis/666.gif?size=48&name=spin)",
        message_reference: { channel_id: String(channel), message_id: "77" }, allowed_mentions: { replied_user: false } });
    expect(await page.evaluate(() => fakeNitroFixture.actions.filter(action => action.type === "MESSAGE_REACTION_REMOVE")
        .map(({ messageId, userId, emoji, optimistic }) => ({ messageId, userId, emoji, optimistic }))))
        .toEqual([{ messageId: "77", userId: "self", emoji: { id: "666", name: "spin", animated: true }, optimistic: true }]);

    // Picked in Discord, the reaction is held back before it shows and the
    // reply goes once; Discord's request, with its escaped @me, stays local.
    const held = await page.evaluate(channel => {
        Lowcord.Dispatcher.dispatch({ type: "MESSAGE_REACTION_ADD", channelId: String(channel), messageId: "77", userId: "self",
            emoji: { id: "888", name: "nod", animated: false }, optimistic: true });
        return fakeNitroFixture.actions.some(action => action.type === "MESSAGE_REACTION_ADD");
    }, channel);
    expect(held).toBe(false);
    expect(await xhr(page, "PUT", `/api/v9/channels/${channel}/messages/77/reactions/nod%3A888/%40me?location=Message&type=0`, null, null)).toBe(204);
    await expect.poll(async () => (await received(page)).length).toBe(10);
    await page.waitForTimeout(300);
    expect((await received(page)).length).toBe(10);
    expect(JSON.parse((await received(page))[9].body)).toMatchObject({ content: "[nod](https://cdn.discordapp.com/emojis/888.webp?size=48&name=nod)",
        message_reference: { message_id: "77" } });
    expect(await page.evaluate(() => fakeNitroFixture.actions.filter(action => action.type === "MESSAGE_REACTION_REMOVE").length)).toBe(1);
});

test("anonymised uploads get 7 random letters, keep extension and spoiler, and match the message", async ({ page }) => {
    const files = [{ id: "1", filename: "Screenshot 2026-10-03 at 4.19.04 AM.png" }, { id: "2", filename: "SPOILER_secret.mp4" }, { id: "3", filename: "backup.tar.gz" }];
    await xhr(page, "POST", `/api/v9/channels/${channel}/attachments`, JSON.stringify({ files }));
    await xhr(page, "POST", `/api/v9/channels/${channel}/messages`, JSON.stringify({ content: "", attachments: files.map((file, id) => ({ id: String(id), filename: file.filename, uploaded_filename: "x" })) }));
    const [upload, message] = (await received(page)).map(entry => JSON.parse(entry.body));
    const names = upload.files.map(file => file.filename);
    expect(names[0]).toMatch(/^[a-z]{7}\.png$/);
    expect(names[1]).toMatch(/^SPOILER_[a-z]{7}\.mp4$/);
    expect(names[2]).toMatch(/^[a-z]{7}\.tar\.gz$/);
    expect(message.attachments.map(attachment => attachment.filename)).toEqual(names);
    // The older multipart path renames the File part itself.
    await page.evaluate(path => {
        const form = new FormData();
        form.append("files[0]", new File(["bytes"], "holiday photo.jpg", { type: "image/jpeg" }));
        form.append("payload_json", JSON.stringify({ content: "" }));
        return fetch(path, { method: "POST", body: form });
    }, `/api/v9/channels/${channel}/messages`);
    expect((await received(page))[2].body).toMatch(/filename="[a-z]{7}\.jpg"/);
    await setExtension(page, "anonymiseFileNames", false);
    await xhr(page, "POST", `/api/v9/channels/${channel}/attachments`, JSON.stringify({ files: [files[0]] }));
    expect(JSON.parse((await received(page))[3].body).files[0].filename).toBe(files[0].filename);
});

test("files are anonymised as they reach the composer, before Discord uploads them", async ({ page }) => {
    const seen = await page.evaluate(() => {
        const seen = [];
        const area = document.querySelector(".channelTextArea_test");
        const input = Object.assign(document.createElement("input"), { type: "file", multiple: true });
        area.append(input);
        // Stand-ins for Discord's own handlers, which run after Lowcord's.
        input.addEventListener("change", () => seen.push(["picker", ...[...input.files].map(file => file.name)]));
        area.addEventListener("paste", event => seen.push(["paste", ...[...event.clipboardData.files].map(file => file.name)]));
        area.addEventListener("drop", event => seen.push(["drop", ...[...event.dataTransfer.files].map(file => file.name)]));
        const files = () => { const data = new DataTransfer(); data.items.add(new File(["a"], "My Photo.PNG", { type: "image/png" })); return data; };
        input.files = files().files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        area.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: files() }));
        area.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: files() }));
        // Plain text pastes and drags pass through unchanged.
        const text = new DataTransfer(); text.setData("text/plain", "hello");
        area.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: text }));
        return seen;
    });
    expect(seen.map(([kind]) => kind)).toEqual(["picker", "paste", "drop", "paste"]);
    for (const [, name] of seen.slice(0, 3)) expect(name).toMatch(/^[a-z]{7}\.PNG$/);
    expect(seen[3]).toEqual(["paste"]);
    // The upload request keeps the name Discord already showed, spoilered or not.
    const files = [{ id: "1", filename: seen[0][1] }, { id: "2", filename: `SPOILER_${seen[1][1]}` }];
    await xhr(page, "POST", `/api/v9/channels/${channel}/attachments`, JSON.stringify({ files }));
    expect(JSON.parse((await received(page))[0].body).files).toEqual(files);
});

test("message bar actions share one button that opens a menu, or is the only action", async ({ page }) => {
    const button = page.locator(".buttons_test > :first-child");
    await expect(button).toHaveClass(/lowcord-actions-button/);
    await expect(button).toHaveAccessibleName("Extensions");
    await expect(page.locator(".lowcord-actions-button")).toHaveCount(1);
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "Extensions" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Voice message", "Screenshot messages", "Delete my messages"]);
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "Delete my messages" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    // A click outside closes it too.
    await button.click();
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);

    await runAction(page, "Voice message");
    await expect(menu).toHaveCount(0);
    const dialog = page.getByRole("dialog", { name: "Record a voice message" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // With one action on, the button is that action.
    await setExtension(page, "chatCapture", false);
    await setExtension(page, "massDelete", false);
    await expect(button).toHaveAccessibleName("Voice message");
    await button.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await setExtension(page, "voiceMessages", false);
    await expect(page.locator(".lowcord-actions-button")).toHaveCount(0);
    await setExtension(page, "voiceMessages", true);
    await expect(page.locator(".lowcord-actions-button")).toHaveCount(1);
});

// Feed real Web Audio into real MediaRecorder without needing an OS microphone
// or playing sound through speakers. Only getUserMedia is substituted.
async function recordingInput(page, { unavailable = false, pending = false } = {}) {
    await page.evaluate(({ unavailable, pending }) => {
        const NativeAudioContext = window.AudioContext;
        const input = new NativeAudioContext();
        const oscillator = input.createOscillator();
        const gain = input.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain);
        const contexts = [], streams = [];
        window.AudioContext = class extends NativeAudioContext {
            constructor(...args) { super(...args); contexts.push(this); }
            createAnalyser() {
                if (unavailable) throw new Error("No analyser");
                const analyser = super.createAnalyser();
                const read = analyser.getFloatTimeDomainData.bind(analyser);
                analyser.getFloatTimeDomainData = samples => { window.recordingInput.reads++; read(samples); };
                return analyser;
            }
        };
        window.recordingInput = { contexts, streams, reads: 0,
            volume: value => { gain.gain.value = value; } };
        oscillator.start();
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
            await input.resume();
            const destination = input.createMediaStreamDestination();
            gain.connect(destination);
            streams.push(destination.stream);
            if (pending) await new Promise(resolve => { window.recordingInput.allow = resolve; });
            return destination.stream;
        } });
    }, { unavailable, pending });
    await runAction(page, "Voice message");
    await page.getByRole("button", { name: "Record", exact: true }).click();
}

const newestWaveHeight = page => page.locator(".lowcord-voice-waveform").evaluate(canvas => {
    const { width, height } = canvas;
    const pixels = canvas.getContext("2d").getImageData(width - 20, 0, 15, height).data;
    let top = height, bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < 15; x++) {
            if (pixels[(y * 15 + x) * 4 + 3]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
        }
    }
    return Math.max(0, bottom - top + 1);
});

test("live recording waveform responds to sound and silence, then releases audio resources", async ({ page }) => {
    await recordingInput(page);
    const visualization = page.locator(".lowcord-voice-visualization");
    const signal = page.locator(".lowcord-voice-signal");
    await expect(visualization).toBeVisible();
    await expect(signal).toHaveText("Listening for sound…");
    await expect.poll(() => newestWaveHeight(page)).toBeLessThan(8);
    await page.evaluate(() => recordingInput.volume(0.04));
    await expect(signal).toHaveText("Microphone is picking up sound");
    await expect.poll(() => newestWaveHeight(page)).toBeGreaterThan(18);
    const quietHeight = await newestWaveHeight(page);
    await page.evaluate(() => recordingInput.volume(0.3));
    await expect.poll(() => newestWaveHeight(page)).toBeGreaterThan(quietHeight + 12);
    await page.screenshot({ path: test.info().outputPath("recording-waveform.png") });
    await page.evaluate(() => recordingInput.volume(0));
    await expect(signal).toHaveText("Listening for sound…");
    await expect.poll(() => newestWaveHeight(page)).toBeLessThan(8);
    // Old sound remains to the left while the newest bars show silence.
    expect(await page.locator(".lowcord-voice-waveform").evaluate(canvas => {
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width - 30, 16).data;
        return pixels.some((value, index) => index % 4 === 3 && value > 0);
    })).toBe(true);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(visualization).toBeHidden();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => recordingInput.contexts.every(context => context.state === "closed"))).toBe(true);
    expect(await page.evaluate(() => recordingInput.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    const reads = await page.evaluate(() => recordingInput.reads);
    // Re-recording gets a fresh waveform and cannot send the earlier recording.
    await page.getByRole("button", { name: "Record again", exact: true }).click();
    await expect(visualization).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(page.locator(".lowcord-voice audio")).toBeHidden();
    await expect.poll(() => page.evaluate(() => recordingInput.reads)).toBeGreaterThan(reads);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".lowcord-voice-backdrop")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => recordingInput.contexts.every(context => context.state === "closed"))).toBe(true);
    expect(await page.evaluate(() => recordingInput.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
});

test("reduced motion recording shows a stationary level meter and Escape stops it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await recordingInput(page);
    const meter = page.locator(".lowcord-voice-waveform");
    const silence = await meter.evaluate(canvas => canvas.toDataURL());
    await page.evaluate(() => recordingInput.volume(0.2));
    await expect(page.locator(".lowcord-voice-signal")).toHaveText("Microphone is picking up sound");
    await expect.poll(() => meter.evaluate(canvas => canvas.toDataURL())).not.toBe(silence);
    await expect.poll(() => newestWaveHeight(page)).toBeLessThan(8);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => recordingInput.contexts.every(context => context.state === "closed"))).toBe(true);
    expect(await page.evaluate(() => recordingInput.streams[0].getTracks()[0].readyState)).toBe("ended");
});

test("an unavailable live analyser does not prevent recording and preview", async ({ page }) => {
    await recordingInput(page, { unavailable: true });
    await expect(page.locator(".lowcord-voice-signal")).toHaveText("Live waveform unavailable. Recording continues.");
    await page.evaluate(() => recordingInput.volume(0.2));
    await expect.poll(() => page.evaluate(() => recordingInput.streams[0].getTracks()[0].readyState)).toBe("live");
    await expect(page.locator(".lowcord-voice-time")).not.toHaveText("0:00");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(page.locator(".lowcord-voice audio")).toBeVisible();
});

test("closing while microphone permission is pending releases the late stream", async ({ page }) => {
    await recordingInput(page, { pending: true });
    await expect.poll(() => page.evaluate(() => typeof recordingInput.allow)).toBe("function");
    await page.keyboard.press("Escape");
    await page.evaluate(() => recordingInput.allow());
    await expect.poll(() => page.evaluate(() => recordingInput.streams[0].getTracks()[0].readyState)).toBe("ended");
    expect(await page.evaluate(() => recordingInput.contexts.length)).toBe(0);
    await expect(page.locator(".lowcord-voice-backdrop")).toHaveCount(0);
});

for (const mode of ["dmg", "automatic"]) test(`update settings checks, downloads, and installs (${mode})`, async ({ page }) => {
    await page.goto('/extensions');
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(mode => {
        let state = { status: 'idle', currentVersion: '0.1.5-1', installMode: mode };
        let listener;
        window.updateActions = [];
        const publish = next => { state = { ...state, ...next }; listener?.(state); return state; };
        window.__LOWCORD_NATIVE__ = {
            updateStatus: async () => state,
            onUpdateStatus: callback => { listener = callback; return () => { listener = null; }; },
            checkForUpdates: async () => {
                window.updateActions.push('check');
                return publish({ status: mode === 'dmg' ? 'available' : 'downloading', version: '0.1.6', progress: 50 });
            },
            downloadUpdate: async () => {
                window.updateActions.push('download');
                publish({ status: 'downloading', progress: 50 });
                return state;
            },
            installUpdate: async () => { window.updateActions.push('install'); return state; },
        };
        window.finishUpdateDownload = () => publish({ status: 'downloaded', progress: 100 });
    }, mode);
    await page.locator('.lowcord-sidebar-section').getByText('Check for updates', { exact: true }).click();
    const body = page.locator('.lowcord-settings-body');
    await body.getByRole('button', { name: 'Check for updates', exact: true }).click();
    if (mode === 'dmg') {
        await expect(body.getByRole('status')).toContainText('0.1.6 is available');
        await body.getByRole('button', { name: 'Download update', exact: true }).click();
    }
    await expect(body.getByRole('progressbar')).toHaveAttribute('value', '50');
    await expect(body.getByRole('button', { name: 'Check for updates', exact: true })).toBeDisabled();
    await page.evaluate(() => window.finishUpdateDownload());
    await body.getByRole('button', { name: mode === 'dmg' ? 'Open installer' : 'Restart and install', exact: true }).click();
    expect(await page.evaluate(() => window.updateActions)).toEqual(mode === 'dmg' ? ['check', 'download', 'install'] : ['check', 'install']);
});

test("OrbitCord section in Discord's settings opens both pages, and toggles save", async ({ page }) => {
    const section = page.locator(".lowcord-sidebar-section");
    await expect(section).toHaveCount(1);
    // Placed after the first section, reusing Discord's class names.
    await expect(page.locator('ul[role="list"] > li').nth(1)).toHaveClass(/lowcord-sidebar-section/);
    await expect(section.getByText("Chat Appearance")).toBeVisible();
    await expect(section.getByText("Extensions")).toBeVisible();
    await expect(section.locator(".active_test")).toHaveCount(0);
    await section.getByText("Extensions").click();
    const dialog = page.getByRole("dialog", { name: "OrbitCord Settings" });
    await expect(dialog.getByRole("heading", { name: "Extensions" })).toBeVisible();
    const toggles = dialog.getByRole("switch");
    await expect(toggles).toHaveCount(Object.keys(await page.evaluate(() => Lowcord.extensions.state)).length);
    await expect(dialog.getByRole("switch", { name: /Photos and carousels as files/ })).not.toBeChecked();
    expect(await toggles.evaluateAll(inputs => inputs.filter(input => input.checked).length)).toBe((await toggles.count()) - 1);
    await dialog.getByRole("switch", { name: /Silent typing/ }).uncheck();
    expect(await page.evaluate(() => JSON.parse(Lowcord.storage.getItem("lowcord.extensions")).silentTyping)).toBe(false);
    await dialog.getByRole("button", { name: "Chat Appearance" }).click();
    await expect(dialog.getByRole("switch", { name: /Chat bubbles/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => window.__lowcordOpenSettings("extensions"));
    await expect(dialog.getByRole("switch", { name: /Silent typing/ })).not.toBeChecked();
});

// A chat of solid-coloured rows. The stand-in capture paints exactly what the
// window shows inside each requested rectangle, so the stitched image proves
// every message lands once, in order, with no gaps or overlaps.
async function captureChat(page) {
    await page.evaluate(() => {
        const color = i => `rgb(${(i * 6) % 256}, ${255 - ((i * 6) % 256)}, ${(i * 37) % 256})`;
        document.body.insertAdjacentHTML("beforeend", `<div id="capture-chat" style="position:fixed;inset:0;z-index:5;display:flex;flex-direction:column;background:#313338">
            <div style="flex:1;position:relative"><div id="capture-scroller" style="position:absolute;inset:0;overflow-y:auto;background:rgb(49, 51, 56)"><ol data-list-id="chat-messages" style="margin:0;padding:0 0 24px;list-style:none">
            ${Array.from({ length: 40 }, (_, i) => `<li id="chat-messages-7-${i}" style="height:${40 + (i % 3) * 25}px;background:${color(i)}">Message ${i}</li>`).join("")}
            </ol></div><div class="chatGradient_test" data-overlay style="position:absolute;left:0;right:0;bottom:0;height:16px;pointer-events:none;background:black"></div></div>
            <div class="channelTextArea_test" data-overlay style="position:relative;height:48px;margin-top:-16px;background:black"><div class="buttons_test" id="capture-buttons"></div></div></div>`);
        window.rowClicks = 0;
        document.querySelectorAll("#capture-chat li").forEach(row => row.addEventListener("click", () => window.rowClicks++));
        window.captures = [];
        window.__LOWCORD_NATIVE__ = { ...window.__LOWCORD_NATIVE__,
            async captureRegion(rect) {
                window.captures.push(rect);
                const canvas = new OffscreenCanvas(rect.width, rect.height), context = canvas.getContext("2d");
                context.fillStyle = "rgb(49, 51, 56)"; context.fillRect(0, 0, rect.width, rect.height);
                for (const row of document.querySelectorAll("#capture-chat li")) {
                    const r = row.getBoundingClientRect();
                    context.fillStyle = row.style.background;
                    context.fillRect(r.left - rect.x, r.top - rect.y, r.width, r.height);
                }
                // Overlays paint over the chat, as in a real window: Discord's
                // message bar and gradient, and the capture bar with its shadow.
                context.fillStyle = "black";
                for (const node of document.querySelectorAll("[data-overlay], .lowcord-capture-bar")) {
                    if (getComputedStyle(node).visibility === "hidden") continue;
                    const r = node.getBoundingClientRect();
                    const shadow = node.matches(".lowcord-capture-bar") && getComputedStyle(node).boxShadow !== "none" ? 40 : 0;
                    context.fillRect(r.left - rect.x, r.top - rect.y, r.width, r.height + shadow);
                }
                return new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
            },
            async copyImage(bytes) { window.copied = bytes; },
            async saveImage() { return true; } };
    });
}

test("chat screenshots stitch the picked range into one image and restore the scroll", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 420 });
    await captureChat(page);
    await runAction(page, "Screenshot messages", "#capture-buttons");
    const bar = page.getByRole("dialog", { name: "Chat screenshot" });
    await expect(bar).toContainText("Click the first message");
    await expect(bar.getByRole("button", { name: "Capture" })).toBeDisabled();
    await page.locator("#chat-messages-7-5").scrollIntoViewIfNeeded();
    await page.locator("#chat-messages-7-5").click();
    await expect(bar).toContainText("Click the last message");
    await page.locator("#chat-messages-7-34").scrollIntoViewIfNeeded();
    await page.locator("#chat-messages-7-34").click({ position: { x: 300, y: 10 } });
    await expect(bar).toContainText("30 messages selected");
    await expect(page.locator('[data-lowcord-capture="range"]')).toHaveCount(30);
    // Picking must not reach the messages' own handlers.
    expect(await page.evaluate(() => window.rowClicks)).toBe(0);
    const scrolled = await page.locator("#capture-scroller").evaluate(node => node.scrollTop);
    await bar.getByRole("button", { name: "Capture" }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.copied))).toBe(true);
    await expect(bar).toHaveCount(0);
    await expect(page.locator("[data-lowcord-capture]")).toHaveCount(0);
    await expect(page.locator(".lowcord-toast")).toContainText("Chat image copied");
    expect(await page.locator("#capture-scroller").evaluate(node => node.scrollTop)).toBe(scrolled);
    const result = await page.evaluate(async () => {
        const bitmap = await createImageBitmap(new Blob([window.copied], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const rows = [...document.querySelectorAll("#capture-chat li")].slice(5, 35);
        const top = rows[0].getBoundingClientRect().top;
        const misses = [];
        for (const row of rows) {
            const r = row.getBoundingClientRect();
            for (let y = r.top - top + 1; y < r.bottom - top - 1; y += 3) {
                const [red, green, blue] = context.getImageData(10, Math.floor(y), 1, 1).data;
                if (`rgb(${red}, ${green}, ${blue})` !== row.style.background) misses.push([row.id, Math.floor(y)]);
            }
        }
        const scroller = document.querySelector("#capture-scroller");
        return { width: bitmap.width, height: bitmap.height, expected: rows.at(-1).getBoundingClientRect().bottom - top,
            scrollerWidth: scroller.clientWidth, captures: window.captures.length, misses };
    });
    expect(result.misses).toEqual([]);
    expect(result.height).toBe(Math.round(result.expected));
    expect(result.width).toBe(result.scrollerWidth);
    expect(result.captures).toBeGreaterThan(3);
});

test("chat screenshots cancel with Escape and leave Discord's clicks alone afterwards", async ({ page }) => {
    await captureChat(page);
    await runAction(page, "Screenshot messages", "#capture-buttons");
    await page.locator("#chat-messages-7-4").click();
    await expect(page.locator('[data-lowcord-capture="range"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Chat screenshot" })).toHaveCount(0);
    await expect(page.locator("[data-lowcord-capture]")).toHaveCount(0);
    await page.locator("#chat-messages-7-1").click();
    expect(await page.evaluate(() => window.rowClicks)).toBe(1);
    await setExtension(page, "chatCapture", false);
    await page.locator("#capture-buttons .lowcord-actions-button").click();
    await expect(page.getByRole("menuitem", { name: "Screenshot messages" })).toHaveCount(0);
});

// A stand-in for Discord's search index and REST client: 60 of the user's
// messages, one system message that can't be deleted, and other people's.
async function fakeMessages(page, { guild }) {
    await page.evaluate(guild => {
        const me = "1", channelId = "500", guildId = guild ? "900" : null;
        const messages = [];
        for (let i = 1; i <= 70; i++) messages.push({ id: String(10_000 + i), channel_id: i % 7 === 0 && guild ? "501" : channelId,
            author: { id: i % 10 === 0 ? "2" : me }, type: i === 33 ? 3 : 0 });
        window.purge = { searches: [], history: [], deletes: [], messages, rateLimited: false, indexed: false };
        const stores = {
            UserStore: { getCurrentUser: () => ({ id: me }), getUser: () => ({ globalName: "Sam" }) },
            SelectedChannelStore: { getChannelId: () => channelId },
            ChannelStore: { getChannel: id => ({ id, guild_id: guildId, name: guild ? "general" : "", recipients: guild ? undefined : ["2"] }) },
            GuildStore: { getGuild: () => ({ name: "Test server" }) },
        };
        const store = Lowcord.store;
        Lowcord.store = name => stores[name] ?? store(name);
        Object.assign(Lowcord.massDelete.pacing, { search: 1, indexing: 1 });
        Object.defineProperty(Lowcord, "RestAPI", { configurable: true, value: {
            async get({ url, query }) {
                if (url === "/guilds/900/channels") return { body: [{ id: "500", type: 0 }, { id: "501", type: 0 }, { id: "502", type: 0 }] };
                if (url === "/guilds/900/threads/active") return { body: { threads: [{ id: "503", type: 11 }] } };
                if (!url.endsWith("/search")) {
                    purge.history.push({ url, query: { ...query } });
                    const channelId = url.split("/")[2];
                    const messages = purge.messages.filter(m => m.channel_id === channelId
                        && (!query.before || BigInt(m.id) < BigInt(query.before)))
                        .sort((a, b) => Number(b.id) - Number(a.id));
                    return { body: messages.slice(0, query.limit) };
                }
                purge.searches.push({ url, query: { ...query } });
                // Discord answers 202 while it indexes a channel for the first time.
                if (!purge.indexed) { purge.indexed = true; return { status: 202, body: { retry_after: 0 } }; }
                const hits = purge.messages.filter(m => !m.unindexed && m.author.id === query.author_id
                    && (!query.channel_id || m.channel_id === query.channel_id)
                    && (!query.max_id || BigInt(m.id) <= BigInt(query.max_id)))
                    .sort((a, b) => Number(b.id) - Number(a.id));
                return { status: 200, body: { total_results: hits.length, messages: hits.slice(0, 25).map(m => [m]) } };
            },
            async del({ url }) {
                if (purge.slow) await new Promise(resolve => setTimeout(resolve, purge.slow));
                const id = url.split("/").pop();
                if (purge.deletes.length === 5 && !purge.rateLimited) { purge.rateLimited = true; throw { status: 429, body: { retry_after: 0.001 } }; }
                const message = purge.messages.find(m => m.id === id);
                if (!message) throw { status: 404, body: { code: 10008 } };
                if (message.type === 3) throw { status: 400, body: { code: 50021 } };
                purge.deletes.push(url);
                // Like Discord's index, search keeps returning deleted messages for a while.
            },
        } });
    }, guild);
}

test("mass delete removes every own message in a DM, past rate limits and indexing", async ({ page }) => {
    await fakeMessages(page, { guild: false });
    await runAction(page, "Delete my messages");
    const dialog = page.getByRole("dialog", { name: "Delete your messages?" });
    await expect(dialog).toContainText("Every message you sent to Sam");
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Delete my messages" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".lowcord-toast")).toContainText("Deleted 62 messages", { timeout: 15_000 });
    await expect(page.locator(".lowcord-toast")).toContainText("1 couldn’t be deleted");
    await expect(page.locator(".lowcord-purge-bar")).toHaveCount(0);
    const { searches, deletes } = await page.evaluate(() => window.purge);
    expect(searches[0]).toEqual({ url: "/channels/500/messages/search",
        query: { author_id: "1", sort_by: "timestamp", sort_order: "desc", include_nsfw: true, max_id: expect.stringMatching(/^\d+$/) } });
    expect(new Set(deletes).size).toBe(62);
    expect(deletes.every(url => url.startsWith("/channels/500/messages/"))).toBe(true);
});

for (const scope of ["dm", "channel", "server"]) {
    test(`mass delete includes unindexed recent messages in ${scope} history`, async ({ page }) => {
        await fakeMessages(page, { guild: scope !== "dm" });
        const result = await page.evaluate(async scope => {
            // More than one history page, including other people's messages.
            for (let i = 1; i <= 120; i++) purge.messages.push({ id: String(20_000 + i), channel_id: "500",
                author: { id: i % 2 ? "1" : "2" }, type: 0, unindexed: true });
            // A channel and active thread with no indexed messages at all.
            for (const channel_id of ["502", "503"]) purge.messages.push({ id: String(30_000 + Number(channel_id)),
                channel_id, author: { id: "1" }, type: 0, unindexed: true });
            const target = { channelId: "500", guildId: scope === "dm" ? null : "900", channelName: "general", guildName: "Test server" };
            return Lowcord.massDelete.start(target, scope === "server" ? "server" : "channel");
        }, scope);
        const state = await page.evaluate(() => purge);
        const expected = state.messages.filter(m => m.author.id === "1" && m.type !== 3
            && (scope === "server" || m.channel_id === "500")).map(m => `/channels/${m.channel_id}/messages/${m.id}`);
        expect([...state.deletes].sort()).toEqual(expected.sort());
        expect(result.failed).toBe(false);
        expect(state.history.filter(request => request.url === "/channels/500/messages").length).toBeGreaterThan(1);
    });
}

test("mass delete finds recent messages when search is empty", async ({ page }) => {
    await fakeMessages(page, { guild: false });
    const result = await page.evaluate(async () => {
        purge.messages.forEach(m => m.unindexed = true);
        return Lowcord.massDelete.start({ channelId: "500", guildId: null, channelName: "Sam" }, "channel");
    });
    expect(result).toMatchObject({ deleted: 62, skipped: 1, failed: false });
});

test("mass delete history retries rate limits and keeps messages sent after it starts", async ({ page }) => {
    await fakeMessages(page, { guild: false });
    const result = await page.evaluate(async () => {
        purge.messages.forEach(m => m.unindexed = true);
        const get = Lowcord.RestAPI.get;
        let attempts = 0;
        Lowcord.RestAPI.get = async request => {
            if (request.url === "/channels/500/messages" && ++attempts === 1) {
                // Represents a message sent after the purge's fixed upper bound.
                purge.messages.push({ id: "9999999999999999999", channel_id: "500", author: { id: "1" }, type: 0 });
                throw { status: 429, body: { retry_after: 0.001, global: true } };
            }
            return get(request);
        };
        const result = await Lowcord.massDelete.start({ channelId: "500", guildId: null, channelName: "Sam" }, "channel");
        return { result, attempts, deletes: purge.deletes };
    });
    expect(result.result).toMatchObject({ deleted: 62, skipped: 1, failed: false });
    expect(result.attempts).toBe(2);
    expect(result.deletes.some(url => url.endsWith("/9999999999999999999"))).toBe(false);
});

test("mass delete can stop while channel history is loading", async ({ page }) => {
    await fakeMessages(page, { guild: false });
    await page.evaluate(() => {
        purge.messages.forEach(m => m.unindexed = true);
        const get = Lowcord.RestAPI.get;
        Lowcord.RestAPI.get = async request => {
            if (request.url === "/channels/500/messages") {
                Lowcord.massDelete.stop();
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            return get(request);
        };
    });
    const result = await page.evaluate(() => Lowcord.massDelete.start({ channelId: "500", guildId: null, channelName: "Sam" }, "channel"));
    expect(result).toMatchObject({ deleted: 0, stopped: true, failed: false });
    expect(await page.evaluate(() => purge.deletes)).toEqual([]);
});

for (const status of [403, 500]) {
    test(`mass delete reports an incomplete history check on HTTP ${status}`, async ({ page }) => {
        await fakeMessages(page, { guild: false });
        const result = await page.evaluate(async status => {
            const get = Lowcord.RestAPI.get;
            Lowcord.RestAPI.get = async request => {
                if (request.url === "/channels/500/messages") throw { status };
                return get(request);
            };
            return Lowcord.massDelete.start({ channelId: "500", guildId: null, channelName: "Sam" }, "channel");
        }, status);
        expect(result.deleted).toBe(62);
        expect(result.failed || result.incomplete).toBe(true);
        await expect(page.locator(".lowcord-toast")).toContainText("Try again later to continue");
    });
}

test("mass delete in a server picks the channel or the whole server and can stop", async ({ page }) => {
    await fakeMessages(page, { guild: true });
    await runAction(page, "Delete my messages");
    const dialog = page.getByRole("dialog", { name: "Delete your messages?" });
    await expect(dialog.getByRole("radio", { name: /Only in #general/ })).toBeChecked();
    await dialog.getByRole("button", { name: "Delete my messages" }).click();
    await expect(page.locator(".lowcord-toast")).toContainText("Deleted 53 messages", { timeout: 15_000 });
    let state = await page.evaluate(() => window.purge);
    expect(state.searches.at(-1).url).toBe("/guilds/900/messages/search");
    expect(state.searches.at(-1).query.channel_id).toBe("500");
    expect(state.deletes.every(url => url.startsWith("/channels/500/"))).toBe(true);

    await page.evaluate(() => {
        purge.messages = purge.messages.filter(m => !purge.deletes.some(url => url.endsWith(`/${m.id}`)));
        purge.deletes = []; purge.searches = []; purge.slow = 50;
    });
    await runAction(page, "Delete my messages");
    await dialog.getByRole("radio", { name: /Everywhere in Test server/ }).check();
    await dialog.getByRole("button", { name: "Delete my messages" }).click();
    const bar = page.locator(".lowcord-purge-bar");
    await expect(bar).toContainText("Test server");
    await expect.poll(() => page.evaluate(() => purge.deletes.length)).toBeGreaterThan(2);
    await bar.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator(".lowcord-toast")).toContainText("Stopped after deleting");
    state = await page.evaluate(() => window.purge);
    expect(state.searches.at(-1).query.channel_id).toBeUndefined();
    expect(state.deletes.some(url => url.startsWith("/channels/501/"))).toBe(true);
    expect(state.deletes.length).toBeLessThan(60);
});

test("media gallery shows a DM's photos and videos by month and jumps to a message", async ({ page }) => {
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    await page.route("https://cdn.discordapp.com/**", route => route.fulfill({ contentType: "image/png", body: pixel }));
    await page.evaluate(() => {
        document.body.insertAdjacentHTML("beforeend", `<div class="chat_test" style="position:fixed;inset:0 0 0 200px;display:flex;flex-direction:column">
            <section class="title_test" style="height:48px"><div class="toolbar_test" style="display:flex;gap:8px">
                <div class="iconWrapper_test clickable_test" role="button" aria-label="Pinned Messages"><svg class="icon_test" width="24" height="24"></svg></div>
                <div class="search_test"></div></div></section>
            <div class="content_test" style="flex:1"><main class="chatContent_test"></main></div></div>`);
        const file = (id, type, extra = {}) => ({ id, filename: extra.spoiler ? "SPOILER_x.png" : "x.png", content_type: type, width: 1200, height: 800,
            duration_secs: extra.duration, proxy_url: `https://media.discordapp.net/attachments/1/${id}/x?ex=1&hm=2` });
        const media = (id, day, type, extra = {}) => ({ id: String(id), channel_id: "700", timestamp: `2026-${day}T12:00:00Z`,
            author: extra.own ? { id: "1", username: "me" } : { id: "2", global_name: "Ada" }, embeds: [], content: extra.content ?? "",
            attachments: [file(`a${id}`, type, extra), ...(extra.second ? [file(`b${id}`, type)] : [])] });
        const messages = window.galleryMessages = [];
        for (let i = 0; i < 30; i++) messages.push(media(20_000 + i, i < 10 ? "08-03" : "10-05", i % 5 === 0 ? "video/mp4" : "image/png",
            { duration: 75, spoiler: i === 29, own: i === 27 || i === 28, second: i === 27, content: i === 27 ? "two photos" : "" }));
        messages.push({ id: "20100", channel_id: "700", timestamp: "2026-10-06T12:00:00Z", author: { id: "1", username: "me" }, attachments: [],
            embeds: [{ type: "gifv", thumbnail: { proxy_url: "https://media.discordapp.net/external/g.gif", width: 200, height: 200 } }] });
        // One message with a photo and a video, the video without a content type.
        messages.push({ ...media(19_999, "08-03", "image/png"), author: { id: "3", username: "bo", avatar: "abc" } });
        messages.at(-1).attachments.push({ ...file("v19999", ""), filename: "clip.MOV" });
        window.gallery = { searches: [], jumps: [], edits: [] };
        const stores = {
            SelectedChannelStore: { getChannelId: () => "700" },
            ChannelStore: { getChannel: id => ({ id, guild_id: null, recipients: ["2"] }) },
            UserStore: { getUser: () => ({ globalName: "Ada" }), getCurrentUser: () => ({ id: "1" }) },
        };
        const store = Lowcord.store;
        Lowcord.store = name => stores[name] ?? store(name);
        Lowcord.mediaGallery.timing.search = 1;
        Object.defineProperty(Lowcord, "transitionTo", { configurable: true, value: path => gallery.jumps.push(path) });
        Object.defineProperty(Lowcord, "RestAPI", { configurable: true, value: {
            async get({ url, query }) {
                gallery.searches.push({ url, query: { ...query } });
                const hits = messages.filter(m => (!query.max_id || BigInt(m.id) <= BigInt(query.max_id))
                    // Like Discord's search, a message matches when any of its files does.
                    && (query.has.includes("video") || !m.attachments.length || m.attachments.some(a => a.content_type.startsWith("image/"))))
                    .sort((a, b) => Number(b.id) - Number(a.id));
                return { status: 200, body: { total_results: hits.length, messages: hits.slice(0, 25).map(m => [m]) } };
            },
            async del({ url }) {
                gallery.edits.push(["delete", url]);
                const id = url.split("/").pop();
                messages.splice(messages.findIndex(m => m.id === id), 1);
            },
            async patch({ url, body }) {
                gallery.edits.push(["patch", url, body]);
                const message = messages.find(m => m.id === url.split("/").pop());
                message.attachments = message.attachments.filter(a => body.attachments.some(kept => kept.id === a.id));
            },
        } });
    });
    const button = page.locator(".toolbar_test .lowcord-media-button");
    await expect(button).toHaveAccessibleName("Media");
    await expect(page.locator(".toolbar_test > *").nth(1)).toHaveClass(/lowcord-media-button/);
    await button.click();
    const pane = page.getByRole("complementary", { name: "Media" });
    await expect(pane).toContainText("Ada");
    await expect(pane.locator(".lowcord-media-tile")).toHaveCount(34);
    // Each tile carries its sender's face: an uploaded avatar, or Discord's default.
    await expect(pane.locator(".lowcord-media-tile .lowcord-media-avatar")).toHaveCount(34);
    await expect(pane.getByRole("button", { name: /^Video from bo/ }).locator(".lowcord-media-avatar"))
        .toHaveAttribute("src", "https://cdn.discordapp.com/avatars/3/abc.webp?size=64");
    await expect(pane.getByRole("button", { name: /^Video from Ada/ }).first().locator(".lowcord-media-avatar"))
        .toHaveAttribute("src", "https://cdn.discordapp.com/embed/avatars/0.png");
    await expect(pane.getByRole("status")).toHaveText("That’s everything.");
    const months = await pane.locator(".lowcord-media-month h3").allTextContents();
    expect(months).toHaveLength(2);
    expect(await pane.locator(".lowcord-media-badge", { hasText: "1:15" }).count()).toBe(6);
    await expect(pane.locator(".lowcord-media-badge", { hasText: "GIF" })).toHaveCount(1);
    await expect(pane.locator(".lowcord-media-tile[data-spoiler]")).toHaveCount(1);
    const src = await pane.locator(".lowcord-media-tile img:first-child").nth(1).getAttribute("src");
    expect(src).toContain("ex=1"); expect(src).toContain("format=webp"); expect(src).toContain("width=420"); expect(src).toContain("height=280");
    const first = await page.evaluate(() => gallery.searches[0]);
    expect(first).toEqual({ url: "/channels/700/messages/search", query: { has: ["image", "video"], include_nsfw: true } });

    await pane.locator(".lowcord-media-tile").nth(3).click();
    expect(await page.evaluate(() => gallery.jumps)).toEqual(["/channels/@me/700/20027"]);
    await expect(pane.locator(".lowcord-media-tile[data-current]")).toHaveCount(1);

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await pane.locator(".lowcord-media-tile").first().click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Media options" });
    await expect(menu.getByRole("menuitem", { name: "Copy media link" })).toBeFocused();
    await menu.getByRole("menuitem", { name: "Copy media link" }).click();
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://media.discordapp.net/external/g.gif");
    await expect(page.locator(".lowcord-toast")).toContainText("Link copied");
    await pane.locator(".lowcord-media-tile").nth(1).click({ button: "right" });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(pane).toBeVisible();

    await page.evaluate(() => {
        window.galleryDownloads = [];
        window.__LOWCORD_NATIVE__ = { downloadMedia: async url => galleryDownloads.push(url) };
    });
    await pane.getByRole('button', { name: /^Video from Ada/ }).first().click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Download video…', exact: true }).click();
    expect(await page.evaluate(() => galleryDownloads)).toEqual(['https://media.discordapp.net/attachments/1/a20025/x?ex=1&hm=2']);
    await expect(menu).toHaveCount(0);

    // Only the user's own media can be deleted; the button shows on hover.
    await expect(pane.locator(".lowcord-media-delete")).toHaveCount(4);
    const own = pane.locator('.lowcord-media-cell[data-message="20028"]');
    const remove = own.getByRole("button", { name: "Delete photo" });
    await expect(remove).toHaveCSS("opacity", "0");
    await own.hover();
    await expect(remove).toHaveCSS("opacity", "1");
    await remove.click();
    await expect(own).toHaveCount(0);
    // A message with text and two photos loses only the photo.
    const pair = pane.locator('.lowcord-media-cell[data-message="20027"]');
    await pair.first().hover();
    await pair.first().getByRole("button", { name: "Delete photo" }).click();
    await expect(pair).toHaveCount(1);
    expect(await page.evaluate(() => gallery.edits)).toEqual([["delete", "/channels/700/messages/20028"],
        ["patch", "/channels/700/messages/20027", { attachments: [{ id: "b20027" }] }]]);
    // Its last photo, with the text still there, is again removed alone.
    await pair.first().hover();
    await pair.first().getByRole("button", { name: "Delete photo" }).click();
    await expect(pair).toHaveCount(0);
    expect(await page.evaluate(() => gallery.edits.at(-1))).toEqual(["patch", "/channels/700/messages/20027", { attachments: [] }]);
    await expect(pane.locator(".lowcord-media-tile")).toHaveCount(31);

    await pane.getByRole("radio", { name: "Photos" }).click();
    await expect(pane.getByRole("radio", { name: "Photos" })).toHaveAttribute("aria-checked", "true");
    // The photo-and-video message shows only its photo here.
    await expect(pane.locator(".lowcord-media-tile")).toHaveCount(24);
    await expect(pane.locator(".lowcord-media-badge", { hasText: "1:15" })).toHaveCount(0);
    await expect(pane.getByRole("button", { name: /^Video/ })).toHaveCount(0);
    await expect(pane.getByRole("button", { name: /^Photo from bo/ })).toHaveCount(1);
    await pane.getByRole("radio", { name: "Videos" }).click();
    await expect(pane.locator(".lowcord-media-tile")).toHaveCount(7);
    await expect(pane.getByRole("button", { name: /^(Photo|GIF)/ })).toHaveCount(0);

    await pane.locator(".lowcord-media-tile").first().focus();
    await page.keyboard.press("Escape");
    await expect(pane).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-pressed", "false");
});

test("right-clicking chat media adds Copy Media Link to Discord's message menu", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => {
        document.body.insertAdjacentHTML("beforeend", `<ol style="position:fixed;top:0;left:300px;z-index:50;margin:0;list-style:none">
            <li id="chat-messages-700-1"><div id="message-accessories-1">
                <div class="imageWrapper_test" id="photo" style="width:120px;height:80px;position:relative">
                    <a class="originalLink_test" href="https://cdn.discordapp.com/attachments/1/2/photo.png?ex=1" style="position:absolute;inset:0"></a>
                    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:120px;height:80px"></div>
                <div class="wrapper_test" id="clip"><video src="https://cdn.discordapp.com/attachments/1/3/clip.mp4" width="120" height="60"></video></div>
                <div class="reactions_test"><img class="emoji_test" id="emoji" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16"></div>
            </div></li></ol>`);
        // Discord's own menu: rendered a frame after the click, closed by Escape.
        window.addEventListener("contextmenu", event => {
            event.preventDefault();
            requestAnimationFrame(() => {
                document.querySelector("#message")?.remove();
                document.body.insertAdjacentHTML("beforeend", `<div id="message" role="menu" style="position:fixed;top:200px;left:300px;z-index:60;background:#111">
                    <div role="group"><div class="item_test" role="menuitem" id="message-add-reaction">Add Reaction</div></div>
                    <div role="group"><div class="item_test focused_test labelContainer_test" role="menuitem" id="message-copy-text" tabindex="-1">
                    <div class="iconContainer_test"><svg width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h1"/></svg></div>
                    <div class="label_test"><span data-text-variant="text-sm/medium">Copy Text</span></div></div></div></div>`);
            });
        });
        document.addEventListener("keydown", event => { if (event.key === "Escape") document.querySelector("#message")?.remove(); });
    });
    const menu = page.locator("#message");
    const item = menu.getByRole("menuitem", { name: "Copy Media Link" });

    await page.locator("#photo").click({ button: "right" });
    await expect(item).toHaveCount(1);
    await expect(menu.getByRole("menuitem").nth(1)).toHaveText("Copy Media Link");
    await expect(item).not.toHaveClass(/focused_test/);
    // Discord keeps its own item focused; hovering ours takes the highlight.
    await page.addStyleTag({ content: ".focused_test { background: rgb(80, 80, 80); }" });
    const copyText = menu.getByRole("menuitem", { name: "Copy Text" });
    const background = locator => locator.evaluate(node => getComputedStyle(node).backgroundColor);
    expect(await background(copyText)).toBe("rgb(80, 80, 80)");
    await item.hover();
    await expect(item).toHaveClass(/focused_test/);
    expect(await background(item)).toBe("rgb(80, 80, 80)");
    expect(await background(copyText)).toBe("rgba(0, 0, 0, 0)");
    await copyText.hover();
    await expect(item).not.toHaveClass(/focused_test/);
    expect(await background(copyText)).toBe("rgb(80, 80, 80)");
    await item.click();
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://cdn.discordapp.com/attachments/1/2/photo.png?ex=1");
    await expect(page.locator(".lowcord-toast")).toContainText("Link copied");

    await page.locator("#clip video").click({ button: "right" });
    await item.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://cdn.discordapp.com/attachments/1/3/clip.mp4");

    await page.locator("#emoji").click({ button: "right", force: true });
    await expect(menu.getByRole("menuitem", { name: "Copy Text" })).toHaveCount(1);
    await expect(item).toHaveCount(0);

    await page.keyboard.press("Escape");
    await setExtension(page, "copyMediaLink", false);
    await page.locator("#photo").click({ button: "right" });
    await expect(menu.getByRole("menuitem", { name: "Copy Text" })).toHaveCount(1);
    await expect(item).toHaveCount(0);
});

test("media gallery months: headings open a month picker that scrolls or restarts from an older month", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 380 });
    await page.evaluate(() => {
        document.body.insertAdjacentHTML("beforeend", `<div style="position:fixed;inset:0 0 0 200px;display:flex;flex-direction:column">
            <section class="title_test" style="height:48px"><div class="toolbar_test" style="display:flex"></div></section>
            <div class="content_test" style="flex:1"></div></div>`);
        // Channel created in March 2025; a photo in each of Jan, Mar, Aug and Oct 2026, and one in May 2025.
        const id = date => ((BigInt(Date.parse(date)) - 1420070400000n) << 22n).toString();
        const channelId = id("2025-03-10T00:00:00Z");
        const messages = ["2026-10-05", "2026-08-03", "2026-03-20", "2026-01-15", "2025-05-02"].flatMap(day =>
            Array.from({ length: 4 }, (_, n) => ({ id: (BigInt(id(`${day}T12:00:00Z`)) + BigInt(n)).toString(), channel_id: channelId,
                timestamp: `${day}T12:00:00Z`, author: { id: "2" }, embeds: [],
                attachments: [{ id: `${day}-${n}`, content_type: "image/png", width: 10, height: 10, proxy_url: "https://media.discordapp.net/x.png" }] })));
        window.monthSearches = [];
        const stores = {
            SelectedChannelStore: { getChannelId: () => channelId },
            ChannelStore: { getChannel: cid => ({ id: cid, guild_id: null, recipients: ["2"] }) },
            UserStore: { getUser: () => ({ globalName: "Ada" }), getCurrentUser: () => ({ id: "1" }) },
        };
        const store = Lowcord.store;
        Lowcord.store = name => stores[name] ?? store(name);
        Lowcord.mediaGallery.timing.search = 1;
        Object.defineProperty(Lowcord, "RestAPI", { configurable: true, value: {
            async get({ query }) {
                monthSearches.push(query.max_id ?? null);
                // Pages of 4, so later months need more scrolling.
                const hits = messages.filter(m => !query.max_id || BigInt(m.id) <= BigInt(query.max_id));
                return { status: 200, body: { total_results: hits.length, messages: hits.slice(0, 4).map(m => [m]) } };
            },
        } });
    });
    await page.locator(".lowcord-media-button").click();
    const pane = page.getByRole("complementary", { name: "Media" });
    await expect(pane.locator(".lowcord-media-tile")).toHaveCount(20);
    // Title, switch, headings and tiles start at one edge.
    await pane.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    const left = selector => pane.locator(selector).first().evaluate(node => Math.round(node.getBoundingClientRect().left));
    const edge = await left(".lowcord-media-tile");
    expect(await left("header h2")).toBe(edge);
    expect(await left(".lowcord-media-segments")).toBe(edge);
    const headingText = await pane.locator(".lowcord-media-month-button").first().evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node.firstChild); return Math.round(range.getBoundingClientRect().left);
    });
    expect(headingText).toBe(edge);

    await pane.locator(".lowcord-media-month-button").first().click();
    const picker = page.getByRole("dialog", { name: "Choose a month" });
    await expect(picker.locator(".lowcord-months-year")).toHaveText("2026");
    await expect(picker.locator('[aria-current="true"]')).toBeFocused();
    await expect(picker.locator("[data-loaded]")).toHaveCount(4);
    await expect(picker.getByRole("button", { name: "Next year" })).toBeDisabled();
    // A loaded month scrolls into view.
    await picker.locator("[data-loaded]").first().click();
    await expect(picker).toHaveCount(0);
    const jan = pane.locator(".lowcord-media-month").filter({ hasText: /2026/ }).last();
    await expect.poll(() => jan.evaluate(node => Math.abs(node.getBoundingClientRect().top - node.closest(".lowcord-media-body").getBoundingClientRect().top))).toBeLessThan(2);

    // Earlier years stop at the chat's creation; an unloaded month restarts the grid.
    await pane.locator(".lowcord-media-month-button").first().click();
    await picker.getByRole("button", { name: "Previous year" }).click();
    await expect(picker.locator(".lowcord-months-year")).toHaveText("2025");
    await expect(picker.getByRole("button", { name: "Previous year" })).toBeDisabled();
    await expect(picker.locator(".lowcord-months-month:disabled")).toHaveCount(2);
    await picker.locator(".lowcord-months-month").nth(6).click();
    await expect(pane.locator(".lowcord-media-tile")).toHaveCount(4);
    await expect(pane.locator(".lowcord-media-month")).toHaveCount(1);
    const back = pane.getByRole("button", { name: "Back to newest" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(back).toBeHidden();
    await expect(pane.locator(".lowcord-media-tile")).toHaveCount(20);

    await pane.locator(".lowcord-media-month-button").first().click();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(pane).toBeVisible();
});
