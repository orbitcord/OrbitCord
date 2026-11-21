// Local appearance settings for the bundled web client. Message data and
// interaction handlers remain owned by Discord; only existing rows are styled.
function setupLowcordChatAppearance() {
    if (window.__lowcordChatAppearance) return;
    const storageKey = "lowcord.dmChatBubbles";
    // Discord removes window.localStorage during startup; Lowcord keeps the
    // original Storage object from before that happens.
    const storage = Lowcord.storage;
    const optionsKey = "lowcord.dmChatAppearance";
    // A null text color means automatic: black or white, whichever reads better.
    // actions: where Discord's hover toolbar sits. "edge" keeps it at the far
    // side of the chat, "beside" next to the message, "corner" over its top
    // corner, "react" beside it with only the reaction buttons.
    const actionPlacements = ["edge", "beside", "corner", "react"];
    const defaults = { style: "bubbles", outgoingPosition: "right", actions: "edge", timestamps: true, outgoingColor: "#006be6", incomingColor: "#3a3a3c",
        outgoingTextColor: null, incomingTextColor: null, dms: true, groupDms: true };
    // Matches the CSS: 16px gutter, plus a 28px face and 8px gap in avatar style.
    const gutter = 16, face = 36;
    function normalizeOptions(value) {
        const color = (key) => /^#[0-9a-f]{6}$/i.test(value?.[key]) ? value[key].toLowerCase() : defaults[key];
        // The retired Classic and iMessage styles both become plain bubbles.
        return { style: value?.style === "avatars" ? "avatars" : "bubbles",
            outgoingPosition: ["left", "right"].includes(value?.outgoingPosition) ? value.outgoingPosition : defaults.outgoingPosition,
            actions: actionPlacements.includes(value?.actions) ? value.actions : defaults.actions,
            timestamps: typeof value?.timestamps === "boolean" ? value.timestamps : defaults.timestamps,
            outgoingColor: color("outgoingColor"), incomingColor: color("incomingColor"),
            outgoingTextColor: color("outgoingTextColor"), incomingTextColor: color("incomingTextColor"),
            ...Object.fromEntries(["dms", "groupDms"].map(key =>
                [key, typeof value?.[key] === "boolean" ? value[key] : defaults[key]])) };
    }
    function readOptions() {
        try { return normalizeOptions(JSON.parse(storage.getItem(optionsKey))); }
        catch { return { ...defaults }; }
    }
    // One-time migration from the retired plugin; future saves belong to Lowcord.
    try {
        const legacy = JSON.parse(storage.getItem("VencordSettings") || "{}").plugins?.ChatBubbles;
        if (storage.getItem(storageKey) === null) {
            storage.setItem(storageKey, String(legacy?.enabled ?? true));
        }
        if (storage.getItem(optionsKey) === null) {
            storage.setItem(optionsKey, JSON.stringify(normalizeOptions(legacy)));
        }
    } catch {}
    let options = readOptions();
    // Pick the more readable foreground for either user-selected bubble color.
    function textColorsFor(value) {
        return { incoming: value.incomingTextColor ?? foreground(value.incomingColor), outgoing: value.outgoingTextColor ?? foreground(value.outgoingColor) };
    }
    function foreground(hex) {
        const channels = hex.slice(1).match(/../g).map(value => {
            const channel = parseInt(value, 16) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        return luminance > 0.179 ? "#000000" : "#ffffff";
    }
    const changeEvent = "lowcord-chat-appearance-change";
    const marker = "data-lowcord-bubble";
    const attributes = [marker, "data-lowcord-media", "data-lowcord-align", "data-lowcord-show-author", "data-lowcord-continuation",
        "data-lowcord-cluster", "data-lowcord-emoji", "data-lowcord-style", "data-lowcord-actions", "data-lowcord-timed", "data-lowcord-caption", "data-lowcord-fit"];
    const actionProperties = ["--lowcord-actions-start", "--lowcord-actions-top", "--lowcord-actions-width", "--lowcord-actions-room"];
    const properties = ["--lowcord-bubble-color", "--lowcord-bubble-text", "--lowcord-reply-max-width", ...actionProperties, "--lowcord-fit"];
    const stores = new Map();
    // The pending nonce leaves MessageStore before React replaces its row.
    // Keep that row's last message until the DOM identity changes. Weak keys
    // let virtualized/unmounted rows and their message data be collected.
    const rowMessages = new WeakMap();
    const renderedRows = new Map(), dirtyRows = new Set();
    let orderedRows = [], fullRefresh = true, structureChanged = true, storeChanged = false;
    let context, timeCache = new WeakMap(), timeContext, timeFormat, titleFormat, timeCheckedAt = 0;
    let colorKey, textColors;
    function invalidate() { fullRefresh = true; structureChanged = true; scheduleRefresh(); }
    function checkTimeContext() { timeCheckedAt = 0; invalidate(); }
    function messageChanged() { storeChanged = true; scheduleRefresh(); }
    // Discord loads the other person's profile after every DM switch. A user
    // change can only move an avatar picture (a change of account is caught
    // by the context check), so it must not lay out every row again.
    let avatarsChanged = false;
    function usersChanged() { avatarsChanged = true; scheduleRefresh(); }
    const storeListeners = new Map();
    let enabled = true;
    // Whether bubbles may be on the page; cleared once they have been removed.
    let drawn = true;
    let stopObserving;
    const resizedTimelines = new Set();
    const resizeObserver = new ResizeObserver(() => invalidate());
    // Media decodes and players mount after the row; their size decides the
    // right-aligned shift, so watch them rather than measuring once.
    const observedMedia = new Set();
    const mediaObserver = new ResizeObserver(records => {
        for (const record of records) {
            const row = record.target.closest('[id^="chat-messages-"]');
            if (row) dirtyRows.add(row);
        }
        scheduleRefresh();
    });
    let frame;
    try { enabled = storage.getItem(storageKey) !== "false"; } catch {}

    // An upload in progress is a list item of its own, not a chat-messages row.
    const uploaderSelector = '[data-list-item-id^="chat-messages___Uploader"]';
    function clearBubbles() {
        document.querySelectorAll("[data-lowcord-uploader]").forEach(node => {
            node.removeAttribute("data-lowcord-uploader"); node.removeAttribute("data-lowcord-style");
        });
        resizeObserver.disconnect();
        resizedTimelines.clear();
        mediaObserver.disconnect();
        observedMedia.clear();
        renderedRows.clear(); orderedRows = []; dirtyRows.clear(); context = undefined; cancelActions();
        fullRefresh = structureChanged = true;
        document.querySelectorAll(`[${marker}], [data-lowcord-media]`).forEach(clearSurface);
    }

    function clearAccessories(surface) {
        surface.querySelectorAll(".lowcord-media-item").forEach(item => {
            item.classList.remove("lowcord-media-item");
            item.style.removeProperty("--lowcord-media-shift");
        });
    }

    function clearSurface(surface) {
        for (const attribute of attributes) surface.removeAttribute(attribute);
        surface.querySelectorAll(":scope > .lowcord-bubble-time, :scope > .lowcord-bubble-avatar").forEach(node => node.remove());
        clearAccessories(surface);
        for (const name of properties) surface.style.removeProperty(name);
    }

    function setAttribute(element, name, value) {
        if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
    function setProperty(element, name, value) {
        if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
    }

    // Grouped rows share a flat inner corner. Solo rows stay fully rounded.
    function clusterRole(continuation, last) {
        if (!continuation && last) return "solo";
        if (!continuation) return "start";
        if (!last) return "middle";
        return "end";
    }

    // A run of messages from one sender within five minutes. A reply starts a
    // new run because its quote card sits above the bubble.
    function joins(a, b) {
        return Boolean(a && b && !b.isReply && a.timeline === b.timeline && a.author === b.author
            && b.date - a.date >= 0 && b.date - a.date < 5 * 60 * 1000);
    }

    // Only emoji (unicode or custom) and spaces: shown as they are, no bubble.
    // Keycaps (1\uFE0F\u20E3) start with a plain digit; subdivision flags end in tag characters.
    const emojiOnlyPattern = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[#*0-9]\uFE0F?\u20E3|\uFE0F|\u200D|[\u{E0020}-\u{E007F}]|<a?:\w+:\d+>|\s)+$/u;
    function isEmojiOnly(message) {
        const content = message.content ?? "";
        return content.trim() !== "" && emojiOnlyPattern.test(content);
    }

    const richContentSelector = '[class*="attachment_"], [class*="attachmentContent_"], [class*="upload_"], '
        + '[class*="uploadProgress_"], [class*="imageWrapper_"], [class*="visualMediaItemContainer_"], '
        + '[class*="mosaicItem_"], [class*="embed_"], [class*="embedFull_"], [class*="sticker_"], '
        + '[class*="messageSnapshot_"], [class*="forwardedMessage_"], .lowcord-music-embeds, .lowcord-social-embeds, video, audio';
    const skipBodySelector = '[class*="repliedMessage_"], [class*="buttonContainer_"], [class*="buttons_"], '
        + '.lowcord-bubble-avatar, .lowcord-bubble-time';
    const richClassPattern = /attachment_|attachmentContent_|upload_|uploadProgress_|imageWrapper_|visualMediaItemContainer_|mosaicItem_|embed_|embedFull_|sticker_|messageSnapshot_|forwardedMessage_|lowcord-music-embeds|lowcord-social-embeds|container_|avatar|decoration|emoji|reaction|repliedMessage_/i;
    function hasRichContent(message, surface) {
        // Discord's store uses camelCase; pending messages and wire payloads
        // can still use snake_case. Forwarded text also has a message snapshot.
        if (message.attachments?.length || message.embeds?.length || message.stickerItems?.length
            || message.sticker_items?.length || message.stickers?.length || message.components?.length
            || message.messageSnapshots?.length || message.message_snapshots?.length
            || message.messageReference?.type === 1 || message.message_reference?.type === 1
            || message.poll) return true;
        // Upload placeholders and asynchronously resolved embeds can appear
        // before MessageStore receives their attachment data. Inspect only the
        // message body, never reply thumbnails, author avatars or action icons.
        for (let body = surface.firstElementChild; body; body = body.nextElementSibling) {
            if (body.matches(skipBodySelector)) continue;
            if (body.matches(richContentSelector) || (body.childElementCount > 0 && body.querySelector(richContentSelector))) return true;
            const imgs = body.getElementsByTagName("img");
            for (let i = 0; i < imgs.length; i++) {
                if (!isChromeImage(imgs[i])) return true;
            }
        }
        return false;
    }

    // Avatar decorations are images too. Treating them as attachments dropped the
    // bubble and left Discord's face on the row.
    function isChromeImage(img) {
        if (img.closest('[class*="avatar" i], [class*="decoration" i], [class*="header_" i], '
            + '[class*="emoji" i], [class*="reaction" i], [class*="repliedMessage_" i]')) return true;
        const src = img.currentSrc || img.getAttribute("src") || "";
        return src.includes("/avatars/") || src.includes("/embed/avatars/") || src.includes("avatar-decoration");
    }

    function authorAvatar(surface, message, size) {
        const author = stores.get("UserStore")?.getUser?.(message.author?.id) ?? message.author;
        let source = surface.querySelector('[class*="avatar_"]')?.getAttribute("src");
        try { source = author?.getAvatarURL?.(null, size, true) || source; } catch {}
        if (!source && author?.avatar) source = `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.webp?size=${size}`;
        if (!source) {
            let index = 0;
            try { index = Number((BigInt(author?.id) >> 22n) % 6n); } catch {}
            source = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
        }
        return source;
    }

    function directChildByClass(parent, className) {
        for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
            if (child.classList.contains(className)) return child;
        }
        return null;
    }

    function setAvatar(surface, message, show) {
        let avatar = directChildByClass(surface, "lowcord-bubble-avatar");
        if (!show) { avatar?.remove(); return; }
        if (!avatar) {
            avatar = document.createElement("img");
            avatar.className = "lowcord-bubble-avatar";
            avatar.alt = "";
            avatar.setAttribute("aria-hidden", "true");
            surface.append(avatar);
        }
        setAttribute(avatar, "src", authorAvatar(surface, message, 64));
    }

    // A footer under the last message of a run, outside the bubble, so text and
    // media share the same timestamp line.
    function setTime(surface, date, show) {
        let time = directChildByClass(surface, "lowcord-bubble-time");
        if (!show) {
            time?.remove();
            if (surface.hasAttribute("data-lowcord-timed")) surface.removeAttribute("data-lowcord-timed");
            return;
        }
        if (!time) {
            time = document.createElement("time");
            time.className = "lowcord-bubble-time";
            time.setAttribute("aria-hidden", "true"); // Discord's article label already includes the time.
        }
        if (surface.lastElementChild !== time) surface.append(time);
        let formatted = timeCache.get(surface);
        if (!formatted || formatted.value !== date.getTime()) {
            formatted = { value: date.getTime(), text: timeFormat.format(date), iso: date.toISOString(), title: titleFormat.format(date) };
            timeCache.set(surface, formatted);
        }
        const text = formatted.text;
        if (time.textContent !== text) time.textContent = text;
        setAttribute(time, "datetime", formatted.iso);
        setAttribute(time, "title", formatted.title);
        setAttribute(surface, "data-lowcord-timed", "true");
    }

    // Discord's attachment grid. The fixture nests it inside contents_.
    const actionsSelector = '[class*="buttonContainer_"]';
    const accessoriesSelector = ':scope > [id^="message-accessories-"], '
        + ':scope > .lowcord-music-embeds, :scope > .lowcord-social-embeds, '
        + ':scope > [class*="container_"]:not([class*="buttonContainer_"]), '
        + ':scope > [class*="contents_"] > [class*="container_"]:not([class*="buttonContainer_"])';
    const mediaSelector = 'img, video, canvas, iframe[data-lowcord-music-player], .lowcord-social-card, [class*="mosaicItem_"], [class*="imageWrapper_"], [class*="embedFull_"], '
        + '[class*="attachment_"], [class*="upload_"], [class*="messageSnapshot_"], [class*="sticker_"]';

    // Discord sizes attachments against a full-width grid, so outgoing media is
    // translated as a whole by the empty space right of each item's content.
    // Reactions wrap in a flex row and are right-justified by CSS instead.
    // markAccessories writes; measureAccessories reads every item in the same
    // layout as the other measurements. Measuring after each item's write
    // forced a layout per media item.
    function markAccessories(entries, seenMedia) {
        const items = [];
        for (const { surface, right } of entries) for (const box of surface.querySelectorAll(accessoriesSelector)) {
            for (const item of box.children) {
                if (item.matches('[class*="reactions_"]')) continue;
                // classList writes the attribute even when unchanged, which the
                // timeline MutationObserver would turn into a refresh loop.
                if (item.classList.contains("lowcord-media-item") !== right) item.classList.toggle("lowcord-media-item", right);
                if (!right) {
                    item.style.removeProperty("--lowcord-media-shift");
                    continue;
                }
                for (const media of item.querySelectorAll(mediaSelector)) {
                    seenMedia.add(media);
                    if (!observedMedia.has(media)) { mediaObserver.observe(media); observedMedia.add(media); }
                }
                items.push({ box, item });
            }
        }
        return items;
    }
    function measureAccessories(items) {
        const boxes = new Map();
        return items.map(({ box, item }) => {
            let boxBounds = boxes.get(box);
            if (!boxBounds) boxes.set(box, boxBounds = box.getBoundingClientRect());
            // Rects include the current shift; subtract it before re-measuring.
            const current = parseFloat(item.style.getPropertyValue("--lowcord-media-shift")) || 0;
            // Discord's media column is wider than the picture it holds, so
            // measure the media elements themselves, then the item's own box.
            let contentRight = -Infinity;
            // A social card's carousel holds off-screen slides; measure the card.
            const inner = item.matches(".lowcord-social-card") ? [] : item.querySelectorAll(mediaSelector);
            for (const nodes of [inner, [item]]) {
                for (const node of nodes) {
                    const rect = node.getBoundingClientRect();
                    if (rect.width && rect.height && rect.width < boxBounds.width - 1) contentRight = Math.max(contentRight, rect.right);
                }
                if (Number.isFinite(contentRight)) break;
            }
            return Number.isFinite(contentRight) ? Math.max(0, Math.round(boxBounds.right - (contentRight - current))) : 0;
        });
    }

    // The hover toolbar is placed once the frame has painted: it matters only
    // when the pointer reaches a message, and measuring it before paint cost
    // another layout of the whole channel.
    const pendingActions = new Set();
    let actionsFrame, actionsTimer;
    function queueActions(entries) {
        for (const entry of entries) pendingActions.add(entry);
        actionsFrame ??= requestAnimationFrame(() => {
            actionsTimer = setTimeout(() => {
                actionsFrame = actionsTimer = undefined;
                // Skip rows that were cleared or read again since.
                const current = [...pendingActions].filter(entry => renderedRows.get(entry.row)?.entry === entry && entry.surface.isConnected);
                pendingActions.clear();
                if (enabled) placeActions(current);
            });
        });
    }
    function cancelActions() {
        if (actionsFrame !== undefined) cancelAnimationFrame(actionsFrame);
        clearTimeout(actionsTimer);
        actionsFrame = actionsTimer = undefined;
        pendingActions.clear();
    }
    // Discord mounts the hover toolbar only while a message is hovered. Its
    // place is measured from the message alone, before it exists, so CSS puts
    // it in position the moment it mounts and nothing moves afterwards.
    // start: the content's near edge, from the surface's near side.
    // top: the content's top, from the surface's top.
    // width: the content (a bubble, or the media inside a full-width row).
    // room: the row beyond the surface's far side.
    // Positions are read for every row before any is written, in one layout.
    function placeActions(entries) {
        const places = entries.map(entry => {
            const bounds = entry.surface.getBoundingClientRect(), rowBounds = entry.row.getBoundingClientRect();
            return { bounds, rowBounds, content: entry.media ? mediaBounds(entry.surface, bounds) : bounds };
        });
        entries.forEach(({ surface, alignment }, i) => {
            const { bounds, rowBounds, content } = places[i];
            if (!content) {
                surface.removeAttribute("data-lowcord-actions");
                for (const name of actionProperties) surface.style.removeProperty(name);
                return;
            }
            const left = alignment === "left";
            setProperty(surface, "--lowcord-actions-start", `${Math.round(left ? content.left - bounds.left : bounds.right - content.right)}px`);
            setProperty(surface, "--lowcord-actions-top", `${Math.round(content.top - bounds.top)}px`);
            setProperty(surface, "--lowcord-actions-width", `${Math.round(content.right - content.left)}px`);
            setProperty(surface, "--lowcord-actions-room", `${Math.max(0, Math.round(left ? rowBounds.right - bounds.right : bounds.left - rowBounds.left))}px`);
            setAttribute(surface, "data-lowcord-actions", options.actions);
        });
    }
    // Media rows span the timeline; measure the pictures, stickers and caption inside.
    function mediaBounds(surface, surfaceBounds) {
        let left = Infinity, right = -Infinity, top = Infinity;
        const measure = node => {
            const rect = node.getBoundingClientRect();
            if (!rect.width || !rect.height || rect.width >= surfaceBounds.width - 1) return false;
            left = Math.min(left, rect.left); right = Math.max(right, rect.right); top = Math.min(top, rect.top);
            return true;
        };
        for (const box of surface.querySelectorAll(accessoriesSelector)) for (const item of box.children) {
            if (item.matches('[class*="reactions_"], [class*="messageContent_"]')) continue;
            // The grid column is wider than its picture; prefer the media itself.
            const inner = item.matches(".lowcord-social-card") ? [] : [...item.querySelectorAll(mediaSelector)];
            if (!inner.map(measure).some(Boolean)) measure(item);
        }
        const text = surface.querySelector(':scope > [class*="contents_"] > [class*="messageContent_"]');
        if (text && surface.hasAttribute("data-lowcord-caption")) measure(text);
        else if (text && surface.getAttribute("data-lowcord-emoji") === "true") text.querySelectorAll("img").forEach(measure);
        return Number.isFinite(right) ? { left, right, top } : null;
    }

    // A wrapped bubble is as wide as its longest possible line, so a long
    // message can end in a wide gap. Fit wrapped bubbles to their widest
    // line: release every width, read all of them in one layout, then write.
    function fitBubble(surface, width) {
        if (!width) { surface.style.removeProperty("--lowcord-fit"); return; }
        setProperty(surface, "--lowcord-fit", `${width}px`);
        surface.setAttribute("data-lowcord-fit", "");
    }
    function wrappedWidth(surface) {
        const text = surface.querySelector(':scope > [class*="contents_"] > [class*="messageContent_"]');
        // Code blocks and tables scroll inside the bubble; leave them be.
        if (!text || text.querySelector("pre, table")) return 0;
        const range = document.createRange();
        range.selectNodeContents(text);
        const rects = range.getClientRects();
        let firstBottom = NaN, wrapped = false, right = -Infinity;
        for (let i = 0; i < rects.length; i++) {
            const rect = rects[i];
            if (!rect.width || !rect.height) continue;
            if (Number.isNaN(firstBottom)) firstBottom = rect.bottom - 2;
            else if (rect.top >= firstBottom) wrapped = true;
            if (rect.right > right) right = rect.right;
        }
        if (!wrapped) return 0;
        const left = text.getBoundingClientRect().left;
        // Reactions sit inside the bubble too; never cut them off.
        const reactions = surface.querySelectorAll('[class*="reactions_"] > *');
        for (let i = 0; i < reactions.length; i++) {
            const r = reactions[i].getBoundingClientRect().right;
            if (r > right) right = r;
        }
        return Math.ceil(right - left) + 1;
    }

    function apply(entry, channel) {
        const { row, surface, message, side, alignment, media } = entry;
        const avatars = options.style === "avatars";
        if (media) {
            if (surface.hasAttribute(marker)) surface.removeAttribute(marker);
            setAttribute(surface, "data-lowcord-media", side);
            setAttribute(surface, "data-lowcord-emoji", String(Boolean(entry.emoji)));
        } else {
            if (surface.hasAttribute("data-lowcord-media")) {
                surface.removeAttribute("data-lowcord-media");
                surface.removeAttribute("data-lowcord-emoji");
                surface.removeAttribute("data-lowcord-caption");
                clearAccessories(surface);
            }
            setAttribute(surface, marker, side);
        }
        setAttribute(surface, "data-lowcord-align", alignment);
        setAttribute(surface, "data-lowcord-style", options.style);
        setAttribute(surface, "data-lowcord-show-author", String(channel.type !== 1));
        setAttribute(surface, "data-lowcord-continuation", String(entry.continuation));
        setAttribute(surface, "data-lowcord-cluster", clusterRole(entry.continuation, entry.last));
        // The placement mode restyles the whole message; set it with the rest
        // so it shares this restyle. placeActions() fills in the measurements.
        setAttribute(surface, "data-lowcord-actions", options.actions);
        const color = side === "outgoing" ? options.outgoingColor : options.incomingColor;
        setProperty(surface, "--lowcord-bubble-color", color);
        setProperty(surface, "--lowcord-bubble-text", textColors[side]);
        setAvatar(surface, message, avatars && entry.last);
        setTime(surface, entry.date, options.timestamps && entry.last && !Number.isNaN(entry.date.getTime()));
        if (media) {
            const caption = surface.querySelector(':scope > [class*="contents_"] > [class*="messageContent_"]');
            if (!entry.emoji && caption?.textContent.trim() && !caption.hasAttribute("data-lowcord-social-link-only")) setAttribute(surface, "data-lowcord-caption", "true");
            else surface.removeAttribute("data-lowcord-caption");
        }
    }

    function rowMessage(row, channelID, messageID) {
        const message = stores.get("MessageStore")?.getMessage(channelID, messageID);
        if (message) {
            rowMessages.set(row, { channelID, messageID, message });
            return message;
        }
        const previous = rowMessages.get(row);
        if (previous?.channelID === channelID && previous.messageID === messageID) return previous.message;
        // On an initial optimistic commit React can also get ahead of the
        // store. Read the message already rendered by its owning component;
        // never patch React/Discord or infer a sender from visible text.
        const key = Object.keys(row).find(name => name.startsWith("__reactFiber$"));
        for (let fiber = key && row[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
            for (const props of [fiber.memoizedProps, fiber.alternate?.memoizedProps]) {
                const rendered = props?.message;
                if (rendered?.id === messageID && (props.channel?.id === channelID || rendered.channel_id === channelID)) {
                    rowMessages.set(row, { channelID, messageID, message: rendered });
                    return rendered;
                }
            }
        }
        rowMessages.delete(row);
        return null;
    }

    // Store notifications carry no message ID. Compare cheap message inputs,
    // then do DOM/formatting/geometry work only for changed rows and neighbors.
    const timestampValue = ts => typeof ts === "string" || typeof ts === "number" ? ts : ts?.valueOf?.() ?? String(ts);
    function inputs(message) {
        if (!message) return null;
        return {
            authorId: message.author?.id, authorAvatar: message.author?.avatar, type: message.type,
            timestamp: timestampValue(message.timestamp), content: message.content, flags: message.flags,
            imUser: message.interactionMetadata?.user?.id, imsUser: message.interaction_metadata?.user?.id, iUser: message.interaction?.user?.id,
            mr: message.messageReference, mrType: message.messageReference?.type,
            mrs: message.message_reference, mrsType: message.message_reference?.type, poll: message.poll,
            att: message.attachments, attLen: message.attachments?.length,
            emb: message.embeds, embLen: message.embeds?.length,
            si: message.stickerItems, siLen: message.stickerItems?.length,
            sis: message.sticker_items, sisLen: message.sticker_items?.length,
            st: message.stickers, stLen: message.stickers?.length,
            cmp: message.components, cmpLen: message.components?.length,
            ms: message.messageSnapshots, msLen: message.messageSnapshots?.length,
            mss: message.message_snapshots, mssLen: message.message_snapshots?.length,
        };
    }
    function inputsMatch(saved, message) {
        if (!saved || !message) return saved === (message ?? null);
        return saved.authorId === message.author?.id
            && saved.authorAvatar === message.author?.avatar
            && saved.type === message.type
            && saved.content === message.content
            && saved.flags === message.flags
            && saved.timestamp === timestampValue(message.timestamp)
            && saved.imUser === message.interactionMetadata?.user?.id
            && saved.imsUser === message.interaction_metadata?.user?.id
            && saved.iUser === message.interaction?.user?.id
            && saved.mr === message.messageReference
            && saved.mrType === message.messageReference?.type
            && saved.mrs === message.message_reference
            && saved.mrsType === message.message_reference?.type
            && saved.poll === message.poll
            && saved.att === message.attachments && saved.attLen === message.attachments?.length
            && saved.emb === message.embeds && saved.embLen === message.embeds?.length
            && saved.si === message.stickerItems && saved.siLen === message.stickerItems?.length
            && saved.sis === message.sticker_items && saved.sisLen === message.sticker_items?.length
            && saved.st === message.stickers && saved.stLen === message.stickers?.length
            && saved.cmp === message.components && saved.cmpLen === message.components?.length
            && saved.ms === message.messageSnapshots && saved.msLen === message.messageSnapshots?.length
            && saved.mss === message.message_snapshots && saved.mssLen === message.message_snapshots?.length;
    }
    const rowIdPattern = /^chat-messages-(\d+)-(.+)$/;
    function parseRowId(row, cached) {
        const id = row.id;
        if (cached && cached.rowId === id) return cached;
        const match = rowIdPattern.exec(id);
        return { rowId: id, rowChannelID: match ? match[1] : null, rowMessageID: match ? match[2] : null };
    }
    function readRow(row, channelID, userID) {
        const parsed = parseRowId(row, renderedRows.get(row));
        const message = parsed.rowChannelID === channelID ? rowMessage(row, channelID, parsed.rowMessageID) : null;
        const surface = row.querySelector('[data-list-item-id^="chat-messages"]') ?? row.querySelector('[class*="message_"]');
        if (!surface) return { ...parsed, message, inputs: inputs(message), entry: null };
        if (!message || ![0, 19, 20, 23].includes(message.type ?? 0)) {
            clearSurface(surface);
            return { ...parsed, message, inputs: inputs(message), entry: null };
        }
        const invoker = message.interactionMetadata?.user?.id ?? message.interaction_metadata?.user?.id ?? message.interaction?.user?.id;
        const isCommand = message.type === 20 || message.type === 23;
        const side = message.author?.id === userID || (isCommand && invoker === userID) ? "outgoing" : "incoming";
        // A reply that is only emoji, such as a Fake Nitro reaction, has no bubble either.
        const emoji = isEmojiOnly(message);
        return { ...parsed, message, inputs: inputs(message), entry: { row, surface, message, side,
            alignment: side === "outgoing" ? options.outgoingPosition : "left", emoji,
            media: emoji || hasRichContent(message, surface), date: new Date(message.timestamp), author: message.author?.id,
            timeline: row.parentElement, isReply: message.type === 19 || isCommand || Boolean(message.messageReference || message.message_reference) } };
    }
    function refresh() {
        frame = undefined;
        if (!enabled) return;
        const channelID = stores.get("SelectedChannelStore")?.getChannelId();
        const channel = stores.get("ChannelStore")?.getChannel(channelID);
        const userID = stores.get("UserStore")?.getCurrentUser()?.id;
        const channelEnabled = channel?.type === 1 ? options.dms : channel?.type === 3
            ? options.groupDms : false;
        if (!channelEnabled || !userID) {
            // Servers and disabled chats draw nothing. Clear once, then stop
            // watching every class change in Discord until a chat needs
            // bubbles again (a store change brings this refresh back).
            stopObserving?.(); stopObserving = undefined;
            if (drawn) { drawn = false; clearBubbles(); }
            return;
        }
        drawn = true;
        observeTimeline();
        const nextContext = `${channelID}:${channel.type}:${userID}`;
        if (context !== nextContext) { context = nextContext; fullRefresh = structureChanged = true; }
        const now = Date.now();
        if (!timeContext || now - timeCheckedAt >= 30000) {
            timeCheckedAt = now;
            const format = Intl.DateTimeFormat().resolvedOptions();
            const nextTimeContext = `${format.locale}:${format.timeZone}`;
            if (timeContext !== nextTimeContext) {
                timeContext = nextTimeContext; timeCache = new WeakMap(); fullRefresh = true;
                // The same output as toLocaleTimeString/toLocaleString, without
                // building a formatter for every timestamp.
                timeFormat = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
                titleFormat = new Intl.DateTimeFormat([], { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
            }
        }
        const nextColors = `${options.incomingColor}:${options.outgoingColor}:${options.incomingTextColor}:${options.outgoingTextColor}`;
        if (colorKey !== nextColors) { colorKey = nextColors; textColors = textColorsFor(options); }
        const hadStructureChange = fullRefresh || structureChanged;
        if (hadStructureChange) {
            // The card uses the media gutter, so it doesn't jump sideways when the upload lands.
            document.querySelectorAll(uploaderSelector).forEach(node => {
                setAttribute(node, "data-lowcord-uploader", options.outgoingPosition);
                setAttribute(node, "data-lowcord-style", options.style);
            });
            const previous = orderedRows;
            orderedRows = [...document.querySelectorAll('[id^="chat-messages-"]')];
            const present = new Set(orderedRows);
            for (let i = 0; i < previous.length; i++) {
                const row = previous[i];
                if (!present.has(row)) {
                    const surface = renderedRows.get(row)?.entry?.surface;
                    if (row.isConnected && surface) clearSurface(surface);
                    renderedRows.delete(row); dirtyRows.delete(row);
                }
            }
            // Reordering/removal can change both sides of a group boundary.
            const previousIndex = new Map();
            for (let i = 0; i < previous.length; i++) previousIndex.set(previous[i], i);
            for (let i = 0; i < orderedRows.length; i++) {
                const row = orderedRows[i];
                const old = previousIndex.get(row);
                if (fullRefresh || old === undefined || previous[old - 1] !== orderedRows[i - 1] || previous[old + 1] !== orderedRows[i + 1]) dirtyRows.add(row);
            }
        }
        if (storeChanged && !fullRefresh) {
            for (let i = 0; i < orderedRows.length; i++) {
                const row = orderedRows[i];
                const cached = renderedRows.get(row);
                const parsed = parseRowId(row, cached);
                const message = parsed.rowChannelID === channelID ? rowMessage(row, channelID, parsed.rowMessageID) : null;
                if (!cached || !inputsMatch(cached.inputs, message)) dirtyRows.add(row);
            }
        }
        const directlyChanged = new Set(), neighbors = new Set();
        for (let i = 0; i < orderedRows.length; i++) {
            const row = orderedRows[i];
            if (!dirtyRows.has(row) && renderedRows.has(row)) continue;
            renderedRows.set(row, readRow(row, channelID, userID));
            directlyChanged.add(row);
            if (i > 0) neighbors.add(orderedRows[i - 1]);
            if (i + 1 < orderedRows.length) neighbors.add(orderedRows[i + 1]);
        }
        const changed = new Set(directlyChanged);
        const work = [];
        if (directlyChanged.size) {
            const entries = new Array(orderedRows.length);
            for (let i = 0; i < orderedRows.length; i++) entries[i] = renderedRows.get(orderedRows[i])?.entry ?? null;
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                if (!entry) continue;
                const direct = directlyChanged.has(entry.row);
                if (!direct && !neighbors.has(entry.row)) continue;
                const nextContinuation = joins(entries[i - 1], entry);
                const nextLast = !joins(entry, entries[i + 1]);
                if (!direct && entry.continuation === nextContinuation && entry.last === nextLast) continue;
                entry.continuation = nextContinuation;
                entry.last = nextLast;
                changed.add(entry.row);
                work.push(entry);
            }
        }
        if (work.length) {
            // Every write that shapes a row comes first, then every measurement in
            // one layout, then the writes that depend on it. Each read between
            // writes would lay out the whole new channel again.
            const bubbles = [], mediaEntries = [];
            for (let i = 0; i < work.length; i++) {
                const entry = work[i];
                apply(entry, channel);
                if (entry.media) mediaEntries.push({ surface: entry.surface, right: entry.side === "outgoing" && entry.alignment === "right" });
                else {
                    bubbles.push(entry);
                    entry.surface.removeAttribute("data-lowcord-fit");
                }
            }
            const seenMedia = new Set();
            const items = mediaEntries.length ? markAccessories(mediaEntries, seenMedia) : [];
            const widths = new Array(work.length);
            for (let i = 0; i < work.length; i++) widths[i] = work[i].row.clientWidth;
            const fits = new Array(bubbles.length);
            for (let i = 0; i < bubbles.length; i++) fits[i] = wrappedWidth(bubbles[i].surface);
            const shifts = items.length ? measureAccessories(items) : [];
            const avatars = options.style === "avatars";
            const edgeOffset = 2 * (gutter + (avatars ? face : 0));
            for (let i = 0; i < work.length; i++) {
                const available = Math.max(0, widths[i] - edgeOffset);
                setProperty(work[i].surface, "--lowcord-reply-max-width", `${Math.floor(Math.min(360, available))}px`);
            }
            for (let i = 0; i < bubbles.length; i++) fitBubble(bubbles[i].surface, fits[i]);
            for (let i = 0; i < items.length; i++) setProperty(items[i].item, "--lowcord-media-shift", `${shifts[i]}px`);
            queueActions(work);
            if (observedMedia.size) {
                for (const media of observedMedia) {
                    if (!media.isConnected || (changed.has(media.closest('[id^="chat-messages-"]')) && !seenMedia.has(media))) {
                        mediaObserver.unobserve(media); observedMedia.delete(media);
                    }
                }
            }
        }
        if (hadStructureChange || work.length) {
            const timelines = new Set();
            for (let i = 0; i < orderedRows.length; i++) {
                const tl = renderedRows.get(orderedRows[i])?.entry?.timeline;
                if (tl) timelines.add(tl);
            }
            for (const timeline of resizedTimelines) if (!timelines.has(timeline)) {
                resizeObserver.unobserve(timeline); resizedTimelines.delete(timeline);
            }
            for (const timeline of timelines) if (!resizedTimelines.has(timeline)) {
                resizeObserver.observe(timeline); resizedTimelines.add(timeline);
            }
        }
        if (avatarsChanged) for (const { entry } of renderedRows.values()) {
            if (entry && !changed.has(entry.row)) setAvatar(entry.surface, entry.message, options.style === "avatars" && entry.last);
        }
        dirtyRows.clear(); fullRefresh = structureChanged = storeChanged = avatarsChanged = false;
    }

    function scheduleRefresh() {
        if (enabled && frame === undefined) frame = requestAnimationFrame(refresh);
    }

    function updateObservers() {
        stopObserving?.(); stopObserving = undefined;
        resizeObserver.disconnect();
        resizedTimelines.clear();
        for (const [store, listener] of storeListeners) store.removeChangeListener?.(listener);
        storeListeners.clear();
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        if (!enabled) { drawn = false; clearBubbles(); return; }
        for (const [name, store] of stores) {
            const listener = name === "MessageStore" ? messageChanged : name === "UserStore" ? usersChanged : invalidate;
            storeListeners.set(store, listener); store.addChangeListener?.(listener);
        }
        fullRefresh = structureChanged = true;
        scheduleRefresh();
    }

    const rowSelector = '[id^="chat-messages-"]', watchedSelector = `${rowSelector}, ${uploaderSelector}`;
    function inKnownTimeline(node) {
        for (const timeline of resizedTimelines) if (timeline.contains(node)) return true;
        return false;
    }
    function allNodesMatch(list, selector) {
        for (let i = 0; i < list.length; i++) {
            const node = list[i];
            if (!(node instanceof Element) || !node.matches(selector)) return false;
        }
        return true;
    }
    function markChildRows(list) {
        let hit = false;
        for (let i = 0; i < list.length; i++) {
            const node = list[i];
            if (!(node instanceof Element)) continue;
            if (node.matches(rowSelector)) { dirtyRows.add(node); hit = true; }
            if (node.childElementCount > 0) {
                const nested = node.querySelectorAll(rowSelector);
                if (nested.length) {
                    for (let j = 0; j < nested.length; j++) dirtyRows.add(nested[j]);
                    hit = true;
                }
            }
        }
        return hit;
    }
    function hasMatchingNode(list, selector) {
        for (let i = 0; i < list.length; i++) {
            const node = list[i];
            if (node instanceof Element && (node.matches(selector) || (node.childElementCount > 0 && node.querySelector(selector)))) return true;
        }
        return false;
    }
    function observeTimeline() {
        if (stopObserving || !document.body) return;
        // Discord virtualizes the timeline. MutationObserver already
        // batches each DOM commit and runs before paint. Deferring again
        // to rAF lets rows committed during a frame paint once without
        // their bubble (including pending -> confirmed replacements).
        // Subscribing can hand over records queued before it; the full
        // refresh that subscribes reads every row anyway.
        let ready = false;
        stopObserving = Lowcord.onDomMutation(records => {
            if (!ready) return;
            // The app shell, member list, composer and settings animate
            // independently. Only timeline changes need a message scan.
            let relevant = false;
            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                if (!target) continue;
                if (record.type === "attributes") {
                    const attr = record.attributeName;
                    if (attr === "class") {
                        // Fast pointer-chain check skips all app-shell class
                        // churn (member list, sidebar, tooltips) without CSS matching.
                        if (resizedTimelines.size > 0 && !inKnownTimeline(target)) continue;
                        const watched = target.closest(watchedSelector);
                        if (!watched) continue;
                        // Toggling hover/selected/replying/mentioned classes on
                        // the message surface itself never alters bubble layout.
                        if (target.hasAttribute("data-lowcord-cluster")) continue;
                        if (target.closest('.lowcord-bubble-time, .lowcord-bubble-avatar') || target.closest(actionsSelector)) continue;
                        const row = watched.matches(rowSelector) ? watched : target.closest(rowSelector);
                        if (row) {
                            const cls = typeof target.className === "string" ? target.className : "";
                            if (renderedRows.get(row)?.entry?.media || richClassPattern.test(cls)) {
                                dirtyRows.add(row); relevant = true;
                            }
                        } else {
                            structureChanged = true; relevant = true;
                        }
                        continue;
                    }
                    if (attr === "src") {
                        if (resizedTimelines.size > 0 && !inKnownTimeline(target)) continue;
                        if (target instanceof HTMLImageElement && isChromeImage(target)) continue;
                        if (target.closest('.lowcord-bubble-time, .lowcord-bubble-avatar') || target.closest(actionsSelector)) continue;
                        const row = target.closest(rowSelector);
                        if (row) { dirtyRows.add(row); relevant = true; }
                        else if (target.closest(uploaderSelector)) { structureChanged = true; relevant = true; }
                        continue;
                    }
                    // attr === "id"
                    if (renderedRows.has(target)) { structureChanged = true; relevant = true; }
                    const row = target.closest(rowSelector);
                    if (row) { dirtyRows.add(row); structureChanged = true; relevant = true; }
                    else if (target.closest(uploaderSelector)) { structureChanged = true; relevant = true; }
                    continue;
                }
                // childList mutation
                const added = record.addedNodes, removed = record.removedNodes;
                const hasNodes = added.length > 0 || removed.length > 0;
                if (hasNodes && allNodesMatch(added, '.lowcord-bubble-time, .lowcord-bubble-avatar')
                    && allNodesMatch(removed, '.lowcord-bubble-time, .lowcord-bubble-avatar')) continue;
                if (target.closest('.lowcord-bubble-time, .lowcord-bubble-avatar')) continue;
                // Hovering mounts Discord's toolbar; CSS alone places it.
                if (target.closest(actionsSelector) || (hasNodes && allNodesMatch(added, actionsSelector) && allNodesMatch(removed, actionsSelector))) continue;
                const row = target.closest(rowSelector);
                if (row) { dirtyRows.add(row); relevant = true; }
                if ((added.length && markChildRows(added)) || (removed.length && markChildRows(removed))) {
                    structureChanged = true; relevant = true;
                }
                if (target.closest(uploaderSelector) || (added.length && hasMatchingNode(added, uploaderSelector))
                    || (removed.length && hasMatchingNode(removed, uploaderSelector))) {
                    structureChanged = true; relevant = true;
                }
            }
            if (relevant) {
                if (frame !== undefined) cancelAnimationFrame(frame);
                refresh();
            }
        });
        ready = true;
    }

    function setEnabled(value) {
        const next = Boolean(value);
        try { storage.setItem(storageKey, String(next)); }
        catch { throw new Error("Couldn't save this setting. Try again."); }
        enabled = next;
        updateObservers();
        window.dispatchEvent(new Event(changeEvent));
    }

    function setOptions(value) {
        const next = normalizeOptions({ ...options, ...value });
        try { storage.setItem(optionsKey, JSON.stringify(next)); }
        catch { throw new Error("Couldn't save this setting. Try again."); }
        options = next;
        invalidate();
        window.dispatchEvent(new Event(changeEvent));
    }

    function ChatAppearanceSettings() {
        const { React } = Lowcord;
        const h = React.createElement;
        const [state, setState] = React.useState(() => ({ enabled, ...options }));
        const [error, setError] = React.useState("");
        // A theme can color the bubbles instead of the colors chosen here.
        const themes = window.__lowcordThemes;
        const themeState = () => {
            const current = themes?.state;
            const theme = current?.bubbles ? themes.catalog.find(entry => entry.id === current.id) ?? null : null;
            return theme;
        };
        const [theme, setTheme] = React.useState(themeState);
        React.useEffect(() => {
            const update = () => setState({ enabled, ...options });
            const updateTheme = () => setTheme(themeState());
            window.addEventListener(changeEvent, update);
            if (themes) window.addEventListener(themes.changeEvent, updateTheme);
            return () => {
                window.removeEventListener(changeEvent, update);
                if (themes) window.removeEventListener(themes.changeEvent, updateTheme);
            };
        }, []);
        const save = callback => { try { callback(); setError(""); } catch (failure) { setError(failure.message); } };
        const toggle = (title, description, checked, onChange) => h("label", { className: "lowcord-chat-toggle" },
            h("span", null, h("strong", null, title), h("span", { className: "lowcord-chat-description" }, description)),
            h("input", { type: "checkbox", role: "switch", checked, onChange: event => save(() => onChange(event.target.checked)) }));
        // The colors on screen: the theme's while it colors the bubbles. The
        // first edit takes them over as the user's own, so nothing jumps.
        const colors = theme ? theme.bubbles : state;
        const ink = { outgoing: colors.outgoingTextColor ?? foreground(colors.outgoingColor),
            incoming: colors.incomingTextColor ?? foreground(colors.incomingColor) };
        const setColors = value => save(() => {
            setOptions(theme ? { ...theme.bubbles, ...value } : value);
            if (theme) themes.set({ bubbles: false });
        });
        const swatch = (key, label, value) => h("span", { className: "lowcord-color-swatch", style: { "--lowcord-swatch": value } },
            h("input", { type: "color", value, "aria-label": label, onChange: event => setColors({ [key]: event.target.value }) }));
        const colorCard = (side, title) => {
            const bubbleKey = `${side}Color`, textKey = `${side}TextColor`, auto = colors[textKey] == null;
            return h("div", { className: "lowcord-color-card" },
                h("div", { className: "lowcord-color-card-header" }, h("strong", null, title),
                    h("span", { className: "lowcord-color-sample", "aria-hidden": true,
                        style: { background: colors[bubbleKey], color: ink[side] } }, "Aa")),
                h("div", { className: "lowcord-color-row" }, h("span", { className: "lowcord-color-label" }, "Bubble"),
                    swatch(bubbleKey, `${title} bubble color`, colors[bubbleKey]), h("code", null, colors[bubbleKey].toUpperCase())),
                h("div", { className: "lowcord-color-row" }, h("span", { className: "lowcord-color-label" }, "Text"),
                    swatch(textKey, `${title} text color`, ink[side]), h("code", null, ink[side].toUpperCase()),
                    auto ? h("span", { className: "lowcord-color-auto" }, "Auto")
                        : h("button", { type: "button", className: "lowcord-color-auto", "aria-label": `Use automatic text color for ${title.toLowerCase()}`,
                            onClick: () => setColors({ [textKey]: null }) }, "Auto")));
        };
        const avatars = state.enabled && state.style === "avatars";
        const example = (side, name, texts, time, quote) => h("div", { className: `lowcord-preview-group ${side}` },
            state.enabled && quote ? h("div", { className: "lowcord-preview-quote" },
                h("strong", null, "Alex"), h("span", null, quote)) : null,
            ...texts.map((text, index) => h("div", { key: index, className: "lowcord-chat-example",
                "data-cluster": texts.length === 1 ? "solo" : index === 0 ? "start" : index === texts.length - 1 ? "end" : "middle" },
                avatars && index === texts.length - 1 ? h("span", { className: "lowcord-preview-avatar", "aria-hidden": true }, name[0]) : null,
                state.enabled ? null : h("span", null, `${name}${state.timestamps ? " · " + time : ""}`),
                h("p", null, text))),
            state.enabled && state.timestamps ? h("time", { className: "lowcord-bubble-time" }, time) : null);
        return h("section", { className: "lowcord-chat-appearance" },
            h("p", { className: "lowcord-chat-intro" }, "Choose how messages look in OrbitCord."),
            toggle("Chat bubbles", "Show messages in bubbles and align photos and videos with them.", state.enabled, setEnabled),
            h("fieldset", { className: "lowcord-appearance-controls", disabled: !state.enabled },
                h("legend", null, "Bubble style"),
                h("div", { className: "lowcord-style-options" },
                    ...[["bubbles", "Bubbles", "Hide profile pictures"], ["avatars", "With avatars", "Show a profile picture beside each message group"]]
                        .map(([value, title, description]) =>
                        h("label", { key: value, className: "lowcord-style-option", "data-selected": String(state.style === value) },
                            h("input", { type: "radio", name: "lowcord-bubble-style", value, checked: state.style === value,
                                onChange: () => save(() => setOptions({ style: value })) }),
                            h("span", null, h("strong", null, title), h("span", { className: "lowcord-chat-description" }, description))))),
                h("label", { className: "lowcord-position-control" },
                    h("span", null, h("strong", null, "Bubble side"),
                        h("span", { className: "lowcord-chat-description" }, "Choose a side for your messages. Received messages stay on the left.")),
                    h("select", { value: state.outgoingPosition, "aria-label": "Bubble side", onChange: event => save(() => setOptions({ outgoingPosition: event.target.value })) },
                        h("option", { value: "right" }, "Right"), h("option", { value: "left" }, "Left"))),
                h("div", { className: "lowcord-chat-preview", "data-bubbles": String(state.enabled), "data-style": state.style,
                    "data-outgoing-position": state.outgoingPosition,
                    style: { "--lowcord-outgoing-color": colors.outgoingColor, "--lowcord-outgoing-text": ink.outgoing,
                        "--lowcord-incoming-color": colors.incomingColor, "--lowcord-incoming-text": ink.incoming },
                    "aria-label": "Message layout preview" },
                    example("incoming", "Alex", ["Hey! How's your day going?"], "10:41 AM"),
                    example("outgoing", "You", ["Pretty good!", "What about you?"], "10:42 AM", "Hey! How's your day going?")),
                h("div", { className: "lowcord-actions-setting", role: "radiogroup", "aria-labelledby": "lowcord-actions-title",
                    style: { "--lowcord-outgoing-color": colors.outgoingColor, "--lowcord-incoming-color": colors.incomingColor } },
                    h("span", null, h("strong", { id: "lowcord-actions-title" }, "Message actions"),
                        h("span", { className: "lowcord-chat-description" }, "Choose where message actions appear when you hover over a message.")),
                    h("div", { className: "lowcord-actions-options" },
                        ...[["edge", "Chat edge", "At the edge of the chat"], ["beside", "Beside", "Next to each message"],
                            ["corner", "Top corner", "Above the message corner"], ["react", "Reactions only", "Right-click for other actions"]]
                            .map(([value, title, description]) =>
                            h("label", { key: value, className: "lowcord-actions-option", "data-selected": String(state.actions === value) },
                                h("span", { className: "lowcord-actions-thumb", "data-actions": value, "aria-hidden": true },
                                    h("span", { className: "lowcord-thumb-bubble incoming" }),
                                    h("span", { className: "lowcord-thumb-bubble outgoing" }),
                                    h("span", { className: "lowcord-thumb-bar" }, h("i"), h("i"), h("i"))),
                                h("span", { className: "lowcord-actions-label" },
                                    h("input", { type: "radio", name: "lowcord-actions", value, checked: state.actions === value,
                                        onChange: () => save(() => setOptions({ actions: value })) }),
                                    h("span", null, h("strong", null, title), h("span", { className: "lowcord-chat-description" }, description))))))),
                h("div", { className: "lowcord-color-settings" },
                    h("div", { className: "lowcord-color-heading" },
                        h("span", null, h("strong", null, "Colors"), h("span", { className: "lowcord-chat-description" }, theme
                            ? `Using colors from ${theme.name}. Change a color to override the theme.`
                            : "OrbitCord picks a readable text color unless you choose one.")),
                        h("button", { type: "button", onClick: () => setColors({ outgoingColor: defaults.outgoingColor, incomingColor: defaults.incomingColor,
                            outgoingTextColor: null, incomingTextColor: null }) }, "Reset colors")),
                    h("div", { className: "lowcord-color-cards" }, colorCard("outgoing", "Your messages"), colorCard("incoming", "Received messages"))),
                toggle("Show timestamps", "Show the time under the last message of each group.", state.timestamps, value => setOptions({ timestamps: value })),
                h("div", { className: "lowcord-channel-settings" },
                    h("h3", null, "Where to use bubbles"),
                    toggle("Direct messages", "One-to-one conversations.", state.dms, value => setOptions({ dms: value })),
                    toggle("Group messages", "Keep sender names visible in group DMs.", state.groupDms, value => setOptions({ groupDms: value })))),
            error ? h("p", { role: "alert" }, error) : null);
    }
    ChatAppearanceSettings.displayName = "Chat Appearance";
    window.__lowcordChatAppearance = { get enabled() { return enabled; }, setEnabled, get options() { return { ...options }; }, setOptions,
        SettingsPanel: ChatAppearanceSettings };
    window.addEventListener("resize", invalidate);
    window.addEventListener("languagechange", checkTimeContext);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) timeCheckedAt = 0; });
    window.addEventListener("storage", event => {
        if (event.storageArea !== storage || (event.key !== storageKey && event.key !== optionsKey && event.key !== null)) return;
        enabled = storage.getItem(storageKey) !== "false";
        options = readOptions();
        updateObservers();
        window.dispatchEvent(new Event(changeEvent));
    });
    for (const name of ["SelectedChannelStore", "ChannelStore", "UserStore", "MessageStore"]) {
        Lowcord.waitForStore(name, store => {
            stores.set(name, store);
            updateObservers();
        });
    }
    function mount() {
        const style = document.createElement("style");
        style.id = "lowcord-chat-appearance-css";
        style.textContent = chatAppearanceCSS;
        document.head.append(style);
        updateObservers();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
}
