// DM quick reply: resting the pointer on a row in the Direct Messages list
// opens a small card beside it with the latest messages and a composer with
// emoji and attachments. Text sends through Discord's own send action, so it
// appears instantly; files go through Discord's uploader, like voice messages.
// One delegated pointer listener does all of the work. The card is built on
// first use and reused, and nothing runs while the pointer is elsewhere.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui } = extensions;
    const paths = {
        open: "M15 2a1 1 0 1 0 0 2h3.6l-7.3 7.3a1 1 0 0 0 1.4 1.4L20 5.4V9a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1h-6ZM5 4a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-5a1 1 0 1 0-2 0v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5a1 1 0 1 0 0-2H5Z",
        close: "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
        reply: "M10 8.5V5.2a.7.7 0 0 0-1.2-.5l-6.5 6.3a1 1 0 0 0 0 1.4l6.5 6.3a.7.7 0 0 0 1.2-.5v-3.4c4.6 0 7.9 1.3 10.3 4.4.3.4.9.1.8-.4C20.3 13.5 16.6 9.2 10 8.5Z",
        plus: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 6a1 1 0 1 0-2 0v3H8a1 1 0 1 0 0 2h3v3a1 1 0 1 0 2 0v-3h3a1 1 0 1 0 0-2h-3V8Z",
        smile: "M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22ZM6.5 13a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1 5.5 5.5 0 0 1-11 0ZM9 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm7.5-1.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z",
        clock: "M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1-17a1 1 0 1 0-2 0v6c0 .27.1.52.3.7l3.5 3.5a1 1 0 0 0 1.4-1.4L13 11.58V6Z",
        file: "M6 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V9.83a3 3 0 0 0-.88-2.12l-4.83-4.83A3 3 0 0 0 13.17 2H6Zm7 1.5V8a1 1 0 0 0 1 1h4.5L13 3.5Z",
    };
    const previewCount = 6;
    const maxFiles = 10;
    // Hover intent: a resting pointer opens the card and starts loading its
    // messages a little earlier; once one is open, moving to the next row
    // switches quickly. Leaving waits a moment so the pointer can cross the
    // gap into the card.
    const timing = { prefetch: 180, open: 420, switch: 120, close: 280, cache: 60_000 };
    const listSelector = 'ul[aria-label="Direct Messages"]';

    const store = name => window.Lowcord.store(name);
    // Discord module lookups scan its whole module cache, so a found module is
    // kept, and one that isn't loaded yet is looked for again at most every few
    // seconds rather than for every bubble.
    const lookups = new Map();
    function lookup(key, filter) {
        const entry = lookups.get(key);
        if (entry?.value) return entry.value;
        if (entry && Date.now() - entry.at < 5000) return null;
        const value = window.Lowcord.find(filter) ?? null;
        lookups.set(key, { value, at: Date.now() });
        return value;
    }
    const svg = (path, size) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("width", size); node.setAttribute("height", size);
        node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="currentColor" fill-rule="evenodd" d="${path}"/>`;
        return node;
    };
    const iconButton = (label, path, onClick, size = 20) =>
        ui("button", { type: "button", className: "lowcord-dm-icon", "aria-label": label, title: label, onClick }, svg(path, size));
    const messageActions = () => lookup("actions", window.Lowcord.filters.byProps("sendMessage", "editMessage", "getSendMessageOptionsForReply"));

    // ----- Data ---------------------------------------------------------------
    // Names as Discord's DM list shows them: your nickname for a friend first,
    // then their display name, then their username.
    function userName(user) {
        const id = user?.id;
        const resolved = id ? store("UserStore")?.getUser?.(id) ?? user : user;
        return (id && store("RelationshipStore")?.getNickname?.(id))
            || resolved?.globalName || resolved?.global_name || resolved?.username || "Unknown";
    }
    function channelInfo(channelId) {
        const channel = store("ChannelStore")?.getChannel?.(channelId);
        if (!channel) return null;
        const users = store("UserStore");
        const name = channel.name || (channel.recipients ?? []).map(id => userName(users?.getUser?.(id) ?? { id })).join(", ") || "Direct message";
        return { channel, name };
    }
    // A proxied image resized to the thumbnail, keeping Discord's signed parameters.
    function thumbnail(file) {
        const video = /^video\//.test(file.content_type ?? "");
        if (!video && !/^image\//.test(file.content_type ?? "")) return null;
        if (!file.width || !file.height) return null;
        const scale = Math.min(1, 180 / file.width, 120 / file.height);
        const width = Math.max(40, Math.round(file.width * scale)), height = Math.max(40, Math.round(file.height * scale));
        try {
            const url = new URL(file.proxy_url || file.url);
            url.searchParams.set("format", video ? "jpeg" : "webp");
            url.searchParams.set("width", width * 2); url.searchParams.set("height", height * 2);
            // Spoilers and media Discord flags as explicit stay blurred, as in the chat.
            const hidden = /^SPOILER_/.test(file.filename ?? "") || Boolean((file.flags ?? 0) & (8 | 16));
            return { src: url.href, width, height, video, hidden };
        } catch { return null; }
    }
    // Mentions and custom emoji read as text; the card is not a renderer.
    function plain(content) {
        const users = store("UserStore");
        return (content ?? "")
            .replace(/<@!?(\d+)>/g, (_, id) => `@${userName(users?.getUser?.(id) ?? { id })}`)
            .replace(/<a?(:\w+:)\d+>/g, "$1")
            .replace(/<#(\d+)>/g, (_, id) => `#${store("ChannelStore")?.getChannel?.(id)?.name ?? "channel"}`);
    }
    function normal(message) {
        const forwarded = (message.messageSnapshots ?? message.message_snapshots)?.[0]?.message;
        const source = forwarded ?? message;
        const files = source.attachments ?? [];
        const media = files.map(thumbnail).filter(Boolean).slice(0, 3);
        let text = plain(source.content);
        if (!text.trim()) {
            const other = files.length - media.length;
            text = other ? (other === 1 ? (files.find(file => !thumbnail(file))?.filename ?? "File") : `${other} files`)
                : media.length ? ""
                : (source.stickerItems ?? source.sticker_items ?? []).length ? "Sticker"
                : source.embeds?.length ? "Link" : "Message";
        }
        if (forwarded) text = `Forwarded${text ? `: ${text}` : ""}`;
        // The original markup is kept for Discord's own renderer.
        const content = source.content?.trim() ? source.content : null;
        return { raw: message, id: message.id, channelId: message.channel_id ?? message.channelId, authorId: message.author?.id,
            author: userName(message.author), text, content, forwarded: Boolean(forwarded), media, timestamp: new Date(message.timestamp) };
    }
    // Default (0) and reply (19) messages; joins, calls and pins are skipped.
    const shown = message => (message.type === 0 || message.type === 19) && message.id;
    // A few emoji and nothing else show large, without a bubble, as in the chat.
    // Unicode or custom emoji (<:name:id>), up to about 27 of them, like Discord's jumbo emoji.
    function emojiOnly(text) {
        const rest = text.replace(/<a?:\w+:\d+>/g, "\u2b50");
        return rest.length <= 54 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(rest) && /\p{Extended_Pictographic}/u.test(rest);
    }

    // Fetched previews are kept briefly and requests in flight are shared, so
    // hovering, prefetching and sweeping back over the list ask only once.
    // Discord's own loaded messages are always preferred.
    const fetched = new Map(), inflight = new Map();
    function loaded(channelId) {
        const cached = store("MessageStore")?.getMessages?.(channelId);
        // A chat scrolled back into its history holds older messages; only its newest page is used.
        if (cached?.ready && !cached.hasMoreAfter && cached._array?.length) return cached._array.filter(shown).slice(-previewCount).map(normal);
        const recent = fetched.get(channelId);
        return recent && Date.now() - recent.at < timing.cache ? recent.messages : null;
    }
    function latest(channelId) {
        const ready = loaded(channelId);
        if (ready) return Promise.resolve(ready);
        if (inflight.has(channelId)) return inflight.get(channelId);
        const request = window.Lowcord.RestAPI.get({ url: `/channels/${channelId}/messages`, query: { limit: previewCount * 2 }, retries: 1 })
            .then(response => {
                const messages = (response?.body ?? []).filter(shown).slice(0, previewCount).reverse().map(normal);
                fetched.delete(channelId);
                fetched.set(channelId, { messages, at: Date.now() });
                if (fetched.size > 20) fetched.delete(fetched.keys().next().value);
                return messages;
            })
            .finally(() => inflight.delete(channelId));
        inflight.set(channelId, request);
        return request;
    }

    // ----- Messages -------------------------------------------------------------
    let card, built, openTimer, prefetchTimer, closeTimer;
    const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    function when(date) {
        return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : `${dayFormat.format(date)}, ${timeFormat.format(date)}`;
    }
    // Message text goes through Discord's own markdown renderer, so emoji,
    // mentions, links, spoilers and formatting look as they do in the chat.
    // Each bubble gets a small React root, unmounted on the next render.
    let textRoots = [];
    const markdown = () => lookup("markdown", value => typeof value?.parse === "function" && typeof value?.parseTopic === "function");
    const markupClass = () => lookup("markup", value => typeof value?.markup === "string" && typeof value?.inlineFormat === "string")?.markup ?? "";
    // Rendering synchronously keeps a bubble from showing up empty for a frame.
    const reactDom = () => lookup("reactDom", value => typeof value?.flushSync === "function" && typeof value?.createPortal === "function");
    function unmountText() {
        for (const root of textRoots) { try { root.unmount(); } catch {} }
        textRoots = [];
    }
    function richText(node, message) {
        const { React, createRoot } = window.Lowcord;
        const parser = message.content && markdown();
        if (!parser || !React || !createRoot) return false;
        try {
            const nodes = parser.parse(message.content, true, { channelId: message.channelId ?? card.channelId, messageId: message.id,
                allowLinks: true, allowEmojiLinks: false });
            const root = createRoot(node);
            const draw = () => root.render(React.createElement(React.Fragment, null,
                message.forwarded ? React.createElement("span", { className: "lowcord-dm-forwarded" }, "Forwarded") : null, nodes));
            const flushSync = reactDom()?.flushSync;
            if (flushSync) flushSync(draw); else draw();
            textRoots.push(root);
            return true;
        } catch (error) {
            console.warn("[lowcord] DM quick reply:", error);
            return false;
        }
    }
    function messageNodes(message, self, cluster, markup) {
        const select = event => {
            // Links, spoilers and mentions inside a bubble keep their own clicks,
            // and selecting text to copy it doesn't pick the message.
            if (event.target.closest?.("a, [role=button]:not(.lowcord-dm-bubble):not(.lowcord-dm-media), [class*=spoiler]")) return;
            if (String(window.getSelection?.() ?? "").trim() && event.currentTarget.contains(window.getSelection().anchorNode)) return;
            setTarget(card.target?.id === message.id ? null : message);
        };
        const props = { "data-id": message.id, "data-self": String(message.authorId === self), "data-cluster": cluster, role: "button", tabindex: "0",
            title: `${message.author}, ${when(message.timestamp)}. Click to reply.`, onClick: select,
            onKeyDown: event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(event); } } };
        const pressed = card.target?.id === message.id ? { "aria-pressed": "true" } : {};
        const nodes = [];
        if (message.media.length) nodes.push(ui("div", { className: "lowcord-dm-media", ...props, ...pressed },
            ...message.media.map(item => ui("span", { className: "lowcord-dm-thumb", "data-video": String(item.video), "data-hidden": String(item.hidden),
                style: `width:${item.width}px;height:${item.height}px` },
                ui("img", { src: item.src, alt: "", loading: "lazy", decoding: "async", draggable: "false" })))));
        if (message.text) {
            const emoji = emojiOnly(message.content ?? message.text);
            const bubble = ui("div", { className: `lowcord-dm-bubble ${markup}`.trim(), ...props, ...pressed, ...(emoji ? { "data-emoji": "true" } : {}) });
            const text = ui("span", { className: "lowcord-dm-text" });
            bubble.append(text);
            if (!richText(text, message)) text.textContent = message.text;
            nodes.push(bubble);
        }
        return nodes;
    }
    function render() {
        if (!card) return;
        const self = store("UserStore")?.getCurrentUser?.()?.id;
        const { list, subtitle } = built.parts;
        const { messages } = card;
        const markup = markupClass();
        unmountText();
        subtitle.textContent = messages?.length ? `Last message ${when(messages[messages.length - 1].timestamp)}` : "";
        list.dataset.state = card.error ? "error" : !messages ? "loading" : messages.length ? "ready" : "empty";
        if (card.error) list.replaceChildren(ui("p", { className: "lowcord-dm-status" }, "Couldn’t load messages."));
        // Placeholder bubbles keep the card's shape while messages load.
        else if (!messages) list.replaceChildren(...["62%", "44%", "70%"].map((width, index) =>
            ui("span", { className: "lowcord-dm-skeleton", "data-self": String(index === 1), style: `width:${width}` })));
        else if (!messages.length) list.replaceChildren(ui("p", { className: "lowcord-dm-status" }, "No messages yet. Say hi."));
        else list.replaceChildren(...messages.flatMap((message, index) => {
            // A run of messages from one person stacks like the chat: only
            // the corners they share are tightened.
            const before = messages[index - 1]?.authorId === message.authorId;
            const after = messages[index + 1]?.authorId === message.authorId;
            return messageNodes(message, self, before ? (after ? "middle" : "end") : (after ? "start" : "single"), markup);
        }));
        // Discord's renderer and images fill the bubbles a little later; the
        // list stays at the newest message unless you've scrolled up.
        built.stick = true;
        list.scrollTop = list.scrollHeight;
        built.sizes ??= new ResizeObserver(() => { if (built.stick) list.scrollTop = list.scrollHeight; });
        built.sizes.disconnect();
        for (const child of list.children) built.sizes.observe(child);
    }
    function setTarget(message) {
        card.target = message;
        built.parts.target.hidden = !message;
        built.parts.targetText.textContent = message ? `Replying to ${message.author}` : "";
        for (const node of built.parts.list.querySelectorAll("[data-id]")) {
            if (message && node.dataset.id === message.id) node.setAttribute("aria-pressed", "true"); else node.removeAttribute("aria-pressed");
        }
        position();
        built.parts.input.focus();
    }
    // The card sits just past the DM list, its header level with the hovered row.
    function position() {
        if (!card?.row.isConnected) return;
        const rect = card.row.getBoundingClientRect();
        const edge = (card.row.closest("nav") ?? card.row).getBoundingClientRect().right;
        const node = built.node;
        const top = rect.top + rect.height / 2 - 26;
        node.style.left = `${Math.round(edge + 8)}px`;
        node.style.top = `${Math.round(Math.max(8, Math.min(top, innerHeight - node.offsetHeight - 8)))}px`;
    }
    // Kept up to date while Discord runs, so a cached preview never misses a
    // message, an edit or a deletion; the open card updates in place.
    function received({ message, channelId }) {
        if (!shown(message ?? {})) return;
        fetched.delete(channelId);
        if (card?.channelId !== channelId) return;
        // Arriving while the card loads: added once the load finishes.
        if (!card.messages) { card.early.push(message); return; }
        // Discord's own optimistic copy has the nonce as its id; the server copy replaces it.
        const index = card.messages.findIndex(item => item.id === message.id || (message.nonce && item.id === message.nonce));
        const item = normal(message);
        if (index >= 0) card.messages[index] = item; else card.messages = [...card.messages, item].slice(-previewCount);
        render();
    }
    function edited({ message }) {
        const channelId = message?.channel_id;
        if (!channelId) return;
        fetched.delete(channelId);
        const index = card?.channelId === channelId ? card.messages?.findIndex(item => item.id === message.id) ?? -1 : -1;
        if (index < 0) return;
        card.messages[index] = normal({ ...card.messages[index].raw, ...message });
        render();
    }
    function deleted({ id, ids, channelId }) {
        if (!channelId) return;
        fetched.delete(channelId);
        const gone = new Set(ids ?? [id]);
        if (card?.channelId !== channelId || !card.messages?.some(item => gone.has(item.id))) return;
        card.messages = card.messages.filter(item => !gone.has(item.id));
        render();
    }
    let subscribed = false;
    function subscribe() {
        const dispatcher = window.Lowcord.Dispatcher;
        if (subscribed || !dispatcher) return;
        subscribed = true;
        dispatcher.subscribe("MESSAGE_CREATE", received);
        dispatcher.subscribe("MESSAGE_UPDATE", edited);
        dispatcher.subscribe("MESSAGE_DELETE", deleted);
        dispatcher.subscribe("MESSAGE_DELETE_BULK", deleted);
    }
    function withEarly(messages) {
        let merged = messages;
        for (const message of card.early) if (!merged.some(item => item.id === message.id || item.id === message.nonce)) merged = [...merged, normal(message)];
        card.early = [];
        return merged.slice(-previewCount);
    }

    // ----- Emoji ----------------------------------------------------------------
    // Discord's own emoji picker, opened beside the card. Its reaction picker
    // is a plain wrapper around the full picker; calling it yields the picker
    // component, which is rendered here for chat messages instead.
    const source = value => { try { return Function.prototype.toString.call(value); } catch { return ""; } };
    function emojiPicker() {
        const wrapper = lookup("reactionPicker", value => typeof value === "function" && source(value).length < 600
            && /pickerIntention:\w+\.EmojiIntention\.REACTION/.test(source(value)));
        let component;
        try { component = wrapper?.({})?.type; } catch {}
        const intents = lookup("emojiIntents", value => value?.EmojiIntention?.CHAT !== undefined)?.EmojiIntention;
        return component && intents ? { component, intent: intents.CHAT } : null;
    }
    // Discord's emoji button: a grey face that turns into a random coloured one on hover.
    function emojiButtonIcon(button) {
        const css = window.Lowcord.find(value => typeof value?.spriteGreyscale === "string" && typeof value?.spriteContainer === "string");
        if (!css) { button.append(svg(paths.smile, 20)); return; }
        const colored = ui("div", { className: `${css.sprite} ${css.spriteColored} ${css.inactive}` });
        const grey = ui("div", { className: `${css.sprite} ${css.spriteGreyscale} ${css.active}` });
        const sprite = ui("div", { className: css.spriteContainer }, colored, grey);
        sprite.style.setProperty("--custom-emoji-sprite-size", "20px");
        // The sheet is 20 faces by 4 rows; its last three cells are empty.
        const face = () => {
            const index = Math.floor(Math.random() * 77);
            sprite.style.setProperty("--custom-emoji-sprite-row", String(Math.floor(index / 20)));
            sprite.style.setProperty("--custom-emoji-sprite-col", String(index % 20));
        };
        const hovered = on => {
            colored.className = `${css.sprite} ${css.spriteColored} ${on ? css.active : css.inactive}`;
            grey.className = `${css.sprite} ${css.spriteGreyscale} ${on ? css.inactive : css.active}`;
        };
        face();
        button.addEventListener("pointerenter", () => { if (button.getAttribute("aria-expanded") !== "true") face(); hovered(true); });
        button.addEventListener("pointerleave", () => hovered(button.getAttribute("aria-expanded") === "true"));
        button.classList.add("lowcord-dm-emoji-button");
        button.append(sprite);
        button.setHovered = hovered;
    }
    let pickerRoot;
    const pickerOpen = () => Boolean(built?.layer.isConnected);
    function placePicker() {
        const { layer, node } = built;
        const card = node.getBoundingClientRect();
        const width = layer.offsetWidth, height = layer.offsetHeight;
        // Beside the card when there's room, otherwise over it.
        const left = card.right + 8 + width <= innerWidth - 8 ? card.right + 8 : Math.max(8, card.right - width);
        layer.style.left = `${Math.round(left)}px`;
        layer.style.top = `${Math.round(Math.max(8, Math.min(card.bottom - height, innerHeight - height - 8)))}px`;
    }
    function toggleEmoji(open = !pickerOpen()) {
        const { layer } = built, { emojiToggle, input } = built.parts;
        const picker = open && emojiPicker();
        const { React, createRoot } = window.Lowcord;
        if (open && (!picker || !React || !createRoot)) { showError("Discord’s emoji picker isn’t available right now."); return; }
        emojiToggle.setAttribute("aria-expanded", String(Boolean(open)));
        emojiToggle.setHovered?.(Boolean(open));
        if (!open) {
            pickerRoot?.render(null);
            layer.remove();
            input.focus({ preventScroll: true });
            return;
        }
        document.body.append(layer);
        pickerRoot ??= createRoot(layer);
        pickerRoot.render(React.createElement(picker.component, {
            pickerIntention: picker.intent, channel: store("ChannelStore")?.getChannel?.(card.channelId),
            closePopout: () => toggleEmoji(false), onSelectEmoji: insertEmoji,
            persistSearch: true, showAddEmojiButton: false, wrapper: "div",
        }));
        placePicker();
        requestAnimationFrame(() => { if (pickerOpen()) placePicker(); });
    }
    // Discord passes { emoji, willClose }; shift-click keeps the picker open.
    // Custom emoji are sent in Discord's markup.
    function insertEmoji(selected) {
        const emoji = selected?.emoji;
        if (!emoji || !card) return;
        const text = emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.optionallyDiverseSequence ?? emoji.surrogates;
        if (!text) return;
        const { input } = built.parts;
        const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
        const before = input.value.slice(0, start);
        input.setRangeText(`${before && !/\s$/.test(before) ? " " : ""}${text}`, start, end, "end");
        autosize(input);
        if (selected.willClose !== false) toggleEmoji(false);
    }

    // ----- Attachments ----------------------------------------------------------
    // Discord's per-file limit for the current user; DMs have no boost tier.
    function uploadLimit() {
        const premium = store("UserStore")?.getCurrentUser?.()?.premiumType;
        return (premium === 2 ? 500 : premium === 1 || premium === 3 ? 50 : 10) * 1024 * 1024;
    }
    function addFiles(list) {
        const files = [...list].filter(file => file instanceof File);
        if (!files.length || !card) return;
        const limit = uploadLimit();
        const tooLarge = files.filter(file => file.size > limit);
        const accepted = files.filter(file => file.size <= limit).slice(0, maxFiles - card.files.length);
        for (const file of accepted) card.files.push({ file, preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : null });
        showError(tooLarge.length ? `${tooLarge.length === 1 ? tooLarge[0].name : `${tooLarge.length} files`} ${tooLarge.length === 1 ? "is" : "are"} over ${Math.round(limit / 1048576)} MB.`
            : files.length - tooLarge.length > accepted.length ? `You can send up to ${maxFiles} files at once.` : "");
        renderFiles();
        built.parts.input.focus({ preventScroll: true });
    }
    function forgetFiles(files) {
        for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
    }
    function renderFiles() {
        const { tray } = built.parts;
        tray.hidden = !card?.files.length;
        tray.replaceChildren(...(card?.files ?? []).map(item => ui("div", { className: "lowcord-dm-file", title: item.file.name },
            item.preview ? ui("img", { src: item.preview, alt: "", draggable: "false" })
                : ui("span", { className: "lowcord-dm-file-name" }, svg(paths.file, 20), ui("span", {}, item.file.name)),
            ui("button", { type: "button", className: "lowcord-dm-file-remove", "aria-label": `Remove ${item.file.name}`, title: "Remove",
                onClick: () => { card.files = card.files.filter(other => other !== item); forgetFiles([item]); renderFiles(); } },
                svg(paths.close, 12)))));
        position();
    }
    // Each file uploads through Discord's own uploader; the message then
    // references the uploads, as Discord's composer does.
    function uploadAll(channelId, files, onProgress) {
        const { CloudUpload } = window.Lowcord;
        if (!CloudUpload) return Promise.reject(new Error("Uploader unavailable"));
        const total = files.reduce((sum, item) => sum + item.file.size, 0) || 1;
        const uploads = files.map(item => new CloudUpload({ file: item.file, isThumbnail: false, platform: 1 }, channelId));
        const report = () => onProgress(Math.min(1, uploads.reduce((sum, upload) => sum + (upload.loaded || 0), 0) / total));
        return Promise.all(uploads.map(upload => new Promise((resolve, reject) => {
            upload.on("progress", report);
            upload.on("complete", () => resolve(upload));
            upload.on("error", () => reject(new Error("Upload failed")));
            upload.upload();
        })));
    }

    // ----- Sending --------------------------------------------------------------
    function autosize(input) {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
    }
    function showError(text) {
        built.parts.error.textContent = text;
        built.parts.error.hidden = !text;
    }
    function showProgress(fraction) {
        const { progress } = built.parts;
        progress.hidden = fraction == null;
        if (fraction != null) progress.style.setProperty("--lowcord-progress", `${Math.round(fraction * 100)}%`);
    }
    async function send() {
        const { input } = built.parts;
        const content = input.value.trim();
        const files = card.files;
        if ((!content && !files.length) || card.sending) return;
        if (content.length > 2000) { showError("Messages can be up to 2,000 characters."); return; }
        const { channelId, target } = card;
        const restore = () => {
            if (card?.channelId !== channelId) return;
            if (!input.value) { input.value = content; autosize(input); }
            if (files.length && !card.files.length) { card.files = files; renderFiles(); }
        };
        if (!files.length) {
            const actions = messageActions();
            if (!actions) { showError("Couldn’t send. Open the chat to reply."); return; }
            input.value = ""; autosize(input); showError("");
            if (target) setTarget(null);
            try {
                await actions.sendMessage(channelId, { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false,
                    target ? { messageReference: { channel_id: channelId, message_id: target.id } } : {});
            } catch (failure) {
                console.warn("[lowcord] DM quick reply:", failure);
                restore();
                if (card?.channelId === channelId) showError("Couldn’t send. Try again.");
            }
            return;
        }
        // While files upload the card stays open; closing it lets the upload finish.
        const current = card;
        current.sending = true; current.files = [];
        input.value = ""; autosize(input); showError(""); renderFiles(); showProgress(0);
        if (target) setTarget(null);
        try {
            const uploads = await uploadAll(channelId, files, fraction => { if (card === current) showProgress(fraction); });
            await window.Lowcord.RestAPI.post({ url: `/channels/${channelId}/messages`, body: {
                content, channel_id: channelId, type: 0, sticker_ids: [],
                nonce: String((BigInt(Date.now()) - 1420070400000n) << 22n),
                attachments: uploads.map((upload, index) => ({ id: String(index), filename: upload.filename, uploaded_filename: upload.uploadedFilename })),
                message_reference: target ? { channel_id: channelId, message_id: target.id } : undefined,
            } });
            forgetFiles(files);
        } catch (failure) {
            console.warn("[lowcord] DM quick reply:", failure);
            if (card === current) { restore(); showError("Couldn’t send the files. Try again."); }
            else { forgetFiles(files); extensions.toast("Couldn’t send your files. Please try again.", true); }
        } finally {
            current.sending = false;
            if (card === current) showProgress(null);
        }
    }

    // ----- Card -----------------------------------------------------------------
    function build() {
        const input = ui("textarea", { className: "lowcord-dm-input", rows: "1", "aria-label": "Message",
            onInput: () => { autosize(input); showError(""); },
            onPaste: event => { if (event.clipboardData?.files?.length) { event.preventDefault(); addFiles(event.clipboardData.files); } },
            onKeyDown: event => {
                if (event.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
                else if (event.key === "Escape" && card?.target) { event.preventDefault(); event.stopPropagation(); setTarget(null); }
            } });
        const fileInput = ui("input", { type: "file", multiple: "", hidden: true,
            onChange: () => { if (card) card.picking = false; addFiles(fileInput.files); fileInput.value = ""; },
            onCancel: () => { if (card) card.picking = false; } });
        const avatar = ui("img", { className: "lowcord-dm-avatar", alt: "", draggable: "false" });
        const title = ui("strong", { className: "lowcord-dm-title" });
        const subtitle = ui("span", { className: "lowcord-dm-subtitle" });
        const list = ui("div", { className: "lowcord-dm-list", role: "log", "aria-live": "polite",
            onScroll: () => { built.stick = list.scrollHeight - list.scrollTop - list.clientHeight < 24; } });
        const targetText = ui("span");
        const target = ui("div", { className: "lowcord-dm-target", hidden: true }, svg(paths.reply, 14), targetText,
            iconButton("Cancel reply", paths.close, () => setTarget(null), 14));
        const tray = ui("div", { className: "lowcord-dm-tray", hidden: true });
        const progress = ui("div", { className: "lowcord-dm-progress", role: "progressbar", "aria-label": "Uploading", hidden: true });
        const error = ui("p", { className: "lowcord-dm-error", role: "alert", hidden: true });
        const emojiToggle = ui("button", { type: "button", className: "lowcord-dm-icon", "aria-label": "Select emoji", title: "Select emoji",
            "aria-expanded": "false", onClick: () => toggleEmoji() });
        emojiButtonIcon(emojiToggle);
        const attach = iconButton("Attach files", paths.plus, () => { if (card) card.picking = true; fileInput.click(); });
        const node = ui("div", { className: "lowcord-dm-card lowcord-chat-preview", role: "dialog", "aria-label": "Quick reply" },
            ui("header", {}, avatar, ui("div", { className: "lowcord-dm-heading" }, title, subtitle),
                iconButton("Open chat", paths.open, () => { const id = card.channelId; close(true); window.Lowcord.transitionTo?.(`/channels/@me/${id}`); }, 16),
                iconButton("Close", paths.close, () => close(), 16)),
            ui("div", { className: "lowcord-dm-body" }, list),
            ui("footer", {}, target, tray, progress, error,
                ui("div", { className: "lowcord-dm-field" }, attach, input, emojiToggle), fileInput));
        // Keep Discord's global shortcuts and file drop out of the card.
        node.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") { if (pickerOpen()) toggleEmoji(false); else close(); }
        });
        // Discord's picker floats beside the card in a layer of its own.
        const layer = ui("div", { className: "lowcord-dm-emoji-layer" });
        layer.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") { event.preventDefault(); toggleEmoji(false); }
        });
        for (const type of ["dragenter", "dragover"]) node.addEventListener(type, event => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault(); event.stopPropagation();
            node.dataset.dropping = "";
        });
        node.addEventListener("dragleave", event => { if (!node.contains(event.relatedTarget)) delete node.dataset.dropping; });
        node.addEventListener("drop", event => {
            delete node.dataset.dropping;
            if (!event.dataTransfer?.files.length) return;
            event.preventDefault(); event.stopPropagation();
            addFiles(event.dataTransfer.files);
        });
        node.addEventListener("pointerenter", () => {
            clearTimeout(closeTimer);
            if (!node.contains(document.activeElement)) input.focus({ preventScroll: true });
        });
        return { node, layer, parts: { input, avatar, title, subtitle, list, emojiToggle, target, targetText, tray, progress, error } };
    }
    // Black or white text for a #rrggbb bubble, as chat-appearance.js picks it.
    function ink(hex) {
        if (!/^#[\da-f]{6}$/i.test(hex ?? "")) return null;
        const [r, g, b] = hex.slice(1).match(/../g).map(value => {
            const channel = parseInt(value, 16) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return r * 0.2126 + g * 0.7152 + b * 0.0722 > 0.179 ? "#000000" : "#ffffff";
    }
    function open(channelId, row) {
        const info = channelInfo(channelId);
        if (!info) return;
        // Switching rows updates the open card in place: no exit and entry
        // animation, and it glides to the new row.
        const switching = Boolean(card) && built.node.isConnected && built.node.dataset.closing === undefined;
        if (switching) forgetFiles(card.files); else close(true);
        built ??= build();
        const { parts, node } = built;
        subscribe();
        card = { channelId, row, messages: loaded(channelId), early: [], error: false, target: null, files: [], picking: false, sending: false };
        parts.title.textContent = info.name;
        const image = row.querySelector("img");
        parts.avatar.hidden = !image?.src;
        if (image?.src) parts.avatar.src = image.src;
        parts.input.placeholder = `Message ${info.channel.type === 1 ? "@" : ""}${info.name}`;
        parts.input.value = ""; autosize(parts.input);
        parts.target.hidden = true; showError(""); showProgress(null); renderFiles();
        if (pickerOpen()) toggleEmoji(false);
        // The same bubble colors and side as the chat; a theme's own bubble colors win in CSS.
        const appearance = window.__lowcordChatAppearance?.options ?? {};
        for (const [property, value] of [["--lowcord-outgoing-color", appearance.outgoingColor], ["--lowcord-incoming-color", appearance.incomingColor],
            ["--lowcord-outgoing-text", appearance.outgoingTextColor ?? ink(appearance.outgoingColor)],
            ["--lowcord-incoming-text", appearance.incomingTextColor ?? ink(appearance.incomingColor)]]) {
            if (value) node.style.setProperty(property, value); else node.style.removeProperty(property);
        }
        node.dataset.outgoingPosition = appearance.outgoingPosition === "left" ? "left" : "right";
        node.toggleAttribute("data-switching", switching);
        if (!switching) {
            delete node.dataset.closing;
            document.body.append(node);
            document.addEventListener("pointerdown", outside, true);
            document.addEventListener("scroll", scrolled, true);
            window.addEventListener("resize", resized);
        }
        // Messages already loaded or prefetched render in the same frame the card opens.
        render(); position();
        if (card.messages) return;
        const current = card;
        latest(channelId).then(messages => {
            if (card !== current) return;
            card.messages = withEarly(messages); render();
        }, failure => {
            console.warn("[lowcord] DM quick reply:", failure);
            if (card === current) { card.error = true; render(); }
        });
    }
    // The card's elements are kept for the next open; its messages are not.
    function close(instant = false) {
        clearTimeout(closeTimer);
        if (!card) return;
        if (!card.sending) forgetFiles(card.files);
        card = null;
        const { node, parts, layer } = built;
        if (layer.isConnected) {
            pickerRoot?.render(null); layer.remove();
            parts.emojiToggle.setAttribute("aria-expanded", "false"); parts.emojiToggle.setHovered?.(false);
        }
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("scroll", scrolled, true);
        window.removeEventListener("resize", resized);
        if (node.contains(document.activeElement)) document.activeElement.blur();
        const remove = () => {
            unmountText(); built.sizes?.disconnect(); node.remove(); parts.list.replaceChildren(); parts.tray.replaceChildren();
        };
        if (instant) { remove(); return; }
        node.dataset.closing = "";
        setTimeout(() => { if (!card && node.dataset.closing !== undefined) remove(); }, 120);
    }
    // Once you've started a reply the card stays until Esc, close or a click outside.
    const engaged = () => Boolean(card && (card.target || card.files.length || card.picking || card.sending
        || pickerOpen() || built.parts.input.value.trim()));
    // The card, Discord's picker beside it, and the popouts the picker opens.
    const inCard = target => Boolean(built && target instanceof Node
        && (built.node.contains(target) || built.layer.contains(target) || target.closest?.('[class*="layerContainer"]')));
    function outside(event) {
        if (card && !inCard(event.target)) close(!card.row.contains(event.target));
    }
    // Only scrolling the DM list moves the row away from the card; other
    // scrolling, such as the open chat receiving a message, leaves it be.
    function scrolled(event) {
        if (!card || inCard(event.target) || !(event.target instanceof Node) || !event.target.contains(card.row)) return;
        if (engaged()) { position(); if (pickerOpen()) placePicker(); } else close(true);
    }
    function resized() {
        if (!card) return;
        position();
        if (pickerOpen()) placePicker();
    }

    // ----- Hover intent ---------------------------------------------------------
    function rowAt(target) {
        const row = target?.closest?.(`${listSelector} li`);
        const link = row?.querySelector('a[href^="/channels/@me/"]');
        const id = link?.getAttribute("href").split("/")[3];
        return id ? { row, id } : null;
    }
    function cancelPending() {
        clearTimeout(openTimer); clearTimeout(prefetchTimer);
        openTimer = prefetchTimer = undefined;
    }
    document.addEventListener("pointerover", event => {
        if (event.pointerType === "touch" || !extensions.enabled("dmQuickReply")) return;
        if (card && inCard(event.target)) { clearTimeout(closeTimer); return; }
        const hit = rowAt(event.target);
        if (!hit) return;
        if (card?.channelId === hit.id) { clearTimeout(closeTimer); cancelPending(); return; }
        if (engaged()) return;
        cancelPending();
        const delay = card ? timing.switch : timing.open;
        if (delay > timing.prefetch) prefetchTimer = setTimeout(() => {
            prefetchTimer = undefined;
            // The first open's one-time module lookups happen here, before the card shows.
            markdown(); reactDom(); markupClass(); messageActions();
            latest(hit.id).catch(() => {});
        }, timing.prefetch);
        openTimer = setTimeout(() => {
            openTimer = undefined;
            if (hit.row.isConnected && hit.row.matches(":hover")) open(hit.id, hit.row);
        }, delay);
    }, { passive: true });
    document.addEventListener("pointerout", event => {
        if (!card && !openTimer) return;
        const from = rowAt(event.target)?.row ?? (inCard(event.target) ? event.target : null);
        if (!from || from.contains(event.relatedTarget)) return;
        if (rowAt(event.relatedTarget) || inCard(event.relatedTarget)) return;
        cancelPending();
        if (!card || engaged()) return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => { if (!engaged()) close(); }, timing.close);
    }, { passive: true });
    // Clicking a row opens Discord's chat; the card would only repeat it.
    document.addEventListener("click", event => {
        if (rowAt(event.target)) { cancelPending(); close(true); }
    }, true);

    window.addEventListener(extensions.changeEvent, () => {
        if (!extensions.enabled("dmQuickReply")) { cancelPending(); close(true); }
    });
})();
