import { test, expect } from "@playwright/test";

async function load(page, query = "") {
    await page.goto("/" + query);
    await expect(page.getByRole("switch", { name: /Chat bubbles/ })).toBeVisible();
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(6);
}
const surface = (page, id) => page.locator(`#chat-messages-100-${id} .message_test`);
const bubble = (page, id) => page.locator(`#chat-messages-100-${id} [data-lowcord-bubble]`);
async function settings(page, options) {
    await page.evaluate(value => window.__lowcordChatAppearance.setOptions(value), options);
}
// The edge every row shares: gutter plus, in avatar style, the face column.
const edge = locator => locator.evaluate(node => {
    const style = getComputedStyle(node);
    if (node.hasAttribute("data-lowcord-media")) return parseFloat(style.paddingRight);
    return parseFloat(node.dataset.lowcordAlign === "right" ? style.marginRight : style.marginLeft);
});
async function cleanMedia(page) {
    expect(await page.locator("[data-media] [data-lowcord-bubble]").count()).toBe(0);
    const { style, timestamps } = await page.evaluate(() => window.__lowcordChatAppearance.options);
    // Every fixture media row is its own group: one face and one time each.
    const mediaCount = await page.locator("[data-media] .message_test").count();
    await expect(page.locator("[data-media] .lowcord-bubble-avatar")).toHaveCount(style === "avatars" ? mediaCount : 0);
    await expect(page.locator("[data-media] .lowcord-bubble-time")).toHaveCount(timestamps ? mediaCount : 0);
    expect(await page.locator("[data-media] .message_test").evaluateAll(nodes => nodes.every(node => {
        const style = getComputedStyle(node);
        return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.borderTopWidth === "0px" && style.borderRadius === "0px";
    }))).toBe(true);
}

