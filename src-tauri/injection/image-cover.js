// Cover image details: drag solid boxes over an image before it is attached.
// The file is re-encoded from pixels, so nothing under a box survives. Discord's
// attachment list is never touched; the result goes in through a normal paste.
(() => {
    const extensions = window.Lowcord.extensions;
    const { ui, toast } = extensions;
    const path = "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm4 7v5h10v-5H7Z";
    const types = /^image\/(?:png|jpeg|webp)$/;
    // Chromium refuses canvases larger than ~268M pixels; the preview stays small.
    const maxArea = 200e6, previewArea = 16e6, fill = "#000";
    const supports = file => types.test(file.type) || /\.(?:png|jpe?g|webp)$/i.test(file.name);

    // Animated files would keep only their first frame.
    async function animated(file) {
        const content = new TextDecoder("latin1").decode(await file.slice(0, 256 * 1024).arrayBuffer());
        if (content.startsWith("RIFF")) return content.includes("ANIM");
        return content.startsWith("PNG", 1) && content.slice(0, content.indexOf("IDAT")).includes("acTL");
    }
    function dialog(bitmap, name) {
        return new Promise(resolve => {
            const restoreFocus = document.activeElement, boxes = [];
            const reduce = Math.min(1, Math.sqrt(previewArea / (bitmap.width * bitmap.height)));
            const canvas = ui("canvas", { width: Math.max(1, Math.round(bitmap.width * reduce)), height: Math.max(1, Math.round(bitmap.height * reduce)),
                role: "img", "aria-label": `Preview of ${name}. Drag over a part of the image to cover it.` });
            const context = canvas.getContext("2d");
            let drag = null;
            const paint = () => {
                context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                context.fillStyle = fill;
                for (const box of drag ? [...boxes, drag] : boxes) context.fillRect(box.x * reduce, box.y * reduce, box.width * reduce, box.height * reduce);
                undo.disabled = clear.disabled = !boxes.length;
                count.textContent = boxes.length ? `${boxes.length} area${boxes.length === 1 ? "" : "s"} covered` : "";
            };
            const point = event => {
                const rect = canvas.getBoundingClientRect();
                return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * bitmap.width,
                    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * bitmap.height };
            };
            const span = (from, to) => ({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) });
            canvas.addEventListener("pointerdown", event => { canvas.setPointerCapture(event.pointerId); const from = point(event); drag = { from, ...span(from, from) }; });
            canvas.addEventListener("pointermove", event => { if (drag) { drag = { from: drag.from, ...span(drag.from, point(event)) }; paint(); } });
            const release = () => {
                if (!drag) return;
                const { from, ...box } = drag;
                drag = null;
                if (box.width * reduce >= 3 && box.height * reduce >= 3) boxes.push(box);
                paint();
            };
            canvas.addEventListener("pointerup", release);
            canvas.addEventListener("pointercancel", release);
            const finish = value => { document.removeEventListener("keydown", onKey, true); backdrop.remove(); restoreFocus?.focus?.(); resolve(value); };
            const onKey = event => {
                if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(null); }
                if (event.key === "Tab") {
                    const nodes = [...backdrop.querySelectorAll("button:not(:disabled)")], first = nodes[0], last = nodes.at(-1);
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                }
            };
            const count = ui("span", { className: "lowcord-capture-count", "aria-live": "polite" });
            const undo = ui("button", { type: "button", className: "lowcord-capture-chip", onClick: () => { boxes.pop(); paint(); } }, "Undo");
            const clear = ui("button", { type: "button", className: "lowcord-capture-chip", onClick: () => { boxes.length = 0; paint(); } }, "Clear all");
            const closeButton = ui("button", { type: "button", className: "lowcord-settings-close", "aria-label": "Close", onClick: () => finish(null) }, "×");
            const panel = ui("section", { className: "lowcord-capture-preview", role: "dialog", "aria-modal": "true", "aria-labelledby": "lowcord-cover-title" },
                ui("header", {}, ui("div", {}, ui("h2", { id: "lowcord-cover-title" }, "Cover image details"),
                    ui("p", {}, "Drag over anything you want to hide.")), closeButton),
                ui("div", { className: "lowcord-capture-toolbar" }, ui("div", { className: "lowcord-capture-chips" }, undo, clear), count),
                ui("div", { className: "lowcord-capture-preview-image" }, ui("div", { className: "lowcord-cover-stage" }, canvas)),
                ui("footer", {}, ui("p", { className: "lowcord-capture-status" }, "Covered areas are solid in the attached image."),
                    ui("div", { className: "lowcord-capture-actions" },
                        ui("button", { type: "button", className: "lowcord-button", onClick: () => finish(null) }, "Cancel"),
                        ui("button", { type: "button", className: "lowcord-button lowcord-button-primary", onClick: () => finish(boxes) }, "Attach image"))));
            const backdrop = ui("div", { className: "lowcord-capture-preview-backdrop" }, panel);
            paint();
            document.body.append(backdrop);
            document.addEventListener("keydown", onKey, true);
            closeButton.focus();
        });
    }
    async function encode(bitmap, boxes, file) {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        context.fillStyle = fill;
        for (const box of boxes) context.fillRect(Math.floor(box.x), Math.floor(box.y), Math.ceil(box.width) + 1, Math.ceil(box.height) + 1);
        const jpeg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name);
        const blob = await canvas.convertToBlob(jpeg ? { type: "image/jpeg", quality: .92 } : { type: "image/png" });
        return new File([blob], jpeg ? file.name : file.name.replace(/\.[^.]*$/, "") + ".png", { type: blob.type, lastModified: 0 });
    }
    // Resolves to the file to attach, or null when cancelled. With nothing
    // covered the original comes back and is handled like any other upload.
    async function review(file) {
        let bitmap;
        try {
            if (await animated(file)) { toast("Animated images can't be covered, so this one was attached as it is."); return file; }
            bitmap = await createImageBitmap(file);
            if (bitmap.width * bitmap.height > maxArea) throw new Error("too large");
            const boxes = await dialog(bitmap, file.name);
            if (!boxes) return null;
            if (!boxes.length) return file;
            const covered = await encode(bitmap, boxes, file);
            window.Lowcord.privacy?.count("covered");
            return covered;
        } catch {
            toast("Couldn't open this image, so it wasn't attached. Try another file.", true);
            return null;
        } finally { bitmap?.close(); }
    }
    function choose() {
        const input = ui("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
        input.addEventListener("change", async () => {
            const file = input.files[0];
            if (!file) return;
            const result = await review(file);
            if (result && !window.Lowcord.privacy?.attach([result])) toast("The message box closed. Attach the image again.", true);
        });
        input.click();
    }
    extensions.addComposerAction({ id: "coverImages", order: 1, label: "Cover image details", path, run: choose });
    window.Lowcord.imageCover = { supports, review };
})();
