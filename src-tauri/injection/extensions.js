// Lowcord's built-in extensions use Discord's own HTTP requests and official
// embed frames, so no Discord code is patched; voice messages use Discord's
// uploader and REST client from its module cache. Quick reply uses the native
// pending-reply action without modifying Discord's modules or message sending.
(() => {
    const storageKey = "lowcord.extensions";
    const catalog = [
        { id: "anonymiseFileNames", title: "Anonymise file names", description: "Uploads get a random 7-letter name. Extensions and spoilers stay." },
        { id: "voiceMessages", title: "Voice messages", description: "Record voice messages from the waveform button." },
        { id: "chatCapture", title: "Chat screenshots", description: "The camera button in the message bar captures every message from a first to a last one as a single image." },
        { id: "quickReply", title: "Quick reply", description: "Shift + ↑/↓ in an empty box picks a message to reply to. Esc cancels. Replaces Discord’s edit shortcut." },
        { id: "cleanUrls", title: "Clean links", description: "Strips tracking parameters like utm_ and fbclid from links you send." },
        { id: "silentTyping", title: "Silent typing", description: "Hides your typing indicator." },
        { id: "noTracking", title: "No tracking", description: "Blocks Discord analytics, crash reports and desktop app prompts." },
        { id: "youtubeAdblock", title: "YouTube ad block", description: "Blocks ads in YouTube embeds and Watch Together." },
        { id: "musicEmbeds", title: "Fix music embeds", description: "Playable Spotify and Apple Music previews, even when Discord shows a plain link." },
        { id: "socialEmbeds", title: "Auto social embeds", description: "Turns pasted X, Instagram, Bluesky, Reddit, TikTok and other post links into embeds. Picks a working provider." },
        { id: "socialCards", title: "Social post cards", description: "Shows social posts as one card with every image and video." },
        { id: "redditVideoUpload", title: "Reddit videos as files", description: "Sends a pasted Reddit video, with sound, as a file instead of the link." },
        { id: "instagramVideoUpload", title: "Instagram Reels as files", description: "Sends a pasted Instagram Reel or video as a file instead of the link." },
        { id: "twitterVideoUpload", title: "X videos as files", description: "Sends a pasted X video as a file instead of the link." },
        { id: "socialPhotoUpload", defaultEnabled: false, title: "Photos and carousels as files", description: "Sends the photos of a pasted Instagram, Reddit or X post, or a whole carousel, as files instead of the link." },
    ];
    const storage = window.Lowcord.storage;
    const changeEvent = "lowcord-extensions-change";
    function read() {
        let saved = {};
        try { saved = JSON.parse(storage.getItem(storageKey)) ?? {}; } catch {}
        return Object.fromEntries(catalog.map(({ id, defaultEnabled = true }) => [id, typeof saved[id] === "boolean" ? saved[id] : defaultEnabled]));
    }
    let state = read();
    const optionsKey = "lowcord.embed-options";
    const links = window.Lowcord.socialLinks;
    const musicLinks = window.Lowcord.musicLinks;
    function readOptions() {
        let saved = {};
        try { saved = JSON.parse(storage.getItem(optionsKey)) ?? {}; } catch {}
        return {
            musicVolume: Number.isFinite(saved.musicVolume) ? Math.max(0, Math.min(100, saved.musicVolume)) : 50,
            ...Object.fromEntries(Object.entries(links.providers).map(([site, hosts]) =>
                [`${site}Provider`, hosts.includes(saved[`${site}Provider`]) ? saved[`${site}Provider`] : "auto"])),
        };
    }
    let options = readOptions();
    function setOption(id, value) {
        if (id === "musicVolume") {
            if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Invalid volume");
        } else {
            const site = /^(\w+)Provider$/.exec(id)?.[1];
            if (!site || !Object.hasOwn(links.providers, site) || (value !== "auto" && !links.providers[site].includes(value))) throw new Error("Invalid provider");
        }
        const next = { ...options, [id]: value };
        try { storage.setItem(optionsKey, JSON.stringify(next)); }
        catch { throw new Error("Couldn’t save this setting. Please try again."); }
        options = next;
        window.dispatchEvent(new Event(changeEvent));
    }
    function syncEmbedPreferences() {
        window.__LOWCORD_NATIVE__?.setEmbedPreferences?.({ youtubeAdblock: state.youtubeAdblock,
            musicEmbeds: state.musicEmbeds, musicVolume: options.musicVolume })?.catch(error => console.warn("[lowcord] Embed settings:", error.message));
    }
    window.addEventListener(changeEvent, syncEmbedPreferences);
    syncEmbedPreferences();
    const enabled = id => state[id] === true;
    function set(id, value) {
        const next = { ...state, [id]: Boolean(value) };
        try { storage.setItem(storageKey, JSON.stringify(next)); }
        catch { throw new Error("Couldn’t save this setting. Please try again."); }
        state = next;
        window.dispatchEvent(new Event(changeEvent));
    }
    window.addEventListener("storage", event => {
        if (event.key === storageKey || event.key === null) { state = read(); window.dispatchEvent(new Event(changeEvent)); }
        if (event.key === optionsKey || event.key === null) { options = readOptions(); window.dispatchEvent(new Event(changeEvent)); }
    });

    // ----- Social links -----------------------------------------------------
    const generatedSocial = new Map();
    function socialContent(content) {
        if (!enabled("socialEmbeds")) return content;
        return links.rewrite(content, (target, original) => {
            if (!target.original) return null; // Keep a deliberately chosen fix URL.
            const preference = options[`${target.site}Provider`];
            const host = preference === "auto" ? links.providers[target.site][0] : preference;
            const result = `https://${host}${target.path}`;
            if (generatedSocial.size >= 128) generatedSocial.delete(generatedSocial.keys().next().value);
            generatedSocial.set(result, original);
            return host;
        });
    }
    function musicContent(content) {
        return enabled("musicEmbeds") ? musicLinks.normalize(content, links.mapUrls) : content;
    }
    async function checkedSocialContent(content) {
        const resolve = window.__LOWCORD_NATIVE__?.resolveSocialLink;
        if (!enabled("socialEmbeds") || !resolve) return content;
        const targets = new Map();
        links.rewrite(content, (target, value) => {
            if ((target.original || generatedSocial.has(value)) && targets.size < 6)
                targets.set(value, { target, original: generatedSocial.get(value) ?? value });
            return null;
        });
        if (!targets.size) return content;
        // Whole URLs: short links (redd.it, vm.tiktok.com) use another path.
        const replacements = new Map();
        await Promise.all([...targets].map(async ([value, { target, original }]) => {
            let timer;
            try {
                const replacement = await Promise.race([resolve(original, options[`${target.site}Provider`]),
                    new Promise(resolve => { timer = setTimeout(() => resolve(original), links.lookupTimeout(target.site) + 300); })]);
                const valid = links.parse(replacement);
                replacements.set(value, valid?.site === target.site && valid.path === target.path ? replacement : original);
            } catch { replacements.set(value, original); }
            finally { clearTimeout(timer); }
        }));
        return enabled("socialEmbeds") ? links.mapUrls(content, value => replacements.get(value)) : content;
    }
    // Paste events Lowcord dispatched itself; its own paste hooks skip them.
    const replayed = new WeakSet();
    // Discord's editor keeps its own copy of the text and ignores DOM edits
    // made outside an input event it handles; a text DOM edit alone leaves the
    // box showing text it can't send. A replayed paste goes through Discord's
    // own paste handling, like the user's.
    function insertText(editor, text) {
        if (editor instanceof HTMLTextAreaElement) {
            editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, "end");
            editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
            return true;
        }
        const data = new DataTransfer();
        data.setData("text/plain", text);
        const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
        replayed.add(paste);
        editor.dispatchEvent(paste);
        return paste.defaultPrevented || document.execCommand("insertText", false, text);
    }
    window.addEventListener("paste", event => {
        if (event.defaultPrevented || replayed.has(event) || event.clipboardData?.files.length) return;
        const editor = event.target instanceof Element ? event.target.closest('[contenteditable="true"][role="textbox"], textarea') : null;
        if (!editor?.closest('[class*="channelTextArea_"]') || editor.closest('[role="dialog"]')) return;
        const text = event.clipboardData?.getData("text/plain");
        if (!text || /`/.test(editor.value ?? editor.textContent)) return;
        // A post on its way to becoming files keeps its own link: the send
        // drops it, or rewrites it if the download fails after all.
        if (prepareVideo(editor, text.trim())) return;
        if (!enabled("socialEmbeds") && !enabled("musicEmbeds")) return;
        const replacement = musicContent(socialContent(text));
        if (replacement === text) return;
        // If insertion is unavailable, let the original paste through; the
        // send hook covers it. Discord's editor inserts a paste even after
        // preventDefault, so the original must not reach it as well.
        if (insertText(editor, replacement)) { event.preventDefault(); event.stopImmediatePropagation(); }
        // Warm the bounded, shared cache while the user composes their message.
        void checkedSocialContent(replacement);
    }, true);

    // ----- Reddit, Instagram and X videos, photos and carousels as files -------
    // Discord's per-user limit, raised by the current server's boost tier.
    function uploadLimit() {
        const mb = 1024 * 1024;
        const premium = window.Lowcord.store("UserStore")?.getCurrentUser?.()?.premiumType;
        const guildId = window.Lowcord.store("SelectedGuildStore")?.getGuildId?.();
        const tier = guildId ? window.Lowcord.store("GuildStore")?.getGuild?.(guildId)?.premiumTier : 0;
        return Math.max(premium === 2 ? 500 * mb : premium === 1 || premium === 3 ? 50 * mb : 10 * mb,
            tier === 3 ? 100 * mb : tier === 2 ? 50 * mb : 0);
    }
    // The pasted link shows at once. A single-video post, or a photo post or
    // carousel, downloads in the background and joins the composer's
    // attachments through Discord's own uploader, so it sends like any file;
    // the send hook drops the link. Each draft is tracked per channel and
    // post, so the same link can wait unsent in several DMs at once.
    const videoToggles = { reddit: "redditVideoUpload", instagram: "instagramVideoUpload", twitter: "twitterVideoUpload" };
    const videos = new Map();
    const draftId = (channelId, key) => `${channelId}:${key}`;
    function forgetVideo(id) {
        videos.delete(id);
    }
    // Names of the files in a channel's message draft; null when unknown.
    function draftFiles(channelId) {
        const uploads = window.Lowcord.store("UploadAttachmentStore")?.getUploads?.(channelId, 0);
        return Array.isArray(uploads) ? new Set(uploads.map(upload => upload?.filename ?? upload?.item?.file?.name)) : null;
    }
    // Discord's composer takes pasted files as attachments of the open channel.
    // It keeps only the first file of a paste, so each file is its own paste.
    function attachFiles(editor, files, channelId) {
        if (window.Lowcord.store("SelectedChannelStore")?.getChannelId?.() !== channelId) return false;
        const target = editor?.isConnected ? editor : document.querySelector('[class*="channelTextArea_"] [contenteditable="true"][role="textbox"]');
        if (!target || target.closest('[role="dialog"]')) return false;
        for (const file of files) {
            const data = new DataTransfer();
            data.items.add(file);
            target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
        }
        return true;
    }
    // Attaches a finished download to its draft. If the user has moved to
    // another channel, the files wait until they come back to it.
    function deliver(editor, entry, files, message) {
        if (attachFiles(editor, files, entry.channelId)) {
            entry.names = files.map(file => file.name);
            entry.pending = null;
            toast(message);
        } else if (window.Lowcord.store("SelectedChannelStore")?.getChannelId?.() !== entry.channelId) {
            entry.pending = { files, message };
            watchChannels();
        }
    }
    let watchingChannels = false;
    function watchChannels() {
        const store = window.Lowcord.store("SelectedChannelStore");
        if (watchingChannels || !store?.addChangeListener) return;
        watchingChannels = true;
        store.addChangeListener(() => {
            const channelId = store.getChannelId?.();
            const waiting = [...videos.values()].filter(entry => entry.pending && entry.channelId === channelId);
            if (!waiting.length) return;
            // The channel's composer mounts after the store changes.
            let tries = 0;
            const retry = () => {
                if (store.getChannelId?.() !== channelId) return;
                for (const entry of waiting) if (entry.pending) deliver(null, entry, entry.pending.files, entry.pending.message);
                if (waiting.some(entry => entry.pending) && ++tries < 40) setTimeout(retry, 100);
            };
            setTimeout(retry, 100);
        });
    }
    function prepareVideo(editor, link) {
        const target = links.parse(link);
        const native = window.__LOWCORD_NATIVE__;
        const channelId = window.Lowcord.store("SelectedChannelStore")?.getChannelId?.();
        const id = target && channelId ? draftId(channelId, target.key) : null;
        if (!id || !videoToggles[target.site]) return false;
        const prior = videos.get(id);
        if (prior) {
            // Files the user removed (or a cleared draft) leave a finished
            // entry behind; pasting the post again must download it again.
            const inDraft = draftFiles(channelId);
            if (!prior.done || prior.pending || !inDraft || prior.names?.some(name => inDraft.has(name))) return true;
            forgetVideo(id);
        }
        const videoOn = enabled(videoToggles[target.site]) && Boolean(native?.socialVideo);
        const photosOn = enabled("socialPhotoUpload") && Boolean(native?.socialMedia && native.socialPost);
        if (!videoOn && !photosOn) return false;
        const service = links.sites[target.site].name;
        const entry = { id, key: target.key, channelId, service, kind: "video", names: null };
        // Shown at once: finding the post can take a few seconds.
        entry.status = progress(`Checking the ${service} post…`);
        entry.work = (async () => {
            // A single-video post downloads as a video, any other post with
            // media as photos (and the videos of a carousel).
            // A GIF arrives as an MP4 and is sent as a GIF file.
            let post = null;
            try { post = await native.socialPost?.(link); } catch {}
            // The lookup failed. The download reads the post again, and
            // gives files only if the whole post comes back.
            if (!post && photosOn) { await prepareWhole(editor, link, entry); return; }
            if (post && !(post.media?.length === 1 && post.media[0].type === "video")) {
                if (photosOn && post.media?.length) await preparePhotos(editor, link, entry, post);
                return;
            }
            if (!videoOn) return;
            if (post) {
                entry.video = true;
                if (post.media[0].gif) entry.kind = "GIF";
                if (entry.announce) entry.announce();
                else entry.status.update(`Getting the ${service} ${entry.kind}…`, "It will be sent instead of the link.");
            }
            let result;
            try { result = await native.socialVideo(link, uploadLimit()); }
            catch { result = { error: "failed" }; }
            if (videos.get(id) !== entry || result?.error === "not-video") return;
            if (result?.gif) entry.kind = "GIF";
            if (result?.error === "too-large") { toast(`This ${service} ${entry.kind} is too large to upload, so the link will be sent.`, true); return; }
            if (!(result?.data instanceof Uint8Array)) { toast(`Couldn’t download that ${service} ${entry.kind}, so the link will be sent.`, true); return; }
            // A Reddit GIF that fits arrives as the GIF itself.
            let file = new File([result.data], result.name, { type: result.type === "image/gif" ? "image/gif" : "video/mp4" });
            if (result.gif && file.type !== "image/gif") {
                if (!entry.announce) entry.status.update(`Making the ${service} GIF…`, "It will be sent instead of the link.");
                let gif = null;
                try { gif = await window.Lowcord.gif?.fromVideo(result.data, uploadLimit()); } catch {}
                if (videos.get(id) !== entry) return;
                if (!gif) { toast(`Couldn’t make that ${service} GIF small enough to upload, so the link will be sent.`, true); return; }
                file = new File([gif], result.name.replace(/\.mp4$/, ".gif"), { type: "image/gif" });
            }
            file = anonymousFile(file);
            deliver(editor, entry, [file], `${service} ${entry.kind} attached. It will be sent instead of the link.`);
        })().finally(() => { entry.status.end(); entry.done = true; if (!entry.names && !entry.pending) forgetVideo(id); });
        // An entry holds only file names (Discord keeps the files), and lasts
        // until its draft is sent; the bound covers drafts left behind.
        if (videos.size >= 30) forgetVideo(videos.keys().next().value);
        videos.set(id, entry);
        return true;
    }
    async function prepareWhole(editor, link, entry) {
        const { service } = entry;
        const native = window.__LOWCORD_NATIVE__;
        entry.video = true;
        entry.kind = "post";
        if (entry.announce) entry.announce();
        else entry.status.update(`Getting the ${service} post…`, "It will be sent instead of the link.");
        let result;
        try { result = await native.socialMedia(link, uploadLimit()); }
        catch { result = { error: "failed" }; }
        if (videos.get(entry.id) !== entry) return;
        const sent = result?.files;
        const files = Array.isArray(sent) ? sent.filter(file => file?.data instanceof Uint8Array) : [];
        if (result?.error === "too-large") { toast(`This ${service} post is too large to upload, so the link will be sent.`, true); return; }
        if (result?.error === "too-many") { toast(`This ${service} post has more than 10 items, so the link will be sent.`, true); return; }
        if (!files.length || files.length !== sent.length) { toast(`Couldn’t get this ${service} post right now, so the link will be sent.`, true); return; }
        const attached = files.map(file => anonymousFile(new File([file.data], file.name, { type: file.type })));
        deliver(editor, entry, attached, `${service} post attached. It will be sent instead of the link.`);
    }
    async function preparePhotos(editor, link, entry, post) {
        const { service } = entry;
        const count = post.media.length;
        const photos = post.media.every(item => item.type === "image");
        const many = count > 1;
        entry.kind = photos ? (many ? "photos" : "photo") : "carousel";
        const these = many ? `One of the ${service} ${photos ? "photos" : "carousel’s items"} is` : `This ${service} photo is`;
        // Discord takes at most 10 files per message.
        if (count > 10) { toast(`This ${service} post has more than 10 items, so the link will be sent.`, true); return; }
        entry.video = true;
        entry.plural = many && photos;
        entry.count = count;
        const what = photos ? (many ? `${count} ${service} photos` : `the ${service} photo`) : `the ${service} carousel’s ${count} items`;
        if (entry.announce) entry.announce();
        else entry.status.update(`Getting ${what}…`, `${many ? "They" : "It"} will be sent instead of the link.`);
        let result;
        try { result = await window.__LOWCORD_NATIVE__.socialMedia(link, uploadLimit()); }
        catch { result = { error: "failed" }; }
        if (videos.get(entry.id) !== entry || result?.error === "not-media") return;
        if (result?.error === "too-large") { toast(`${these} too large to upload, so the link will be sent.`, true); return; }
        if (result?.error === "too-many") { toast(`This ${service} post has more than 10 items, so the link will be sent.`, true); return; }
        const files = Array.isArray(result?.files) ? result.files.filter(file => file?.data instanceof Uint8Array) : [];
        if (!files.length || files.length !== result.files.length) {
            toast(`Couldn’t download ${entry.plural ? "those" : "that"} ${service} ${entry.kind}, so the link will be sent.`, true);
            return;
        }
        const attached = files.map(file => anonymousFile(new File([file.data], file.name, { type: file.type })));
        const done = entry.plural ? `${count} ${service} photos` : `${service} ${entry.kind}`;
        deliver(editor, entry, attached, `${done} attached. ${entry.plural ? "They" : "It"} will be sent instead of the link.`);
    }
    const composerVideos = text => {
        const channelId = window.Lowcord.store("SelectedChannelStore")?.getChannelId?.();
        return links.collect(text, 10).map(target => videos.get(draftId(channelId, target.key))).filter(Boolean);
    };
    // A send before the download finishes waits for it, then sends with the file.
    window.addEventListener("keydown", event => {
        if (!videos.size || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
        const editor = event.target instanceof Element ? event.target.closest('[contenteditable="true"][role="textbox"], textarea') : null;
        if (!editor?.closest('[class*="channelTextArea_"]') || editor.getAttribute("aria-expanded") === "true") return;
        const queued = composerVideos(editor.value ?? editor.textContent);
        const waiting = queued.filter(entry => !entry.done);
        if (!waiting.length) {
            // The link leaves the composer before the send, so Discord's
            // upload row shows only the video, not the link beside it.
            const ready = queued.filter(entry => entry.names && !entry.stripped);
            if (!ready.length) return;
            ready.forEach(entry => { entry.stripped = true; });
            if (!removeLinks(editor, new Set(ready.map(entry => entry.key)))) return;
            event.preventDefault(); event.stopImmediatePropagation();
            setTimeout(() => {
                if (!editor.isConnected) return;
                editor.focus();
                editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }, 50);
            return;
        }
        event.preventDefault(); event.stopImmediatePropagation();
        if (waiting.some(entry => entry.held)) return;
        // Image posts are still being checked here; only a confirmed video
        // download is announced.
        let announced = false;
        const announce = () => {
            const video = waiting.find(entry => entry.video && !entry.done);
            if (announced || !video) return;
            announced = true;
            video.status.update(`Sending once the ${video.service} ${video.kind} ${video.plural ? "are" : "is"} ready…`, "Your message sends right after.");
        };
        waiting.forEach(entry => { entry.held = true; entry.announce = announce; });
        announce();
        void Promise.all(waiting.map(entry => entry.work)).then(() => {
            waiting.forEach(entry => { entry.held = false; entry.announce = null; });
            if (!editor.isConnected) return;
            // Let Discord add the attachment before the send reads it.
            setTimeout(() => {
                editor.focus();
                editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }, 50);
        });
    }, true);
    // Discord's composer is a Slate editor: DOM edits (even execCommand) are
    // repainted from its model and never reach the message it sends.
    function slateEditor(element) {
        const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
        let fiber = key && element[key];
        for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
            const editor = fiber.memoizedProps?.editor;
            if (typeof editor?.apply === "function" && Array.isArray(editor.children)) return editor;
        }
        return null;
    }
    // Finds each link in `text` whose post is one of `keys`.
    function linkRanges(text, keys) {
        const found = [];
        let from = 0;
        links.mapUrls(text, value => {
            const start = text.indexOf(value, from);
            if (start < 0) return null;
            from = start + value.length;
            if (keys.has(links.parse(value)?.key)) found.push({ start, text: value });
            return null;
        });
        return found;
    }
    // Deletes the given links from the composer, through Discord's own editor.
    function removeLinks(editor, keys) {
        if (editor instanceof HTMLTextAreaElement) {
            const text = links.mapUrls(editor.value, value => keys.has(links.parse(value)?.key) ? "" : null).trim();
            if (text === editor.value) return false;
            editor.value = text;
            editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContent" }));
            return true;
        }
        const slate = slateEditor(editor);
        if (slate) {
            const removals = [];
            const visit = (nodes, path) => nodes.forEach((node, index) => {
                if (typeof node.text === "string") {
                    for (const range of linkRanges(node.text, keys)) removals.push({ path: [...path, index], ...range });
                } else if (Array.isArray(node.children)) visit(node.children, [...path, index]);
            });
            visit(slate.children, []);
            // Last first, so earlier offsets stay valid.
            for (const { path, start, text } of removals.reverse()) slate.apply({ type: "remove_text", path, offset: start, text });
            return removals.length > 0;
        }
        // A plain contenteditable takes the DOM edit directly.
        const found = [];
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode())
            for (const range of linkRanges(node.data, keys)) found.push({ node, ...range });
        for (const { node, start, text } of found.reverse()) node.deleteData(start, text.length);
        return found.length > 0;
    }
    // Drops the link of each post sent as files with this message.
    function withoutVideoLinks(data) {
        const names = new Set((data.attachments ?? []).map(attachment => attachment.filename));
        if (!videos.size || typeof data.content !== "string" || !names.size) return false;
        const sent = [...videos.values()].filter(entry => entry.names?.some(name => names.has(name)));
        if (!sent.length) return false;
        const keys = new Set(sent.map(entry => entry.key));
        data.content = links.mapUrls(data.content, value => keys.has(links.parse(value)?.key) ? "" : null).trim();
        sent.forEach(entry => forgetVideo(entry.id));
        return true;
    }

    function messageRequest(method, url) {
        return (method === "POST" || method === "PATCH") && /^\/channels\/\d+\/messages(?:\/\d+)?$/.test(route(url)?.path ?? "");
    }
    function payloadOf(body) {
        try {
            const value = body instanceof FormData ? body.get("payload_json") : body;
            return typeof value === "string" ? JSON.parse(value) : null;
        } catch { return null; }
    }
    function withPayload(body, data) {
        if (!(body instanceof FormData)) return JSON.stringify(data);
        const form = new FormData();
        for (const [key, value] of body) form.append(key, key === "payload_json" ? JSON.stringify(data) : value);
        return form;
    }
    function hasSocialLinks(body) {
        const content = payloadOf(body)?.content;
        if (typeof content !== "string") return false;
        let found = false;
        links.rewrite(content, (target, value) => { if (target.original || generatedSocial.has(value)) found = true; return null; });
        return found;
    }
    async function checkMessageBody(body) {
        const data = payloadOf(body);
        if (typeof data?.content !== "string") return body;
        const next = await checkedSocialContent(data.content);
        if (data.content === next) return body;
        data.content = next;
        return withPayload(body, data);
    }


    // ----- Keyboard reply ----------------------------------------------------
    let replySelection, replyRow, createReply;
    function clearReplyHighlight() {
        replyRow?.removeAttribute("data-lowcord-quick-reply");
        replyRow = replySelection = undefined;
    }
    function reconcileReply() {
        if (!replySelection) return;
        const channelId = window.Lowcord.store("SelectedChannelStore")?.getChannelId();
        const pending = window.Lowcord.store("PendingReplyStore")?.getPendingReply(channelId);
        if (!enabled("quickReply") || channelId !== replySelection.channelId
            || pending?.message?.id !== replySelection.messageId || !replyRow?.isConnected) clearReplyHighlight();
    }
    function cancelQuickReply() {
        const channelId = replySelection?.channelId;
        clearReplyHighlight();
        if (channelId) window.Lowcord.Dispatcher?.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
    }
    function replyKey(event) {
        if (!enabled("quickReply") || event.defaultPrevented || event.isComposing || event.keyCode === 229
            || event.altKey || event.ctrlKey || event.metaKey) return;
        const editor = event.target instanceof Element ? event.target.closest('[contenteditable="true"][role="textbox"], textarea') : null;
        if (!editor?.closest('[class*="channelTextArea_"]') || editor.closest('[role="dialog"]')
            || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        // Let Discord's completion menus keep their own keyboard navigation.
        if (editor.getAttribute("aria-expanded") === "true" || editor.getAttribute("aria-activedescendant")) return;
        reconcileReply();
        if (event.key === "Escape" && !event.shiftKey && replySelection) {
            event.preventDefault(); event.stopImmediatePropagation();
            cancelQuickReply();
            return;
        }
        if (!event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)
            || (editor.value ?? editor.textContent).replace(/[\u200b\ufeff]/g, "").trim()) return;
        const channelId = window.Lowcord.store("SelectedChannelStore")?.getChannelId();
        const channel = window.Lowcord.store("ChannelStore")?.getChannel(channelId);
        const messages = window.Lowcord.store("MessageStore");
        const pendingStore = window.Lowcord.store("PendingReplyStore");
        createReply ??= window.Lowcord.find(window.Lowcord.filters.byCode("CREATE_PENDING_REPLY", "shouldMention", "showMentionToggle"));
        if (!channelId || !channel || !messages || !pendingStore || !createReply || !window.Lowcord.Dispatcher) return;
        // Scan only on a shortcut press; Discord owns history loading and
        // virtualization. Media messages are eligible, system rows are not.
        const candidates = [];
        for (const row of document.querySelectorAll('[id^="chat-messages-"]')) {
            const match = /^chat-messages-(\d+)-(\d+)$/.exec(row.id);
            if (match?.[1] !== channelId || !row.getClientRects().length) continue;
            const message = messages.getMessage(channelId, match[2]);
            if (message?.author && [0, 19].includes(message.type ?? 0) && !(message.flags & 64)
                && (message.state == null || message.state === "SENT")) candidates.push({ row, message });
        }
        if (!candidates.length) return;
        const pending = pendingStore.getPendingReply(channelId);
        const current = candidates.findIndex(({ message }) => message.id === pending?.message?.id);
        let next;
        if (event.key === "ArrowUp") next = current < 0 ? candidates.length - 1 : Math.max(0, current - 1);
        else {
            if (current < 0) return;
            next = current + 1;
        }
        event.preventDefault(); event.stopImmediatePropagation();
        if (next === candidates.length) {
            clearReplyHighlight();
            window.Lowcord.Dispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
            return;
        }
        const { row, message } = candidates[next];
        createReply({ channel, message,
            shouldMention: message.author.id !== window.Lowcord.store("UserStore")?.getCurrentUser()?.id,
            showMentionToggle: true });
        clearReplyHighlight();
        replySelection = { channelId, messageId: message.id };
        replyRow = row;
        row.setAttribute("data-lowcord-quick-reply", "true");
        row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        editor.focus({ preventScroll: true });
    }
    window.addEventListener("keydown", replyKey, true);
    window.addEventListener(changeEvent, reconcileReply);
    window.Lowcord.onDomChange(reconcileReply);
    for (const name of ["PendingReplyStore", "SelectedChannelStore", "MessageStore"]) {
        window.Lowcord.waitForStore(name, store => {
            store.addChangeListener?.(reconcileReply);
            reconcileReply();
        });
    }

    // ----- Request rules -----------------------------------------------------
    const api = /^\/api(?:\/v\d+)?(\/.*)$/;
    function route(url) {
        let parsed;
        try { parsed = new URL(url, location.href); } catch { return null; }
        const discord = parsed.origin === location.origin || parsed.hostname === "discord.com" || parsed.hostname.endsWith(".discord.com");
        return { url: parsed, path: discord ? api.exec(parsed.pathname)?.[1] ?? null : null };
    }
    const rpcPorts = port => Number(port) >= 6463 && Number(port) <= 6472;
    // "ok" answers like the server would, so Discord drops the batch instead of retrying.
    function decide(method, url) {
        const target = route(url);
        if (!target) return null;
        const { path } = target;
        if (enabled("silentTyping") && method === "POST" && /^\/channels\/\d+\/typing$/.test(path ?? "")) return "ok";
        if (enabled("noTracking")) {
            if (/^\/(science|track|metrics(\/v2)?)$/.test(path ?? "")) return "ok";
            // Discord tunnels Sentry crash reports through its own origin.
            if (target.url.pathname.startsWith("/error-reporting-proxy/") || /(^|\.)sentry\.io$/.test(target.url.hostname)) return "ok";
            // The desktop app's local RPC server, which Discord probes before deep linking.
            if (target.url.hostname === "127.0.0.1" && rpcPorts(target.url.port)) return "fail";
        }
        return null;
    }

    const random = length => {
        const letters = "abcdefghijklmnopqrstuvwxyz";
        const bytes = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(bytes, byte => letters[byte % letters.length]).join("");
    };
    function anonymous(name) {
        const spoiler = /^SPOILER_/.test(name) ? "SPOILER_" : "";
        const base = name.slice(spoiler.length);
        const ext = /\.tar\.\w+$/i.exec(base)?.[0] ?? (base.lastIndexOf(".") > 0 ? base.slice(base.lastIndexOf(".")) : "");
        return spoiler + random(7) + ext;
    }
    // Files are renamed as they reach the composer, so Discord's preview and
    // upload progress already show the random name. Discord adds SPOILER_ itself.
    const generated = new Set();
    const isGenerated = name => generated.has(name.replace(/^SPOILER_/, ""));
    function anonymousFile(file) {
        if (!enabled("anonymiseFileNames") || isGenerated(file.name)) return file;
        const name = anonymous(file.name);
        if (generated.size >= 512) generated.delete(generated.values().next().value);
        generated.add(name);
        return new File([file], name, { type: file.type, lastModified: file.lastModified });
    }
    function anonymousFiles(files) {
        const list = [...(files ?? [])];
        if (!enabled("anonymiseFileNames") || !list.length || list.every(file => isGenerated(file.name))) return null;
        const data = new DataTransfer();
        for (const file of list) data.items.add(anonymousFile(file));
        return data;
    }
    // Paste and drop data can't be edited, so the event is replayed with renamed files.
    function replayWithFiles(event, make) {
        if (replayed.has(event) || event.defaultPrevented) return;
        const data = anonymousFiles(event instanceof ClipboardEvent ? event.clipboardData?.files : event.dataTransfer?.files);
        if (!data) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const replay = make(data);
        replayed.add(replay);
        event.target.dispatchEvent(replay);
    }
    window.addEventListener("change", event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
        const data = anonymousFiles(input.files);
        if (data) input.files = data.files;
    }, true);
    window.addEventListener("drop", event => replayWithFiles(event, data => new DragEvent("drop", {
        bubbles: true, cancelable: true, composed: true, dataTransfer: data, clientX: event.clientX, clientY: event.clientY,
        screenX: event.screenX, screenY: event.screenY, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey })), true);
    window.addEventListener("paste", event => replayWithFiles(event, data => new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, composed: true, clipboardData: data })), true);

    // Discord registers each upload, then sends the message naming the same
    // files. Each original name maps to the random names given to it, in order.
    const renamed = new Map();
    function renameUpload(name) {
        if (isGenerated(name)) return name;
        const next = anonymous(name);
        renamed.set(name, [...(renamed.get(name) ?? []), next]);
        return next;
    }
    function renamedFor(name) {
        const queue = renamed.get(name);
        if (!queue?.length) return null;
        const next = queue.shift();
        if (!queue.length) renamed.delete(name);
        return next;
    }

    // Common tracking parameters, and ones that only mean tracking on one site.
    const trackingParams = /^(utm_\w+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|igsh|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|vero_id|oly_anon_id|oly_enc_id|rb_clickid|s_cid|wickedid|_ga|_gl|ncid|ref_src|ref_url|spm|scm|_branch_match_id|_branch_referrer)$/i;
    const siteParams = [
        [/(^|\.)(youtube\.com|youtu\.be)$/, /^(si|pp|feature)$/],
        [/(^|\.)spotify\.com$/, /^(si|context|nd)$/],
        [/(^|\.)(x\.com|twitter\.com)$/, /^(s|t)$/],
        [/(^|\.)tiktok\.com$/, /^(_r|_t|is_from_webapp|sender_device|is_copy_url|share_app_id|share_link_id|share_item_id|tt_from|u_code|user_id|timestamp|social_share_type|source)$/],
        [/(^|\.)reddit\.com$/, /^(share_id|rdt|ref|ref_source|correlation_id)$/],
        [/(^|\.)amazon\.[a-z.]+$/, /^(ref|ref_|psc|pd_rd_\w+|pf_rd_\w+|content-id|crid|sprefix|dib|dib_tag|qid|sr|keywords|th|linkCode|tag|linkId|camp|creative)$/],
        [/(^|\.)linkedin\.com$/, /^(trk|trkInfo|lipi|trackingId|originalSubdomain)$/],
        [/(^|\.)facebook\.com$/, /^(mibextid|rdid|share_url|sfnsn)$/],
        [/(^|\.)(threads\.net|threads\.com)$/, /^(xmt|slof)$/],
    ];
    function cleanUrl(text) {
        let url;
        try { url = new URL(text); } catch { return text; }
        const site = siteParams.filter(([host]) => host.test(url.hostname)).map(([, params]) => params);
        const remove = [...url.searchParams.keys()].filter(key => trackingParams.test(key) || site.some(params => params.test(key)));
        if (!remove.length) return text;
        for (const key of remove) url.searchParams.delete(key);
        return url.toString().replace(/\?$/, "");
    }
    // Discord's link syntax ends at whitespace or an angle bracket; trailing
    // punctuation belongs to the sentence, not the link.
    const cleanContent = content => content.replace(/https?:\/\/[^\s<>]+/g, match => {
        const tail = /[.,;:!?)\]'"]+$/.exec(match)?.[0] ?? "";
        return cleanUrl(match.slice(0, match.length - tail.length)) + tail;
    });

    // Returns a replacement body, or undefined to send the original.
    function rewrite(method, url, body) {
        const path = route(url)?.path;
        if (!path || (!enabled("anonymiseFileNames") && !enabled("cleanUrls") && !enabled("socialEmbeds") && !enabled("musicEmbeds") && !videos.size)) return undefined;
        const upload = method === "POST" && /^\/channels\/\d+\/attachments$/.test(path);
        const message = (method === "POST" || method === "PATCH") && /^\/channels\/\d+\/messages(\/\d+)?$/.test(path);
        if (!upload && !message) return undefined;
        if (body instanceof FormData) return rewriteForm(body);
        if (typeof body !== "string") return undefined;
        let data;
        try { data = JSON.parse(body); } catch { return undefined; }
        let changed = false;
        if (upload && enabled("anonymiseFileNames")) {
            for (const file of data.files ?? []) {
                if (typeof file.filename === "string") { file.filename = renameUpload(file.filename); changed = true; }
            }
        }
        if (message) {
            if (typeof data.content === "string") {
                const content = musicContent(socialContent(enabled("cleanUrls") ? cleanContent(data.content) : data.content));
                if (content !== data.content) { data.content = content; changed = true; }
            }
            if (enabled("anonymiseFileNames")) {
                for (const attachment of data.attachments ?? []) {
                    const name = typeof attachment.filename === "string" && renamedFor(attachment.filename);
                    if (name) { attachment.filename = name; changed = true; }
                }
            }
            if (method === "POST" && withoutVideoLinks(data)) changed = true;
        }
        return changed ? JSON.stringify(data) : undefined;
    }
    // The older multipart path carries files and a payload_json part.
    function rewriteForm(form) {
        const next = new FormData();
        let changed = false;
        for (const [key, value] of form.entries()) {
            if (value instanceof File && enabled("anonymiseFileNames") && !isGenerated(value.name)) {
                next.append(key, value, anonymous(value.name));
                changed = true;
            } else if (key === "payload_json" && typeof value === "string" && (enabled("cleanUrls") || enabled("socialEmbeds") || enabled("musicEmbeds") || videos.size)) {
                try {
                    const payload = JSON.parse(value);
                    if (typeof payload.content === "string") payload.content = musicContent(socialContent(enabled("cleanUrls") ? cleanContent(payload.content) : payload.content));
                    withoutVideoLinks(payload);
                    next.append(key, JSON.stringify(payload));
                    changed = true;
                } catch { next.append(key, value); }
            } else next.append(key, value);
        }
        return changed ? next : undefined;
    }

    // ----- Request hooks -----------------------------------------------------
    const xhr = XMLHttpRequest.prototype;
    const open = xhr.open, send = xhr.send, abort = xhr.abort;
    xhr.open = function (method, url) {
        this.__lowcord = { method: String(method).toUpperCase(), url: String(url), async: arguments[2] !== false };
        return open.apply(this, arguments);
    };
    xhr.abort = function () {
        const meta = this.__lowcord;
        const deferred = meta?.pending && !meta.sent && this.readyState === 1;
        if (meta) meta.cancelled = true;
        const result = abort.apply(this, arguments);
        // Native send has not begun during a provider lookup; still complete
        // the caller's cancellation lifecycle rather than leaving it waiting.
        if (deferred) {
            this.dispatchEvent(new ProgressEvent("abort"));
            this.dispatchEvent(new ProgressEvent("loadend"));
        }
        return result;
    };
    xhr.send = function (body) {
        const meta = this.__lowcord;
        if (meta) {
            if (meta.pending) throw new DOMException("Request already sent", "InvalidStateError");
            const verdict = decide(meta.method, meta.url);
            if (verdict) { answer(this, verdict); return; }
            const replacement = rewrite(meta.method, meta.url, body);
            if (replacement !== undefined) body = replacement;
            if (meta.async && enabled("socialEmbeds") && window.__LOWCORD_NATIVE__?.resolveSocialLink
                && messageRequest(meta.method, meta.url) && hasSocialLinks(body)) {
                if (this.readyState !== 1) return send.call(this, body);
                meta.pending = true;
                void checkMessageBody(body).catch(() => body).then(next => {
                    if (meta.cancelled || this.__lowcord !== meta || this.readyState !== 1) return;
                    try { meta.sent = true; send.call(this, next); }
                    catch { this.dispatchEvent(new ProgressEvent("error")); this.dispatchEvent(new ProgressEvent("loadend")); }
                });
                return;
            }
        }
        return send.call(this, body);
    };
    function answer(request, verdict) {
        const ok = verdict === "ok";
        const values = { readyState: 4, status: ok ? 204 : 0, statusText: ok ? "No Content" : "",
            responseText: "", response: request.responseType === "json" ? null : "", responseURL: request.__lowcord.url };
        for (const [key, value] of Object.entries(values)) Object.defineProperty(request, key, { configurable: true, get: () => value });
        request.getAllResponseHeaders = () => "";
        request.getResponseHeader = () => null;
        setTimeout(() => {
            for (const type of ["readystatechange", ok ? "load" : "error", "loadend"]) request.dispatchEvent(new ProgressEvent(type));
        });
    }
    const nativeFetch = window.fetch;
    window.fetch = async function (input, init) {
        const url = input instanceof Request ? input.url : String(input);
        const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const verdict = decide(method, url);
        if (verdict === "ok") return Promise.resolve(new Response(null, { status: 204 }));
        if (verdict === "fail") return Promise.reject(new TypeError("Failed to fetch"));
        let body = init?.body;
        const requestBody = body === undefined && input instanceof Request && messageRequest(method, url);
        if (requestBody) {
            try { body = await input.clone().text(); } catch { return nativeFetch.call(this, input, init); }
        }
        if (body !== undefined) {
            body = rewrite(method, url, body) ?? body;
            if (messageRequest(method, url)) body = await checkMessageBody(body);
            if (requestBody) input = new Request(input, { body });
            else init = { ...init, body };
        }
        return nativeFetch.call(this, input, init);
    };
    const beacon = navigator.sendBeacon?.bind(navigator);
    if (beacon) navigator.sendBeacon = (url, data) => decide("POST", String(url)) ? true : beacon(url, data);
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
            const url = route(String(args[0]))?.url;
            if (enabled("noTracking") && url?.hostname === "127.0.0.1" && rpcPorts(url.port)) {
                // Discord treats a constructor error as "desktop app not running".
                throw new DOMException("Blocked by OrbitCord", "SecurityError");
            }
            return Reflect.construct(target, args);
        }
    });

    // ----- Voice messages ----------------------------------------------------
    const ui = (tag, props = {}, ...children) => {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
            else if (key === "className" || key === "textContent" || key === "disabled" || key === "hidden") node[key] = value;
            else node.setAttribute(key, value);
        }
        node.append(...children.filter(child => child != null));
        return node;
    };
    const svg = path => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("width", "20"); node.setAttribute("height", "20");
        node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="currentColor" d="${path}"/>`;
        return node;
    };
    const micPath = "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm7 9a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11Z";
    const waveformPath = "M3 9a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-3 0v-3A1.5 1.5 0 0 1 3 9Zm4.5-4A1.5 1.5 0 0 1 9 6.5v11a1.5 1.5 0 0 1-3 0v-11A1.5 1.5 0 0 1 7.5 5ZM12 2a1.5 1.5 0 0 1 1.5 1.5v17a1.5 1.5 0 0 1-3 0v-17A1.5 1.5 0 0 1 12 2Zm4.5 4A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-3 0v-9A1.5 1.5 0 0 1 16.5 6ZM21 9a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-3 0v-3A1.5 1.5 0 0 1 21 9Z";

    // ----- Toasts -------------------------------------------------------------
    // A headline and, quieter below it, what happens next. A message written
    // as one string splits at its first sentence, or at ", so ...".
    function splitMessage(message) {
        const so = /^(.+?),\s+so\s+(.+?)\.?$/s.exec(message);
        if (so) return [so[1], `${so[2][0].toUpperCase()}${so[2].slice(1)}.`];
        const sentence = /^(.+?[.!?])\s+(\S.*)$/s.exec(message);
        return sentence ? [sentence[1].replace(/\.$/, ""), sentence[2]] : [message, ""];
    }
    const svgNs = "http://www.w3.org/2000/svg";
    const toastIcons = {
        progress: [["circle", { cx: 12, cy: 12, r: 9, class: "lowcord-toast-track" }], ["path", { d: "M21 12a9 9 0 0 0-9-9", class: "lowcord-toast-arc" }]],
        success: [["path", { d: "M5.5 12.5 10 17l8.5-9.5", class: "lowcord-toast-check" }]],
        failure: [["path", { d: "M12 7v6.2M12 17.2v.1" }]],
    };
    function toastIcon(tone) {
        const svg = document.createElementNS(svgNs, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("class", `lowcord-toast-icon lowcord-toast-icon-${tone}`);
        for (const [tag, attributes] of toastIcons[tone]) {
            const part = document.createElementNS(svgNs, tag);
            for (const [name, value] of Object.entries(attributes)) part.setAttribute(name, value);
            svg.append(part);
        }
        return svg;
    }
    function buildToast(tone, title, detail, action) {
        const copy = ui("span", { className: "lowcord-toast-copy" }, ui("span", { className: "lowcord-toast-title" }, title));
        if (detail) copy.append(ui("span", { className: "lowcord-toast-detail" }, detail));
        const button = action && ui("button", { type: "button", className: "lowcord-toast-action",
            onClick: () => { dismissToast(toast); action.onClick(); } }, action.label);
        const toast = ui("div", { className: `lowcord-toast lowcord-toast-${tone}`, role: "status" },
            ui("span", { className: "lowcord-toast-badge", "aria-hidden": "true" }, toastIcon(tone)), copy, button);
        return toast;
    }
    // One toast at a time. A toast that replaces another settles into its
    // place instead of arriving again.
    function showToast(toast) {
        const previous = document.querySelectorAll(".lowcord-toast");
        previous.forEach(old => old.remove());
        if (previous.length) toast.classList.add("lowcord-toast-swap");
        document.body.append(toast);
    }
    function dismissToast(toast) {
        if (!toast?.isConnected) return;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) { toast.remove(); return; }
        toast.classList.add("lowcord-toast-out");
        // Only the exit counts: the entrance and the check-mark draw end too.
        toast.addEventListener("animationend", event => { if (event.target === toast && event.animationName === "lowcord-toast-out") toast.remove(); });
        setTimeout(() => toast.remove(), 400);
    }
    function toast(message, failure = false, action = null) {
        // A message ending in an ellipsis is work still going on.
        const tone = failure ? "failure" : /…$/.test(message) ? "progress" : "success";
        const [title, detail] = splitMessage(message);
        const toast = buildToast(tone, title, detail, action);
        showToast(toast);
        // Leave time to reach an action button.
        setTimeout(() => dismissToast(toast), action ? 8000 : 4000);
        return toast;
    }
    // A status that stays, with a spinner, while work runs; a toast with the
    // outcome replaces it. Bounded, so a stuck download can't leave it up.
    function progress(title, detail = "") {
        const toast = buildToast("progress", title, detail);
        let ended = false;
        const timer = setTimeout(() => { ended = true; dismissToast(toast); }, 120_000);
        showToast(toast);
        return {
            update(nextTitle, nextDetail = "") {
                if (ended) return;
                toast.querySelector(".lowcord-toast-title").textContent = nextTitle;
                let line = toast.querySelector(".lowcord-toast-detail");
                if (nextDetail && !line) toast.querySelector(".lowcord-toast-copy").append(line = ui("span", { className: "lowcord-toast-detail" }));
                if (line) { line.textContent = nextDetail; line.hidden = !nextDetail; }
                // Come back only if no other toast took the place, such as
                // another download's.
                if (!toast.isConnected && !document.querySelector(".lowcord-toast:not(.lowcord-toast-out)")) showToast(toast);
            },
            end() { ended = true; clearTimeout(timer); dismissToast(toast); },
        };
    }

    async function measure(blob) {
        const context = new AudioContext();
        try {
            const audio = await context.decodeAudioData(await blob.arrayBuffer());
            const samples = audio.getChannelData(0);
            // Root mean square of up to 256 bins, eased so quiet recordings still show.
            const bins = new Uint8Array(Math.max(Math.min(32, samples.length), Math.min(256, Math.floor(audio.duration * 10))));
            const size = Math.floor(samples.length / bins.length) || 1;
            for (let bin = 0; bin < bins.length; bin++) {
                let squares = 0;
                for (let i = 0; i < size; i++) squares += (samples[bin * size + i] ?? 0) ** 2;
                bins[bin] = ~~(Math.sqrt(squares / size) * 0xff);
            }
            const max = Math.max(1, ...bins);
            const ratio = 1 + (0xff / max - 1) * Math.min(1, 100 * (max / 0xff) ** 3);
            for (let i = 0; i < bins.length; i++) bins[i] = Math.min(0xff, ~~(bins[i] * ratio));
            return { waveform: btoa(String.fromCharCode(...bins)), duration: audio.duration };
        } finally { context.close(); }
    }

    function sendVoice(blob, meta) {
        const { CloudUpload, RestAPI, Dispatcher } = window.Lowcord;
        const channelId = window.Lowcord.store("SelectedChannelStore")?.getChannelId();
        if (!CloudUpload || !RestAPI || !channelId) { toast("Couldn’t send the voice message. Please try again.", true); return; }
        const reply = window.Lowcord.store("PendingReplyStore")?.getPendingReply(channelId);
        if (reply) Dispatcher?.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
        const upload = new CloudUpload({ file: new File([blob], "voice-message.ogg", { type: "audio/ogg; codecs=opus" }),
            isThumbnail: false, platform: 1 }, channelId);
        upload.on("complete", () => {
            RestAPI.post({
                url: `/channels/${channelId}/messages`,
                body: {
                    flags: 1 << 13, channel_id: channelId, content: "", type: 0, sticker_ids: [],
                    nonce: String((BigInt(Date.now()) - 1420070400000n) << 22n),
                    attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename,
                        waveform: meta.waveform, duration_secs: meta.duration }],
                    message_reference: reply ? { guild_id: reply.channel?.guild_id ?? undefined, channel_id: reply.message.channel_id,
                        message_id: reply.message.id } : undefined,
                },
            }).catch(() => toast("Couldn’t send the voice message. Please try again.", true));
        });
        upload.on("error", () => toast("Couldn’t upload the voice message. Please try again.", true));
        upload.upload();
    }

    // Analyse the same stream being recorded, without routing it to speakers.
    // History stays bounded; canvas redraws at most 30 times a second.
    function liveWaveform(stream, canvas, hint) {
        let context, source, analyser, frame, stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            cancelAnimationFrame(frame);
            source?.disconnect();
            analyser?.disconnect();
            if (context && context.state !== "closed") context.close().catch(() => {});
        };
        const unavailable = () => {
            stop();
            hint.textContent = "Live waveform unavailable. Recording continues.";
        };
        try {
            context = new AudioContext();
            source = context.createMediaStreamSource(stream);
            analyser = context.createAnalyser();
            analyser.fftSize = 1024;
            source.connect(analyser);
            const paint = canvas.getContext("2d");
            if (!paint) throw new Error("Canvas unavailable");
            const samples = new Float32Array(analyser.fftSize);
            const history = new Float32Array(80);
            const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
            const color = getComputedStyle(canvas).color;
            let lastDraw = 0, lastSample = 0, lastSound = -Infinity, signal = "", level = 0;
            const draw = now => {
                if (stopped) return;
                frame = requestAnimationFrame(draw);
                if (now - lastDraw < (reducedMotion.matches ? 100 : 33)) return;
                lastDraw = now;
                if (context.state !== "running") return;
                analyser.getFloatTimeDomainData(samples);
                let squares = 0;
                for (const sample of samples) squares += sample * sample;
                const rms = Math.sqrt(squares / samples.length);
                level = Math.min(1, Math.sqrt(rms) * 2.5);
                if (rms > 0.008) lastSound = now;
                const nextSignal = now - lastSound < 800 ? "sound" : "quiet";
                if (nextSignal !== signal) {
                    signal = nextSignal;
                    hint.dataset.signal = signal;
                    hint.textContent = signal === "sound" ? "Microphone is picking up sound" : "Listening for sound…";
                }
                if (now - lastSample >= 80) {
                    history.copyWithin(0, 1);
                    history[history.length - 1] = level;
                    lastSample = now;
                }
                // A fixed logical canvas avoids reading layout on each frame.
                const width = 420, height = 64;
                const ratio = Math.min(devicePixelRatio || 1, 2);
                const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
                if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
                    canvas.width = pixelWidth;
                    canvas.height = pixelHeight;
                }
                paint.setTransform(ratio, 0, 0, ratio, 0, 0);
                paint.clearRect(0, 0, width, height);
                paint.strokeStyle = color;
                paint.lineWidth = 3;
                paint.lineCap = "round";
                if (reducedMotion.matches) {
                    // Keep real level feedback, without horizontal motion.
                    paint.globalAlpha = 0.2;
                    paint.beginPath(); paint.moveTo(8, height / 2); paint.lineTo(width - 8, height / 2); paint.stroke();
                    paint.globalAlpha = 1;
                    paint.beginPath(); paint.moveTo(8, height / 2); paint.lineTo(8 + (width - 16) * level, height / 2); paint.stroke();
                    return;
                }
                const step = width / (history.length - 1);
                const offset = Math.min(1, (now - lastSample) / 80) * step;
                for (let i = 0; i < history.length; i++) {
                    const x = i * step - offset;
                    const amplitude = Math.max(1, history[i] * (height - 12) / 2);
                    paint.globalAlpha = 0.25 + 0.75 * i / (history.length - 1);
                    paint.beginPath(); paint.moveTo(x, height / 2 - amplitude); paint.lineTo(x, height / 2 + amplitude); paint.stroke();
                }
            };
            context.resume().catch(unavailable);
            frame = requestAnimationFrame(draw);
        } catch { unavailable(); }
        return stop;
    }

    function openRecorder() {
        if (document.querySelector(".lowcord-voice-backdrop")) return;
        let recorder, stream, chunks = [], blob, meta, started = 0, ticker, stopWaveform, closed = false;
        const time = ui("span", { className: "lowcord-voice-time" }, "0:00");
        const record = ui("button", { type: "button", className: "lowcord-button lowcord-voice-record", onClick: toggle }, svg(micPath), "Record");
        const preview = ui("audio", { controls: "", hidden: true });
        const status = ui("p", { className: "lowcord-voice-status", role: "status" }, "Press Record and speak. Press Stop when you’re done.");
        const canvas = ui("canvas", { className: "lowcord-voice-waveform", width: "420", height: "64", "aria-hidden": "true" });
        const hint = ui("p", { className: "lowcord-voice-signal", role: "status" }, "Listening for sound…");
        const visualization = ui("div", { className: "lowcord-voice-visualization", hidden: true }, canvas, hint);
        const sendButton = ui("button", { type: "button", className: "lowcord-button lowcord-button-primary", disabled: true, onClick: submit }, "Send");
        const cancel = ui("button", { type: "button", className: "lowcord-button", onClick: close }, "Cancel");
        const dialog = ui("div", { className: "lowcord-voice", role: "dialog", "aria-modal": "true", "aria-label": "Record a voice message" },
            ui("h2", {}, "Voice message"), status, visualization, ui("div", { className: "lowcord-voice-controls" }, record, time), preview,
            ui("div", { className: "lowcord-dialog-actions" }, cancel, sendButton));
        const backdrop = ui("div", { className: "lowcord-voice-backdrop", onMousedown: event => { if (event.target === backdrop) close(); } }, dialog);
        const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
        window.addEventListener("keydown", onKey, true);
        document.body.append(backdrop);
        record.focus();

        async function toggle() {
            if (recorder?.state === "recording") {
                record.disabled = true;
                stopWaveform?.();
                recorder.stop();
                return;
            }
            record.disabled = true;
            try {
                const deviceId = window.Lowcord.store("MediaEngineStore")?.getInputDeviceId?.();
                stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId && deviceId !== "default" ? deviceId : undefined,
                    echoCancellation: true, noiseSuppression: true } });
                if (closed) { stream.getTracks().forEach(track => track.stop()); return; }
            } catch {
                status.textContent = "OrbitCord couldn’t use the microphone. Allow microphone access for OrbitCord, then try again.";
                record.disabled = false;
                return;
            }
            try {
                const type = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"].find(candidate => MediaRecorder.isTypeSupported(candidate));
                recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
                chunks = [];
                recorder.addEventListener("dataavailable", event => chunks.push(event.data));
                recorder.addEventListener("stop", finish);
                recorder.start();
            } catch {
                stream.getTracks().forEach(track => track.stop());
                status.textContent = "That recording couldn’t start. Please try again.";
                record.disabled = false;
                return;
            }
            if (preview.src) URL.revokeObjectURL(preview.src);
            preview.removeAttribute("src");
            preview.hidden = true;
            blob = meta = undefined;
            time.textContent = "0:00";
            started = Date.now();
            ticker = setInterval(() => {
                const seconds = Math.floor((Date.now() - started) / 1000);
                time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
            }, 250);
            record.lastChild.textContent = "Stop";
            record.classList.add("lowcord-recording");
            record.disabled = false;
            status.textContent = "Recording…";
            sendButton.disabled = true;
            hint.textContent = "Listening for sound…";
            delete hint.dataset.signal;
            visualization.hidden = false;
            stopWaveform = liveWaveform(stream, canvas, hint);
        }
        async function finish() {
            clearInterval(ticker);
            stopWaveform?.();
            visualization.hidden = true;
            stream?.getTracks().forEach(track => track.stop());
            if (closed) return;
            record.disabled = true;
            record.lastChild.textContent = "Record again";
            record.classList.remove("lowcord-recording");
            status.textContent = "Preparing recording…";
            blob = new Blob(chunks, { type: "audio/ogg; codecs=opus" });
            preview.src = URL.createObjectURL(blob);
            preview.hidden = false;
            try {
                meta = await measure(blob);
                if (closed) return;
                status.textContent = "Listen back, then send it.";
                sendButton.disabled = false;
            } catch {
                if (closed) return;
                status.textContent = "That recording couldn’t be read. Please record again.";
            }
            record.disabled = false;
        }
        function submit() {
            if (!blob || !meta) return;
            sendVoice(blob, meta);
            toast("Sending voice message…");
            close();
        }
        function close() {
            closed = true;
            if (recorder?.state === "recording") { recorder.removeEventListener("stop", finish); recorder.stop(); }
            clearInterval(ticker);
            stopWaveform?.();
            stream?.getTracks().forEach(track => track.stop());
            if (preview.src) URL.revokeObjectURL(preview.src);
            window.removeEventListener("keydown", onKey, true);
            backdrop.remove();
        }
    }

    // A waveform button at the start of the message bar's buttons. Discord
    // mutates the page constantly, so a full scan runs only when a known bar
    // went away or half a second has passed.
    let bars = [], scanned = 0;
    function placeVoiceButtons(event) {
        if (!window.Lowcord.domChanged(event, '[class*="channelTextArea_"]')) return;
        const show = enabled("voiceMessages");
        const settled = bars.length && bars.every(bar => bar.isConnected && bar.querySelector(":scope > .lowcord-voice-button"));
        if (show && !event && settled && performance.now() - scanned < 500) return;
        scanned = performance.now();
        bars = [...document.querySelectorAll('[class*="channelTextArea_"] [class*="buttons_"]')];
        for (const bar of bars) {
            const existing = bar.querySelector(":scope > .lowcord-voice-button");
            if (!show) { existing?.remove(); continue; }
            if (existing) continue;
            bar.prepend(ui("button", { type: "button", className: "lowcord-voice-button", "aria-label": "Record a voice message",
                title: "Record a voice message", onClick: openRecorder }, svg(waveformPath)));
        }
    }
    window.Lowcord.onDomChange(placeVoiceButtons);
    window.addEventListener(changeEvent, placeVoiceButtons);

    // Allow playback only for official music embeds. Save the original allow
    // attribute so disabling the plugin restores Discord's own frame policy.
    const musicAllows = new WeakMap();
    function fixMusicFrames(records) {
        if (!window.Lowcord.domChanged(records, 'iframe[src]')) return;
        for (const frame of document.querySelectorAll('iframe[src]')) {
            let url;
            try { url = new URL(frame.src); } catch { continue; }
            if (url.protocol !== 'https:' || !(url.hostname === 'embed.music.apple.com'
                || (url.hostname === 'open.spotify.com' && /^\/(?:intl-[\w-]+\/)?embed\//.test(url.pathname)))) continue;
            if (enabled("musicEmbeds")) {
                if (!musicAllows.has(frame)) musicAllows.set(frame, frame.getAttribute('allow'));
                const allow = frame.getAttribute('allow') ?? '';
                const extra = ['autoplay', 'encrypted-media'].filter(feature => !allow.split(';').some(item => item.trim().split(/\s+/)[0] === feature));
                if (extra.length) frame.setAttribute('allow', [allow, ...extra].filter(Boolean).join('; '));
            } else if (musicAllows.has(frame)) {
                const original = musicAllows.get(frame);
                if (original === null) frame.removeAttribute('allow'); else frame.setAttribute('allow', original);
                musicAllows.delete(frame);
            }
        }
    }
    window.Lowcord.onDomChange(fixMusicFrames);
    window.addEventListener(changeEvent, fixMusicFrames);
    window.Lowcord.extensions = { catalog, enabled, set, setOption, changeEvent,
        get state() { return { ...state }; }, get options() { return { ...options }; },
        cleanContent, socialContent, anonymous, openRecorder, toast, progress, ui };
})();
