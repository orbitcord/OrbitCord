// Edit photos: crop, rotate, flip and cover parts of an image before it is
// attached. The file is re-encoded from pixels, so nothing under a cover box
// or outside the crop survives. Discord's attachment list is never touched;
// the result goes in through a normal paste.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui, toast } = extensions;
    // Crop marks: the composer button's icon.
    const path = "M7 2a1 1 0 0 1 1 1v12a1 1 0 0 0 1 1h12a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3H9a3 3 0 0 1-3-3V8H3a1 1 0 0 1 0-2h3V3a1 1 0 0 1 1-1Zm3 4h5a3 3 0 0 1 3 3v5a1 1 0 1 1-2 0V9a1 1 0 0 0-1-1h-5a1 1 0 1 1 0-2Z";
    // Outline icons from Tabler Icons (MIT), drawn as 2px strokes.
    const icons = {
        rotateLeft: "M15 4.55a8 8 0 0 0 -6 14.9m0 -4.45v5h-5M18.37 7.16v.01M13 19.94v.01M16.84 18.37v.01M19.37 15.1v.01M19.94 11v.01",
        rotateRight: "M9 4.55a8 8 0 0 1 6 14.9m0 -4.45v5h5M5.63 7.16v.01M4.06 11v.01M4.63 15.1v.01M7.37 18.37v.01M11 19.94v.01",
        flipH: "M12 3v18M16 7v10h5l-5 -10M8 7v10h-5l5 -10",
        flipV: "M3 12h18M7 16h10l-10 5v-5M7 8h10l-10 -5v5",
        cover: "M4 5a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1zM8 9h6v5h-6z",
        undo: "M9 14l-4 -4l4 -4M5 10h11a4 4 0 1 1 0 8h-1",
        redo: "M15 14l4 -4l-4 -4M19 10h-11a4 4 0 1 0 0 8h1",
        compare: "M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6",
    };
    const types = /^image\/(?:png|jpeg|webp)$/;
    // Chromium refuses canvases larger than ~268M pixels; the preview stays small.
    const maxArea = 200e6, previewArea = 16e6, fill = "#000";
    const supports = file => types.test(file.type) || /\.(?:png|jpe?g|webp)$/i.test(file.name);
    const ratios = [["Free", 0], ["Original", -1], ["Square", 1], ["4:3", 4 / 3], ["16:9", 16 / 9], ["3:4", 3 / 4], ["9:16", 9 / 16]];

    // Animated files would keep only their first frame.
    async function animated(file) {
        const content = new TextDecoder("latin1").decode(await file.slice(0, 256 * 1024).arrayBuffer());
        if (content.startsWith("RIFF")) return content.includes("ANIM");
        return content.startsWith("PNG", 1) && content.slice(0, content.indexOf("IDAT")).includes("acTL");
    }
    const icon = (name, size = 16) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("width", size); node.setAttribute("height", size); node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="${icons[name]}"/>`;
        return node;
    };

    // ----- Geometry ----------------------------------------------------------
    // An edit is a matrix from the source image to its rotated/flipped
    // ("oriented") space, that space's size, an optional crop and cover boxes.
    // Crop and boxes live in oriented space, so each rotate or flip maps them too.
    const clampRect = (rect, width, height) => {
        const x = Math.max(0, Math.min(width, rect.x)), y = Math.max(0, Math.min(height, rect.y));
        return { x, y, width: Math.max(0, Math.min(width, rect.x + rect.width) - x), height: Math.max(0, Math.min(height, rect.y + rect.height) - y) };
    };
    function mapRect(matrix, rect) {
        const a = matrix.transformPoint({ x: rect.x, y: rect.y }), b = matrix.transformPoint({ x: rect.x + rect.width, y: rect.y + rect.height });
        return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    }
    function transform(edit, op) {
        const { width: w, height: h } = edit;
        const turn = op === "rotateLeft" || op === "rotateRight";
        const matrix = op === "rotateRight" ? new DOMMatrix([0, 1, -1, 0, h, 0]) : op === "rotateLeft" ? new DOMMatrix([0, -1, 1, 0, 0, w])
            : op === "flipH" ? new DOMMatrix([-1, 0, 0, 1, w, 0]) : new DOMMatrix([1, 0, 0, -1, 0, h]);
        return { matrix: matrix.multiply(edit.matrix), width: turn ? h : w, height: turn ? w : h,
            crop: edit.crop && mapRect(matrix, edit.crop), boxes: edit.boxes.map(box => mapRect(matrix, box)) };
    }
    const fullCrop = edit => ({ x: 0, y: 0, width: edit.width, height: edit.height });
    const cropOf = edit => edit.crop ?? fullCrop(edit);
    // True when the edit would produce the same pixels as the original.
    const untouched = edit => edit.matrix.isIdentity && !edit.boxes.length
        && (!edit.crop || (edit.crop.x < .5 && edit.crop.y < .5 && edit.crop.width > edit.width - 1 && edit.crop.height > edit.height - 1));
    // The largest rectangle of a ratio, centred in the image.
    function centred(edit, ratio) {
        let width = edit.width, height = width / ratio;
        if (height > edit.height) { height = edit.height; width = height * ratio; }
        return { x: (edit.width - width) / 2, y: (edit.height - height) / 2, width, height };
    }

    function dialog(bitmap, name, { tool: startTool = "crop", index = 0, total = 1, queue = [] } = {}) {
        return new Promise(resolve => {
            const restoreFocus = document.activeElement;
            const reduce = Math.min(1, Math.sqrt(previewArea / (bitmap.width * bitmap.height)));
            let edit = { matrix: new DOMMatrix(), width: bitmap.width, height: bitmap.height, crop: null, boxes: [] };
            const history = [], future = [];
            let comparing = false;
            let tool = startTool, ratio = 0, choice = 0, drag = null;
            const canvas = ui("canvas", { role: "img" });
            const context = canvas.getContext("2d");
            const size = () => {
                canvas.width = Math.max(1, Math.round(edit.width * reduce));
                canvas.height = Math.max(1, Math.round(edit.height * reduce));
            };
            // ~12 CSS pixels in image units, for grabbing crop handles.
            const tolerance = () => 12 * edit.width / Math.max(1, canvas.getBoundingClientRect().width);
            const handles = rect => {
                const { x, y, width: w, height: h } = rect, list = [["nw", x, y], ["ne", x + w, y], ["sw", x, y + h], ["se", x + w, y + h]];
                if (!ratio) list.push(["n", x + w / 2, y], ["s", x + w / 2, y + h], ["w", x, y + h / 2], ["e", x + w, y + h / 2]);
                return list;
            };
            function paint() {
                if (comparing) {
                    // Hold to compare: the untouched original, at its own shape.
                    canvas.width = Math.max(1, Math.round(bitmap.width * reduce)); canvas.height = Math.max(1, Math.round(bitmap.height * reduce));
                    context.setTransform(reduce, 0, 0, reduce, 0, 0);
                    context.drawImage(bitmap, 0, 0);
                    return;
                }
                context.setTransform(new DOMMatrix([reduce, 0, 0, reduce, 0, 0]).multiply(edit.matrix));
                context.drawImage(bitmap, 0, 0);
                context.setTransform(reduce, 0, 0, reduce, 0, 0);
                context.fillStyle = fill;
                const boxes = drag?.kind === "box" ? [...edit.boxes, drag.box] : edit.boxes;
                for (const box of boxes) context.fillRect(box.x, box.y, box.width, box.height);
                const crop = edit.crop ?? (tool === "crop" ? fullCrop(edit) : null);
                if (crop) {
                    context.fillStyle = "rgb(0 0 0 / .55)";
                    context.beginPath(); context.rect(0, 0, edit.width, edit.height); context.rect(crop.x, crop.y, crop.width, crop.height);
                    context.fill("evenodd");
                }
                if (crop && tool === "crop") {
                    context.setTransform(1, 0, 0, 1, 0, 0);
                    const [x, y, w, h] = [crop.x, crop.y, crop.width, crop.height].map(value => value * reduce);
                    const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width || canvas.width);
                    // Thirds guide, brighter while dragging; then the frame.
                    context.lineWidth = scale; context.strokeStyle = drag ? "rgb(255 255 255 / .6)" : "rgb(255 255 255 / .28)";
                    context.beginPath();
                    for (const part of [1, 2]) {
                        context.moveTo(x + w * part / 3, y); context.lineTo(x + w * part / 3, y + h);
                        context.moveTo(x, y + h * part / 3); context.lineTo(x + w, y + h * part / 3);
                    }
                    context.stroke();
                    context.lineWidth = scale; context.strokeStyle = "rgb(255 255 255 / .9)";
                    context.strokeRect(x, y, w, h);
                    // Corner brackets and, for a free crop, short edge bars.
                    const arm = Math.min(18 * scale, w / 3, h / 3), thick = 3 * scale;
                    context.fillStyle = "#fff";
                    // Drawn inside the frame, so they stay whole at the image's edges.
                    for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
                        context.fillRect(dx > 0 ? cx : cx - arm, dy > 0 ? cy : cy - thick, arm, thick);
                        context.fillRect(dx > 0 ? cx : cx - thick, dy > 0 ? cy : cy - arm, thick, arm);
                    }
                    if (!ratio) {
                        const bar = Math.min(20 * scale, w / 4, h / 4);
                        context.fillRect(x + w / 2 - bar / 2, y, bar, thick); context.fillRect(x + w / 2 - bar / 2, y + h - thick, bar, thick);
                        context.fillRect(x, y + h / 2 - bar / 2, thick, bar); context.fillRect(x + w - thick, y + h / 2 - bar / 2, thick, bar);
                    }
                }
                canvas.style.cursor = tool === "cover" ? "crosshair" : "";
                canvas.setAttribute("aria-label", tool === "crop" ? `Preview of ${name}. Drag the frame or its corners to crop.` : `Preview of ${name}. Drag over a part of the image to cover it.`);
                undo.disabled = !history.length;
                redo.disabled = !future.length;
                reset.disabled = compare.disabled = untouched(edit) && !edit.crop;
                const covered = edit.boxes.length;
                const cropped = edit.crop && !untouched({ ...edit, boxes: [], matrix: new DOMMatrix() });
                const out = cropOf(edit);
                status.textContent = [cropped ? `${Math.round(out.width)} × ${Math.round(out.height)}` : "",
                    covered ? `${covered} area${covered === 1 ? "" : "s"} covered` : ""].filter(Boolean).join(" · ");
                coverButton.setAttribute("aria-pressed", String(tool === "cover"));
                clear.hidden = !covered;
                for (const button of ratioButtons) button.setAttribute("aria-pressed", String(tool === "crop" && Number(button.dataset.ratio) === choice));
            }
            const commit = next => { history.push(edit); if (history.length > 50) history.shift(); future.length = 0; edit = next; };
            const apply = op => {
                commit(transform(edit, op));
                // A quarter turn swaps a held shape, so 4:3 becomes 3:4.
                if (ratio && op.startsWith("rotate")) {
                    ratio = 1 / ratio;
                    if (choice !== -1) choice = ratios.find(([, value]) => value > 0 && Math.abs(value - ratio) < 1e-6)?.[1] ?? 0;
                    if (!choice && choice !== -1) ratio = 0;
                }
                size(); paint();
            };
            const point = event => {
                const rect = canvas.getBoundingClientRect();
                return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * edit.width,
                    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * edit.height };
            };
            const span = (from, to) => ({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) });
            // A rectangle from a fixed corner to the pointer, held to the ratio.
            function framed(anchor, to) {
                let width = Math.abs(to.x - anchor.x), height = Math.abs(to.y - anchor.y);
                if (ratio) {
                    if (width / height > ratio) width = height * ratio; else height = width / ratio;
                    const room = { x: to.x < anchor.x ? anchor.x : edit.width - anchor.x, y: to.y < anchor.y ? anchor.y : edit.height - anchor.y };
                    const fit = Math.min(1, room.x / Math.max(width, 1e-6), room.y / Math.max(height, 1e-6));
                    width *= fit; height *= fit;
                }
                return clampRect({ x: to.x < anchor.x ? anchor.x - width : anchor.x, y: to.y < anchor.y ? anchor.y - height : anchor.y, width, height }, edit.width, edit.height);
            }
            canvas.addEventListener("pointerdown", event => {
                if (event.button !== 0) return;
                canvas.setPointerCapture(event.pointerId);
                const at = point(event);
                if (tool === "cover") { drag = { kind: "box", from: at, box: span(at, at) }; return; }
                const crop = cropOf(edit), reach = tolerance();
                const handle = handles(crop).find(([, hx, hy]) => Math.abs(at.x - hx) <= reach && Math.abs(at.y - hy) <= reach)?.[0];
                const inside = at.x > crop.x && at.x < crop.x + crop.width && at.y > crop.y && at.y < crop.y + crop.height;
                drag = { kind: handle ? "resize" : inside ? "move" : "draw", handle, from: at, start: crop, before: edit };
            });
            canvas.addEventListener("pointermove", event => {
                if (!drag) {
                    if (tool !== "crop") return;
                    const at = point(event), crop = cropOf(edit), reach = tolerance();
                    const handle = handles(crop).find(([, hx, hy]) => Math.abs(at.x - hx) <= reach && Math.abs(at.y - hy) <= reach)?.[0];
                    const inside = at.x > crop.x && at.x < crop.x + crop.width && at.y > crop.y && at.y < crop.y + crop.height;
                    canvas.style.cursor = handle ? `${handle}-resize` : inside ? "move" : "crosshair";
                    return;
                }
                const at = point(event);
                if (drag.kind === "box") { drag.box = span(drag.from, at); paint(); return; }
                const { start } = drag;
                let crop;
                if (drag.kind === "move") {
                    crop = { ...start, x: Math.max(0, Math.min(edit.width - start.width, start.x + at.x - drag.from.x)),
                        y: Math.max(0, Math.min(edit.height - start.height, start.y + at.y - drag.from.y)) };
                } else if (drag.kind === "draw") crop = framed(drag.from, at);
                else if (drag.handle.length === 2) {
                    // Corner: the opposite corner stays put.
                    const anchor = { x: drag.handle.includes("w") ? start.x + start.width : start.x, y: drag.handle.includes("n") ? start.y + start.height : start.y };
                    crop = framed(anchor, at);
                } else {
                    const right = start.x + start.width, bottom = start.y + start.height;
                    crop = { ...start };
                    if (drag.handle === "w") { crop.x = Math.min(at.x, right); crop.width = right - crop.x; }
                    if (drag.handle === "e") crop.width = Math.max(0, at.x - start.x);
                    if (drag.handle === "n") { crop.y = Math.min(at.y, bottom); crop.height = bottom - crop.y; }
                    if (drag.handle === "s") crop.height = Math.max(0, at.y - start.y);
                }
                edit = { ...edit, crop };
                paint();
            });
            const release = () => {
                if (!drag) return;
                const done = drag;
                drag = null;
                if (done.kind === "box") {
                    if (done.box.width * reduce >= 3 && done.box.height * reduce >= 3) commit({ ...edit, boxes: [...edit.boxes, done.box] });
                } else {
                    // A click or a frame too small to see leaves the crop as it was.
                    const crop = edit.crop;
                    if (!crop || crop.width * reduce < 8 || crop.height * reduce < 8) edit = done.before;
                    else if (JSON.stringify(crop) !== JSON.stringify(done.before.crop)) { const next = edit; edit = done.before; commit(next); }
                }
                paint();
            };
            canvas.addEventListener("pointerup", release);
            canvas.addEventListener("pointercancel", release);
            const finish = value => { document.removeEventListener("keydown", onKey, true); backdrop.remove(); for (const url of urls) URL.revokeObjectURL(url); restoreFocus?.focus?.(); resolve(value); };
            const onKey = event => {
                if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(null); return; }
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
                    event.preventDefault(); event.stopImmediatePropagation(); (event.shiftKey ? redo : undo).click(); return;
                }
                if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLButtonElement)) {
                    event.preventDefault(); event.stopImmediatePropagation(); finish(edit); return;
                }
                if (event.key === "Tab") {
                    const nodes = [...backdrop.querySelectorAll("button:not(:disabled)")].filter(node => !node.closest("[hidden]")), first = nodes[0], last = nodes.at(-1);
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                }
            };
            const button = (label, props, ...children) => ui("button", { type: "button", ...props }, ...children, label);
            // Icon with a one-word label; the full name is the accessible one.
            const toolButton = (op, word, label) => button("", { className: "lowcord-edit-icon", "aria-label": label, title: label, onClick: () => apply(op) },
                icon(op, 18), ui("span", {}, word));
            const historyButton = (name, label, props) => button("", { className: "lowcord-edit-history-button", "aria-label": label, title: label, ...props }, icon(name, 18));
            // The chosen shape, and the ratio it holds the crop to (0 is free).
            // "Original" follows the image as it is now turned. 3:4 is reached by
            // turning a 4:3 crop, so it isn't offered as a button of its own.
            const ratioButtons = ratios.filter(([label]) => label !== "3:4").map(([label, value]) => {
                const node = button(label, { className: "lowcord-edit-chip", "aria-pressed": "false", onClick: () => {
                    tool = "crop"; choice = value;
                    ratio = value === -1 ? edit.width / edit.height : value;
                    if (ratio) commit({ ...edit, crop: centred(edit, ratio) });
                    paint();
                } });
                node.dataset.ratio = String(value);
                return node;
            });
            const coverButton = button("Cover areas", { className: "lowcord-edit-toggle", "aria-pressed": "false",
                onClick: () => { tool = tool === "cover" ? "crop" : "cover"; paint(); } }, icon("cover"));
            const clear = button("Clear", { className: "lowcord-edit-link", onClick: () => { commit({ ...edit, boxes: [] }); paint(); } });
            const mod = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+";
            const undo = historyButton("undo", `Undo (${mod}Z)`, { onClick: () => { if (history.length) { future.push(edit); edit = history.pop(); size(); paint(); } } });
            const redo = historyButton("redo", `Redo (${mod}Shift+Z)`.replace("⌘Shift+", "⇧⌘"), { onClick: () => { if (future.length) { history.push(edit); edit = future.pop(); size(); paint(); } } });
            // Shows the original only while held, by pointer or by Space/Enter.
            const hold = on => { if (comparing === on) return; comparing = on; compare.setAttribute("aria-pressed", String(on)); if (!on) size(); paint(); };
            const compare = historyButton("compare", "Hold to see the original", { "aria-pressed": "false",
                onPointerdown: event => { compare.setPointerCapture(event.pointerId); hold(true); }, onPointerup: () => hold(false), onPointercancel: () => hold(false),
                onKeydown: event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); hold(true); } },
                onKeyup: event => { if (event.key === " " || event.key === "Enter") hold(false); }, onBlur: () => hold(false) });
            const reset = button("Reset", { className: "lowcord-edit-reset", title: "Undo every change to this photo",
                onClick: () => { commit({ matrix: new DOMMatrix(), width: bitmap.width, height: bitmap.height, crop: null, boxes: [] }); ratio = choice = 0; size(); paint(); } });
            const status = ui("span", { className: "lowcord-capture-count", "aria-live": "polite" });
            const closeButton = ui("button", { type: "button", className: "lowcord-settings-close", "aria-label": "Close", onClick: () => finish(null) }, "×");
            const many = total > 1;
            const section = (title, ...children) => ui("div", { className: "lowcord-edit-section", role: "group", "aria-label": title }, ui("h3", {}, title), ...children);
            // Thumbnails of every photo in this batch, the current one marked.
            const urls = many ? queue.map(file => URL.createObjectURL(file)) : [];
            const strip = many ? ui("div", { className: "lowcord-edit-strip" },
                ...urls.map((url, position) => ui("img", { src: url, alt: "", className: position === index ? "is-current" : position < index ? "is-done" : "" })),
                ui("span", {}, `${index + 1} of ${total}`)) : null;
            const panel = ui("section", { className: "lowcord-edit-preview", role: "dialog", "aria-modal": "true", "aria-labelledby": "lowcord-cover-title" },
                ui("div", { className: "lowcord-edit-main" },
                    ui("div", { className: "lowcord-edit-stage" }, canvas), strip),
                ui("aside", { className: "lowcord-edit-panel" },
                    ui("header", {}, ui("h2", { id: "lowcord-cover-title" }, many ? `Edit image ${index + 1} of ${total}` : "Edit image"), closeButton),
                    ui("div", { className: "lowcord-edit-historybar", role: "group", "aria-label": "History" }, ui("span", {}, undo, redo, compare), reset),
                    section("Crop", ui("div", { className: "lowcord-edit-ratios" }, ...ratioButtons)),
                    section("Rotate and flip", ui("div", { className: "lowcord-edit-icons" },
                        toolButton("rotateLeft", "Left", "Rotate left"), toolButton("rotateRight", "Right", "Rotate right"),
                        toolButton("flipH", "Mirror", "Flip horizontally"), toolButton("flipV", "Flip", "Flip vertically"))),
                    section("Cover", ui("p", {}, "Drag over names, faces or anything else to hide it."), ui("div", { className: "lowcord-edit-row" }, coverButton, clear)),
                    ui("div", { className: "lowcord-edit-footer" },
                        status,
                        ui("button", { type: "button", className: "lowcord-button lowcord-button-primary", onClick: () => finish(edit) }, "Attach image"),
                        ui("button", { type: "button", className: "lowcord-button lowcord-edit-skip", onClick: () => finish(null) }, many ? "Skip this photo" : "Cancel"))));
            const backdrop = ui("div", { className: "lowcord-capture-preview-backdrop lowcord-edit-backdrop" }, panel);
            size();
            document.body.append(backdrop);
            paint();
            // Handles are sized in CSS pixels, so repaint once the canvas has its laid-out size.
            requestAnimationFrame(paint);
            document.addEventListener("keydown", onKey, true);
            closeButton.focus();
        });
    }
    async function encode(bitmap, edit, file) {
        const crop = cropOf(edit);
        const x = Math.round(crop.x), y = Math.round(crop.y);
        const width = Math.max(1, Math.round(crop.x + crop.width) - x), height = Math.max(1, Math.round(crop.y + crop.height) - y);
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
        context.setTransform(new DOMMatrix([1, 0, 0, 1, -x, -y]).multiply(edit.matrix));
        context.drawImage(bitmap, 0, 0);
        context.setTransform(1, 0, 0, 1, -x, -y);
        context.fillStyle = fill;
        for (const box of edit.boxes) context.fillRect(Math.floor(box.x), Math.floor(box.y), Math.ceil(box.width) + 1, Math.ceil(box.height) + 1);
        const jpeg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name);
        const blob = await canvas.convertToBlob(jpeg ? { type: "image/jpeg", quality: .92 } : { type: "image/png" });
        return new File([blob], jpeg ? file.name : file.name.replace(/\.[^.]*$/, "") + ".png", { type: blob.type, lastModified: 0 });
    }
    // Resolves to the file to attach, or null when cancelled. With nothing
    // changed the original comes back and is handled like any other upload.
    async function review(file, options = {}) {
        let bitmap;
        try {
            if (await animated(file)) { toast("Animated images can't be edited, so this one was attached as it is."); return file; }
            // The browser applies EXIF rotation, so the preview and output match what people see.
            bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
            if (bitmap.width * bitmap.height > maxArea) throw new Error("too large");
            const edit = await dialog(bitmap, file.name, { tool: "cover", ...options });
            if (!edit) return null;
            if (untouched(edit)) return file;
            const edited = await encode(bitmap, edit, file);
            if (edit.boxes.length) window.Lowcord.privacy?.count("covered");
            return edited;
        } catch {
            toast("Couldn't open this image, so it wasn't attached. Try another file.", true);
            return null;
        } finally { bitmap?.close(); }
    }
    function choose() {
        const input = ui("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "" });
        input.addEventListener("change", async () => {
            const files = [...input.files].filter(supports);
            if (!files.length) { if (input.files.length) toast("Choose a PNG, JPEG or WebP image.", true); return; }
            const results = [];
            for (const [index, file] of files.entries()) {
                const result = await review(file, { tool: "crop", index, total: files.length, queue: files });
                if (result) results.push(result);
            }
            if (results.length && !window.Lowcord.privacy?.attach(results)) toast("The message box closed. Attach the images again.", true);
        });
        input.click();
    }
    extensions.addComposerAction({ id: "coverImages", order: 1, label: "Edit photos", path, run: choose });
    window.Lowcord.imageCover = { supports, review, transform, untouched, open: choose };
})();
