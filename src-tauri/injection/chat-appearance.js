// Local appearance settings for the bundled web client. Message data and
// interaction handlers remain owned by Discord; only existing rows are styled.
function setupLowcordChatAppearance() {
    if (window.__lowcordChatAppearance) return;
    const storageKey = "lowcord.dmChatBubbles";
    // Discord removes window.localStorage during startup; Lowcord keeps the
    // original Storage object from before that happens.
    const storage = Lowcord.storage;
    const optionsKey = "lowcord.dmChatAppearance";
    const defaults = { style: "bubbles", outgoingPosition: "right", timestamps: true, outgoingColor: "#006be6", incomingColor: "#3a3a3c",
        dms: true, groupDms: true };
    // Matches the CSS: 16px gutter, plus a 28px face and 8px gap in avatar style.
    const gutter = 16, face = 36;
    function normalizeOptions(value) {
        const color = (key) => /^#[0-9a-f]{6}$/i.test(value?.[key]) ? value[key].toLowerCase() : defaults[key];
        // The retired Classic and iMessage styles both become plain bubbles.
        return { style: value?.style === "avatars" ? "avatars" : "bubbles",
            outgoingPosition: ["left", "right"].includes(value?.outgoingPosition) ? value.outgoingPosition : defaults.outgoingPosition,
            timestamps: typeof value?.timestamps === "boolean" ? value.timestamps : defaults.timestamps,
            outgoingColor: color("outgoingColor"), incomingColor: color("incomingColor"),
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
        "data-lowcord-cluster", "data-lowcord-emoji", "data-lowcord-style", "data-lowcord-actions", "data-lowcord-timed", "data-lowcord-caption"];
    const properties = ["--lowcord-bubble-color", "--lowcord-bubble-text", "--lowcord-reply-max-width", "--lowcord-actions-max-width",
        "--lowcord-actions-inset", "--lowcord-actions-top", "--lowcord-actions-bridge-height"];
    const stores = new Map();
    // The pending nonce leaves MessageStore before React replaces its row.
    // Keep that row's last message until the DOM identity changes. Weak keys
    // let virtualized/unmounted rows and their message data be collected.
    const rowMessages = new WeakMap();
    const renderedRows = new Map(), dirtyRows = new Set();
    let orderedRows = [], fullRefresh = true, structureChanged = true, storeChanged = false;
    let context, timeCache = new WeakMap(), timeContext;
    let colorKey, textColors;
    function invalidate() { fullRefresh = true; structureChanged = true; scheduleRefresh(); }
    function messageChanged() { storeChanged = true; scheduleRefresh(); }
    const storeListeners = new Map();
    let enabled = true;
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
        document.querySelectorAll("[data-lowcord-uploader]").forEach(node => node.removeAttribute("data-lowcord-uploader"));
        resizeObserver.disconnect();
        resizedTimelines.clear();
        mediaObserver.disconnect();
        observedMedia.clear();
        renderedRows.clear(); orderedRows = []; dirtyRows.clear(); context = undefined;
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

    function hasRichContent(message, surface) {
        // Discord's store uses camelCase; pending messages and wire payloads
        // can still use snake_case. Forwarded text also has a message snapshot.
        if (["attachments", "embeds", "stickerItems", "sticker_items", "stickers", "components",
            "messageSnapshots", "message_snapshots"].some(key => message[key]?.length)
            || message.messageReference?.type === 1 || message.message_reference?.type === 1
            || message.poll) return true;
        // Upload placeholders and asynchronously resolved embeds can appear
        // before MessageStore receives their attachment data. Inspect only the
        // message body, never reply thumbnails, author avatars or action icons.
        const richContent = '[class*="attachment_"], [class*="attachmentContent_"], [class*="upload_"], '
            + '[class*="uploadProgress_"], [class*="imageWrapper_"], [class*="visualMediaItemContainer_"], '
            + '[class*="mosaicItem_"], [class*="embed_"], [class*="embedFull_"], [class*="sticker_"], '
            + '[class*="messageSnapshot_"], [class*="forwardedMessage_"], .lowcord-music-embeds, .lowcord-social-embeds, video, audio';
        return Array.from(surface.children)
            .filter(body => !body.matches('[class*="repliedMessage_"], [class*="buttonContainer_"], [class*="buttons_"], '
                + '.lowcord-bubble-avatar, .lowcord-bubble-time'))
            .some(body => body.matches(richContent) || body.querySelector(richContent)
                || Array.from(body.querySelectorAll("img")).some(img => !isChromeImage(img)));
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

    function setAvatar(surface, message, show) {
        let avatar = surface.querySelector(":scope > .lowcord-bubble-avatar");
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
        let time = surface.querySelector(":scope > .lowcord-bubble-time");
        if (!show) {
            time?.remove();
            surface.removeAttribute("data-lowcord-timed");
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
            formatted = { value: date.getTime(), text: date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
                iso: date.toISOString(), title: date.toLocaleString() };
            timeCache.set(surface, formatted);
        }
        const text = formatted.text;
        if (time.textContent !== text) time.textContent = text;
        setAttribute(time, "datetime", formatted.iso);
        setAttribute(time, "title", formatted.title);
        setAttribute(surface, "data-lowcord-timed", "true");
    }

    // Discord's attachment grid. The fixture nests it inside contents_.
    const accessoriesSelector = ':scope > [id^="message-accessories-"], '
        + ':scope > .lowcord-music-embeds, :scope > .lowcord-social-embeds, '
        + ':scope > [class*="container_"]:not([class*="buttonContainer_"]), '
        + ':scope > [class*="contents_"] > [class*="container_"]:not([class*="buttonContainer_"])';
    const mediaSelector = 'img, video, canvas, iframe[data-lowcord-music-player], .lowcord-social-card, [class*="mosaicItem_"], [class*="imageWrapper_"], [class*="embedFull_"], '
        + '[class*="attachment_"], [class*="upload_"], [class*="messageSnapshot_"], [class*="sticker_"]';

    // Discord sizes attachments against a full-width grid, so outgoing media is
    // translated as a whole by the empty space right of each item's content.
    // Reactions wrap in a flex row and are right-justified by CSS instead.
    function alignAccessories(surface, right, seenMedia) {
        for (const box of surface.querySelectorAll(accessoriesSelector)) {
            const boxBounds = box.getBoundingClientRect();
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
                const shift = Number.isFinite(contentRight) ? Math.max(0, Math.round(boxBounds.right - (contentRight - current))) : 0;
                setProperty(item, "--lowcord-media-shift", `${shift}px`);
            }
        }
    }

    // Toolbar placement beside a bubble. Discord hides it and makes it
    // click-through as soon as the pointer leaves the message, so the gap
    // beside the bubble needs a hover target.
    function placeActions(surface, row, alignment) {
        const actions = surface.querySelector(':scope > [class*="buttonContainer_"], :scope > [class*="buttons_"]');
        if (!actions) {
            surface.removeAttribute("data-lowcord-actions");
            for (const name of ["--lowcord-actions-inset", "--lowcord-actions-top", "--lowcord-actions-bridge-height"]) surface.style.removeProperty(name);
            return;
        }
        const bubbleBounds = surface.getBoundingClientRect();
        const rowBounds = row.getBoundingClientRect();
        const freeSpace = alignment === "left" ? rowBounds.right - bubbleBounds.right : bubbleBounds.left - rowBounds.left;
        // Align the visible bar, rather than its often padded outer container.
        // Plugin buttons can change both its width and height.
        const barBounds = (actions.querySelector('[class*="buttonsInner_"]') ?? actions).getBoundingClientRect();
        const actionBounds = actions.getBoundingClientRect();
        const outside = barBounds.width > 0 && freeSpace >= barBounds.width + 12;
        const offset = alignment === "left" ? barBounds.left - actionBounds.left : actionBounds.right - barBounds.right;
        setProperty(surface, "--lowcord-actions-inset", `${(outside ? bubbleBounds.width + 6 : 4) - offset}px`);
        const top = Math.max(0, (bubbleBounds.height - barBounds.height) / 2) - (barBounds.top - actionBounds.top);
        setProperty(surface, "--lowcord-actions-top", `${top}px`);
        setAttribute(surface, "data-lowcord-actions", outside ? "outside" : "inside");
        setProperty(surface, "--lowcord-actions-bridge-height", `${Math.max(bubbleBounds.height, barBounds.height)}px`);
    }

    function apply(entry, channel) {
        const { row, surface, message, side, alignment, media } = entry;
        const avatars = options.style === "avatars";
        if (media) {
            surface.removeAttribute(marker);
            surface.removeAttribute("data-lowcord-actions");
            setAttribute(surface, "data-lowcord-media", side);
            setAttribute(surface, "data-lowcord-emoji", String(Boolean(entry.emoji)));
        } else {
            surface.removeAttribute("data-lowcord-media");
            surface.removeAttribute("data-lowcord-emoji");
            surface.removeAttribute("data-lowcord-caption");
            clearAccessories(surface);
            setAttribute(surface, marker, side);
        }
        setAttribute(surface, "data-lowcord-align", alignment);
        setAttribute(surface, "data-lowcord-style", options.style);
        setAttribute(surface, "data-lowcord-show-author", String(channel.type !== 1));
        setAttribute(surface, "data-lowcord-continuation", String(entry.continuation));
        setAttribute(surface, "data-lowcord-cluster", clusterRole(entry.continuation, entry.last));
        const color = side === "outgoing" ? options.outgoingColor : options.incomingColor;
        setProperty(surface, "--lowcord-bubble-color", color);
        setProperty(surface, "--lowcord-bubble-text", textColors[side]);
        setAvatar(surface, message, avatars && entry.last);
        setTime(surface, entry.date, options.timestamps && entry.last && !Number.isNaN(entry.date.getTime()));
        const available = Math.max(0, entry.width - 2 * (gutter + (avatars ? face : 0)));
        setProperty(surface, "--lowcord-reply-max-width", `${Math.floor(Math.min(360, available))}px`);
        setProperty(surface, "--lowcord-actions-max-width", `${Math.floor(available)}px`);
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
    function inputs(message) {
        if (!message) return null;
        return [message.author?.id, message.author?.avatar, message.type, String(message.timestamp), message.content, message.flags,
            message.interactionMetadata?.user?.id, message.interaction_metadata?.user?.id, message.interaction?.user?.id,
            message.messageReference, message.messageReference?.type, message.message_reference, message.message_reference?.type, message.poll,
            ...["attachments", "embeds", "stickerItems", "sticker_items", "stickers", "components",
                "messageSnapshots", "message_snapshots"].flatMap(key => [message[key], message[key]?.length])];
    }
    function sameInputs(a, b) { return a === b || Boolean(a && b && a.length === b.length && a.every((value, i) => value === b[i])); }
    function readRow(row, channelID, userID) {
        const match = /^chat-messages-(\d+)-(.+)$/.exec(row.id);
        const message = match?.[1] === channelID ? rowMessage(row, channelID, match[2]) : null;
        const surface = row.querySelector('[data-list-item-id^="chat-messages"]') ?? row.querySelector('[class*="message_"]');
        if (!surface) return { message, inputs: inputs(message), entry: null };
        if (!message || ![0, 19, 20, 23].includes(message.type ?? 0)) {
            clearSurface(surface);
            return { message, inputs: inputs(message), entry: null };
        }
        const invoker = message.interactionMetadata?.user?.id ?? message.interaction_metadata?.user?.id ?? message.interaction?.user?.id;
        const isCommand = message.type === 20 || message.type === 23;
        const side = message.author?.id === userID || (isCommand && invoker === userID) ? "outgoing" : "incoming";
        const emoji = isEmojiOnly(message) && !message.messageReference && !message.message_reference;
        return { message, inputs: inputs(message), entry: { row, surface, message, side,
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
        if (!channelEnabled || !userID) { clearBubbles(); return; }
        const nextContext = `${channelID}:${channel.type}:${userID}`;
        if (context !== nextContext) { context = nextContext; fullRefresh = structureChanged = true; }
        const format = Intl.DateTimeFormat().resolvedOptions();
        const nextTimeContext = `${format.locale}:${format.timeZone}`;
        if (timeContext !== nextTimeContext) { timeContext = nextTimeContext; timeCache = new WeakMap(); fullRefresh = true; }
        const nextColors = `${options.incomingColor}:${options.outgoingColor}`;
        if (colorKey !== nextColors) { colorKey = nextColors; textColors = { incoming: foreground(options.incomingColor), outgoing: foreground(options.outgoingColor) }; }
        if (fullRefresh || structureChanged) {
            document.querySelectorAll(uploaderSelector).forEach(node => setAttribute(node, "data-lowcord-uploader", options.outgoingPosition));
            const previous = orderedRows;
            orderedRows = [...document.querySelectorAll('[id^="chat-messages-"]')];
            const present = new Set(orderedRows);
            for (const row of previous) if (!present.has(row)) {
                const surface = renderedRows.get(row)?.entry?.surface;
                if (row.isConnected && surface) clearSurface(surface);
                renderedRows.delete(row); dirtyRows.delete(row);
            }
            // Reordering/removal can change both sides of a group boundary.
            const previousIndex = new Map(previous.map((row, i) => [row, i]));
            orderedRows.forEach((row, i) => {
                const old = previousIndex.get(row);
                if (fullRefresh || old === undefined || previous[old - 1] !== orderedRows[i - 1] || previous[old + 1] !== orderedRows[i + 1]) dirtyRows.add(row);
            });
        }
        if (storeChanged && !fullRefresh) for (const row of orderedRows) {
            const match = /^chat-messages-(\d+)-(.+)$/.exec(row.id);
            const message = match?.[1] === channelID ? rowMessage(row, channelID, match[2]) : null;
            if (!sameInputs(renderedRows.get(row)?.inputs, inputs(message))) dirtyRows.add(row);
        }
        const changed = new Set();
        orderedRows.forEach((row, i) => {
            if (!dirtyRows.has(row) && renderedRows.has(row)) return;
            renderedRows.set(row, readRow(row, channelID, userID));
            changed.add(row);
            if (orderedRows[i - 1]) changed.add(orderedRows[i - 1]);
            if (orderedRows[i + 1]) changed.add(orderedRows[i + 1]);
        });
        const entries = orderedRows.map(row => renderedRows.get(row)?.entry ?? null);
        const work = [];
        entries.forEach((entry, i) => {
            if (!entry || !changed.has(entry.row)) return;
            entry.continuation = joins(entries[i - 1], entry);
            entry.last = !joins(entry, entries[i + 1]);
            work.push(entry);
        });
        // Read widths before writing padding, colors, avatars and timestamps.
        for (const entry of work) entry.width = entry.row.clientWidth;
        for (const entry of work) apply(entry, channel);
        for (const entry of work) if (!entry.media) placeActions(entry.surface, entry.row, entry.alignment);
        const seenMedia = new Set();
        for (const entry of work) if (entry.media) alignAccessories(entry.surface, entry.side === "outgoing" && entry.alignment === "right", seenMedia);
        for (const media of observedMedia) {
            if (!media.isConnected || (changed.has(media.closest('[id^="chat-messages-"]')) && !seenMedia.has(media))) {
                mediaObserver.unobserve(media); observedMedia.delete(media);
            }
        }
        const timelines = new Set(entries.filter(Boolean).map(entry => entry.timeline));
        for (const timeline of resizedTimelines) if (!timelines.has(timeline)) {
            resizeObserver.unobserve(timeline); resizedTimelines.delete(timeline);
        }
        for (const timeline of timelines) if (timeline && !resizedTimelines.has(timeline)) {
            resizeObserver.observe(timeline); resizedTimelines.add(timeline);
        }
        dirtyRows.clear(); fullRefresh = structureChanged = storeChanged = false;
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
        if (!enabled) { clearBubbles(); return; }
        for (const [name, store] of stores) {
            const listener = name === "MessageStore" ? messageChanged : invalidate;
            storeListeners.set(store, listener); store.addChangeListener?.(listener);
        }
        fullRefresh = structureChanged = true;
        if (document.body) {
            // Discord virtualizes the timeline. MutationObserver already
            // batches each DOM commit and runs before paint. Deferring again
            // to rAF lets rows committed during a frame paint once without
            // their bubble (including pending -> confirmed replacements).
            stopObserving = Lowcord.onDomMutation(records => {
                // The app shell, member list, composer and settings animate
                // independently. Only timeline changes need a message scan.
                let relevant = false;
                const selector = '[id^="chat-messages-"]';
                for (const record of records) {
                    const target = record.target instanceof Element ? record.target : record.target.parentElement;
                    const row = target?.closest(selector);
                    const nodes = [...record.addedNodes, ...record.removedNodes];
                    if (record.type === "childList" && nodes.length && nodes.every(node => node instanceof Element &&
                        node.matches('.lowcord-bubble-time, .lowcord-bubble-avatar'))) continue;
                    if (target?.closest('.lowcord-bubble-time, .lowcord-bubble-avatar')) continue;
                    if (row) { dirtyRows.add(row); relevant = true; }
                    if (record.attributeName === "id" && row) structureChanged = true;
                    if (record.attributeName === "id" && renderedRows.has(target)) { structureChanged = true; relevant = true; }
                    for (const node of nodes) if (node instanceof Element &&
                        (node.matches(selector) || node.querySelector(selector))) {
                        if (node.matches(selector)) dirtyRows.add(node);
                        node.querySelectorAll(selector).forEach(row => dirtyRows.add(row));
                        structureChanged = true; relevant = true;
                    }
                    if (target?.closest(uploaderSelector) || nodes.some(node => node instanceof Element &&
                        (node.matches(uploaderSelector) || node.querySelector(uploaderSelector)))) { structureChanged = true; relevant = true; }
                }
                if (relevant) {
                    if (frame !== undefined) cancelAnimationFrame(frame);
                    refresh();
                }
            });
        }
        scheduleRefresh();
    }

    function setEnabled(value) {
        const next = Boolean(value);
        try { storage.setItem(storageKey, String(next)); }
        catch { throw new Error("Couldn’t save this setting. Please try again."); }
        enabled = next;
        updateObservers();
        window.dispatchEvent(new Event(changeEvent));
    }

    function setOptions(value) {
        const next = normalizeOptions({ ...options, ...value });
        try { storage.setItem(optionsKey, JSON.stringify(next)); }
        catch { throw new Error("Couldn’t save this setting. Please try again."); }
        options = next;
        invalidate();
        window.dispatchEvent(new Event(changeEvent));
    }

    function ChatAppearanceSettings() {
        const { React } = Lowcord;
        const h = React.createElement;
        const [state, setState] = React.useState(() => ({ enabled, ...options }));
        const [error, setError] = React.useState("");
        React.useEffect(() => {
            const update = () => setState({ enabled, ...options });
            window.addEventListener(changeEvent, update);
            return () => window.removeEventListener(changeEvent, update);
        }, []);
        const save = callback => { try { callback(); setError(""); } catch (failure) { setError(failure.message); } };
        const toggle = (title, description, checked, onChange) => h("label", { className: "lowcord-chat-toggle" },
            h("span", null, h("strong", null, title), h("span", { className: "lowcord-chat-description" }, description)),
            h("input", { type: "checkbox", role: "switch", checked, onChange: event => save(() => onChange(event.target.checked)) }));
        const colorControl = (key, title) => h("label", { className: "lowcord-color-control" }, h("span", null, title),
            h("span", { className: "lowcord-color-value" },
                h("input", { type: "color", value: state[key], "aria-label": title,
                    onChange: event => save(() => setOptions({ [key]: event.target.value })) }), h("code", null, state[key].toUpperCase())));
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
            toggle("Chat bubbles", "Show text as bubbles and line media up on the same side.", state.enabled, setEnabled),
            h("fieldset", { className: "lowcord-appearance-controls", disabled: !state.enabled },
                h("legend", null, "Bubble style"),
                h("div", { className: "lowcord-style-options" },
                    ...[["bubbles", "Bubbles", "Text only, no profile pictures"], ["avatars", "With avatars", "A profile picture beside each group"]]
                        .map(([value, title, description]) =>
                        h("label", { key: value, className: "lowcord-style-option", "data-selected": String(state.style === value) },
                            h("input", { type: "radio", name: "lowcord-bubble-style", value, checked: state.style === value,
                                onChange: () => save(() => setOptions({ style: value })) }),
                            h("span", null, h("strong", null, title), h("span", { className: "lowcord-chat-description" }, description))))),
                h("div", { className: "lowcord-chat-preview", "data-bubbles": String(state.enabled), "data-style": state.style,
                    "data-outgoing-position": state.outgoingPosition,
                    style: { "--lowcord-outgoing-color": state.outgoingColor, "--lowcord-outgoing-text": foreground(state.outgoingColor),
                        "--lowcord-incoming-color": state.incomingColor, "--lowcord-incoming-text": foreground(state.incomingColor) },
                    "aria-label": "Message layout preview" },
                    example("incoming", "Alex", ["Hey! How’s your day going?"], "10:41 AM"),
                    example("outgoing", "You", ["Pretty good!", "What about you?"], "10:42 AM", "Hey! How’s your day going?")),
                h("div", { className: "lowcord-color-settings" },
                    colorControl("outgoingColor", "Your messages"), colorControl("incomingColor", "Received messages"),
                    h("button", { type: "button", onClick: () => save(() => setOptions({ outgoingColor: defaults.outgoingColor, incomingColor: defaults.incomingColor })) }, "Reset colors")),
                toggle("Show timestamps", "Show the time under the last message of each group.", state.timestamps, value => setOptions({ timestamps: value })),
                h("div", { className: "lowcord-channel-settings" },
                    h("h3", null, "Where to use bubbles"),
                    toggle("Direct messages", "One-to-one conversations.", state.dms, value => setOptions({ dms: value })),
                    toggle("Group messages", "Keep sender names visible in group DMs.", state.groupDms, value => setOptions({ groupDms: value })))),
            h("p", { className: "lowcord-chat-description" }, "Changes apply immediately and are saved on this device."),
            error ? h("p", { role: "alert" }, error) : null);
    }
    ChatAppearanceSettings.displayName = "Chat Appearance";
    window.__lowcordChatAppearance = { get enabled() { return enabled; }, setEnabled, get options() { return { ...options }; }, setOptions,
        SettingsPanel: ChatAppearanceSettings };
    window.addEventListener("resize", invalidate);
    window.addEventListener("languagechange", invalidate);
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
