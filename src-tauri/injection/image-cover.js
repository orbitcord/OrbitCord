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
        play: "M7 4v16l13 -8z",
        pause: "M6 5h4v14h-4zM14 5h4v14h-4z",
        sound: "M15 8a5 5 0 0 1 0 8M17.7 5a9 9 0 0 1 0 14M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5",
        muted: "M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5M16 10l4 4m0 -4l-4 4",
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

    function dialog(bitmap, name, { tool: startTool = "crop", index = 0, total = 1, queue = [], kind = "image", confirm = "Attach image", video = null } = {}) {
        window.Lowcord.ensureStyle?.("privacy");
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
            // A video session draws its current frame in place of the still.
            const draw = () => video ? video.draw(context) : context.drawImage(bitmap, 0, 0);
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
                    draw();
                    return;
                }
                context.setTransform(new DOMMatrix([reduce, 0, 0, reduce, 0, 0]).multiply(edit.matrix));
                draw();
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
            const finish = value => { video?.pause(); document.removeEventListener("keydown", onKey, true); backdrop.remove(); for (const url of urls) URL.revokeObjectURL(url); restoreFocus?.focus?.(); resolve(value); };
            const onKey = event => {
                if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(null); return; }
                if (video && event.key === " " && !(event.target instanceof HTMLButtonElement) && event.target.getAttribute?.("role") !== "slider") {
                    event.preventDefault(); event.stopImmediatePropagation(); video.toggle(); return;
                }
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
                    event.preventDefault(); event.stopImmediatePropagation(); (event.shiftKey ? redo : undo).click(); return;
                }
                if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLButtonElement) && event.target.getAttribute?.("role") !== "slider") {
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
                    ui("div", { className: "lowcord-edit-stage" }, canvas), strip, video?.timeline),
                ui("aside", { className: "lowcord-edit-panel" },
                    ui("header", {}, ui("h2", { id: "lowcord-cover-title" }, many ? `Edit ${kind} ${index + 1} of ${total}` : `Edit ${kind}`), closeButton),
                    ui("div", { className: "lowcord-edit-historybar", role: "group", "aria-label": "History" }, ui("span", {}, undo, redo, compare), reset),
                    section("Crop", ui("div", { className: "lowcord-edit-ratios" }, ...ratioButtons)),
                    section("Rotate and flip", ui("div", { className: "lowcord-edit-icons" },
                        toolButton("rotateLeft", "Left", "Rotate left"), toolButton("rotateRight", "Right", "Rotate right"),
                        toolButton("flipH", "Mirror", "Flip horizontally"), toolButton("flipV", "Flip", "Flip vertically"))),
                    section("Cover", ui("p", {}, "Drag over names, faces or anything else to hide it."), ui("div", { className: "lowcord-edit-row" }, coverButton, clear)),
                    ...(video?.sections(section, button) ?? []),
                    ui("div", { className: "lowcord-edit-footer" },
                        status,
                        ui("button", { type: "button", className: "lowcord-button lowcord-button-primary", onClick: () => finish(edit) }, confirm),
                        ui("button", { type: "button", className: "lowcord-button lowcord-edit-skip", onClick: () => finish(null) }, many ? "Skip this photo" : "Cancel"))));
            const backdrop = ui("div", { className: "lowcord-capture-preview-backdrop lowcord-edit-backdrop" }, panel);
            size();
            document.body.append(backdrop);
            video?.attach(paint);
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
    let editing = false;
    // Opens each file in the editor, then attaches the results through the
    // normal paste path so metadata removal and anonymous names still run.
    async function editFiles(files) {
        if (editing) { toast("Finish editing the current image first.", true); return; }
        editing = true;
        try {
            const results = [];
            for (const [index, file] of files.entries()) {
                const result = await review(file, { tool: "crop", index, total: files.length, queue: files });
                if (result) results.push(result);
            }
            if (results.length && !window.Lowcord.privacy?.attach(results)) toast("The message box closed. Attach the images again.", true);
        } finally { editing = false; }
    }
    function choose() {
        const input = ui("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "" });
        input.addEventListener("change", () => {
            const files = [...input.files].filter(supports);
            if (!files.length) { if (input.files.length) toast("Choose a PNG, JPEG or WebP image.", true); return; }
            void editFiles(files);
        });
        input.click();
    }
    extensions.addComposerAction({ id: "coverImages", order: 1, label: "Edit photos", path, run: choose });

    // ----- Paste to edit: Cmd/Ctrl+Shift+V -----------------------------------
    // The shortcut's own paste-and-match-style carries text only, so it is
    // replaced by a real paste that privacy.js routes through the editor.
    const composerSelector = '[class*="channelTextArea_"]';
    const inComposer = target => target instanceof Element && Boolean(target.closest(composerSelector)) && !target.closest('[role="dialog"]');
    const mac = /Mac/.test(navigator.platform);
    let armed = 0;
    window.addEventListener("keydown", event => {
        if (event.repeat || event.altKey || !event.shiftKey || event.code !== "KeyV" || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
        const paste = window.__LOWCORD_NATIVE__?.paste;
        if (!paste || !extensions.enabled("coverImages") || !inComposer(event.target)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        armed = performance.now();
        paste(false).catch(() => { armed = 0; });
    }, true);
    // Called by privacy.js for each composer paste. True when the editor
    // should open for its images; text alone is pasted as plain text, as the
    // shortcut normally does.
    function claimPaste(event) {
        if (!armed || performance.now() - armed > 2000) return false;
        armed = 0;
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.some(supports)) return true;
        event.preventDefault(); event.stopImmediatePropagation();
        if (files.length) toast("Only PNG, JPEG and WebP images can be edited.", true);
        else void window.__LOWCORD_NATIVE__.paste(true);
        return false;
    }

    // ----- Edit button on attachments waiting in the message box --------------
    // Each image or video card gets a small pencil at its bottom left. The
    // edited file replaces the original in place, keeping its position,
    // spoiler and description, through Discord's own upload actions.
    const uploadStore = () => window.Lowcord.store("UploadAttachmentStore");
    const channelId = () => window.Lowcord.store("SelectedChannelStore")?.getChannelId?.();
    let uploadActions;
    const actions = () => uploadActions ??= window.Lowcord.find(module => typeof module?.setFile === "function"
        && typeof module.setUploads === "function" && typeof module.update === "function" && typeof module.remove === "function");
    const videoTypes = /^video\/(?:mp4|quicktime|webm|x-matroska|x-m4v)$/i;
    const isVideo = file => videoTypes.test(file.type) || /\.(?:mp4|m4v|mov|webm|mkv)$/i.test(file.name);
    const cardId = card => card.getAttribute("data-list-item-id")?.replace(/^attachments___/, "");

    async function replaceUpload(channel, upload, file) {
        const store = uploadStore(), creators = actions();
        if (!store || !creators) throw new Error("uploader");
        const before = store.getUploads(channel, 0).map(item => item.id);
        if (!before.includes(upload.id)) throw new Error("gone");
        const { spoiler, description } = upload;
        creators.setFile({ file: { file, platform: 1 }, channelId: channel, id: upload.id, draftType: 0 });
        // Discord adds the new file at the end; put it back where the old one was.
        const now = store.getUploads(channel, 0), fresh = now.find(item => !before.includes(item.id));
        if (!fresh) return;
        const order = before.map(id => id === upload.id ? fresh : now.find(item => item.id === id)).filter(Boolean);
        if (order.length === now.length) creators.setUploads({ uploads: order, channelId: channel, draftType: 0 });
        if (spoiler || description) creators.update(channel, fresh.id, 0, { spoiler, description, filename: fresh.filename });
    }

    // Rotation, flips, cover boxes, crop, trims and sound as numbers for the
    // native encoder. Electron builds the FFmpeg filter itself; nothing here is
    // a filter string.
    function videoFilters(edit, { clips, mute }) {
        const { a, b, c, d } = edit.matrix, key = [a, b, c, d].map(Math.round).join();
        const turns = { "1,0,0,1": [null, false, false], "-1,0,0,1": [null, true, false], "1,0,0,-1": [null, false, true], "-1,0,0,-1": [null, true, true],
            "0,1,-1,0": [1, false, false], "0,-1,1,0": [2, false, false], "0,1,1,0": [0, false, false], "0,-1,-1,0": [3, false, false] }[key];
        if (!turns) throw new Error("matrix");
        const whole = rect => ({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
        const time = value => Math.round(value * 1000) / 1000;
        return { transpose: turns[0], hflip: turns[1], vflip: turns[2], width: edit.width, height: edit.height, mute,
            crop: whole(clampRect(cropOf(edit), edit.width, edit.height)), boxes: edit.boxes.map(box => whole(clampRect(box, edit.width, edit.height))).filter(box => box.width && box.height),
            clips: clips.map(clip => ({ start: time(clip.start), end: time(clip.end) })) };
    }

    // ----- Video session: playback, trim, sound and joined clips --------------
    // Like the trim bar in QuickTime and Photos: a filmstrip with a yellow frame
    // whose ends are dragged to trim, a white playhead and a play button. Later
    // clips are fitted into the first clip's frame, as the encoder does.
    const maxClips = 5, minLength = .5;
    const clock = time => { const minutes = Math.floor(time / 60), rest = time - minutes * 60; return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`; };
    async function loadClip(file, uploadId = null) {
        const url = URL.createObjectURL(file), video = document.createElement("video");
        video.preload = "auto"; video.playsInline = true; video.src = url;
        try {
            await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error("decode")); });
            if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) throw new Error("decode");
        } catch (error) { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); throw error; }
        return { file, uploadId, url, video, duration: video.duration, start: 0, end: video.duration, film: null };
    }
    async function videoSession(file, uploadId, attached = []) {
        const clips = [await loadClip(file, uploadId)];
        const width = clips[0].video.videoWidth, height = clips[0].video.videoHeight;
        let current = 0, mute = false, playing = false, frame = 0, repaint = () => {}, sectionHelpers = null;
        const active = () => clips[current];
        const watchClip = clip => clip.video.addEventListener("seeked", () => { if (clip === active() && !playing) { repaint(); place(); } });
        watchClip(clips[0]);

        function draw(context) {
            const { video } = active(), scale = Math.min(width / video.videoWidth, height / video.videoHeight);
            const w = video.videoWidth * scale, h = video.videoHeight * scale;
            context.fillStyle = "#000"; context.fillRect(0, 0, width, height);
            context.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
        }
        function loop() {
            if (!playing) return;
            const clip = active();
            if (clip.video.ended || clip.video.currentTime >= clip.end - .03) {
                clip.video.pause();
                if (current + 1 < clips.length) { current++; startClip(); }
                else { playing = false; current = 0; active().video.currentTime = active().start; render(); return; }
            }
            repaint(); place();
            frame = requestAnimationFrame(loop);
        }
        function startClip() {
            const clip = active();
            clip.video.muted = mute;
            if (clip.video.currentTime < clip.start || clip.video.currentTime >= clip.end - .05) clip.video.currentTime = clip.start;
            clip.video.play().catch(() => { playing = false; render(); });
            render();
        }
        function play() {
            // From the end of a clip, carry on into the next; from the very end, start over.
            const clip = active();
            if (clip.video.currentTime >= clip.end - .05) {
                current = current + 1 < clips.length ? current + 1 : 0;
                active().video.currentTime = active().start;
            }
            playing = true; startClip(); cancelAnimationFrame(frame); frame = requestAnimationFrame(loop);
        }
        function pause() { playing = false; cancelAnimationFrame(frame); for (const clip of clips) clip.video.pause(); render(); }
        const toggle = () => playing ? pause() : play();
        function select(index) {
            if (index === current) return;
            pause(); current = index;
            const clip = active();
            if (clip.video.currentTime < clip.start || clip.video.currentTime > clip.end) clip.video.currentTime = clip.start;
            render(); repaint();
        }

        // ----- Timeline -----
        // Every clip sits end to end, sized by its length, each with its own
        // yellow trim frame; one playhead runs across them all.
        const playButton = ui("button", { type: "button", className: "lowcord-trim-button", onClick: toggle });
        const muteButton = ui("button", { type: "button", className: "lowcord-trim-button", "aria-label": "Mute", "aria-pressed": "false",
            onClick: () => { mute = !mute; for (const clip of clips) clip.video.muted = mute; render(); } });
        const head = ui("div", { className: "lowcord-trim-head", "aria-hidden": "true" });
        const track = ui("div", { className: "lowcord-trim-track" }, head);
        const times = ui("span", { className: "lowcord-trim-time", "aria-live": "off" });
        const timeline = ui("div", { className: "lowcord-trim", role: "group", "aria-label": "Timeline" }, playButton, muteButton, track, times);
        let segments = [], layout = "";
        function buildSegments() {
            const key = clips.map(clip => clip.url).join();
            if (key === layout) return;
            layout = key;
            for (const segment of segments) segment.node.remove();
            segments = clips.map((clip, index) => {
                const suffix = clips.length > 1 ? `, clip ${index + 1}` : "";
                const handle = edge => ui("div", { className: `lowcord-trim-handle is-${edge}`, role: "slider", tabindex: "0",
                    "aria-label": `${edge === "start" ? "Trim start" : "Trim end"}${suffix}`, "aria-valuemin": "0" });
                const start = handle("start"), end = handle("end");
                const film = ui("canvas", { className: "lowcord-trim-film", "aria-hidden": "true" });
                const shadeStart = ui("div", { className: "lowcord-trim-shade is-start" }), shadeEnd = ui("div", { className: "lowcord-trim-shade is-end" });
                const bracket = ui("div", { className: "lowcord-trim-frame" }, start, end);
                const node = ui("div", { className: "lowcord-trim-segment" }, film, shadeStart, shadeEnd, bracket);
                node.style.flexGrow = String(clip.duration);
                for (const [element, edge] of [[start, "start"], [end, "end"]]) element.addEventListener("keydown", event => {
                    const step = event.shiftKey ? 1 : .1, now = clip[edge];
                    const next = { ArrowLeft: now - step, ArrowDown: now - step, ArrowRight: now + step, ArrowUp: now + step, Home: 0, End: clip.duration }[event.key];
                    if (next === undefined) return;
                    event.preventDefault(); event.stopPropagation(); pause(); focusClip(clips.indexOf(clip)); setEdge(clip, edge, next);
                });
                track.insertBefore(node, head);
                return { clip, node, film, shadeStart, shadeEnd, bracket, start, end };
            });
        }
        const percent = (clip, time) => `${time / clip.duration * 100}%`;
        const lengthOf = clip => clip.end - clip.start;
        function place() {
            for (const { clip, node, shadeStart, shadeEnd, bracket, start, end } of segments) {
                shadeStart.style.width = percent(clip, clip.start);
                shadeEnd.style.width = percent(clip, clip.duration - clip.end);
                bracket.style.left = percent(clip, clip.start);
                bracket.style.right = percent(clip, clip.duration - clip.end);
                node.classList.toggle("is-current", clip === active() && clips.length > 1);
                for (const [element, value] of [[start, clip.start], [end, clip.end]]) {
                    element.setAttribute("aria-valuemax", clip.duration.toFixed(1)); element.setAttribute("aria-valuenow", value.toFixed(1));
                    element.setAttribute("aria-valuetext", clock(value));
                }
            }
            const clip = active(), segment = segments.find(item => item.clip === clip);
            const time = Math.max(clip.start, Math.min(clip.end, clip.video.currentTime));
            if (segment) head.style.left = `${segment.node.offsetLeft + time / clip.duration * segment.node.offsetWidth}px`;
            const total = clips.reduce((sum, item) => sum + lengthOf(item), 0);
            const before = clips.slice(0, current).reduce((sum, item) => sum + lengthOf(item), 0);
            times.textContent = `${clock(before + time - clip.start)} / ${clock(total)}`;
        }
        function focusClip(index) {
            if (index === current) return;
            current = index;
            renderClips();
        }
        function setEdge(clip, edge, time) {
            if (edge === "start") clip.start = Math.max(0, Math.min(time, clip.end - minLength));
            else clip.end = Math.min(clip.duration, Math.max(time, clip.start + minLength));
            // Show the frame at the edge being moved, as QuickTime does.
            clip.video.currentTime = edge === "start" ? clip.start : Math.max(clip.start, clip.end - .05);
            place(); renderClips();
        }
        // The clip and time under the pointer, kept inside that clip's trim.
        function pointAt(event, only) {
            const list = only ? segments.filter(item => item.clip === only) : segments;
            let segment = list.find(item => { const rect = item.node.getBoundingClientRect(); return event.clientX >= rect.left && event.clientX <= rect.right; });
            if (!segment) segment = list.reduce((best, item) => {
                const rect = item.node.getBoundingClientRect(), distance = Math.min(Math.abs(event.clientX - rect.left), Math.abs(event.clientX - rect.right));
                return !best || distance < best.distance ? { item, distance } : best;
            }, null).item;
            const rect = segment.node.getBoundingClientRect();
            return { segment, time: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * segment.clip.duration };
        }
        let dragging = null;
        track.addEventListener("pointerdown", event => {
            if (event.button !== 0) return;
            event.preventDefault();
            pause();
            track.setPointerCapture(event.pointerId);
            const grip = event.target.closest?.(".lowcord-trim-handle");
            const segment = grip ? segments.find(item => item.start === grip || item.end === grip) : pointAt(event).segment;
            focusClip(clips.indexOf(segment.clip));
            if (grip) { dragging = { clip: segment.clip, edge: grip === segment.start ? "start" : "end" }; grip.focus(); return; }
            dragging = { clip: null };
            seekTo(event);
        });
        function seekTo(event) {
            const { segment, time } = pointAt(event);
            const index = clips.indexOf(segment.clip);
            if (index !== current) { focusClip(index); repaint(); }
            segment.clip.video.currentTime = Math.max(segment.clip.start, Math.min(segment.clip.end, time));
            place();
        }
        track.addEventListener("pointermove", event => {
            if (!dragging) return;
            if (!dragging.clip) { seekTo(event); return; }
            setEdge(dragging.clip, dragging.edge, pointAt(event, dragging.clip).time);
        });
        const drop = () => { dragging = null; };
        track.addEventListener("pointerup", drop); track.addEventListener("pointercancel", drop);
        // Frames across each clip, drawn from a second player so playback is
        // never interrupted, and redrawn only when the clip's width changes.
        async function filmstrip(segment) {
            const { clip, film, node } = segment, ratio = devicePixelRatio || 1;
            const w = Math.max(1, Math.round(node.offsetWidth * ratio)), h = Math.max(1, Math.round(node.offsetHeight * ratio));
            if (clip.film?.width === w && clip.film?.height === h) { paintFilm(segment); return; }
            const canvas = new OffscreenCanvas(w, h), context = canvas.getContext("2d");
            clip.film = canvas;
            const probe = document.createElement("video");
            probe.muted = true; probe.preload = "auto"; probe.src = clip.url;
            try {
                await new Promise((resolve, reject) => { probe.onloadeddata = resolve; probe.onerror = reject; });
                const cell = h * probe.videoWidth / probe.videoHeight, count = Math.max(1, Math.ceil(w / cell));
                for (let index = 0; index < count; index++) {
                    if (clip.film !== canvas || !timeline.isConnected) break;
                    await new Promise(resolve => { probe.onseeked = resolve; probe.currentTime = Math.min(clip.duration - .01, (index + .5) * clip.duration / count); });
                    context.drawImage(probe, index * cell, 0, cell, h);
                    paintFilm(segment);
                }
            } catch {} finally { probe.removeAttribute("src"); probe.load(); }
        }
        function paintFilm({ clip, film }) {
            if (!clip.film) return;
            if (film.width !== clip.film.width || film.height !== clip.film.height) { film.width = clip.film.width; film.height = clip.film.height; }
            film.getContext("2d").drawImage(clip.film, 0, 0);
        }
        const resize = new ResizeObserver(() => { for (const segment of segments) void filmstrip(segment); place(); });
        resize.observe(track);

        // ----- Clips section -----
        const clipList = ui("ol", { className: "lowcord-clip-list" });
        const addRow = ui("div", { className: "lowcord-edit-row lowcord-clip-add" });
        async function addClip(fileToAdd, id = null) {
            if (clips.length >= maxClips) return;
            try { const clip = await loadClip(fileToAdd, id); watchClip(clip); clips.push(clip); }
            catch { toast(`Couldn't open ${fileToAdd.name}. It wasn't added.`, true); }
            render();
        }
        function chooseClips() {
            const input = ui("input", { type: "file", accept: "video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv,.mov,.m4v", multiple: "" });
            input.addEventListener("change", async () => { for (const picked of [...input.files].filter(isVideo)) await addClip(picked); });
            input.click();
        }
        function renderClips() {
            if (!sectionHelpers) return;
            const { button } = sectionHelpers;
            clipList.replaceChildren(...clips.map((clip, index) => ui("li", { className: index === current ? "is-current" : "" },
                button("", { className: "lowcord-clip-pick", title: clip.file.name, "aria-current": index === current ? "true" : "false", onClick: () => select(index) },
                    ui("span", { className: "lowcord-clip-name" }, `${index + 1}. ${clip.file.name}`), ui("span", { className: "lowcord-clip-length" }, clock(clip.end - clip.start))),
                ...(clips.length > 1 ? [
                    button("↑", { className: "lowcord-clip-move", "aria-label": `Move ${clip.file.name} earlier`, disabled: index === 0 || undefined,
                        onClick: () => { const keep = active(); clips.splice(index - 1, 0, clips.splice(index, 1)[0]); current = clips.indexOf(keep); render(); } }),
                    button("↓", { className: "lowcord-clip-move", "aria-label": `Move ${clip.file.name} later`, disabled: index === clips.length - 1 || undefined,
                        onClick: () => { const keep = active(); clips.splice(index + 1, 0, clips.splice(index, 1)[0]); current = clips.indexOf(keep); render(); } }),
                    button("×", { className: "lowcord-clip-move", "aria-label": `Remove ${clip.file.name} from the video`,
                        onClick: () => { pause(); const keep = active(); const [gone] = clips.splice(index, 1); release(gone); current = Math.max(0, clips.indexOf(keep)); render(); repaint(); } }),
                ] : []))));
            const spare = attached.filter(item => !clips.some(clip => clip.uploadId === item.uploadId));
            addRow.replaceChildren(...(clips.length < maxClips ? [
                ...spare.map(item => button(`Add ${item.file.name}`, { className: "lowcord-edit-chip", title: "Join this attached video", onClick: () => void addClip(item.file, item.uploadId) })),
                button("Add clip…", { className: "lowcord-edit-chip", onClick: chooseClips }),
            ] : [ui("p", {}, `Up to ${maxClips} clips.`)]));
        }
        function render() {
            const label = playing ? "Pause" : "Play";
            playButton.replaceChildren(icon(playing ? "pause" : "play", 18));
            playButton.setAttribute("aria-label", `${label} (Space)`); playButton.title = `${label} (Space)`;
            muteButton.replaceChildren(icon(mute ? "muted" : "sound", 18));
            muteButton.setAttribute("aria-pressed", String(mute));
            muteButton.title = mute ? "Sound off: the video is sent without audio" : "Mute: send the video without audio";
            buildSegments(); place(); renderClips();
            for (const segment of segments) void filmstrip(segment);
        }
        const release = clip => { clip.video.pause(); clip.video.removeAttribute("src"); clip.video.load(); URL.revokeObjectURL(clip.url); clip.film = null; };
        return {
            frame: { width, height }, timeline, draw, toggle, pause,
            attach(paint) { repaint = paint; render(); requestAnimationFrame(render); },
            sections(section, button) {
                sectionHelpers = { button };
                renderClips();
                return [section("Clips", ui("p", {}, "Clips play and are sent in this order, as one video. Drag each clip's yellow ends to trim it."), clipList, addRow)];
            },
            changed: () => mute || clips.length > 1 || clips[0].uploadId !== uploadId || clips.some(clip => clip.start > .05 || clip.end < clip.duration - .05),
            state: () => ({ mute, clips: clips.map(({ file, uploadId: id, start, end }) => ({ file, uploadId: id, start, end })) }),
            close() { pause(); resize.disconnect(); for (const clip of clips) release(clip); },
        };
    }
    const chunk = 1024 * 1024;
    async function native(action, ...args) {
        const result = await window.__LOWCORD_NATIVE__.videoCompression(action, ...args);
        if (result?.error) throw Object.assign(new Error(result.error), { code: result.error });
        return result;
    }
    async function encodeVideo(files, filters, status) {
        let id;
        const total = files.reduce((sum, file) => sum + file.size, 0);
        try {
            ({ id } = await native("begin", { sizes: files.map(file => file.size), kind: "edit", edit: filters }));
            let sent = 0;
            for (const file of files) for (let offset = 0; offset < file.size; offset += chunk) {
                const bytes = new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer());
                await native("append", id, bytes);
                sent += bytes.length;
                status.update("Editing video…", `Copying ${Math.round(sent / total * 100)}%`);
            }
            status.update("Editing video…", "Encoding. Longer videos take a while.");
            const result = await native("finish", id);
            const parts = [];
            for (let offset = 0; offset < result.size; offset += chunk) parts.push(new Blob([await native("read", id, offset)]));
            return new File(parts, files[0].name.replace(/\.[^.]*$/, "") + ".mp4", { type: "video/mp4", lastModified: 0 });
        } finally { if (id) await native("cancel", id).catch(() => {}); }
    }
    function videoError(error) {
        if (error.code === "ffmpeg-missing") return "Install FFmpeg and restart OrbitCord to edit videos. Your video is unchanged.";
        if (error.code === "unsupported-duration") return "Couldn't read this video, or it's longer than six hours. Your video is unchanged.";
        if (error.code === "encode-timeout") return "Editing this video took too long. Your video is unchanged.";
        if (error.code === "busy") return "Another video is still being prepared. Try again when it's done.";
        return "Couldn't edit this video. Your video is unchanged.";
    }

    // Video compression's size target for the open chat; unchanged when that
    // extension is off or the file already fits.
    const fitToChat = async file => await window.Lowcord.videoCompression?.fit?.(file) ?? file;
    async function editUpload(uploadId) {
        if (editing) { toast("Finish editing the current file first.", true); return; }
        const channel = channelId(), upload = uploadStore()?.getUploads?.(channel, 0)?.find(item => item.id === uploadId);
        const file = upload?.item?.file;
        if (!(file instanceof File)) return;
        editing = true;
        let bitmap, status;
        try {
            if (isVideo(file)) {
                if (!window.__LOWCORD_NATIVE__?.videoCompression) return;
                // Other videos waiting in this message can be joined to this one.
                const attached = uploadStore().getUploads(channel, 0)
                    .filter(item => item.id !== uploadId && item.item?.file instanceof File && isVideo(item.item.file))
                    .map(item => ({ uploadId: item.id, file: item.item.file }));
                let session;
                try { session = await videoSession(file, uploadId, attached); }
                catch { toast("Couldn't open this video for editing.", true); return; }
                let edit, state;
                try {
                    edit = await dialog(session.frame, file.name, { kind: "video", confirm: "Save video", video: session });
                    state = session.state();
                } finally { session.close(); }
                if (!edit || untouched(edit) && !session.changed()) return;
                status = extensions.progress("Editing video…", "Preparing");
                let edited;
                try { edited = await encodeVideo(state.clips.map(clip => clip.file), videoFilters(edit, state), status); }
                catch (error) { toast(videoError(error), true); return; }
                if (channelId() !== channel) { toast("You switched chats, so the video wasn't changed.", true); return; }
                // Shrunk to this chat's upload limit, as a newly attached video would be.
                status.end(); status = null;
                edited = await fitToChat(edited);
                if (channelId() !== channel) { toast("You switched chats, so the video wasn't changed.", true); return; }
                await replaceUpload(channel, upload, edited);
                // Joined clips become part of this video, so their own attachments go.
                const joined = state.clips.filter(clip => clip.uploadId && clip.uploadId !== uploadId).map(clip => clip.uploadId);
                for (const id of joined) actions().remove(channel, id, 0);
                if (edit.boxes.length) window.Lowcord.privacy?.count("covered");
                toast(joined.length ? `${joined.length + 1} clips joined into one video.` : "Video edited.", false, 1800);
                return;
            }
            if (!supports(file)) { toast("Only PNG, JPEG and WebP images and MP4, MOV, WebM and MKV videos can be edited.", true); return; }
            const result = await review(file, { tool: "crop", confirm: "Save image" });
            if (!result || result === file) return;
            const fitted = await fitToChat(result);
            if (channelId() !== channel) { toast("You switched chats, so the image wasn't changed.", true); return; }
            await replaceUpload(channel, upload, fitted);
        } catch { toast("Couldn't replace the attachment. It's unchanged.", true); }
        finally { bitmap?.close(); status?.end?.(); editing = false; }
    }
    // Discord's pencil icon, outlined to sit apart from its own action bar.
    const editIcon = "M4 20h4l10.5-10.5a2.83 2.83 0 0 0-4-4L4 16v4M13.5 6.5l4 4";
    function decorate() {
        if (!extensions.enabled("coverImages")) return;
        const channel = channelId(), uploads = uploadStore()?.getUploads?.(channel, 0);
        if (!Array.isArray(uploads)) return;
        for (const card of document.querySelectorAll('[class*="channelTextArea_"] li[data-list-item-id^="attachments___"]')) {
            const media = card.querySelector('[class*="mediaContainer_"]');
            if (!media || media.querySelector(":scope > .lowcord-upload-edit")) continue;
            const id = cardId(card), file = uploads.find(item => item.id === id)?.item?.file;
            if (!(file instanceof File) || !(supports(file) || isVideo(file))) continue;
            window.Lowcord.ensureStyle?.("privacy");
            const label = isVideo(file) ? "Edit video" : "Edit image";
            const button = ui("button", { type: "button", className: "lowcord-upload-edit", "aria-label": label, title: label,
                onClick: event => { event.preventDefault(); event.stopPropagation(); void editUpload(cardId(card)); } });
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("aria-hidden", "true");
            svg.innerHTML = `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="${editIcon}"/>`;
            button.append(svg);
            media.append(button);
        }
    }
    window.Lowcord.onDomChange(records => { if (window.Lowcord.domChanged(records, 'li[data-list-item-id^="attachments___"]')) decorate(); });
    window.addEventListener(extensions.changeEvent, () => {
        if (extensions.enabled("coverImages")) decorate();
        else for (const button of document.querySelectorAll(".lowcord-upload-edit")) button.remove();
    });
    decorate();

    window.Lowcord.imageCover = { supports, review, transform, untouched, open: choose, claimPaste, videoFilters, editUpload };
})();