for (const style of ["bubbles", "avatars"]) {
    for (const position of ["left", "right"]) {
        for (const timestamps of [true, false]) {
            for (const width of [1000, 520]) {
                test(`${style}, own text ${position}, timestamps ${timestamps}, width ${width}`, async ({ page }) => {
                    await page.setViewportSize({ width, height: 800 });
                    await load(page);
                    await settings(page, { style, outgoingPosition: position, timestamps });
                    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-align", position);
                    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-style", style);
                    await expect(bubble(page, 1)).toHaveAttribute("data-lowcord-align", "left");
                    await expect(bubble(page, 3)).toHaveAttribute("data-lowcord-continuation", "true");
                    await expect(bubble(page, 4)).toHaveAttribute("data-lowcord-continuation", "false");
                    await expect(bubble(page, 1)).toHaveAttribute("data-lowcord-cluster", "solo");
                    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-cluster", "start");
                    await expect(bubble(page, 3)).toHaveAttribute("data-lowcord-cluster", "end");
                    await expect(bubble(page, 4)).toHaveAttribute("data-lowcord-cluster", "solo");
                    await expect(page.locator("#timeline .lowcord-bubble-tail")).toHaveCount(0);
                    expect(await bubble(page, 1).evaluate(node => getComputedStyle(node).borderBottomLeftRadius)).toBe("18px");
                    expect(await bubble(page, 3).evaluate(node => getComputedStyle(node).borderBottomLeftRadius)).toBe("18px");
                    expect(await bubble(page, 1).evaluate(node => getComputedStyle(node).borderTopRightRadius)).toBe("18px");
                    const stacked = position === "left" ? "borderTopLeftRadius" : "borderTopRightRadius";
                    expect(await bubble(page, 3).evaluate((node, prop) => getComputedStyle(node)[prop], stacked)).toBe("4px");
                    // One time and one face per group, on its last message.
                    const groupEnds = await page.locator('#timeline [data-lowcord-cluster="solo"], #timeline [data-lowcord-cluster="end"]').count();
                    await expect(page.locator("#timeline .lowcord-bubble-time")).toHaveCount(timestamps ? groupEnds : 0);
                    await expect(page.locator("#timeline .lowcord-bubble-avatar")).toHaveCount(style === "avatars" ? groupEnds : 0);
                    await expect(bubble(page, 2).locator(".lowcord-bubble-time, .lowcord-bubble-avatar")).toHaveCount(0);
                    // Text padding is even on both sides, whatever Discord's logical padding says.
                    expect(await bubble(page, 1).evaluate(node => { const s = getComputedStyle(node); return [s.paddingLeft, s.paddingRight]; })).toEqual(["12px", "12px"]);
                    // Incoming and outgoing rows mirror each other.
                    const timeline = await page.locator("#timeline").boundingBox(), first = await bubble(page, 1).boundingBox();
                    const expected = await edge(bubble(page, 1));
                    expect(first.x - timeline.x).toBeCloseTo(expected, 0);
                    if (position === "right") expect(timeline.x + timeline.width - ((await bubble(page, 3).boundingBox()).x + (await bubble(page, 3).boundingBox()).width)).toBeCloseTo(expected, 0);
                    const a = await bubble(page, 1).boundingBox(), b = await bubble(page, 2).boundingBox();
                    expect(position === "left" ? Math.abs(a.x - b.x) < 1 : b.x > a.x).toBe(true);
                    expect(await page.locator("#timeline [data-lowcord-bubble], #timeline .lowcord-bubble-avatar, #timeline .repliedMessage_test, #timeline .lowcord-bubble-tail").evaluateAll(nodes => nodes.every(node => {
                        const r = node.getBoundingClientRect(), timeline = document.querySelector("#timeline").getBoundingClientRect();
                        return r.left >= timeline.left && r.right <= timeline.right + 1 && r.left >= 0 && r.right <= innerWidth;
                    }))).toBe(true);
                    // The intentionally external avatar contributes to the
                    // surface's scrollWidth. Check the actual text box instead.
                    expect(await bubble(page, 4).locator(".messageContent_test").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
                    const reply = await page.locator(".repliedMessage_test").boundingBox(), text = await bubble(page, 4).boundingBox();
                    expect(reply.y + reply.height).toBeLessThan(text.y);
                    await cleanMedia(page);
                    await expect(page.locator('[data-media] [data-lowcord-media="outgoing"]').first()).toHaveAttribute("data-lowcord-align", position);
                    await expect(page.locator('[data-media] [data-lowcord-media="incoming"]').first()).toHaveAttribute("data-lowcord-align", "left");
                    if (position === "right") {
                        const incoming = await page.locator('[data-media="upload"] [data-lowcord-media="incoming"] .upload_test').boundingBox();
                        const outgoing = await page.locator('[data-media="upload"] [data-lowcord-media="outgoing"] .upload_test').boundingBox();
                        // A full-width upload may use all available space on a
                        // narrow timeline; its right edge still owns the gutter.
                        const bounds = await page.locator('[data-media="upload"] [data-lowcord-media="outgoing"]').boundingBox();
                        const inset = await edge(page.locator('[data-media="upload"] [data-lowcord-media="outgoing"]'));
                        expect(outgoing.x + outgoing.width).toBeCloseTo(bounds.x + bounds.width - inset, 0);
                        const image = await page.locator('[data-media="image"] [data-lowcord-media="outgoing"] .imageWrapper_test img').boundingBox();
                        const imageRow = await page.locator('[data-media="image"] [data-lowcord-media="outgoing"]').boundingBox();
                        await expect.poll(async () => Math.round(imageRow.x + imageRow.width - inset - ((await page.locator('[data-media="image"] [data-lowcord-media="outgoing"] .imageWrapper_test img').boundingBox()).x + image.width))).toBe(0);
                        if (width === 1000) expect(outgoing.x).toBeGreaterThan(incoming.x);
                    }
                    // Changes affect the real settings component and its live preview.
                    await expect(page.locator(".lowcord-chat-preview")).toHaveAttribute("data-outgoing-position", position);
                    const preview = await page.locator(".lowcord-chat-preview .outgoing .lowcord-chat-example").last().boundingBox();
                    const received = await page.locator(".lowcord-chat-preview .incoming .lowcord-chat-example").boundingBox();
                    if (position === "left") expect(Math.abs(preview.x - received.x)).toBeLessThan(1);
                    else {
                        const right = await page.locator(".lowcord-chat-preview").evaluate(node => {
                            const css = getComputedStyle(node);
                            return node.getBoundingClientRect().right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth);
                        });
                        expect(preview.x + preview.width).toBeCloseTo(right - (style === "avatars" ? 36 : 0), 0);
                    }
                });
            }
        }
    }
}

