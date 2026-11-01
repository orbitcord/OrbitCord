// Chat screenshots: pick a first and a last message, then the timeline scrolls
// through the range while the main process captures each screenful. Discord's
// own rendering is captured, so bubbles, embeds and themes look exactly as shown.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui, toast, progress } = extensions;
    const rowSelector = '[id^="chat-messages-"]';
    const cameraPath = "M9.4 3.5a2 2 0 0 0-1.66.89L6.66 6H5a3 3 0 0 0-3 3v8.5a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-1.66l-1.08-1.61a2 2 0 0 0-1.66-.89H9.4ZM12 8.5a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5Zm0 2a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z";
    // Chromium refuses canvases taller than 32767px, or larger than ~268M pixels.
    const maxSide = 32000, maxArea = 200e6;
    // The review shows a reduced copy; export uses the full capture.
    const previewArea = 16e6;
    const redactionTargets = [['name', '[id^="message-username-"], [class*="username_"], [class*="repliedTextUsername_"], span.mention'],
        ['avatar', '[class*="avatar_"], [class*="replyAvatar_"], .lowcord-bubble-avatar'], ['channel', 'a[href^="/channels/"] [class*="name_"]']];

    // One session at a time: picking, then capturing.
    let session;
    const native = () => window.__LOWCORD_NATIVE__;

    function scrollerOf(list) {
        for (let node = list.parentElement; node && node !== document.body; node = node.parentElement) {
            const overflow = getComputedStyle(node).overflowY;
            if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
        }
        return null;
    }
    const listOf = row => row.closest('[data-list-id="chat-messages"]') ?? row.parentElement;
    function rowsBetween(a, b) {
        if (!a || !b) return [];
        const [first, last] = a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? [b, a] : [a, b];
        const rows = [...listOf(first).querySelectorAll(rowSelector)];
        return rows.slice(rows.indexOf(first), rows.indexOf(last) + 1);
    }

    // ----- Picking ------------------------------------------------------------
    function mark(rows) {
        for (const row of session.marked) if (!rows.includes(row)) row.removeAttribute("data-lowcord-capture");
        for (const row of rows) if (row.getAttribute("data-lowcord-capture") !== "range") row.setAttribute("data-lowcord-capture", "range");
        session.marked = rows;
    }
    function render() {
        const { start, end, bar } = session;
        const count = rowsBetween(start, end).length;
        bar.title.textContent = !start ? "Click the first message" : !end ? "Click the last message"
            : `${count} message${count === 1 ? "" : "s"} selected`;
        bar.detail.textContent = !start ? "Scroll anywhere in the chat first." : !end ? "Scroll up or down to reach it."
            : "Click another message to change the end.";
        bar.capture.disabled = !end;
        place();
    }
    // Centred over the chat, clear of Discord's channel header.
    function place() {
        const scroller = session?.scroller;
        if (!scroller?.isConnected) return;
        const rect = scroller.getBoundingClientRect();
        session.bar.node.style.left = `${rect.left + rect.width / 2}px`;
        session.bar.node.style.top = `${rect.top + 12}px`;
    }
    function rowAt(event) {
        const row = event.target instanceof Element ? event.target.closest(rowSelector) : null;
        return row && session.scroller?.contains(row) ? row : null;
    }
    function onPointer(event) {
        if (!session || session.capturing || session.bar.node.contains(event.target)) return;
        const row = rowAt(event);
        if (event.type === "pointermove") {
            if (session.start && !session.end && row) mark(rowsBetween(session.start, row));
            else if (!session.start) mark(row ? [row] : []);
            return;
        }
        if (!row) return;
        // Message links, images and buttons must not act while picking.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type !== "click") return;
        // Later clicks move the end; a second click on the first message picks just it.
        if (!session.start) session.start = row;
        else session.end = row;
        mark(rowsBetween(session.start, session.end ?? row));
        render();
    }
    function onKey(event) {
        if (session && event.key === "Escape") {
            event.preventDefault(); event.stopImmediatePropagation();
            if (session.capturing) session.cancelled = true; else stop();
        }
    }
    function onDom() {
        if (!session || session.capturing) return;
        // A channel switch or history jump removes the rows; start over.
        if (!session.scroller.isConnected || (session.start && !session.start.isConnected) || (session.end && !session.end.isConnected)) {
            if (!session.scroller.isConnected) { stop(); return; }
            session.start = session.end = null;
            mark([]);
            render();
        }
    }
    const pointerEvents = ["pointerdown", "mousedown", "click", "pointermove", "auxclick", "dblclick"];
    let stopDom;
    function start() {
        if (session) { stop(); return; }
        if (!native()?.captureRegion) { toast("Chat screenshots need the OrbitCord app", true); return; }
        const list = document.querySelector('[data-list-id="chat-messages"]')
            ?? document.querySelector(rowSelector)?.parentElement;
        const scroller = list && scrollerOf(list);
        if (!scroller) { toast("Open a chat first", true); return; }
        const capture = ui("button", { type: "button", className: "lowcord-button lowcord-button-primary", onClick: run }, "Capture");
        const cancel = ui("button", { type: "button", className: "lowcord-button", onClick: () => {
            if (session?.capturing) session.cancelled = true; else stop();
        } }, "Cancel");
        const title = ui("span", { className: "lowcord-toast-title" });
        const detail = ui("span", { className: "lowcord-toast-detail" });
        const node = ui("div", { className: "lowcord-capture-bar", role: "dialog", "aria-label": "Chat screenshot" },
            ui("span", { className: "lowcord-toast-copy" }, title, detail), cancel, capture);
        session = { scroller, start: null, end: null, marked: [], bar: { node, title, detail, capture, cancel } };
        document.body.append(node);
        scroller.setAttribute("data-lowcord-capture-picking", "true");
        for (const type of pointerEvents) window.addEventListener(type, onPointer, true);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", place);
        stopDom = window.Lowcord.onDomChange(onDom);
        render();
    }
    function stop() {
        if (!session) return;
        for (const type of pointerEvents) window.removeEventListener(type, onPointer, true);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", place);
        stopDom?.(); stopDom = undefined;
        mark([]);
        session.scroller.removeAttribute("data-lowcord-capture-picking");
        session.bar.node.remove();
        session = undefined;
    }

    // ----- Capturing ----------------------------------------------------------
    const frame = () => new Promise(requestAnimationFrame);
    async function settle(rows, top, bottom) {
        await frame(); await frame();
        // Wait, briefly, for pictures that just scrolled into view.
        const pending = [];
        for (const row of rows) {
            const rect = row.getBoundingClientRect();
            if (rect.bottom < top || rect.top > bottom) continue;
            for (const img of row.querySelectorAll("img")) {
                if (!img.complete) pending.push(new Promise(resolve => {
                    img.addEventListener("load", resolve, { once: true });
                    img.addEventListener("error", resolve, { once: true });
                }));
            }
        }
        if (pending.length) await Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, 1500))]);
        await frame();
    }
    // The part of the chat nothing else covers. Discord's message bar overlaps
    // the scroller's bottom edge; anything over the chat would repeat as a band
    // in every screenful. Messages ignore the pointer while capturing, so a hit
    // that the scroller doesn't own is an overlay.
    function clearSpan(scroller) {
        const box = scroller.getBoundingClientRect();
        let top = box.top + scroller.clientTop, bottom = top + scroller.clientHeight;
        const left = box.left + scroller.clientLeft;
        const owned = (x, y) => { const hit = document.elementFromPoint(x, y); return !hit || scroller.contains(hit); };
        for (const x of [left + 24, left + scroller.clientWidth / 2, left + scroller.clientWidth - 24]) {
            while (bottom - top > 80 && !owned(x, bottom - 1)) bottom -= 1;
            while (bottom - top > 80 && !owned(x, top)) top += 1;
        }
        return { top, bottom };
    }
    async function run() {
        if (!session?.end || session.capturing) return;
        const current = session;
        const { scroller } = current;
        let [first, last] = [current.start, current.end];
        if (first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_PRECEDING) [first, last] = [last, first];
        const rows = rowsBetween(first, last);
        current.capturing = true;
        mark([]);
        current.bar.capture.disabled = true;
        current.bar.title.textContent = "Capturing…";
        current.bar.detail.textContent = "Esc stops.";
        document.documentElement.setAttribute("data-lowcord-capturing", "true");
        // Move the bar onto the channel header, out of the picture.
        const bar = current.bar.node;
        bar.style.top = `${Math.max(4, scroller.getBoundingClientRect().top - bar.offsetHeight - 4)}px`;
        await frame(); await frame();
        // Put the reader back where they were afterwards.
        const view = scroller.getBoundingClientRect();
        const anchor = [...scroller.querySelectorAll(rowSelector)].find(row => row.getBoundingClientRect().bottom > view.top);
        const anchorTop = anchor?.getBoundingClientRect().top;
        const segments = [], redactions = [], messageRegions = [];
        const seenRegions = new Set();
        let failure;
        try {
            let y = 0, stalls = 0, height = 0, left = 0, width = 0;
            for (let step = 0; step < 1000; step++) {
                if (current.cancelled) throw new Error("cancelled");
                if (!first.isConnected || !last.isConnected) throw new Error("unloaded");
                const box = scroller.getBoundingClientRect();
                const { top: viewTop, bottom: viewBottom } = clearSpan(scroller);
                scroller.scrollTop += first.getBoundingClientRect().top + y - viewTop;
                await settle(rows, viewTop, viewBottom);
                if (current.cancelled) throw new Error("cancelled");
                const top = first.getBoundingClientRect().top;
                height = last.getBoundingClientRect().bottom - top;
                left = Math.round(box.left + scroller.clientLeft);
                width = Math.round(scroller.clientWidth);
                const from = Math.round(Math.max(viewTop, top + y)), to = Math.round(Math.min(viewBottom, top + height));
                // History loading above can move the range; retry from the same place.
                if (from > Math.round(top + y) + 1 || to <= from) {
                    if (++stalls > 8) throw new Error("stuck");
                    continue;
                }
                stalls = 0;
                // Measure against the same origin used by capture. Redactions
                // are painted into exported pixels, never cosmetic blur layers.
                for (const row of rows) {
                    const box = row.getBoundingClientRect();
                    if (box.bottom <= from || box.top >= to) continue;
                    if (!seenRegions.has(row.id)) {
                        seenRegions.add(row.id);
                        messageRegions.push({ id: row.id, x: 0, y: box.top - top, width, height: box.height });
                    }
                    for (const [kind, selector] of redactionTargets) {
                        row.querySelectorAll(selector).forEach((node, index) => {
                            const regionKey = `${row.id}:${kind}:${index}`;
                            if (seenRegions.has(regionKey)) return;
                            const rect = node.getBoundingClientRect();
                            if (!rect.width || !rect.height) return;
                            seenRegions.add(regionKey);
                            redactions.push({ kind, x: rect.left - left - 2, y: rect.top - top - 2, width: rect.width + 4, height: rect.height + 4 });
                        });
                    }
                }
                const bytes = await native().captureRegion({ x: left, y: from, width, height: to - from });
                segments.push({ offset: from - top, height: to - from, blob: new Blob([bytes], { type: "image/png" }) });
                current.bar.title.textContent = `Capturing… ${Math.min(99, Math.round((to - top) / height * 100))}%`;
                y = to - top;
                if (y >= height - 0.5) break;
            }
            if (!segments.length) throw new Error("empty");
            const background = getComputedStyle(scroller).backgroundColor;
            return await finish(segments, width, height, background, redactions, messageRegions);
        } catch (error) {
            failure = error;
        } finally {
            document.documentElement.removeAttribute("data-lowcord-capturing");
            if (anchor?.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
            if (session === current) stop();
        }
        if (failure.message === "cancelled") return;
        if (failure.message === "unloaded") toast("Couldn't capture that many messages. Pick a shorter range.", true);
        else { console.warn("[lowcord] Chat screenshot:", failure); toast("Couldn't capture the chat. Try again.", true); }
    }
    async function finish(segments, width, height, background, redactions = [], messageRegions = []) {
        const first = await createImageBitmap(segments[0].blob);
        // Device pixels per CSS pixel, as captured.
        const density = first.width / width;
        first.close();
        let scale = density;
        if (height * scale > maxSide) scale = maxSide / height;
        if (width * scale * height * scale > maxArea) scale = Math.sqrt(maxArea / (width * height));
        const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = background && background !== "rgba(0, 0, 0, 0)" ? background : "#313338";
        context.fillRect(0, 0, canvas.width, canvas.height);
        // Decode one screenful at a time to keep memory flat. Both edges come
        // from the running offset, so neighbours meet exactly: rounding each
        // height on its own left 1px gaps (a visible seam) at fractional zoom.
        // Each also reaches a pixel into the next, which paints over it.
        for (const [index, segment] of segments.entries()) {
            const bitmap = await createImageBitmap(segment.blob);
            const top = Math.round(segment.offset * scale);
            const bottom = index === segments.length - 1 ? Math.round((segment.offset + segment.height) * scale)
                : Math.min(canvas.height, Math.round((segment.offset + segment.height) * scale) + 1);
            context.drawImage(bitmap, 0, top, canvas.width, bottom - top);
            bitmap.close();
        }
        const channel = window.Lowcord.store?.("ChannelStore")?.getChannel(window.Lowcord.store?.("SelectedChannelStore")?.getChannelId());
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
        const name = `${(channel?.name || "Chat").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "Chat"} ${stamp}.png`;
        if (extensions.options.captureReview !== false) {
            await preview(canvas, scale, redactions, messageRegions);
            return { width: canvas.width, height: canvas.height, segments: segments.length };
        }
        const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
        await native().copyImage(png);
        toast("Chat image copied. Paste it anywhere, or save it as a file.", false,
            { label: "Save…", onClick: () => native().saveImage(png, name).catch(() => toast("Couldn't save the image", true)) });
        return { width: canvas.width, height: canvas.height, segments: segments.length };
    }

    async function preview(source, scale, regions, messages) {
        const restoreFocus = document.activeElement;
        // Defaults come from the Chat screenshots options; each review can change them.
        const defaults = extensions.options;
        const hidden = new Set(), options = { name: defaults.captureNames !== false, avatar: defaults.captureAvatars !== false, channel: defaults.captureChannels !== false };
        const reduce = Math.min(1, Math.sqrt(previewArea / (source.width * source.height)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(source.width * reduce)); canvas.height = Math.max(1, Math.round(source.height * reduce));
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'Screenshot preview. Click a message to hide or reveal it.');
        const context = canvas.getContext('2d');
        const box = (region, factor) => [Math.floor(region.x * factor), Math.floor(region.y * factor), Math.ceil(region.width * factor), Math.ceil(region.height * factor)];
        const boxes = factor => [...regions.filter(r => options[r.kind]), ...messages.filter(m => hidden.has(m.id))].map(region => box(region, factor));
        const count = ui('span', { className: 'lowcord-capture-count', 'aria-live': 'polite' });
        const showAll = ui('button', { type: 'button', className: 'lowcord-capture-link', onClick: () => { hidden.clear(); paint(); } }, 'Show all');
        // Toggles repaint only the small preview, never the full capture. The
        // "Hidden" label is a preview aid; exports get plain solid boxes.
        const paint = () => {
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            context.fillStyle = '#202126';
            for (const rect of boxes(scale * reduce)) context.fillRect(...rect);
            context.fillStyle = '#949ba4'; context.font = `500 ${Math.max(11, Math.round(13 * scale * reduce))}px system-ui, sans-serif`; context.textBaseline = 'middle';
            for (const message of messages.filter(m => hidden.has(m.id))) {
                const [x, y, , height] = box(message, scale * reduce);
                if (height > 12) context.fillText('Hidden', x + Math.round(16 * scale * reduce), y + height / 2);
            }
            count.textContent = hidden.size ? `${hidden.size} message${hidden.size === 1 ? '' : 's'} hidden` : '';
            showAll.hidden = !hidden.size;
        };
        paint();
        const backdrop = ui('div', { className: 'lowcord-capture-preview-backdrop' });
        const close = () => { document.removeEventListener('keydown', onKey, true); backdrop.remove(); canvas.width = canvas.height = 0; source.width = source.height = 0; restoreFocus?.focus?.(); };
        const onKey = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
            if (event.key === 'Tab') {
                const nodes = [...backdrop.querySelectorAll('button:not(:disabled):not([hidden])')];
                const first = nodes[0], last = nodes.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        };
        const chip = (kind, label) => {
            const button = ui('button', { type: 'button', className: 'lowcord-capture-chip', 'aria-pressed': String(options[kind]), 'aria-label': `Hide ${label.toLowerCase()}`,
                onClick: () => { options[kind] = !options[kind]; button.setAttribute('aria-pressed', String(options[kind])); paint(); } }, label);
            return button;
        };
        // Paint solid boxes into the full capture, encode, then put back only the
        // covered pixels so later toggles still work. No second full-size copy.
        const exportBytes = async () => {
            const full = source.getContext('2d'), saved = [];
            for (const rect of boxes(scale)) { saved.push([full.getImageData(...rect), rect[0], rect[1]]); full.fillStyle = '#202126'; full.fillRect(...rect); }
            try { return new Uint8Array(await (await source.convertToBlob({ type: 'image/png' })).arrayBuffer()); }
            finally { for (const [data, x, y] of saved.reverse()) full.putImageData(data, x, y); }
        };
        const status = ui('p', { className: 'lowcord-capture-status', role: 'status', 'aria-live': 'polite' }, 'Covered areas are solid in the saved image.');
        let exporting = false;
        const exportImage = async save => {
            // Overlapping exports would save already-covered pixels as originals.
            if (exporting) return;
            exporting = true;
            try {
                const bytes = await exportBytes();
                const result = save ? await native().saveImage(bytes, 'Redacted chat.png') : await native().copyImage(bytes);
                if (save && result === null) return;
                status.textContent = save ? 'Redacted image saved.' : 'Redacted image copied.';
            } catch { status.textContent = 'Could not export the image. Try again.'; }
            finally { exporting = false; }
        };
        // Hover outlines the message a click would hide or reveal.
        const outline = ui('span', { className: 'lowcord-capture-outline', hidden: true, 'aria-hidden': 'true' });
        const messageAt = event => {
            const rect = canvas.getBoundingClientRect(), y = (event.clientY - rect.top) / rect.height * source.height / scale;
            return messages.find(m => y >= m.y && y < m.y + m.height);
        };
        canvas.addEventListener('pointermove', event => {
            const message = messageAt(event);
            outline.hidden = !message;
            if (message) Object.assign(outline.style, { top: `${message.y * scale / source.height * 100}%`, height: `${message.height * scale / source.height * 100}%` });
        });
        canvas.addEventListener('pointerleave', () => { outline.hidden = true; });
        canvas.addEventListener('click', event => {
            const message = messageAt(event);
            if (message) { if (hidden.has(message.id)) hidden.delete(message.id); else hidden.add(message.id); paint(); }
        });
        const closeButton = ui('button', { type: 'button', className: 'lowcord-settings-close', 'aria-label': 'Close preview', onClick: close }, '×');
        const panel = ui('section', { className: 'lowcord-capture-preview', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lowcord-capture-title' },
            ui('header', {}, ui('div', {}, ui('h2', { id: 'lowcord-capture-title' }, 'Review screenshot'),
                ui('p', {}, 'Click a message to hide it. Nothing is copied or saved until you choose.')), closeButton),
            ui('div', { className: 'lowcord-capture-toolbar' },
                ui('div', { className: 'lowcord-capture-chips', role: 'group', 'aria-label': 'Cover' }, ui('span', {}, 'Cover'),
                    chip('name', 'Names'), chip('avatar', 'Avatars'), chip('channel', 'Channel mentions')),
                ui('div', { className: 'lowcord-capture-hidden' }, count, showAll)),
            ui('div', { className: 'lowcord-capture-preview-image' }, ui('div', { className: 'lowcord-capture-stage' }, canvas, outline)),
            ui('footer', {}, status,
                ui('div', { className: 'lowcord-capture-actions' },
                    ui('button', { type: 'button', className: 'lowcord-button', onClick: () => exportImage(false) }, 'Copy image'),
                    ui('button', { type: 'button', className: 'lowcord-button lowcord-button-primary', onClick: () => exportImage(true) }, 'Save image'))));
        backdrop.append(panel); document.body.append(backdrop); document.addEventListener('keydown', onKey, true);
        closeButton.focus();
    }

    // ----- Message bar action ---------------------------------------------------
    extensions.addComposerAction({ id: "chatCapture", order: 1, label: "Screenshot messages", path: cameraPath, run: start });
    window.addEventListener(extensions.changeEvent, () => { if (session && !extensions.enabled("chatCapture")) stop(); });
    window.Lowcord.chatCapture = { start, stop, run, preview, finish, get active() { return Boolean(session); } };
})();
