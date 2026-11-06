// GIF captions: a small button on each result in Discord's GIF picker, and a
// "Caption this GIF" item in the message menu, open a dialog to add a caption
// (bar, meme text, subtitle or speech bubble) and trim the clip. The clip's
// video (or animated GIF/WebP, for favourites) is fetched as bytes (so canvases
// are never tainted), drawn frame by
// frame through gif.js's bounded-memory encoder, then sent through Discord's
// uploader or queued in the composer for review.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui, toast, progress } = extensions;
    const id = "gifCaptioner", maxBytes = 32 * 1024 * 1024, MB = 1024 * 1024, minTrim = .3;
    const resultSelector = '#gif-picker-tab-panel [class*="result_"], [class*="gifPickerWrap"] [class*="result_"]';
    const menuId = "message-lowcord-caption-gif";
    const barFont = px => `700 ${px}px Impact, "Futura Condensed ExtraBold", "Arial Narrow Bold", "Arial Narrow", sans-serif`;
    const bubbleFont = px => `700 ${px}px "Helvetica Neue", Arial, sans-serif`;
    const memeFont = px => `${px}px Impact, "Arial Black", "Helvetica Neue", sans-serif`;
    const subtitleFont = px => `600 ${px}px "Helvetica Neue", Arial, sans-serif`;
    const fontFor = (style, px) => (style === "bubble" ? bubbleFont : barFont)(px);
    const icon = "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm3 9v2h10v-2H7Zm0-4v2h6v-2H7Z";
    const styles = {
        bar: ["Bar", "A white bar with bold text above the GIF."],
        meme: ["Meme", "Classic meme text at the top and bottom."],
        subtitle: ["Subtitle", "White text along the bottom, like captions."],
        bubble: ["Bubble", "Click the preview to move the bubble's tip."],
    };

    // ----- Text layout (pure, testable) --------------------------------------
    // Greedy word wrap; a word wider than the line is split by characters.
    function wrap(measure, text, maxWidth) {
        const lines = [];
        for (const paragraph of String(text).split(/\r?\n/)) {
            let line = "";
            for (const word of paragraph.split(/\s+/).filter(Boolean)) {
                const next = line ? `${line} ${word}` : word;
                if (measure(next) <= maxWidth) { line = next; continue; }
                if (line) { lines.push(line); line = ""; }
                if (measure(word) <= maxWidth) { line = word; continue; }
                let piece = "";
                for (const char of word) {
                    if (piece && measure(piece + char) > maxWidth) { lines.push(piece); piece = ""; }
                    piece += char;
                }
                line = piece;
            }
            if (line || !paragraph) lines.push(line);
        }
        while (lines.length && !lines.at(-1)) lines.pop();
        return lines;
    }
    // Largest font that keeps the text within five lines of the given width.
    function fit(measureWith, text, width, style) {
        const pad = Math.round(width * .04);
        if (!String(text).trim()) return { lines: [], size: 0, lineHeight: 0, pad, height: 0 };
        const maxWidth = Math.max(10, width - pad * 2);
        let size = Math.max(14, Math.min(64, Math.round(width * .11))), lines;
        for (;; size--) {
            const measure = measureWith(fontFor(style, size));
            lines = wrap(measure, text, maxWidth);
            if (size <= 10 || (lines.length <= 5 && lines.every(line => measure(line) <= maxWidth))) break;
        }
        const lineHeight = Math.round(size * 1.15);
        return { lines, size, lineHeight, pad, height: lines.length * lineHeight + pad * 2 };
    }
    // One block of text over the video: the largest size from `max` down to
    // `min` that keeps it within `maxLines` and `maxHeight`; at the smallest
    // size, extra lines are cut and the last one ends in an ellipsis.
    function fitBlock(measureWith, text, width, { font, max, min = 10, maxLines = 3, maxHeight = Infinity, leading = 1.1 }) {
        const value = String(text).replace(/\s+/g, " ").trim();
        if (!value) return { lines: [], size: 0, lineHeight: 0, height: 0 };
        let size = Math.max(min, Math.round(max)), lines, measure;
        for (;; size--) {
            measure = measureWith(font(size));
            lines = wrap(measure, value, width);
            if (size <= min || (lines.length <= maxLines && lines.length * Math.round(size * leading) <= maxHeight && lines.every(line => measure(line) <= width))) break;
        }
        if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            let last = lines[maxLines - 1];
            while (last && measure(`${last}…`) > width) last = last.slice(0, -1).trimEnd();
            lines[maxLines - 1] = `${last}…`;
        }
        const lineHeight = Math.round(size * leading);
        return { lines, size, lineHeight, height: lines.length * lineHeight };
    }
    // Meme text: uppercase, top and bottom blocks, each up to three lines.
    function memeLayout(measureWith, text, width, height) {
        const pad = Math.round(width * .03), inner = Math.max(10, width - pad * 2);
        const options = { font: memeFont, max: width * .13, maxLines: 3, maxHeight: height * .42 };
        const block = value => fitBlock(measureWith, String(value ?? "").toUpperCase(), inner, options);
        return { pad, top: block(text?.top), bottom: block(text?.bottom) };
    }
    function subtitleLayout(measureWith, text, width, height) {
        const pad = Math.round(width * .04);
        return { pad, block: fitBlock(measureWith, text, Math.max(10, width - pad * 2), { font: subtitleFont, max: width * .07, maxLines: 3, maxHeight: height * .45, leading: 1.2 }) };
    }
    const seconds = value => `${(Math.round(value * 10) / 10).toFixed(1)}s`;
    const trimText = (start, end, duration) => `Trim · ${seconds(start)} – ${seconds(end)} of ${seconds(duration)}`;

    let measuring;
    const measureWith = font => {
        measuring ??= document.createElement("canvas").getContext("2d");
        measuring.font = font;
        return value => measuring.measureText(value).width;
    };
    // White text with a round black outline, centred, one line per row.
    function outlined(context, font, lines, size, lineHeight, x, top, ratio) {
        context.font = font(size);
        context.textAlign = "center"; context.textBaseline = "middle";
        context.lineJoin = "round"; context.miterLimit = 2;
        context.lineWidth = Math.max(2, size / ratio);
        context.strokeStyle = "#000"; context.fillStyle = "#fff";
        lines.forEach((line, index) => {
            const y = top + lineHeight * (index + .5);
            context.strokeText(line, x, y);
            context.fillText(line, x, y);
        });
    }
    // Layout and drawing for one caption. `text` is a string, or { top, bottom }
    // for meme text. `tip` is the bubble tail's position as fractions of the
    // finished picture.
    function caption(text, style, tip = { x: .3, y: .45 }) {
        const cache = new Map();
        const place = (width, height) => {
            const key = style === "meme" || style === "subtitle" ? `${width}x${height}` : width;
            if (!cache.has(key)) cache.set(key, style === "meme" ? memeLayout(measureWith, text, width, height)
                : style === "subtitle" ? subtitleLayout(measureWith, text, width, height) : fit(measureWith, text, width, style));
            return cache.get(key);
        };
        const over = style === "meme" || style === "subtitle";
        return {
            place,
            layout(width, height) {
                if (over) return { width, height, x: 0, y: 0, w: width, h: height };
                const top = place(width).height;
                return { width, height: height + top, x: 0, y: top, w: width, h: height };
            },
            drawOverlay(context, width, height = context.canvas.height) {
                if (style === "meme") {
                    const { pad, top, bottom } = place(width, height);
                    if (top.lines.length) outlined(context, memeFont, top.lines, top.size, top.lineHeight, width / 2, pad, 8);
                    if (bottom.lines.length) outlined(context, memeFont, bottom.lines, bottom.size, bottom.lineHeight, width / 2, height - pad - bottom.height, 8);
                    return;
                }
                if (style === "subtitle") {
                    const { pad, block } = place(width, height);
                    if (block.lines.length) outlined(context, subtitleFont, block.lines, block.size, block.lineHeight, width / 2, height - pad - block.height, 5);
                    return;
                }
                const { lines, size, lineHeight, pad, height: barHeight } = place(width);
                if (!barHeight) return;
                if (style === "bubble") {
                    const full = context.canvas.height, tx = Math.max(0, Math.min(1, tip.x)) * width, ty = Math.max(barHeight + 8, Math.min(1, tip.y) * full);
                    const base = Math.max(width * .14, Math.min(width * .86, tx)), half = width * .05;
                    context.fillStyle = "#fff";
                    context.beginPath();
                    context.moveTo(base - half, barHeight - 1); context.lineTo(base + half, barHeight - 1); context.lineTo(tx, ty); context.closePath();
                    context.fill();
                }
                context.fillStyle = "#000"; context.textAlign = "center"; context.textBaseline = "middle";
                context.font = fontFor(style, size);
                lines.forEach((line, index) => context.fillText(line, width / 2, pad + lineHeight * (index + .5)));
            },
        };
    }

    // ----- Source clip -------------------------------------------------------
    const allowed = /^https:\/\/(?:media\.tenor\.com|c\.tenor\.com|static\.klipy\.com|media\.discordapp\.net|cdn\.discordapp\.com|images-ext-[12]\.discordapp\.net)\//;
    async function fetchBytes(url) {
        try {
            const response = await fetch(url, { credentials: "omit" });
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                if (buffer.byteLength <= maxBytes) return new Uint8Array(buffer);
            }
        } catch {}
        if (!allowed.test(url) || !window.__LOWCORD_NATIVE__?.fetchRemote) throw new Error("Could not download this GIF.");
        const result = await window.__LOWCORD_NATIVE__.fetchRemote(url, { as: "bytes", maxBytes });
        const bytes = result?.body ?? result;
        if (result?.status && (result.status < 200 || result.status > 299)) throw new Error("Could not download this GIF.");
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error("Could not download this GIF.");
        return bytes;
    }
    const store = name => window.Lowcord.store(name);
    function uploadLimit() {
        const premium = store("UserStore")?.getCurrentUser?.()?.premiumType;
        const guildId = store("SelectedGuildStore")?.getGuildId?.();
        const tier = guildId ? store("GuildStore")?.getGuild?.(guildId)?.premiumTier : 0;
        return Math.max(premium === 2 ? 500 * MB : premium === 1 || premium === 3 ? 50 * MB : 10 * MB, tier === 3 ? 100 * MB : tier === 2 ? 50 * MB : 0);
    }
    // Discord's picker item carries the clip's video URL (Klipy WebM or Tenor MP4)
    // even when the tile itself shows an animated WebP image; favourites carry
    // only the image. Trending category tiles carry only a name and a GIF image
    // (no url or format): they are search shortcuts, not clips.
    const absolute = url => typeof url === "string" && url ? new URL(url, location.href).href : "";
    const isVideo = url => /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url);
    const isImage = url => /\.(?:gif|webp)(?:[?#]|$)/i.test(url);
    // Favourites are image items (format 1) whose src is an animated GIF/WebP.
    function itemSource(result) {
        const key = Object.keys(result).find(name => name.startsWith("__reactFiber$"));
        for (let fiber = result[key], depth = 0; fiber && depth < 6; fiber = fiber.return, depth++) {
            const item = fiber.memoizedProps?.item;
            if (item && typeof item === "object") {
                if (item.name && !item.url && item.format == null) return "";
                const url = [item.src, item.url].map(absolute).find(isVideo);
                if (url) return url;
                const src = absolute(item.src);
                if (src && (item.format === 1 || isImage(src))) return src;
            }
        }
        return "";
    }
    // Tenor serves every rendition under the same id with a format code:
    // /<id>AAAAM/name.gif (tiny GIF) has an MP4 at /<id>AAAPo/name.mp4.
    function tenorMp4(url) {
        const match = /^(https:\/\/media\.tenor\.com\/[\w-]+?)AAA[\w-]{1,2}\/([^/?#]+)\.gif(?:[?#]|$)/.exec(url);
        return match ? `${match[1]}AAAPo/${match[2]}.mp4` : "";
    }
    const videoSource = result => {
        const video = result.querySelector("video");
        const direct = video?.currentSrc || video?.src || video?.querySelector("source")?.src || "";
        return isVideo(direct) || direct.startsWith("blob:") ? direct : itemSource(result);
    };

    // ----- Clips in chat messages ---------------------------------------------
    // GIF embeds (Tenor, Klipy, ...) and video attachments of one message.
    function messageClips(message) {
        const clips = [];
        for (const embed of message?.embeds ?? []) {
            if (embed?.type !== "gifv") continue;
            const video = embed.video ?? {};
            const url = absolute(video.proxyURL || video.proxy_url || video.url);
            if (url) clips.push({ url, keys: [video.url, video.proxyURL, video.proxy_url, url] });
        }
        for (const file of message?.attachments ?? []) {
            if (!isVideo(file?.filename ?? "") && !isVideo(file?.url ?? "")) continue;
            const url = absolute(file.proxy_url || file.proxyURL || file.url);
            if (url) clips.push({ url, keys: [file.url, file.proxy_url, file.proxyURL, url] });
        }
        return clips;
    }
    const fileName = url => { try { return new URL(url, location.href).pathname.split("/").pop() || ""; } catch { return ""; } };
    // The clip under the pointer when the message has several, else the first.
    function clipUnder(target, row, clips) {
        if (clips.length === 1) return clips[0];
        for (let node = target; node && node !== row.parentElement; node = node.parentElement) {
            const videos = node.matches("video") ? [node] : [...node.querySelectorAll("video")];
            if (videos.length > 1) break;
            if (!videos.length) continue;
            const name = fileName(videos[0].currentSrc || videos[0].src || videos[0].querySelector("source")?.src || "");
            return clips.find(clip => clip.keys.some(key => key && fileName(key) === name)) ?? clips[0];
        }
        return clips[0];
    }
    function chatClip(target) {
        if (!(target instanceof Element) || target.closest('[class*="reactions_"]')) return null;
        const row = target.closest('[id^="chat-messages-"]');
        const [, channelId, messageId] = /^chat-messages-(\d+)-(\d+)$/.exec(row?.id ?? "") ?? [];
        if (!messageId) return null;
        const message = store("MessageStore")?.getMessage?.(channelId, messageId);
        const clips = messageClips(message);
        if (!clips.length) return null;
        const guildId = store("ChannelStore")?.getChannel?.(channelId)?.guild_id ?? message.guild_id ?? null;
        return { url: clipUnder(target, row, clips).url, reply: { message, channelId, messageId, guildId } };
    }

    // ----- Dialog ------------------------------------------------------------
    let closeDialog = null;
    // `image` is gif.js's AnimatedImage for GIF/WebP sources, else null and
    // `blobUrl` is the clip's video.
    function dialog(blobUrl, image, reply) {
        return new Promise(resolve => {
            const restoreFocus = document.activeElement;
            let style = "bar", tip = { x: .3, y: .45 }, current, frame, stopped = false;
            let duration = 0, start = 0, end = 0, dragging = null;
            const video = image ? null : ui("video", { muted: "", loop: "", playsinline: "", preload: "auto" });
            if (video) Object.assign(video, { muted: true, loop: true, playsInline: true, src: blobUrl });
            const media = image ?? video;
            // An image plays on its own clock: `from` seconds at `clock` ms.
            let from = 0, clock = performance.now();
            const playTime = () => {
                if (!image) return video.currentTime;
                // Clips too short to trim still loop over their whole length.
                const low = duration ? start : 0, high = duration ? end : image.duration;
                let time = from + (performance.now() - clock) / 1000;
                if (time >= high || time < low) { from = time = low; clock = performance.now(); }
                return time;
            };
            const jump = time => { if (image) { from = time; clock = performance.now(); } else video.currentTime = time; };
            const canvas = ui("canvas", { role: "img", "aria-label": "Preview of the captioned GIF" });
            const context = canvas.getContext("2d");

            // Fields: one caption for bar, bubble and subtitle; two for meme.
            const field = (tag, label, extra = {}) => ui(tag, { className: "lowcord-gifcap-text", maxlength: "200", "aria-label": label, ...extra });
            const area = field("textarea", "Caption", { rows: "2", placeholder: "Type a caption" });
            const line = field("input", "Caption", { type: "text", placeholder: "Type a caption", hidden: true });
            const top = field("input", "Top text", { type: "text", placeholder: "Top text" });
            const bottom = field("input", "Bottom text", { type: "text", placeholder: "Bottom text" });
            const memeFields = ui("div", { className: "lowcord-gifcap-meme", hidden: true }, top, bottom);
            const textValue = () => (style === "subtitle" ? line : area).value;
            const spec = () => style === "meme" ? { top: top.value, bottom: bottom.value } : textValue();
            const hasText = () => style === "meme" ? Boolean(top.value.trim() || bottom.value.trim()) : Boolean(textValue().trim());
            const build = () => caption(spec(), style, tip);

            const paint = () => {
                if (video && duration && (video.currentTime >= end - .02 || video.currentTime < start - .05)) video.currentTime = start;
                const time = playTime();
                if (image) image.currentTime = time;
                if (duration) playhead.style.left = `${Math.max(0, Math.min(1, time / duration)) * 100}%`;
                if (!current || !media.videoWidth) return;
                const scale = Math.min(1, 480 / Math.max(media.videoWidth, media.videoHeight));
                const box = current.layout(Math.round(media.videoWidth * scale), Math.round(media.videoHeight * scale));
                if (canvas.width !== box.width || canvas.height !== box.height) Object.assign(canvas, { width: box.width, height: box.height });
                context.fillStyle = "#fff"; context.fillRect(0, 0, box.width, box.height);
                const picture = image ? image.frame : video;
                if (picture) context.drawImage(picture, box.x, box.y, box.w, box.h);
                current.drawOverlay(context, box.width, box.height);
            };
            const schedule = () => {
                if (stopped) return;
                const next = () => { paint(); schedule(); };
                frame = video?.requestVideoFrameCallback ? video.requestVideoFrameCallback(next) : requestAnimationFrame(next);
            };

            const rebuild = () => {
                current = build(); paint();
                const empty = !hasText();
                send.disabled = empty; add.disabled = empty;
            };

            // Trim: two keyboard-accessible handles on a track.
            const handle = label => ui("div", { className: "lowcord-gifcap-handle", role: "slider", tabindex: "0", "aria-label": label, "aria-valuemin": "0" });
            const startHandle = handle("Trim start"), endHandle = handle("Trim end");
            const range = ui("div", { className: "lowcord-gifcap-range" });
            const playhead = ui("div", { className: "lowcord-gifcap-playhead" });
            const track = ui("div", { className: "lowcord-gifcap-track" }, range, playhead, startHandle, endHandle);
            const trimLabel = ui("p", { className: "lowcord-gifcap-trim-label" });
            const trim = ui("div", { className: "lowcord-gifcap-trim", hidden: true }, trimLabel, track);
            const drawTrim = () => {
                const at = value => `${value / duration * 100}%`;
                startHandle.style.left = at(start); endHandle.style.left = at(end);
                range.style.left = at(start); range.style.right = `${100 - end / duration * 100}%`;
                trimLabel.textContent = trimText(start, end, duration);
                for (const [node, value, low, high] of [[startHandle, start, 0, end - minTrim], [endHandle, end, start + minTrim, duration]]) {
                    node.setAttribute("aria-valuenow", value.toFixed(1));
                    node.setAttribute("aria-valuemin", Math.max(0, low).toFixed(1)); node.setAttribute("aria-valuemax", high.toFixed(1));
                    node.setAttribute("aria-valuetext", `${value.toFixed(1)} seconds`);
                }
            };
            const setTrim = (which, value) => {
                if (!duration) return;
                if (which === "start") start = Math.max(0, Math.min(end - minTrim, value));
                else end = Math.min(duration, Math.max(start + minTrim, value));
                drawTrim();
                jump(which === "start" ? start : Math.max(start, end - .5));
            };
            const timeAt = event => {
                const rect = track.getBoundingClientRect();
                return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
            };
            track.addEventListener("pointerdown", event => {
                if (!duration || event.button !== 0) return;
                event.preventDefault();
                const time = timeAt(event), target = event.target instanceof Element ? event.target.closest(".lowcord-gifcap-handle") : null;
                dragging = target === startHandle ? "start" : target === endHandle ? "end" : Math.abs(time - start) <= Math.abs(time - end) ? "start" : "end";
                (dragging === "start" ? startHandle : endHandle).focus();
                track.setPointerCapture?.(event.pointerId);
                if (!target) setTrim(dragging, time);
            });
            track.addEventListener("pointermove", event => { if (dragging) setTrim(dragging, timeAt(event)); });
            for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) track.addEventListener(type, () => { dragging = null; });
            for (const [node, which] of [[startHandle, "start"], [endHandle, "end"]]) node.addEventListener("keydown", event => {
                const value = which === "start" ? start : end;
                const next = { ArrowLeft: value - .1, ArrowDown: value - .1, ArrowRight: value + .1, ArrowUp: value + .1,
                    PageDown: value - 1, PageUp: value + 1, Home: 0, End: duration }[event.key];
                if (next === undefined) return;
                event.preventDefault(); event.stopPropagation();
                setTrim(which, Math.round(next * 10) / 10);
            });
            const setDuration = value => {
                if (!Number.isFinite(value) || value <= minTrim) return;
                duration = value; start = 0; end = duration;
                trim.hidden = false; drawTrim();
            };
            if (image) setDuration(image.duration);
            else video.addEventListener("loadedmetadata", () => setDuration(video.duration), { once: true });

            const finish = value => {
                if (stopped) return;
                stopped = true; closeDialog = null;
                if (video?.cancelVideoFrameCallback && frame) video.cancelVideoFrameCallback(frame);
                else if (frame) cancelAnimationFrame(frame);
                if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
                image?.close();
                document.removeEventListener("keydown", onKey, true);
                backdrop.remove(); restoreFocus?.focus?.(); resolve(value);
            };
            closeDialog = () => finish(null);
            const choose = mode => { if (hasText()) finish({ text: spec(), style, tip, start, end: duration ? end : undefined, mode }); };
            const onKey = event => {
                if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(null); }
                if (event.key === "Tab") {
                    const nodes = [...backdrop.querySelectorAll('button:not(:disabled), textarea, input, [role="slider"]')].filter(node => node.getClientRects().length);
                    const first = nodes[0], last = nodes.at(-1);
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                }
            };
            // Enter sends; Shift+Enter adds the GIF to the message box instead.
            const onFieldKey = event => {
                if (event.key !== "Enter" || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
                event.preventDefault(); event.stopPropagation();
                choose(event.shiftKey ? "attach" : "send");
            };
            for (const node of [area, line, top, bottom]) {
                node.addEventListener("input", rebuild);
                node.addEventListener("keydown", onFieldKey);
            }

            const chips = Object.entries(styles).map(([key, [label]]) =>
                ui("button", { type: "button", className: "lowcord-capture-chip", "aria-pressed": String(key === style), "data-style": key, onClick: () => pick(key) }, label));
            const hint = ui("p", { className: "lowcord-capture-status" }, styles.bar[1]);
            const pick = next => {
                if (next === style) return;
                const shared = textValue();
                style = next;
                for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset.style === next));
                area.hidden = next === "meme" || next === "subtitle"; line.hidden = next !== "subtitle"; memeFields.hidden = next !== "meme";
                if (next === "subtitle") line.value = shared; else if (next !== "meme") area.value = shared;
                hint.textContent = styles[next][1];
                canvas.style.cursor = next === "bubble" ? "crosshair" : "";
                rebuild();
                // Typing continues in the style's first field, not on the chip.
                (next === "meme" ? top : next === "subtitle" ? line : area).focus();
            };
            canvas.addEventListener("click", event => {
                if (style !== "bubble") return;
                const rect = canvas.getBoundingClientRect();
                tip = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
                rebuild();
            });
            const add = ui("button", { type: "button", className: "lowcord-button", disabled: true, onClick: () => choose("attach") }, "Add to message");
            const send = ui("button", { type: "button", className: "lowcord-button lowcord-button-primary", disabled: true, onClick: () => choose("send") }, "Send");
            const closeButton = ui("button", { type: "button", className: "lowcord-settings-close", "aria-label": "Close", onClick: () => finish(null) }, "×");
            const author = reply?.message?.author;
            const who = author?.globalName || author?.global_name || author?.username;
            const intro = reply ? `Sends as a reply${who ? ` to ${who}` : ""}. Enter sends, Shift+Enter adds it to your message.`
                : "Enter sends, Shift+Enter adds it to your message.";
            const panel = ui("section", { className: "lowcord-capture-preview lowcord-gifcap-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "lowcord-gifcap-title" },
                ui("header", {}, ui("div", {}, ui("h2", { id: "lowcord-gifcap-title" }, "Caption GIF"), ui("p", {}, intro)), closeButton),
                ui("div", { className: "lowcord-capture-toolbar" }, ui("div", { className: "lowcord-capture-chips" }, ...chips)),
                area, line, memeFields,
                ui("div", { className: "lowcord-capture-preview-image" }, ui("div", { className: "lowcord-capture-stage" }, canvas)),
                trim,
                ui("footer", {}, hint, ui("div", { className: "lowcord-capture-actions" }, add, send)));
            const backdrop = ui("div", { className: "lowcord-capture-preview-backdrop" }, panel);
            document.body.append(backdrop);
            document.addEventListener("keydown", onKey, true);
            rebuild();
            video?.play().catch(() => {});
            schedule();
            // Discord hands focus back to the message box once its picker closes;
            // take it again so one click (or none) is enough to type.
            area.focus();
            setTimeout(() => { if (backdrop.isConnected && !backdrop.contains(document.activeElement)) area.focus(); }, 80);
        });
    }

    // ----- Send --------------------------------------------------------------
    const nonce = () => String((BigInt(Date.now()) - 1420070400000n) << 22n | BigInt(Math.floor(Math.random() * 4194304)));
    // Through Discord's own uploader, then a message that references the
    // upload, as its composer does.
    function upload(file, channelId, onProgress) {
        return new Promise((resolve, reject) => {
            const item = new window.Lowcord.CloudUpload({ file, isThumbnail: false, platform: 1 }, channelId);
            let done = false;
            const finish = error => {
                if (done) return;
                done = true; clearTimeout(timer);
                if (error) { try { item.cancel?.(); } catch {} reject(error); } else resolve(item);
            };
            const timer = setTimeout(() => finish(new Error("The upload timed out.")), 120_000);
            item.on("progress", (value, total) => {
                const ratio = Number.isFinite(total) && total > 0 ? value / total : typeof value === "number" ? value : value?.total ? value.loaded / value.total : NaN;
                if (Number.isFinite(ratio)) onProgress?.(Math.max(0, Math.min(1, ratio > 1 ? ratio / 100 : ratio)));
            });
            item.on("complete", () => finish());
            item.on("error", () => finish(new Error("The upload failed.")));
            try { Promise.resolve(item.upload()).catch(finish); } catch (error) { finish(error); }
        });
    }
    async function sendFile(file, channelId, reference, onProgress) {
        const { CloudUpload, RestAPI } = window.Lowcord;
        if (!CloudUpload || !RestAPI?.post) throw new Error("Discord's uploader is still loading.");
        const done = await upload(file, channelId, onProgress);
        if (typeof done.uploadedFilename !== "string" || !done.uploadedFilename) throw new Error("The upload failed.");
        await RestAPI.post({ url: `/channels/${channelId}/messages`, body: {
            channel_id: channelId, content: "", type: 0, sticker_ids: [], nonce: nonce(),
            attachments: [{ id: "0", filename: done.filename || file.name, uploaded_filename: done.uploadedFilename }],
            ...(reference ? { message_reference: reference } : {}),
        } });
    }
    // Discord's own reply bar, for a GIF added to the message box.
    function replyInComposer(reply) {
        const channel = store("ChannelStore")?.getChannel?.(reply.channelId);
        // Discord's reply action is minified, so dispatch the same Flux action it sends.
        if (!channel || !reply.message) return;
        try {
            window.Lowcord.Dispatcher?.dispatch({ type: "CREATE_PENDING_REPLY", message: reply.message, channel,
                shouldMention: true, showMentionToggle: channel.guild_id != null });
        } catch {}
    }

    let busy = false;
    // Closes Discord's expression picker the way a user would (its toggle, else
    // Escape where it listens) and waits until it is gone, so its focus lock lets go.
    async function closePicker() {
        const panel = () => document.querySelector("#gif-picker-tab-panel");
        if (!panel()) return;
        const toggle = document.querySelector('[class*="channelTextArea_"] [aria-haspopup="dialog"][aria-expanded="true"]');
        if (toggle) toggle.click();
        else (panel() ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        for (let frame = 0; frame < 20 && panel(); frame++) await new Promise(requestAnimationFrame);
    }
    async function open(url, reply = null) {
        if (busy || !url) return;
        busy = true;
        // The picker's focus lock would pull every click back to itself, so it
        // closes before the caption dialog opens.
        if (!reply) await closePicker();
        let blobUrl, status = progress("Loading GIF…");
        try {
            // A Tenor GIF has a much smaller MP4 of the same clip; the GIF is the fallback.
            const mp4 = tenorMp4(url);
            const bytes = (mp4 && await fetchBytes(mp4).catch(() => null)) || await fetchBytes(url);
            const image = await window.Lowcord.gif.animated(bytes);
            if (!image) blobUrl = URL.createObjectURL(new Blob([bytes], { type: /\.webm(?:[?#]|$)/i.test(url) ? "video/webm" : "video/mp4" }));
            status.end(); status = null;
            if (!on) { image?.close(); return; }
            const limit = uploadLimit();
            const choice = await dialog(blobUrl, image, reply);
            if (!choice) return;
            status = progress("Adding caption…", "Preparing frames");
            const made = caption(choice.text, choice.style, choice.tip);
            const data = await window.Lowcord.gif.encode({ bytes, limit, layout: made.layout, drawOverlay: made.drawOverlay, start: choice.start, end: choice.end,
                progress: fraction => status?.update("Adding caption…", `${Math.round(fraction * 100)}%`) });
            if (!data) { toast("This GIF is too large to caption within your upload limit. Try trimming it.", true); return; }
            const file = new File([data], "caption.gif", { type: "image/gif" });
            if (choice.mode === "send") {
                const channelId = reply?.channelId ?? store("SelectedChannelStore")?.getChannelId?.();
                if (!channelId) throw new Error("Open a chat first.");
                const pending = reply ? null : store("PendingReplyStore")?.getPendingReply?.(channelId);
                const target = reply ?? (pending?.message ? { channelId, messageId: pending.message.id, guildId: pending.channel?.guild_id } : null);
                const reference = target ? { channel_id: target.channelId, message_id: target.messageId, ...(target.guildId ? { guild_id: target.guildId } : {}) } : null;
                status.update("Sending GIF…", "Uploading");
                await sendFile(file, channelId, reference, fraction => status?.update("Sending GIF…", `${Math.round(fraction * 100)}%`));
                if (pending) window.Lowcord.Dispatcher?.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
                status.end(); status = null;
            } else {
                status.end(); status = null;
                if (reply) replyInComposer(reply);
                if (!window.Lowcord.privacy?.attach?.([file])) toast("The message box closed. Open the chat and try again.", true);
            }
        } catch (error) {
            toast(`Couldn't caption this GIF. ${error?.message ?? ""}`.trim(), true);
        } finally {
            status?.end();
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            busy = false;
        }
    }

    // ----- Picker buttons (delegated, nothing is scanned) ---------------------
    const glyph = () => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("width", "16"); node.setAttribute("height", "16"); node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="currentColor" fill-rule="evenodd" d="${icon}"/>`;
        return node;
    };
    function addButton(result) {
        if (result.hasAttribute("data-lowcord-gifcap") || !result.querySelector("video, img")) return;
        // Only results with a clip: trending category tiles are search shortcuts.
        if (!videoSource(result)) return;
        result.setAttribute("data-lowcord-gifcap", "");
        const button = ui("button", { type: "button", className: "lowcord-gifcap-btn", "aria-label": "Add a caption", title: "Add a caption" });
        button.append(glyph());
        result.append(button);
    }
    const onHover = event => {
        const result = event.target instanceof Element && event.target.closest(resultSelector);
        if (result) addButton(result);
    };
    const onClick = event => {
        const button = event.target instanceof Element && event.target.closest(".lowcord-gifcap-btn");
        if (!button) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const result = button.closest("[data-lowcord-gifcap]");
        const url = result && videoSource(result);
        if (!url) { toast("This GIF can't be captioned.", true); return; }
        open(url);
    };
    const onKeyDown = event => {
        if ((event.key === "Enter" || event.key === " ") && event.target instanceof Element && event.target.closest(".lowcord-gifcap-btn")) {
            event.stopImmediatePropagation(); // the button's own click still fires
        }
    };

    // ----- Message menu item ---------------------------------------------------
    function addMenuItem(menu, clip) {
        if (menu.querySelector(`#${menuId}`)) return;
        const reply = menu.querySelector("#message-reply");
        const model = [reply, menu.querySelector("#message-copy-text"), menu.querySelector('[role="menuitem"]:not([id*="quickreact"])')].find(Boolean);
        if (!model) return;
        const item = model.cloneNode(true);
        item.id = menuId;
        item.removeAttribute("aria-disabled");
        // Shares media-gallery's menu-item styling and hover handling.
        item.className = [...item.classList].filter(name => !/^(focused|disabled)_/.test(name)).join(" ") + " lowcord-copy-media";
        const suffix = /^item(_\w+)$/.exec([...item.classList].find(name => /^item_/.test(name)) ?? "")?.[1];
        const focusedClass = suffix ? `focused${suffix}` : "lowcord-copy-media-focused";
        const highlight = value => { item.classList.toggle(focusedClass, value); menu.toggleAttribute("data-lowcord-media-hover", value); };
        const label = "Caption this GIF";
        const text = item.querySelector('[data-text-variant], [class*="label_"]');
        item.removeAttribute("aria-labelledby");
        item.setAttribute("aria-label", label);
        if (text) text.textContent = label; else item.textContent = label;
        for (const node of item.querySelectorAll('[class*="subtext_"], [class*="hint_"]')) node.remove();
        const svg = item.querySelector("svg");
        if (svg) svg.innerHTML = `<path fill="currentColor" fill-rule="evenodd" d="${icon}"/>`;
        const pickItem = event => {
            event.preventDefault(); event.stopPropagation();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
            open(clip.url, clip.reply);
        };
        item.addEventListener("click", pickItem);
        item.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") pickItem(event); });
        item.addEventListener("pointerenter", () => highlight(true));
        item.addEventListener("pointerleave", () => highlight(false));
        item.addEventListener("focus", () => highlight(true));
        item.addEventListener("blur", () => highlight(false));
        if (model === reply) reply.after(item); else model.before(item);
        const plain = getComputedStyle(item);
        menu.style.setProperty("--lowcord-menu-item-bg", plain.backgroundColor);
        menu.style.setProperty("--lowcord-menu-item-color", plain.color);
    }
    let menuRequest = 0;
    const onContextMenu = event => {
        const request = ++menuRequest;
        document.getElementById(menuId)?.remove();
        const clip = chatClip(event.target);
        if (!clip) return;
        // The menu renders within a few frames of the click.
        let frames = 0;
        const look = () => {
            if (request !== menuRequest || !on) return;
            const menu = document.querySelector('#message[role="menu"]');
            if (menu) addMenuItem(menu, clip);
            else if (++frames < 30) requestAnimationFrame(look);
        };
        requestAnimationFrame(() => requestAnimationFrame(look));
    };

    let on = false;
    function sync() {
        const next = extensions.enabled(id);
        if (next === on) return;
        on = next;
        const method = next ? "addEventListener" : "removeEventListener";
        document[method]("mouseover", onHover, true);
        document[method]("focusin", onHover, true);
        document[method]("click", onClick, true);
        document[method]("keydown", onKeyDown, true);
        window[method]("contextmenu", onContextMenu, true);
        if (!next) {
            menuRequest++;
            document.getElementById(menuId)?.remove();
            closeDialog?.();
            for (const button of document.querySelectorAll(".lowcord-gifcap-btn")) button.remove();
            for (const result of document.querySelectorAll("[data-lowcord-gifcap]")) result.removeAttribute("data-lowcord-gifcap");
        }
    }
    window.addEventListener(extensions.changeEvent, sync);
    sync();
    window.Lowcord.gifCaptioner = { wrap, fit, fitBlock, memeLayout, subtitleLayout, trimText, tenorMp4, caption, open, messageClips, chatClip, sendFile, resultSelector };
})();
