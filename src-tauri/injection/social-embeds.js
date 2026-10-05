// Social post cards: one consistent card per supported post link, with every
// image and video of a carousel or gallery. Post data and media come from the
// native side (social-posts.cjs); Discord keeps sending and native embeds,
// which are hidden only once a card for the same post has rendered.
(() => {
    const { socialLinks: links, extensions } = window.Lowcord;
    const rowSelector = '[id^="chat-messages-"]';
    const ownSelector = '.lowcord-social-embeds, .lowcord-social-lightbox';
    // Fix providers such as vxReddit answer with a components embed, not an article.
    const embedSelector = '[id^="message-accessories-"] article, [id^="message-accessories-"] [class*="embedWrapper_"], '
        + '[id^="message-accessories-"] [class*="componentEmbedContainer_"]';
    const posts = new Map(), rows = new Set(), rowState = new WeakMap();
    let frame;

    // ----- Data ---------------------------------------------------------------
    function load(target) {
        const known = posts.get(target.key);
        if (known) return known;
        const entry = { status: "pending", post: null };
        const fetchPost = window.__LOWCORD_NATIVE__?.socialPost;
        if (!fetchPost) { entry.status = "failed"; return entry; }
        if (posts.size >= 300) posts.delete(posts.keys().next().value);
        posts.set(target.key, entry);
        Promise.resolve(fetchPost(target.url)).then(post => {
            entry.post = post && Array.isArray(post.media) ? post : null;
            entry.status = entry.post ? "ready" : "failed";
        }, () => { entry.status = "failed"; }).finally(() => {
            document.querySelectorAll(rowSelector).forEach(row => { if (rowState.get(row)?.keys.includes(target.key)) rows.add(row); });
            schedule();
        });
        return entry;
    }

    // ----- Card -------------------------------------------------------------
    const el = (tag, className, props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);
    const icon = path => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="currentColor" d="${path}"/>`;
        return node;
    };
    const paths = {
        replies: "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
        comments: "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
        reposts: "M7 7h10V4l4 4-4 4V9H7v3H5V9a2 2 0 0 1 2-2Zm10 10H7v3l-4-4 4-4v3h10v-3h2v3a2 2 0 0 1-2 2Z",
        likes: "M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 5 6.4 5c2 0 3.6 1.1 4.6 2.6l1 1.4 1-1.4C14 6.1 15.6 5 17.6 5 21 5 23.1 8.4 21.6 11.8 19.5 16.4 12 21 12 21Z",
        score: "M12 3 4 12h5v9h6v-9h5l-8-9Z",
        views: "M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7Zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
        bookmarks: "M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z",
    };
    const labels = { replies: "replies", comments: "comments", reposts: "reposts", likes: "likes", score: "points", views: "views", bookmarks: "bookmarks" };
    const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    const link = (className, href, text) => {
        const node = el("a", className, { href, target: "_blank", rel: "noopener noreferrer" });
        node.textContent = text;
        return node;
    };
    const safeUrl = value => { try { return ["https:", "http:"].includes(new URL(value).protocol) ? value : null; } catch { return null; } };
    const mediaUrl = value => typeof value === "string" && /^(?:lowcord-media:\/\/media\/[\da-f]+|https?:\/\/|data:image\/|blob:)/.test(value) ? value : null;

    function openLightbox(src, alt) {
        const box = el("div", "lowcord-social-lightbox", { role: "dialog", ariaModal: "true", ariaLabel: "Image viewer", tabIndex: -1 });
        const image = el("img", "", { src, alt: alt ?? "" });
        const close = () => { box.remove(); window.removeEventListener("keydown", key, true); };
        const key = event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); } };
        box.addEventListener("click", close);
        window.addEventListener("keydown", key, true);
        box.append(image);
        document.body.append(box);
        box.focus();
    }
    function slide(item, index, total) {
        const node = el("div", "lowcord-social-slide", { role: "group", ariaRoleDescription: "slide", ariaLabel: `${index + 1} of ${total}` });
        const src = mediaUrl(item.src), poster = mediaUrl(item.poster);
        const picture = source => {
            const image = el("img", "", { src: source, alt: item.alt ?? "", loading: "lazy", decoding: "async" });
            image.addEventListener("click", () => openLightbox(source, item.alt));
            return image;
        };
        if (item.type === "video" && src) {
            // A GIF plays like one: silent, looping, without controls.
            const video = item.gif ? el("video", "", { src, muted: true, autoplay: true, loop: true, playsInline: true, preload: "auto" })
                : el("video", "", { src, controls: true, playsInline: true, preload: poster ? "none" : "metadata", loop: Boolean(item.loop) });
            if (poster) video.poster = poster;
            if (!item.gif) video.volume = (extensions.options.musicVolume ?? 50) / 100;
            // A provider may label an image as a video; fall back to its poster.
            video.addEventListener("error", () => { if (poster) video.replaceWith(picture(poster)); }, { once: true });
            node.append(video);
        } else if (src) node.append(picture(src));
        return node;
    }
    function carousel(post, hidden) {
        const items = post.media.filter(item => mediaUrl(item?.src));
        if (!items.length) return null;
        const first = items[0];
        const ratio = first.width > 0 && first.height > 0 ? Math.min(1.91, Math.max(0.56, first.width / first.height)) : 1;
        const root = el("div", "lowcord-social-carousel");
        root.style.setProperty("--lowcord-social-ratio", String(ratio));
        const track = el("div", "lowcord-social-track", { tabIndex: 0, role: "region", ariaRoleDescription: "carousel",
            ariaLabel: items.length > 1 ? `${items.length} media items` : "Media" });
        items.forEach((item, index) => track.append(slide(item, index, items.length)));
        root.append(track);
        if (items.length > 1) {
            const count = el("span", "lowcord-social-count", { ariaLive: "polite" });
            const previous = el("button", "lowcord-social-nav lowcord-social-prev", { type: "button", ariaLabel: "Previous item" });
            const next = el("button", "lowcord-social-nav lowcord-social-next", { type: "button", ariaLabel: "Next item" });
            previous.append(icon("M15 5 8 12l7 7"));
            next.append(icon("m9 5 7 7-7 7"));
            const dots = el("div", "lowcord-social-dots", { ariaHidden: "true" });
            items.forEach(() => dots.append(el("span")));
            const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
            const go = index => track.scrollTo({ left: Math.max(0, Math.min(items.length - 1, index)) * track.clientWidth,
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
            let pending;
            const update = () => {
                pending = undefined;
                const index = current();
                count.textContent = `${index + 1} / ${items.length}`;
                previous.disabled = index === 0;
                next.disabled = index === items.length - 1;
                [...dots.children].forEach((dot, position) => dot.classList.toggle("lowcord-social-dot-active", position === index));
                [...track.children].forEach((slide, position) => { if (position !== index) slide.querySelector("video")?.pause(); });
            };
            track.addEventListener("scroll", () => { pending ??= requestAnimationFrame(update); }, { passive: true });
            previous.addEventListener("click", () => go(current() - 1));
            next.addEventListener("click", () => go(current() + 1));
            track.addEventListener("keydown", event => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault(); event.stopPropagation();
                go(current() + (event.key === "ArrowRight" ? 1 : -1));
            });
            root.append(previous, next, count, dots);
            update();
        }
        if (hidden) {
            root.classList.add("lowcord-social-concealed");
            const reveal = el("button", "lowcord-social-reveal", { type: "button" });
            reveal.textContent = `${hidden} · Show`;
            reveal.addEventListener("click", () => { root.classList.remove("lowcord-social-concealed"); reveal.remove(); });
            root.append(reveal);
        }
        return root;
    }
    function card(post, key, nsfwChannel) {
        const root = el("article", "lowcord-social-card");
        root.dataset.socialKey = key;
        root.style.setProperty("--lowcord-social-accent", /^#[\da-f]{6}$/i.test(post.color ?? "") ? post.color : "#5865f2");
        const postUrl = safeUrl(post.url);
        const header = el("header", "lowcord-social-header");
        const avatar = mediaUrl(post.author?.avatar);
        if (avatar) header.append(el("img", "lowcord-social-avatar", { src: avatar, alt: "", loading: "lazy" }));
        const who = el("div", "lowcord-social-who");
        const authorUrl = safeUrl(post.author?.url);
        const name = post.author?.name || post.service;
        who.append(authorUrl ? link("lowcord-social-name", authorUrl, name) : Object.assign(el("strong", "lowcord-social-name"), { textContent: name }));
        if (post.author?.handle) who.append(Object.assign(el("span", "lowcord-social-handle"), { textContent: post.author.handle }));
        header.append(who);
        if (postUrl) header.append(link("lowcord-social-service", postUrl, post.service));
        root.append(header);
        if (post.title) root.append(postUrl ? link("lowcord-social-title", postUrl, post.title)
            : Object.assign(el("strong", "lowcord-social-title"), { textContent: post.title }));
        if (post.text) {
            const body = el("p", "lowcord-social-text", { textContent: post.text });
            root.append(body);
            if (post.text.length > 300 || post.text.split("\n").length > 6) {
                const more = el("button", "lowcord-social-more", { type: "button", textContent: "Show more" });
                more.addEventListener("click", () => {
                    const open = body.classList.toggle("lowcord-social-text-open");
                    more.textContent = open ? "Show less" : "Show more";
                });
                root.append(more);
            }
        }
        const hidden = post.spoiler ? "Spoiler" : post.sensitive && !nsfwChannel ? "Sensitive content" : null;
        const media = carousel(post, hidden);
        if (media) root.append(media);
        const footer = el("footer", "lowcord-social-footer");
        for (const [stat, value] of Object.entries(post.stats ?? {})) {
            if (!Number.isFinite(value) || !paths[stat]) continue;
            const item = el("span", "lowcord-social-stat", { title: `${value.toLocaleString()} ${labels[stat]}` });
            item.append(icon(paths[stat]), compact.format(value));
            footer.append(item);
        }
        if (Number.isFinite(post.created)) footer.append(Object.assign(el("time", "lowcord-social-time"),
            { dateTime: new Date(post.created).toISOString(), textContent: when.format(post.created) }));
        if (footer.childElementCount) root.append(footer);
        return root;
    }

    // ----- Rows ---------------------------------------------------------------
    // Native embeds often link only to the author (X, Instagram), so match them
    // to the message's embed URLs: Discord renders one per distinct URL, in order.
    function hideNative(row, keys, message) {
        const native = [...row.querySelectorAll(embedSelector)].filter(embed => {
            const outer = embed.parentElement?.closest(embedSelector);
            return !(outer && row.contains(outer));
        });
        const urls = [...new Set((message?.embeds ?? []).map(embed => embed?.url).filter(Boolean))];
        native.forEach((embed, index) => {
            const match = urls.length === native.length ? keys.has(links.parse(urls[index])?.key)
                : [...embed.querySelectorAll("a[href]")].some(anchor => keys.has(links.parse(anchor.href)?.key));
            if (match) embed.dataset.lowcordSocialHidden = "true";
            else delete embed.dataset.lowcordSocialHidden;
        });
    }
    function updateRow(row) {
        if (!row.isConnected) return;
        const ids = /^chat-messages-(\d+)-(\d+)$/.exec(row.id);
        if (!ids) return;
        const surface = row.querySelector(':scope > [data-list-item-id^="chat-messages"]') ?? row.firstElementChild;
        if (!surface) return;
        const message = window.Lowcord.store("MessageStore")?.getMessage?.(ids[1], ids[2]);
        // Read the markdown so code blocks and <suppressed> links are skipped.
        const suppressed = Boolean((message?.flags ?? 0) & 4);
        const targets = typeof message?.content === "string" && !suppressed ? links.collect(message.content, 3) : [];
        const entries = targets.map(target => [target.key, load(target)]);
        const ready = entries.filter(([, entry]) => entry.status === "ready");
        const keys = new Set(ready.map(([key]) => key));
        // A share link (/r/sub/s/code) names the same post as the embed's permalink.
        hideNative(row, new Set(ready.flatMap(([key, entry]) => [key, links.parse(entry.post.url ?? "")?.key]).filter(Boolean)), message);
        // A message that is only the link reads as the card alone.
        const text = row.querySelector(`#message-content-${ids[2]}`);
        if (text) {
            const linkOnly = targets.length === 1 && keys.has(targets[0].key) && message.content.trim() === targets[0].url;
            if (linkOnly) text.dataset.lowcordSocialLinkOnly = "true";
            else delete text.dataset.lowcordSocialLinkOnly;
        }
        const nsfw = Boolean(window.Lowcord.store("ChannelStore")?.getChannel?.(ids[1])?.nsfw);
        const signature = `${nsfw}:${[...keys].join(",")}`;
        const prior = rowState.get(row);
        let host = surface.querySelector(":scope > .lowcord-social-embeds");
        rowState.set(row, { keys: targets.map(target => target.key), signature });
        if (prior?.signature === signature && (!keys.size || host)) return;
        if (!keys.size) { host?.remove(); return; }
        if (!host) {
            host = el("div", "lowcord-social-embeds");
            surface.append(host);
        }
        const existing = new Map([...host.children].map(node => [node.dataset.socialKey, node]));
        const desired = ready.map(([key, entry]) => existing.get(key) ?? card(entry.post, key, nsfw));
        for (const node of host.children) if (!desired.includes(node)) node.remove();
        desired.forEach((node, index) => { if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null); });
    }
    function flush() {
        frame = undefined;
        if (!extensions.enabled("socialCards")) { rows.clear(); return; }
        for (const row of rows) updateRow(row);
        rows.clear();
    }
    function schedule() { frame ??= requestAnimationFrame(flush); }
    function refresh() {
        if (!extensions.enabled("socialCards")) {
            document.querySelectorAll(".lowcord-social-embeds").forEach(host => host.remove());
            document.querySelectorAll("[data-lowcord-social-hidden]").forEach(embed => delete embed.dataset.lowcordSocialHidden);
            document.querySelectorAll("[data-lowcord-social-link-only]").forEach(text => delete text.dataset.lowcordSocialLinkOnly);
            rows.clear(); return;
        }
        document.querySelectorAll(rowSelector).forEach(row => { rowState.delete(row); rows.add(row); });
        schedule();
    }
    window.addEventListener(extensions.changeEvent, refresh);
    function start() {
        new MutationObserver(records => {
            if (!extensions.enabled("socialCards")) return;
            for (const record of records) {
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                if (!target || target.closest(ownSelector)) continue;
                const added = [...record.addedNodes].filter(node => node instanceof Element && !node.matches(ownSelector));
                if (!added.length && ![...record.removedNodes].some(node => !(node instanceof Element && node.matches(ownSelector)))) continue;
                const row = target.closest(rowSelector);
                if (row) rows.add(row);
                for (const node of added) {
                    if (node.matches(rowSelector)) rows.add(node);
                    node.querySelectorAll(rowSelector).forEach(item => rows.add(item));
                }
            }
            if (rows.size) schedule();
        }).observe(document.body, { childList: true, subtree: true });
        refresh();
    }
    if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
    window.Lowcord.waitForStore("MessageStore", store => {
        // Store changes cover edits and suppression flags with no DOM change.
        store.addChangeListener?.(() => {
            if (!extensions.enabled("socialCards")) return;
            document.querySelectorAll(rowSelector).forEach(row => rows.add(row));
            schedule();
        });
        refresh();
    });
    window.Lowcord.socialEmbeds = { refresh };
})();
