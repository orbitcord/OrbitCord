// Media gallery: a pane beside the chat with every photo and video sent in the
// open DM or channel, newest first and grouped by month, like Discord's mobile
// app. It reads Discord's own search, loads small thumbnails from Discord's
// media proxy as the grid scrolls, and a click jumps to the message.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui } = extensions;
    const galleryPath = "M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm13.5 1a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM4.4 18.6c-.3.4 0 .9.5.9h14.2c.5 0 .8-.6.5-1l-3.4-4.3a1 1 0 0 0-1.6 0l-1.2 1.5-3.6-4.8a1 1 0 0 0-1.6 0L4.4 18.6Z";
    const closePath = "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";
    const trashPath = "M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5ZM5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z";
    const chevronPath = "M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z";
    const playPath = "M8 5.6v12.8a1 1 0 0 0 1.5.86l10.6-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6Z";
    const filters = [["all", "All", ["image", "video"]], ["image", "Photos", ["image"]], ["video", "Videos", ["video"]]];
    // Thumbnails are requested at the tile's size on a 2x screen.
    const thumbSize = 280;
    const timing = { search: 250, indexing: 3000 };

    const store = name => window.Lowcord.store(name);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const svg = (path, size = 20) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("width", size); node.setAttribute("height", size);
        node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="currentColor" fill-rule="evenodd" d="${path}"/>`;
        return node;
    };
    let pane;

    // ----- Data ---------------------------------------------------------------
    function currentChannel() {
        const channelId = store("SelectedChannelStore")?.getChannelId?.();
        const channel = channelId && store("ChannelStore")?.getChannel?.(channelId);
        if (!channel) return null;
        const guildId = channel.guild_id ?? channel.getGuildId?.() ?? null;
        let name = channel.name ? (guildId ? `#${channel.name}` : channel.name) : "";
        if (!name) {
            const user = store("UserStore")?.getUser?.(channel.recipients?.[0]);
            name = user?.globalName || user?.global_name || user?.username || "this conversation";
        }
        return { channelId, guildId, name };
    }
    // A proxied URL resized to fit a tile, keeping Discord's signed parameters.
    function thumbnail(source, width, height, video) {
        try {
            const url = new URL(source);
            const scale = width && height ? Math.min(1, thumbSize / Math.min(width, height)) : 1;
            url.searchParams.set("format", video ? "jpeg" : "webp");
            if (width && height) {
                url.searchParams.set("width", Math.max(1, Math.round(width * scale)));
                url.searchParams.set("height", Math.max(1, Math.round(height * scale)));
            } else url.searchParams.set("width", thumbSize);
            return url.href;
        } catch { return null; }
    }
    function itemsOf(message) {
        const items = [];
        // Shared by every tile of one message, so deleting one keeps the rest right.
        const post = { id: message.id, channelId: message.channel_id, content: message.content ?? "",
            own: message.author?.id === store("UserStore")?.getCurrentUser?.()?.id,
            files: new Set((message.attachments ?? []).map(file => file.id)) };
        for (const file of message.attachments ?? []) {
            const type = file.content_type ?? "";
            const video = type.startsWith("video/");
            if (!video && !type.startsWith("image/")) continue;
            const thumb = thumbnail(file.proxy_url || file.url, file.width, file.height, video);
            if (!thumb) continue;
            items.push({ key: file.id, fileId: file.id, deletable: post.own, thumb, video, gif: type === "image/gif", duration: file.duration_secs ?? null,
                spoiler: /^SPOILER_/.test(file.filename ?? "") || Boolean(file.flags & 8), name: file.filename, link: file.url || file.proxy_url });
        }
        for (const [index, embed] of (message.embeds ?? []).entries()) {
            if (!["image", "gifv", "video"].includes(embed.type)) continue;
            const media = embed.thumbnail ?? embed.image;
            const thumb = media?.proxy_url && thumbnail(media.proxy_url, media.width, media.height, false);
            if (!thumb) continue;
            // A link preview goes only with its message, and only when the
            // message is nothing but links.
            const linksOnly = !post.files.size && (!post.content.trim() || post.content.trim().split(/\s+/).every(word => /^<?https?:\/\/\S+>?$/.test(word)));
            items.push({ key: `${message.id}:${index}`, fileId: null, deletable: post.own && linksOnly, thumb, video: embed.type === "video", gif: embed.type === "gifv",
                duration: null, spoiler: false, name: embed.title || embed.provider?.name || "",
                link: embed.url || embed.video?.url || media.url || media.proxy_url });
        }
        return items.map(item => ({ ...item, post, messageId: message.id, channelId: message.channel_id,
            author: message.author?.global_name || message.author?.username || "", time: new Date(message.timestamp) }));
    }
    async function searchPage(state, maxId) {
        const { target } = state;
        const url = target.guildId ? `/guilds/${target.guildId}/messages/search` : `/channels/${target.channelId}/messages/search`;
        const query = { has: filters.find(([id]) => id === state.filter)[2], include_nsfw: true };
        if (target.guildId) query.channel_id = target.channelId;
        if (maxId) query.max_id = maxId;
        for (let attempt = 0; ; attempt++) {
            if (state !== pane?.state) return null;
            let response;
            try { response = await window.Lowcord.RestAPI.get({ url, query, retries: 0 }); }
            catch (error) {
                if (error?.status === 429) { await wait(Math.max(500, (Number(error.body?.retry_after) || 1) * 1000)); continue; }
                if (attempt < 2) { await wait(800 * (attempt + 1)); continue; }
                throw error;
            }
            if (response?.status === 202) {
                state.indexing = true; renderStatus();
                await wait(Math.max(timing.indexing, (Number(response.body?.retry_after) || 0) * 1000));
                continue;
            }
            state.indexing = false;
            return response?.body ?? {};
        }
    }
    async function loadMore() {
        const state = pane?.state;
        if (!state || state.loading || state.done) return;
        state.loading = true; state.error = false; renderStatus();
        try {
            const body = await searchPage(state, state.maxId);
            if (!body || state !== pane?.state) return;
            const messages = (body.messages ?? []).flat().filter(message => message?.id && !state.seen.has(message.id))
                .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
            if (!messages.length) { state.done = true; return; }
            for (const message of messages) state.seen.add(message.id);
            state.maxId = (BigInt(messages[messages.length - 1].id) - 1n).toString();
            append(messages.flatMap(itemsOf));
            await wait(timing.search);
        } catch (error) {
            console.warn("[lowcord] Media gallery:", error);
            if (state === pane?.state) state.error = true;
        } finally {
            if (state === pane?.state) {
                state.loading = false; renderStatus();
                // Keep filling until the grid scrolls, or the history ends.
                if (!state.done && !state.error && pane.sentinelVisible) loadMore();
            }
        }
    }

    // ----- Pane ---------------------------------------------------------------
    const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
    const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
    const duration = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    function tile(item) {
        const image = ui("img", { alt: "", loading: "lazy", decoding: "async", draggable: "false", src: item.thumb,
            onLoad: () => image.setAttribute("data-loaded", ""), onError: () => button.setAttribute("data-broken", "") });
        const what = item.video ? "Video" : item.gif ? "GIF" : "Photo";
        const label = `${what}${item.author ? ` from ${item.author}` : ""}, ${dayFormat.format(item.time)}`;
        const badge = item.video ? ui("span", { className: "lowcord-media-badge" }, svg(playPath, 12), item.duration ? duration(item.duration) : null)
            : item.gif ? ui("span", { className: "lowcord-media-badge" }, "GIF") : null;
        const button = ui("button", { type: "button", className: "lowcord-media-tile", "aria-label": `${label}. Jump to message`, title: label,
            onClick: () => jump(item, button), onContextmenu: event => showMenu(event, item, button) }, image, badge, item.spoiler ? ui("span", { className: "lowcord-media-spoiler" }, "Spoiler") : null);
        if (item.spoiler) button.setAttribute("data-spoiler", "");
        const cell = ui("div", { role: "listitem", className: "lowcord-media-cell", "data-message": item.messageId }, button);
        if (item.deletable) cell.append(ui("button", { type: "button", className: "lowcord-media-delete", "aria-label": `Delete ${what.toLowerCase()}`,
            title: "Delete", onClick: () => deleteMedia(item, cell, what) }, svg(trashPath, 14)));
        return cell;
    }
    // One click deletes: the file alone when its message has more to keep,
    // otherwise the whole message.
    async function request(method, options) {
        for (let attempt = 0; ; attempt++) {
            try { return await window.Lowcord.RestAPI[method]({ ...options, retries: 0 }); }
            catch (error) {
                if (error?.status === 429 && attempt < 3) { await wait(Math.max(500, (Number(error.body?.retry_after) || 1) * 1000)); continue; }
                throw error;
            }
        }
    }
    function removeCell(cell) {
        const section = cell.closest(".lowcord-media-month");
        const done = () => {
            cell.remove();
            if (section && !section.querySelector(".lowcord-media-cell")) section.remove();
            if (pane) { pane.state.count = pane.grid.querySelectorAll(".lowcord-media-cell").length; renderStatus(); }
        };
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) { done(); return; }
        cell.setAttribute("data-removing", "");
        cell.addEventListener("animationend", done, { once: true });
        setTimeout(done, 300);
    }
    async function deleteMedia(item, cell, what) {
        if (cell.hasAttribute("data-deleting")) return;
        const { post } = item;
        const rest = [...post.files].filter(id => id !== item.fileId);
        const whole = !item.fileId || (!rest.length && !post.content.trim());
        cell.setAttribute("data-deleting", "");
        const url = `/channels/${post.channelId}/messages/${post.id}`;
        try {
            if (whole) await request("del", { url });
            else await request("patch", { url, body: { attachments: rest.map(id => ({ id })) } });
        } catch (error) {
            cell.removeAttribute("data-deleting");
            // Already gone is what was wanted.
            if (error?.status !== 404) {
                console.warn("[lowcord] Media gallery delete:", error);
                extensions.toast(`Couldn’t delete that ${what.toLowerCase()}. Please try again.`, true);
                return;
            }
        }
        if (whole) {
            for (const other of pane?.grid.querySelectorAll(`.lowcord-media-cell[data-message="${post.id}"]`) ?? []) removeCell(other);
            if (!cell.isConnected) return;
        } else post.files.delete(item.fileId);
        removeCell(cell);
    }
    function append(items) {
        const { grid, state } = pane;
        for (const item of items) {
            const month = monthFormat.format(item.time);
            if (month !== state.month || !state.section?.isConnected) {
                state.month = month;
                const key = monthKey(item.time);
                state.months.add(key);
                state.section = ui("div", { className: "lowcord-media-grid", role: "list" });
                const heading = ui("button", { type: "button", className: "lowcord-media-month-button", "aria-haspopup": "dialog",
                    "aria-label": `${month}. Choose a month`, onClick: () => showMonths(heading, item.time) }, month, svg(chevronPath, 14));
                grid.append(ui("section", { className: "lowcord-media-month", "aria-label": month, "data-month": key },
                    ui("h3", {}, heading), state.section));
            }
            state.section.append(tile(item));
            state.count++;
        }
    }
    function renderStatus() {
        if (!pane) return;
        const { state, status, retry } = pane;
        const empty = !state.count;
        const kind = state.filter === "video" ? "videos" : state.filter === "image" ? "photos" : "photos or videos";
        let text = "";
        if (state.error) text = "Couldn’t load more media.";
        else if (state.indexing) text = "Discord is preparing search for this chat…";
        else if (state.loading) text = empty ? "" : "Loading…";
        else if (state.done) text = empty ? `No ${kind} in ${state.target.name} yet.` : "That’s everything.";
        status.textContent = text;
        status.hidden = !text;
        retry.hidden = !state.error;
        pane.node.toggleAttribute("data-empty", empty && state.done);
        pane.skeleton.hidden = !(empty && state.loading && !state.indexing);
    }
    function jump(item, button) {
        const navigate = window.Lowcord.transitionTo;
        const guild = pane?.state.target.guildId ?? "@me";
        const path = `/channels/${guild}/${item.channelId}/${item.messageId}`;
        if (typeof navigate === "function") navigate(path);
        else { history.pushState(history.state, "", path); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); }
        pane.node.querySelector(".lowcord-media-tile[data-current]")?.removeAttribute("data-current");
        button.setAttribute("data-current", "");
    }
    // `from` starts the grid at an older month instead of the newest media.
    function reset(target, filter = "all", from = null) {
        const { grid, scroll } = pane;
        hideMonths();
        pane.state = { target, filter, seen: new Set(), maxId: from ? snowflake(from) : null, from, months: new Set(),
            count: 0, month: null, section: null, loading: false, done: false, error: false, indexing: false };
        grid.replaceChildren();
        pane.latest.hidden = !from;
        scroll.scrollTop = 0;
        pane.subtitle.textContent = target.name;
        for (const button of pane.segments) button.setAttribute("aria-checked", String(button.dataset.filter === filter));
        renderStatus();
        loadMore();
    }
    // Over the right of the chat, from below the channel header down.
    function place() {
        if (!pane) return;
        const header = document.querySelector('section[class*="title_"]');
        const content = header?.parentElement?.querySelector('[class*="content_"]') ?? document.querySelector('main[class*="chatContent_"]')?.parentElement;
        if (!header || !content) return;
        const top = header.getBoundingClientRect().bottom, box = content.getBoundingClientRect();
        const style = pane.node.style;
        style.top = `${top}px`;
        style.right = `${Math.max(0, innerWidth - box.right)}px`;
        style.height = `${Math.max(200, box.bottom - top)}px`;
        style.width = `${Math.round(Math.min(400, Math.max(280, box.width * 0.42)))}px`;
    }
    function open() {
        const target = currentChannel();
        if (!target) { extensions.toast("Open a DM or channel first", true); return; }
        if (pane) { if (pane.state.target.channelId !== target.channelId) reset(target); return; }
        const title = ui("h2", { id: "lowcord-media-title" }, "Media");
        const subtitle = ui("span", { className: "lowcord-media-subtitle" });
        const close = ui("button", { type: "button", className: "lowcord-media-close", "aria-label": "Close media", title: "Close", onClick: closePane }, svg(closePath, 18));
        const segments = filters.map(([id, label]) => ui("button", { type: "button", role: "radio", "data-filter": id,
            className: "lowcord-media-segment", onClick: () => { if (pane.state.filter !== id) reset(pane.state.target, id); } }, label));
        const grid = ui("div", { className: "lowcord-media-scroll" });
        const skeleton = ui("div", { className: "lowcord-media-grid lowcord-media-skeleton", "aria-hidden": "true" },
            ...Array.from({ length: 12 }, () => ui("span")));
        const status = ui("p", { className: "lowcord-media-status", role: "status" });
        const retry = ui("button", { type: "button", className: "lowcord-button", hidden: true, onClick: loadMore }, "Try again");
        const sentinel = ui("div", { className: "lowcord-media-sentinel" });
        const latest = ui("button", { type: "button", className: "lowcord-media-latest", hidden: true,
            onClick: () => reset(pane.state.target, pane.state.filter) }, svg(chevronPath, 14), "Back to newest");
        const scroll = ui("div", { className: "lowcord-media-body" }, latest, grid, skeleton, ui("div", { className: "lowcord-media-footer" }, status, retry), sentinel);
        const node = ui("aside", { className: "lowcord-media-pane", "aria-labelledby": "lowcord-media-title" },
            ui("header", {}, ui("div", { className: "lowcord-media-heading" }, title, subtitle), close),
            ui("div", { className: "lowcord-media-segments", role: "radiogroup", "aria-label": "Show" }, ...segments),
            scroll);
        pane = { node, grid, scroll, latest, skeleton, status, retry, subtitle, segments, sentinelVisible: false };
        pane.observer = new IntersectionObserver(([entry]) => {
            pane.sentinelVisible = entry.isIntersecting;
            if (entry.isIntersecting) loadMore();
        }, { root: scroll, rootMargin: "600px 0px" });
        pane.observer.observe(sentinel);
        pane.resize = new ResizeObserver(place);
        pane.resize.observe(document.body);
        document.body.append(node);
        place();
        reset(target);
        updateButtons();
        segments[0].focus();
    }
    function closePane() {
        if (!pane) return;
        hideMenu(); hideMonths();
        pane.observer.disconnect(); pane.resize.disconnect();
        const { node } = pane;
        pane = undefined;
        updateButtons();
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) { node.remove(); return; }
        node.setAttribute("data-closing", "");
        node.addEventListener("animationend", () => node.remove(), { once: true });
        setTimeout(() => node.remove(), 300);
    }
    const toggle = () => (pane ? closePane() : open());

    // ----- Month picker -------------------------------------------------------
    // A month heading opens a year of months: months already in the grid are
    // marked, a loaded month scrolls into view, and an older one restarts the
    // grid from there, with "Back to newest" above it.
    const discordEpoch = 1420070400000n;
    const monthKey = date => `${date.getFullYear()}-${date.getMonth()}`;
    // The newest possible message id before the start of the month after `from`.
    const snowflake = from => (((BigInt(new Date(from.year, from.month + 1, 1).getTime()) - discordEpoch) << 22n) - 1n).toString();
    const shortMonth = new Intl.DateTimeFormat(undefined, { month: "short" });
    let months;
    function hideMonths() {
        if (!months) return;
        months.node.remove();
        months.heading.setAttribute("aria-expanded", "false");
        for (const [type, fn, capture] of months.listeners) window.removeEventListener(type, fn, capture);
        months = undefined;
    }
    function goToMonth(year, month) {
        const { state, grid, scroll } = pane;
        const heading = months?.heading;
        hideMonths();
        const section = grid.querySelector(`.lowcord-media-month[data-month="${year}-${month}"]`);
        if (section) {
            scroll.scrollTo({ top: scroll.scrollTop + section.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
            section.querySelector(".lowcord-media-month-button")?.focus({ preventScroll: true });
            return;
        }
        reset(state.target, state.filter, { year, month });
        heading?.isConnected && heading.blur();
        pane.latest.focus({ preventScroll: true });
    }
    function showMonths(heading, date) {
        if (months?.heading === heading) { hideMonths(); return; }
        hideMonths();
        const { target } = pane.state;
        const now = new Date();
        // Nothing can be older than the chat itself.
        const created = new Date(Number((BigInt(target.channelId) >> 22n) + discordEpoch));
        const first = created.getFullYear() * 12 + created.getMonth(), last = now.getFullYear() * 12 + now.getMonth();
        let year = date.getFullYear();
        const title = ui("span", { className: "lowcord-months-year", "aria-live": "polite" });
        const previous = ui("button", { type: "button", className: "lowcord-months-step", "aria-label": "Previous year", onClick: () => { year--; render(); } }, svg(chevronPath, 16));
        const next = ui("button", { type: "button", className: "lowcord-months-step", "aria-label": "Next year", onClick: () => { year++; render(); } }, svg(chevronPath, 16));
        previous.setAttribute("data-direction", "previous"); next.setAttribute("data-direction", "next");
        const grid = ui("div", { className: "lowcord-months-grid" });
        const node = ui("div", { className: "lowcord-months", role: "dialog", "aria-label": "Choose a month" },
            ui("div", { className: "lowcord-months-header" }, previous, title, next), grid);
        function render() {
            title.textContent = year;
            previous.disabled = year <= created.getFullYear();
            next.disabled = year >= now.getFullYear();
            grid.replaceChildren(...Array.from({ length: 12 }, (_, month) => {
                const index = year * 12 + month;
                const button = ui("button", { type: "button", className: "lowcord-months-month", disabled: index < first || index > last,
                    "aria-label": monthFormat.format(new Date(year, month, 1)), onClick: () => goToMonth(year, month) },
                    shortMonth.format(new Date(year, month, 1)));
                if (pane.state.months.has(`${year}-${month}`)) button.setAttribute("data-loaded", "");
                if (year === date.getFullYear() && month === date.getMonth()) button.setAttribute("aria-current", "true");
                return button;
            }));
        }
        render();
        pane.node.append(node);
        // Below the heading, across the grid's width.
        const paneBox = pane.node.getBoundingClientRect(), box = heading.getBoundingClientRect(), gridBox = pane.grid.getBoundingClientRect();
        node.style.left = `${gridBox.left - paneBox.left}px`;
        node.style.width = `${gridBox.width}px`;
        node.style.top = `${Math.min(box.bottom - paneBox.top + 4, paneBox.height - node.offsetHeight - 12)}px`;
        heading.setAttribute("aria-expanded", "true");
        const outside = event => { if (!node.contains(event.target) && !heading.contains(event.target)) hideMonths(); };
        const key = event => {
            if (event.key !== "Escape") return;
            event.preventDefault(); event.stopImmediatePropagation();
            hideMonths(); heading.focus();
        };
        months = { node, heading, listeners: [["pointerdown", outside, true], ["keydown", key, true]] };
        for (const [type, fn, capture] of months.listeners) window.addEventListener(type, fn, capture);
        (grid.querySelector('[aria-current="true"]') ?? grid.querySelector("button:not(:disabled)"))?.focus();
    }

    // ----- Tile menu ----------------------------------------------------------
    // A right-click menu in the style of Discord's own: copy the media's
    // original link, or jump to its message.
    let menu;
    async function copyLink(link) {
        try { await navigator.clipboard.writeText(link); extensions.toast("Link copied"); }
        catch { extensions.toast("Couldn’t copy the link. Please try again.", true); }
    }
    function hideMenu() {
        if (!menu) return;
        menu.node.remove();
        for (const [type, fn, capture] of menu.listeners) window.removeEventListener(type, fn, capture);
        menu = undefined;
    }
    function showMenu(event, item, button) {
        event.preventDefault(); event.stopPropagation();
        hideMenu();
        const entry = (label, action) => ui("button", { type: "button", role: "menuitem", className: "lowcord-menu-item",
            onClick: () => { hideMenu(); action(); } }, label);
        const items = [item.link && entry("Copy media link", () => copyLink(item.link)), entry("Jump to message", () => jump(item, button))].filter(Boolean);
        const node = ui("div", { className: "lowcord-menu", role: "menu", "aria-label": "Media options" }, ...items);
        document.body.append(node);
        // Opens at the pointer, kept on screen.
        const { width, height } = node.getBoundingClientRect();
        const x = event.clientX || button.getBoundingClientRect().left, y = event.clientY || button.getBoundingClientRect().bottom;
        node.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
        node.style.top = `${Math.max(8, y + height + 8 > innerHeight ? y - height : y)}px`;
        const outside = pointer => { if (!node.contains(pointer.target)) hideMenu(); };
        const key = keyEvent => {
            if (keyEvent.key === "Escape") { keyEvent.preventDefault(); keyEvent.stopImmediatePropagation(); hideMenu(); button.focus(); return; }
            if (keyEvent.key !== "ArrowDown" && keyEvent.key !== "ArrowUp") return;
            keyEvent.preventDefault();
            const buttons = [...node.querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
            buttons[(index + (keyEvent.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
        };
        menu = { node, listeners: [["pointerdown", outside, true], ["keydown", key, true], ["blur", hideMenu, false], ["resize", hideMenu, false], ["wheel", hideMenu, true]] };
        for (const [type, fn, capture] of menu.listeners) window.addEventListener(type, fn, capture);
        node.querySelector("button").focus();
    }
    window.addEventListener("keydown", event => {
        // The month picker handles its own Escape.
        if (event.key !== "Escape" || !pane || months || !pane.node.contains(document.activeElement)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        closePane();
    }, true);
    // A new chat refreshes the pane; leaving chats closes it.
    function followChannel() {
        if (!pane) return;
        const target = currentChannel();
        if (!target) { closePane(); return; }
        place();
        if (target.channelId !== pane.state.target.channelId) reset(target);
    }

    // ----- Header button ------------------------------------------------------
    // Styled like Discord's own header icons by borrowing their classes.
    function updateButtons() {
        for (const button of document.querySelectorAll(".lowcord-media-button")) button.setAttribute("aria-pressed", String(Boolean(pane)));
    }
    function placeButtons(event) {
        followChannel();
        if (!window.Lowcord.domChanged(event, 'section[class*="title_"]')) return;
        const show = extensions.enabled("mediaGallery");
        if (!show && pane) closePane();
        for (const toolbar of document.querySelectorAll('section[class*="title_"] [class*="toolbar_"]')) {
            const existing = toolbar.querySelector(":scope > .lowcord-media-button");
            if (!show) { existing?.remove(); continue; }
            if (existing) continue;
            const native = toolbar.querySelector(':scope > [class*="iconWrapper_"]');
            const nativeIcon = native?.querySelector("svg");
            const icon = svg(galleryPath, 24);
            if (nativeIcon?.getAttribute("class")) icon.setAttribute("class", nativeIcon.getAttribute("class"));
            const button = ui("div", { role: "button", tabindex: "0", className: `${native?.className ?? ""} lowcord-media-button`.trim(),
                "aria-label": "Media", title: "Media", "aria-pressed": String(Boolean(pane)), onClick: toggle,
                onKeydown: keyEvent => { if (keyEvent.key === "Enter" || keyEvent.key === " ") { keyEvent.preventDefault(); toggle(); } } }, icon);
            // Beside Pinned Messages, ahead of search.
            const search = toolbar.querySelector(':scope > [class*="search_"]');
            const pins = [...toolbar.querySelectorAll(':scope > [class*="iconWrapper_"]')].find(node => /pin/i.test(node.getAttribute("aria-label") ?? ""));
            if (pins) pins.after(button); else if (search) search.before(button); else toolbar.append(button);
        }
    }
    window.Lowcord.onDomChange(placeButtons);
    window.addEventListener(extensions.changeEvent, placeButtons);

    // ----- Copy media link in chats -------------------------------------------
    // Discord's web menu for a message has no media items. A right-click on a
    // photo or video remembers its original link; when Discord's message menu
    // opens, a "Copy Media Link" item joins it, styled from its own items.
    const linkPath = "M16.32 14.72a1 1 0 0 1 0-1.41l2.51-2.51a3.98 3.98 0 0 0-5.62-5.63l-2.52 2.51a1 1 0 0 1-1.41-1.41l2.52-2.52a5.98 5.98 0 0 1 8.45 8.46l-2.52 2.51a1 1 0 0 1-1.41 0ZM7.68 9.29a1 1 0 0 1 0 1.41l-2.52 2.51a3.98 3.98 0 1 0 5.63 5.63l2.51-2.52a1 1 0 0 1 1.42 1.42l-2.52 2.51a5.98 5.98 0 0 1-8.45-8.45l2.51-2.51a1 1 0 0 1 1.42 0Zm1.92 6.37a1 1 0 0 1-1.41-1.41l6.07-6.07a1 1 0 1 1 1.41 1.41l-6.07 6.07Z";
    const skipImages = '[class*="emoji"], [class*="avatar"], [class*="icon"], [class*="reaction"]';
    function mediaLink(target) {
        const accessories = target instanceof Element ? target.closest('[id^="message-accessories-"]') : null;
        if (!accessories || target.closest('[class*="reactions_"]')) return null;
        for (let node = target; node && node !== accessories; node = node.parentElement) {
            const original = node.matches('a[class*="originalLink_"]') ? node : node.querySelector(':scope > a[class*="originalLink_"]');
            if (original?.href) return original.href;
            const media = (node.matches("video, img") ? [node] : [...node.querySelectorAll("video, img")]).filter(element => !element.matches(skipImages));
            if (media.length > 1) return null;
            const source = media[0] && (media[0].currentSrc || media[0].src || media[0].querySelector?.("source")?.src);
            if (source && /^https?:/.test(source)) return source;
        }
        return null;
    }
    function addMenuItem(menu, link) {
        if (menu.querySelector("#message-lowcord-copy-media")) return;
        // Beside Copy Text, the other copy items; any plain item otherwise.
        const model = ["#message-copy-text", "#message-copy-link", '[role="menuitem"]:not([id*="quickreact"])']
            .map(selector => menu.querySelector(selector)).find(Boolean);
        if (!model) return;
        const item = model.cloneNode(true);
        item.id = "message-lowcord-copy-media";
        item.removeAttribute("aria-disabled");
        item.className = [...item.classList].filter(name => !/^(focused|disabled)_/.test(name)).join(" ") + " lowcord-copy-media";
        // Discord highlights the item its menu has focused, through a hashed
        // class that shares the item class's suffix. Its menu never focuses
        // this item, so hovering it borrows that class, and the item Discord
        // still has focused is shown plain meanwhile.
        const suffix = /^item(_\w+)$/.exec([...item.classList].find(name => /^item_/.test(name)) ?? "")?.[1];
        const focusedClass = suffix ? `focused${suffix}` : "lowcord-copy-media-focused";
        const highlight = on => {
            item.classList.toggle(focusedClass, on);
            menu.toggleAttribute("data-lowcord-media-hover", on);
        };
        const text = item.querySelector('[data-text-variant], [class*="label_"]');
        if (text) text.textContent = "Copy Media Link"; else item.textContent = "Copy Media Link";
        const icon = item.querySelector("svg");
        if (icon) icon.innerHTML = `<path fill="currentColor" d="${linkPath}"/>`;
        const choose = event => {
            event.preventDefault(); event.stopPropagation();
            copyLink(link);
            // Discord's layer closes on Escape.
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        };
        item.addEventListener("click", choose);
        item.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") choose(event); });
        item.addEventListener("pointerenter", () => highlight(true));
        item.addEventListener("pointerleave", () => highlight(false));
        item.addEventListener("focus", () => highlight(true));
        item.addEventListener("blur", () => highlight(false));
        model.before(item);
        // An unhighlighted item's colours, for the item Discord still has focused.
        const plain = getComputedStyle(item);
        menu.style.setProperty("--lowcord-menu-item-bg", plain.backgroundColor);
        menu.style.setProperty("--lowcord-menu-item-color", plain.color);
    }
    window.addEventListener("contextmenu", event => {
        if (!extensions.enabled("copyMediaLink")) return;
        const link = mediaLink(event.target);
        if (!link) return;
        // The menu renders within a few frames of the click.
        let frames = 0;
        const look = () => {
            const menu = document.querySelector('#message[role="menu"]');
            if (menu) addMenuItem(menu, link);
            else if (++frames < 30) requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
    }, true);

    window.Lowcord.mediaGallery = { open, close: closePane, toggle, timing, get isOpen() { return Boolean(pane); } };
})();