for (const width of [1000, 520]) for (const theme of ["dark", "light"]) {
    test(`reply avatars stay beside the quote on both sides, ${theme}, width ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await load(page, `?theme=${theme}`);
        await settings(page, { style: "avatars" });
        await page.evaluate(() => {
            for (const [id, author] of [[95, "other"], [96, "self"]]) {
                const row = fixture.add(id, author, '<div class="messageContent_test">OK</div>', {}, true);
                row.querySelector('.repliedTextContent_test').textContent = 'A much longer quoted message';
                // Discord can render the reply avatar directly or inside a link.
                if (author === "self") row.querySelector('.replyAvatar_test').parentElement.replaceWith(row.querySelector('.replyAvatar_test'));
            }
        });
        for (const id of [4, 95, 96]) {
            const quote = bubble(page, id).locator('.repliedMessage_test');
            await expect(quote.locator('.replyAvatar_test')).toBeVisible();
            await expect.poll(() => quote.evaluate(node => {
                const avatar = node.querySelector('[class*="replyAvatar_"]').getBoundingClientRect();
                const name = node.querySelector('[class*="username_"]').getBoundingClientRect();
                const preview = node.querySelector('[class*="repliedTextPreview_"]').getBoundingClientRect();
                const right = node.parentElement.dataset.lowcordAlign === 'right';
                return Math.round(right ? avatar.left - Math.max(name.right, preview.right)
                    : Math.min(name.left, preview.left) - avatar.right);
            })).toBe(8);
        }
        await bubble(page, 96).locator('.repliedTextContent_test').click();
        expect(await page.evaluate(() => fixture.replies)).toBe(1);
        await settings(page, { style: "bubbles" });
        await expect(bubble(page, 96).locator('.replyAvatar_test')).toBeHidden();
    });
}

test("settings controls, persisted position, disable and failed saves", async ({ page }) => {
    await load(page);
    await settings(page, { outgoingPosition: "left" });
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-align", "left");
    expect(await page.evaluate(() => JSON.parse(Lowcord.storage.getItem("lowcord.dmChatAppearance")).outgoingPosition)).toBe("left");
    await expect(page.getByRole("radio")).toHaveCount(2);
    await page.getByRole("radio", { name: /With avatars/ }).check();
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-style", "avatars");
    await page.getByRole("switch", { name: /Show timestamps/ }).uncheck();
    await expect(page.locator("#timeline .lowcord-bubble-time")).toHaveCount(0);
    await page.evaluate(() => { const prototype = Object.getPrototypeOf(Lowcord.storage); window.restoreSave = prototype.setItem; prototype.setItem = () => { throw Error("full"); }; });
    await page.getByRole("switch", { name: /Show timestamps/ }).click();
    await expect(page.getByRole("alert")).toContainText("Couldn’t save");
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-align", "left");
    await expect(page.getByRole("switch", { name: /Show timestamps/ })).not.toBeChecked();
    await page.evaluate(() => { Object.getPrototypeOf(Lowcord.storage).setItem = window.restoreSave; delete window.localStorage; });
    await page.getByRole("switch", { name: /Chat bubbles/ }).uncheck();
    await expect(page.locator("[data-lowcord-bubble], [data-lowcord-align], .lowcord-bubble-avatar, #timeline .lowcord-bubble-time, #timeline .lowcord-bubble-tail")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: /With avatars/ })).toBeDisabled();
    await page.getByRole("switch", { name: /Chat bubbles/ }).check();
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-align", "left");
});

test("uploads and dynamic media clear bubbles and restore text when removed", async ({ page }) => {
    await load(page);
    await settings(page, { style: "avatars" });
    await expect(bubble(page, 3).locator(".lowcord-bubble-avatar")).toHaveCount(1);
    await page.evaluate(() => document.querySelector("#chat-messages-100-2 .contents_test").insertAdjacentHTML("beforeend", '<div id="late" class="attachment_test upload_test">Uploading 2 Files<progress max="100" value="0"></progress><button>Cancel</button></div>'));
    await expect(bubble(page, 2)).toHaveCount(0);
    await expect(surface(page, 2)).toHaveAttribute("data-lowcord-align", "right");
    // An upload still belongs to its sender's group: the face and time stay on the last message.
    await expect(surface(page, 2)).toHaveAttribute("data-lowcord-cluster", "start");
    await expect(surface(page, 2).locator(".lowcord-bubble-time, .lowcord-bubble-avatar")).toHaveCount(0);
    await expect(bubble(page, 3).locator(".lowcord-bubble-avatar")).toHaveCount(1);
    await page.evaluate(() => { document.querySelector("#late").remove(); fixture.messages[2].attachments = [{filename:"image.png"}]; fixture.emit(); });
    await expect(bubble(page, 2)).toHaveCount(0);
    await page.evaluate(() => { fixture.messages[2].attachments = []; fixture.emit(); });
    await expect(bubble(page, 2)).toHaveCount(1);
    await page.evaluate(() => { fixture.messages[2].messageSnapshots = [{ message: { content:"Forwarded text" } }]; fixture.emit(); });
    await expect(bubble(page, 2)).toHaveCount(0);
    await page.evaluate(() => { delete fixture.messages[2].messageSnapshots; fixture.messages[2].messageReference = { type:1 }; fixture.emit(); });
    await expect(bubble(page, 2)).toHaveCount(0);
    // Some pending renderers mount their upload/snapshot at the surface root,
    // or reuse an existing node by changing its class without a store event.
    await page.evaluate(() => { delete fixture.messages[2].messageReference; fixture.emit(); });
    await expect(bubble(page, 2)).toHaveCount(1);
    await page.evaluate(() => {
        const pending = document.createElement("div"); pending.id="root-pending";
        pending.textContent="Uploading 2 Files";
        document.querySelector("#chat-messages-100-2 .message_test").append(pending);
    });
    await expect(bubble(page, 2)).toHaveCount(1);
    await page.evaluate(() => { document.querySelector("#root-pending").className="upload_test"; });
    await expect(bubble(page, 2)).toHaveCount(0);
    await page.evaluate(() => { document.querySelector("#root-pending").className="messageSnapshot_test"; });
    await expect(bubble(page, 2)).toHaveCount(0);
    await page.evaluate(() => document.querySelector("#root-pending").remove());
    await expect(bubble(page, 2)).toHaveCount(1);
    await cleanMedia(page);
    await page.locator('[data-media="upload"]').first().getByLabel("Cancel upload").click();
    await expect(page.locator('[data-media="upload"]')).toHaveCount(1);
    await page.locator('[data-media="spoiler"]').first().getByLabel("Reveal spoiler").click();
    await expect(page.locator('[data-media="spoiler"]').first().getByAltText("Spoiler image")).toBeVisible();
});

test("media sizes and handlers stay native through style switches", async ({ page }) => {
    await load(page);
    await page.evaluate(() => window.__lowcordChatAppearance.setEnabled(false));
    await expect(bubble(page, 1)).toHaveCount(0);
    const measure = () => page.locator("[data-media] .container_test img:not([hidden]), [data-media] video, [data-media] .upload_test").evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect(); return { width:Math.round(r.width), height:Math.round(r.height) };
    }));
    const before = await measure();
    await page.evaluate(() => window.__lowcordChatAppearance.setEnabled(true));
    for (const style of ["avatars", "bubbles"]) {
        await settings(page, {style, outgoingPosition:"left"});
        await expect(bubble(page, 1)).toHaveAttribute("data-lowcord-style", style);
        await cleanMedia(page);
        expect(await measure()).toEqual(before);
    }
    await page.locator("#reaction").click();
    await page.locator(".repliedTextContent_test").click();
    expect(await page.evaluate(() => [fixture.clicks, fixture.replies])).toEqual([1, 1]);
    await expect(page.locator('[data-media="file"]').first().getByRole("link")).toHaveAttribute("href", "#download");
});

test("sticker rows keep a cropped avatar and do not stretch decorations", async ({ page }) => {
    await load(page);
    const outgoing = page.locator("#chat-messages-100-23 .message_test");
    const incoming = page.locator("#chat-messages-100-22 .message_test");
    await page.evaluate(() => {
        const deco = document.createElement("div");
        deco.className = "avatarDecoration_test";
        deco.style.cssText = "position:absolute;left:4px;top:0;width:56px;height:56px;background:#f5a";
        document.querySelector("#chat-messages-100-23 .contents_test").append(deco);
    });
    await expect(outgoing.locator(".avatar_test")).toBeHidden();
    await expect(outgoing.locator(".avatarDecoration_test")).toBeHidden();
    await expect(outgoing.locator(".lowcord-bubble-avatar")).toHaveCount(0);
    const sticker = await outgoing.locator(".sticker_test").boundingBox();
    await settings(page, { style: "avatars" });
    const face = outgoing.locator(".lowcord-bubble-avatar");
    await expect(outgoing).toHaveAttribute("data-lowcord-media", "outgoing");
    await expect(outgoing).not.toHaveAttribute("data-lowcord-bubble");
    await expect(outgoing.locator(".avatar_test")).toBeHidden();
    await expect(outgoing.locator(".avatarDecoration_test")).toBeHidden();
    await expect(face).toHaveCount(1);
    await expect.poll(async () => {
        const message = await outgoing.boundingBox();
        const avatar = await face.boundingBox();
        const incomingMessage = await incoming.boundingBox();
        const incomingAvatar = await incoming.locator(".lowcord-bubble-avatar").boundingBox();
        return {
            width: Math.round(avatar.width),
            height: Math.round(avatar.height),
            rightInset: Math.round(message.x + message.width - avatar.x - avatar.width),
            leftInset: Math.round(incomingAvatar.x - incomingMessage.x)
        };
    }).toEqual({ width: 28, height: 28, rightInset: 16, leftInset: 16 });
    expect(await face.evaluate(node => getComputedStyle(node).objectFit)).toBe("cover");
    expect(await face.evaluate(node => {
        const radius = getComputedStyle(node).borderTopLeftRadius;
        return radius === "50%" || parseFloat(radius) >= 14;
    })).toBe(true);
    const stickerAfter = await outgoing.locator(".sticker_test").boundingBox();
    expect(stickerAfter.width).toBeCloseTo(sticker.width, 0);
    expect(stickerAfter.height).toBeCloseTo(sticker.height, 0);
});

for (const width of [1000, 520]) for (const position of ["left", "right"]) {
    test(`hover toolbar and reply controls, ${position}, width ${width}`, async ({ page }) => {
        await page.setViewportSize({width, height:800});
        await load(page);
        await settings(page, {style:"avatars", outgoingPosition:position});
        await page.evaluate(() => { fixture.toolbar(1); fixture.toolbar(2); });
        await expect(page.locator(".buttonsInner_test")).toHaveCount(2);
        await expect.poll(() => page.locator(".buttonsInner_test").evaluateAll(nodes => nodes.every(node => {
            const r = node.getBoundingClientRect(), timeline = document.querySelector("#timeline").getBoundingClientRect();
            return r.left >= timeline.left && r.right <= timeline.right + 1 && r.top >= node.closest(".message_test").getBoundingClientRect().top;
        }))).toBe(true);
        // Move like a real pointer, from the bubble to the button in small steps.
        for (const [id, replies] of [[2, 1], [1, 2]]) {
            const start = await bubble(page, id).locator(".messageContent_test").boundingBox();
            await page.mouse.move(start.x + 4, start.y + start.height / 2);
            const target = await bubble(page, id).getByLabel("Reply", {exact:true}).boundingBox();
            await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:40});
            await page.mouse.down();
            await page.mouse.up();
            expect(await page.evaluate(() => fixture.replies)).toBe(replies);
        }
        await page.evaluate(() => { document.querySelectorAll(".buttonContainer_test").forEach(node => node.remove()); fixture.toolbar(1, 10); });
        await expect.poll(() => page.locator(".buttonsInner_test").evaluate(node => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= innerWidth)).toBe(true);
    });
}

test("channel modes, virtualized row reuse, missing user and system messages", async ({ page }) => {
    await load(page);
    for (const type of [0, 5, 10, 11, 12]) {
        await settings(page, {servers:false});
        await page.evaluate(type => {fixture.channel.type=type;fixture.emit();}, type);
        await expect(bubble(page, 1)).toHaveCount(0);
        await settings(page, {servers:true});
        await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(6);
        await expect(bubble(page, 1)).toHaveAttribute("data-lowcord-show-author", "true");
        await cleanMedia(page);
    }
    await page.evaluate(() => {fixture.channel.type=3;fixture.emit();});
    await expect(bubble(page, 1)).toHaveAttribute("data-lowcord-show-author", "true");
    await settings(page, {groupDms:false});
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(0);
    await page.evaluate(() => {fixture.channel.type=1;fixture.emit();});
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(6);
    await settings(page, {dms:false});
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(0);
    await settings(page, {dms:true, style:"avatars"});
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(6);
    await page.evaluate(() => {document.querySelector("#chat-messages-100-2").id="chat-messages-999-2";});
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(5);
    await page.evaluate(() => {fixture.user=null;fixture.emit();});
    await expect(page.locator("[data-lowcord-bubble], [data-lowcord-align], #timeline .lowcord-bubble-avatar")).toHaveCount(0);
});

test("preferences migrate, normalize, synchronize and setup is idempotent", async ({ page }) => {
    await load(page, "?options=" + encodeURIComponent(JSON.stringify({style:"imessage", outgoingPosition:"left", outgoingColor:"#ffffff", incomingColor:"#111111"})));
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-align", "left");
    // The retired Classic and iMessage styles become plain bubbles and keep their colors.
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-style", "bubbles");
    expect(await bubble(page, 2).evaluate(node => getComputedStyle(node).color)).toBe("rgb(0, 0, 0)");
    expect(await bubble(page, 1).evaluate(node => getComputedStyle(node).color)).toBe("rgb(255, 255, 255)");
    await page.evaluate(() => {setupLowcordChatAppearance();setupLowcordChatAppearance();});
    await expect(page.locator("#lowcord-chat-appearance-css")).toHaveCount(1);
    await settings(page, {style:"unknown", outgoingPosition:"invalid", outgoingColor:"url(invalid)"});
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-align", "right");
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-style", "bubbles");
    await page.evaluate(() => { const storage=Lowcord.storage; storage.setItem("lowcord.dmChatAppearance",JSON.stringify({outgoingPosition:"left"})); window.dispatchEvent(new StorageEvent("storage",{key:"lowcord.dmChatAppearance",storageArea:storage})); });
    await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-align", "left");
    await page.goto("/?legacy=" + encodeURIComponent(JSON.stringify({enabled:false, dms:false, servers:true})));
    await expect(page.getByRole("switch", {name:/Chat bubbles/})).not.toBeChecked();
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(0);
    await page.getByRole("switch", {name:/Chat bubbles/}).check();
    await page.getByRole("switch", {name:/Direct messages/}).check();
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(6);
});

test("HTML5 file drops reach attachment drafts once; never send automatically", async ({ page }) => {
    await load(page);
    const dataTransfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(new File(["fixture png"], "photo.png", {type:"image/png"}));
        data.items.add(new File(["fixture gif"], "animation.gif", {type:"image/gif"}));
        data.items.add(new File(["fixture video"], "clip.mp4", {type:"video/mp4"}));
        return data;
    });
    await page.locator("#composer").dispatchEvent("dragover", {dataTransfer});
    await page.locator("#composer").dispatchEvent("drop", {dataTransfer});
    await expect(page.locator("#drafts span")).toHaveText(["photo.png", "animation.gif", "clip.mp4"]);
    await expect(page.locator("#sent")).toHaveText("0 sent");
    await page.getByRole("switch", {name:/Chat bubbles/}).uncheck();
    await expect(page.locator("#drafts span")).toHaveCount(3);
    await page.getByRole("button", {name:"Send test message"}).click();
    await expect(page.locator("#sent")).toHaveText("1 sent");
    await expect(page.locator("#drafts span")).toHaveCount(0);
    await dataTransfer.dispose();
});

test("unbubbled message text stays readable in dark mode", async ({ page }) => {
    await load(page);
    await page.evaluate(() => {
        document.documentElement.classList.add("theme-dark");
        document.body.style.color = "rgb(0, 0, 0)";
    });
    const colorOf = selector => page.locator(selector).first().evaluate(node => getComputedStyle(node).color);
    expect(await colorOf('[data-media="caption"] .messageContent_test')).toBe("rgb(242, 243, 245)");
    expect(await bubble(page, 2).locator(".messageContent_test").evaluate(node => getComputedStyle(node).color)).toBe("rgb(255, 255, 255)");
    await settings(page, {dms:false});
    await expect(page.locator("[data-lowcord-bubble]")).toHaveCount(0);
    expect(await colorOf("#chat-messages-100-1 .messageContent_test")).toBe("rgb(242, 243, 245)");
});

test("light theme and reduced motion have no runtime errors", async ({ page }) => {
    const errors=[];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({reducedMotion:"reduce"});
    await load(page, "?theme=light");
    for (const style of ["bubbles", "avatars"]) {
        await settings(page, {style, outgoingPosition:"left"});
        await expect(bubble(page, 2)).toHaveAttribute("data-lowcord-style", style);
        await cleanMedia(page);
    }
    expect(errors).toEqual([]);
    expect(await page.getByRole("switch", {name:/Chat bubbles/}).evaluate(node => getComputedStyle(node).transitionDuration)).toBe("0s");
});

for (const style of ["bubbles", "avatars"]) for (const width of [1000, 520]) {
    test(`multi-image uploads keep their size and the row fits, ${style}, width ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await load(page);
        await settings(page, { style, outgoingPosition: "right" });
        await page.evaluate(() => {
            const picture = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#267077"/></svg>');
            const tiles = [1, 2, 3].map(i => `<div><img class="tile_test" alt="Upload ${i}" src="${picture}"></div>`).join("");
            const row = fixture.add(40, "self", `<div class="messageContent_test">three photos</div><div class="container_test"><div class="mosaic_test">${tiles}</div></div>`, { attachments: [{}, {}, {}] });
            fixture.accessories(row);
            fixture.toolbar(40, 6);
            fixture.emit();
            document.querySelector("#chat-messages-100-1 .contents_test").insertAdjacentHTML("afterbegin", `<img class="decoration__test" alt="" width="56" height="56" src="${picture}">`);
        });
        const row = page.locator("#chat-messages-100-40");
        await expect(row.locator(".message_test")).toHaveAttribute("data-lowcord-media", "outgoing");
        await expect(page.locator(".decoration__test")).toBeHidden();
        await expect(row.locator(".avatar_test")).toBeHidden();
        await expect(row.locator(".lowcord-bubble-avatar")).toHaveCount(style === "avatars" ? 1 : 0);
        const barOffset = () => row.evaluate(node => Math.round(node.querySelector(".buttonsInner_test").getBoundingClientRect().right
            - node.querySelector(".message_test").getBoundingClientRect().right));
        const styledOffset = await barOffset();
        await page.evaluate(() => window.__lowcordChatAppearance.setEnabled(false));
        expect(styledOffset).toBe(await barOffset());
        await page.evaluate(() => window.__lowcordChatAppearance.setEnabled(true));
        await expect(row.locator(".message_test")).toHaveAttribute("data-lowcord-media", "outgoing");
        const result = await row.evaluate(node => {
            const message = node.querySelector(".message_test").getBoundingClientRect();
            const tiles = Array.from(node.querySelectorAll(".tile_test")).map(img => img.getBoundingClientRect());
            const text = node.querySelector(".messageContent_test").getBoundingClientRect();
            const avatar = node.querySelector(".lowcord-bubble-avatar")?.getBoundingClientRect();
            const timeline = document.querySelector("#timeline");
            return {
                visible: tiles.every(tile => tile.width > 40 && tile.height > 20),
                right: Math.round(message.right - Math.max(...tiles.map(tile => tile.right))),
                textClear: !avatar || text.right <= avatar.left,
                mediaClear: !avatar || Math.max(...tiles.map(tile => tile.right)) <= avatar.left,
                fits: timeline.scrollWidth <= timeline.clientWidth + 1
            };
        });
        expect(result).toEqual({ visible: true, right: await edge(row.locator(".message_test")), textClear: true, mediaClear: true, fits: true });
    });
}

test("unrelated shell mutations do not rescan the message timeline", async ({page}) => {
    await load(page);
    await page.evaluate(() => {
        window.scans = 0;
        const query = document.querySelectorAll.bind(document);
        document.querySelectorAll = selector => { if(selector === '[id^="chat-messages-"]') window.scans++; return query(selector); };
    });
    await page.evaluate(async () => {
        const shell = document.createElement("div"); document.body.append(shell);
        for(let i=0;i<10;i++) {shell.className="animation-"+i; shell.textContent=String(i); await new Promise(requestAnimationFrame);}
    });
    expect(await page.evaluate(() => window.scans)).toBeLessThanOrEqual(1);
    await page.evaluate(() => {document.querySelector('#chat-messages-100-2 .messageContent_test').classList.add('updated');});
    await expect.poll(()=>page.evaluate(()=>window.scans)).toBeGreaterThan(0);
});
