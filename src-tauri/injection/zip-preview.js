(() => {
    // ----- Zip reading (pure; exported for tests) ------------------------------------
    const MAX_ENTRIES = 5000, MAX_DIRECTORY = 8 * 1024 * 1024, MAX_FILE = 2 * 1024 * 1024, TAIL = 65536;
    const CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
    function decodeName(bytes, utf8) {
        if (utf8) return new TextDecoder().decode(bytes);
        let out = "";
        for (const byte of bytes) out += byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128];
        return out;
    }
    const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u64 = (dv, at) => Number(dv.getBigUint64(at, true));

    // Locates the central directory from the last bytes of the file.
    function findDirectory(tail) {
        const dv = view(tail);
        for (let at = tail.length - 22; at >= 0; at--) {
            if (dv.getUint32(at, true) !== 0x06054b50 || at + 22 + dv.getUint16(at + 20, true) > tail.length) continue;
            const result = { count: dv.getUint16(at + 10, true), size: dv.getUint32(at + 12, true), offset: dv.getUint32(at + 16, true), zip64: null };
            if (result.count === 0xffff || result.size === 0xffffffff || result.offset === 0xffffffff) {
                if (at < 20 || dv.getUint32(at - 20, true) !== 0x07064b50) throw new Error("Unsupported zip");
                result.zip64 = u64(dv, at - 20 + 8);
            }
            return result;
        }
        throw new Error("Not a zip file");
    }
    function applyZip64(found, bytes) {
        const dv = view(bytes);
        if (bytes.length < 56 || dv.getUint32(0, true) !== 0x06064b50) throw new Error("Unsupported zip");
        return { count: u64(dv, 32), size: u64(dv, 40), offset: u64(dv, 48), zip64: null };
    }
    function parseEntries(bytes, count) {
        const dv = view(bytes), entries = [];
        let truncated = false;
        for (let at = 0; entries.length < count && at + 46 <= bytes.length;) {
            if (dv.getUint32(at, true) !== 0x02014b50) throw new Error("Corrupt zip");
            if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
            const flags = dv.getUint16(at + 8, true), method = dv.getUint16(at + 10, true);
            let compressed = dv.getUint32(at + 20, true), size = dv.getUint32(at + 24, true), offset = dv.getUint32(at + 42, true);
            const nameLength = dv.getUint16(at + 28, true), extraLength = dv.getUint16(at + 30, true), commentLength = dv.getUint16(at + 32, true);
            const nameEnd = at + 46 + nameLength, extraEnd = nameEnd + extraLength;
            if (extraEnd + commentLength > bytes.length) throw new Error("Corrupt zip");
            // ZIP64 extra: only the fields stored as 0xFFFFFFFF appear, in this order.
            for (let extra = nameEnd; extra + 4 <= extraEnd;) {
                const id = dv.getUint16(extra, true), length = dv.getUint16(extra + 2, true);
                if (id === 1) {
                    let cursor = extra + 4;
                    if (size === 0xffffffff && cursor + 8 <= extraEnd) { size = u64(dv, cursor); cursor += 8; }
                    if (compressed === 0xffffffff && cursor + 8 <= extraEnd) { compressed = u64(dv, cursor); cursor += 8; }
                    if (offset === 0xffffffff && cursor + 8 <= extraEnd) offset = u64(dv, cursor);
                }
                extra += 4 + length;
            }
            const name = decodeName(bytes.subarray(at + 46, nameEnd), (flags & 0x800) !== 0);
            entries.push({ name, size, compressed, method, offset, encrypted: (flags & 1) !== 0, directory: name.endsWith("/") });
            at = extraEnd + commentLength;
        }
        return { entries, truncated };
    }
    // fetchRange(start, end) -> Uint8Array for the inclusive byte range.
    async function readDirectory(fetchRange, fileSize) {
        const tailStart = Math.max(0, fileSize - TAIL);
        let found = findDirectory(await fetchRange(tailStart, fileSize - 1));
        if (found.zip64 != null) found = applyZip64(found, await fetchRange(found.zip64, found.zip64 + 55));
        if (found.size > MAX_DIRECTORY) throw new Error("Zip directory too large");
        if (found.offset + found.size > fileSize) throw new Error("Corrupt zip");
        const bytes = found.size ? await fetchRange(found.offset, found.offset + found.size - 1) : new Uint8Array(0);
        return window.__LOWCORD_NATIVE__?.mediaProcess
            ? window.__LOWCORD_NATIVE__.mediaProcess("zip_directory", {count:found.count}, bytes) : parseEntries(bytes, found.count);
    }
    async function readEntry(fetchRange, entry) {
        if (entry.encrypted) throw new Error("Encrypted");
        if (entry.size > MAX_FILE || entry.compressed > MAX_FILE) throw new Error("Too large");
        if (entry.method !== 0 && entry.method !== 8) throw new Error("Unsupported");
        const header = view(await fetchRange(entry.offset, entry.offset + 29));
        if (header.getUint32(0, true) !== 0x04034b50) throw new Error("Corrupt zip");
        const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        if (!entry.compressed) return new Uint8Array(0);
        const data = await fetchRange(start, start + entry.compressed - 1);
        if (entry.method === 0) return data;
        if (window.__LOWCORD_NATIVE__?.mediaProcess) return window.__LOWCORD_NATIVE__.mediaProcess("zip_inflate", {}, data);
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        const out = new Uint8Array(await new Response(stream).arrayBuffer());
        if (out.length > MAX_FILE) throw new Error("Too large");
        return out;
    }
    // Folders of a flat entry list: { dirs: Map, files: [] } nested by path.
    function buildTree(entries) {
        const root = { name: "", dirs: new Map(), files: [] };
        for (const entry of entries) {
            const parts = entry.name.split("/").filter(Boolean);
            if (!parts.length || parts.includes("..")) continue;
            let node = root;
            const folders = entry.directory ? parts : parts.slice(0, -1);
            for (const part of folders) {
                if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] });
                node = node.dirs.get(part);
            }
            if (!entry.directory) node.files.push({ ...entry, base: parts.at(-1) });
        }
        return root;
    }
    window.Lowcord ??= {};
    window.Lowcord.zipPreview = { findDirectory, parseEntries, readDirectory, readEntry, buildTree, decodeName };

    // ----- Page integration ----------------------------------------------------------------
    const extensions = window.Lowcord.extensions;
    if (!extensions || typeof document === "undefined") return;
    const { ui } = extensions;
    const ID = "zipPreview";
    const textTypes = /\.(txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|html?|xml|ya?ml|toml|ini|cfg|conf|csv|tsv|log|py|rb|rs|go|java|kt|c|h|cpp|hpp|cs|sh|bat|sql|svg|gitignore|env|lock)$/i;
    const imageTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    const basename = url => { try { return decodeURIComponent(new URL(url).pathname.split("/").pop()); } catch { return ""; } };
    const bytesLabel = size => size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`;
    const failure = "Couldn't read this zip file, so try again later.";
    const panels = new Set();

    function makeFetcher(url, size) {
        return async (start, end) => {
            const native = window.__LOWCORD_NATIVE__;
            if (!native?.fetchRemote) throw new Error("Unavailable");
            const response = await native.fetchRemote(url, { as: "bytes", range: [start, end], maxBytes: Math.max(end - start + 1, 1024) });
            if (response.status === 206) return new Uint8Array(response.body);
            // A server that ignores Range sends everything; take the slice that was asked for.
            if (response.status === 200) return new Uint8Array(response.body).subarray(start, end + 1);
            throw new Error(`Status ${response.status}`);
        };
    }

    function mount(card, attachment) {
        const next = card.nextElementSibling;
        if (next?.classList.contains("lowcord-zip") && next.dataset.attachment === attachment.id) return;
        const bar = ui("div", { className: "lowcord-zip" });
        bar.dataset.attachment = attachment.id;
        const toggle = ui("button", { type: "button", className: "lowcord-zip-toggle", "aria-expanded": "false" }, "Show files");
        bar.append(toggle);
        card.after(bar);
        let panel, session;
        const close = () => {
            session?.cleanup(); session = undefined;
            panel?.remove(); panel = undefined; panels.delete(close);
            toggle.textContent = "Show files"; toggle.setAttribute("aria-expanded", "false");
        };
        toggle.addEventListener("click", async () => {
            if (panel) { close(); return; }
            panel = ui("div", { className: "lowcord-zip-panel" }, ui("div", { className: "lowcord-zip-status" }, "Reading…"));
            bar.append(panel); panels.add(close);
            toggle.textContent = "Hide files"; toggle.setAttribute("aria-expanded", "true");
            const mine = panel;
            try {
                const fetchRange = makeFetcher(attachment.url, attachment.size);
                const { entries, truncated } = await readDirectory(fetchRange, attachment.size);
                if (panel !== mine) return;
                session = browse(mine, buildTree(entries), fetchRange, truncated);
            } catch {
                if (panel === mine) { mine.replaceChildren(ui("div", { className: "lowcord-zip-status" }, "Couldn't read this zip file.")); extensions.toast(failure, true); }
            }
        });
        bar.lowcordClose = close;
    }

    // The file browser: breadcrumbs, up button, folder rows, and a preview pane.
    function browse(panel, root, fetchRange, truncated) {
        const path = [];
        let url, preview;
        const nodeAt = () => path.reduce((node, part) => node.dirs.get(part), root);
        const releasePreview = () => { if (url) URL.revokeObjectURL(url); url = undefined; preview?.remove(); preview = undefined; };
        const crumbs = ui("div", { className: "lowcord-zip-crumbs" });
        const list = ui("div", { className: "lowcord-zip-list" });
        panel.replaceChildren(crumbs, list);
        function render() {
            const node = nodeAt();
            const crumb = (label, depth) => ui("button", { type: "button", className: "lowcord-zip-crumb", onClick: () => { path.length = depth; releasePreview(); render(); } }, label);
            crumbs.replaceChildren(ui("button", { type: "button", className: "lowcord-zip-crumb lowcord-zip-up", "aria-label": "Up one folder", disabled: !path.length,
                onClick: () => { path.pop(); releasePreview(); render(); } }, "↑"), crumb("/", 0),
                ...path.flatMap((part, index) => [ui("span", { className: "lowcord-zip-sep" }, "›"), crumb(part, index + 1)]));
            const rows = [...[...node.dirs.keys()].sort().map(name => ui("button", { type: "button", className: "lowcord-zip-row",
                onClick: () => { path.push(name); releasePreview(); render(); } }, ui("span", { className: "lowcord-zip-name", textContent: `${name}/` }))),
                ...[...node.files].sort((a, b) => a.base.localeCompare(b.base)).map(file => ui("button", { type: "button", className: "lowcord-zip-row",
                    onClick: () => void show(file) }, ui("span", { className: "lowcord-zip-name", textContent: file.base }),
                    ui("span", { className: "lowcord-zip-size", textContent: bytesLabel(file.size) })))];
            if (!rows.length) rows.push(ui("div", { className: "lowcord-zip-status" }, "Empty folder"));
            if (truncated && !path.length) rows.push(ui("div", { className: "lowcord-zip-status" }, `Showing the first ${MAX_ENTRIES} files.`));
            list.replaceChildren(...rows);
        }
        async function show(file) {
            releasePreview();
            preview = ui("div", { className: "lowcord-zip-preview" }, ui("div", { className: "lowcord-zip-status" }, "Loading…"));
            panel.append(preview);
            const mine = preview;
            const say = message => { if (preview === mine) mine.replaceChildren(ui("div", { className: "lowcord-zip-status" }, message)); };
            if (file.encrypted) { say("Encrypted — no preview"); return; }
            if (file.size > MAX_FILE) { say("Too large to preview (over 2 MB)"); return; }
            let data;
            try { data = await readEntry(fetchRange, file); } catch (error) { say(error.message === "Unsupported" ? "No preview" : "Couldn't read this file."); return; }
            if (preview !== mine) return;
            const ext = file.base.split(".").pop().toLowerCase();
            const actions = [];
            let body, text;
            if (imageTypes[ext]) {
                url = URL.createObjectURL(new Blob([data], { type: imageTypes[ext] }));
                body = ui("img", { className: "lowcord-zip-image", src: url, alt: file.base });
            } else {
                try {
                    if (data.includes(0) && !textTypes.test(file.base)) throw new Error("binary");
                    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
                    body = ui("pre", { className: "lowcord-zip-text", textContent: text });
                    actions.push(ui("button", { type: "button", className: "lowcord-zip-action", onClick: () => {
                        navigator.clipboard?.writeText(text).then(() => extensions.toast("Copied to clipboard."), () => extensions.toast("Couldn't copy this text.", true)); } }, "Copy text"));
                } catch { body = ui("div", { className: "lowcord-zip-status" }, "No preview"); }
            }
            actions.push(ui("button", { type: "button", className: "lowcord-zip-action", onClick: () => {
                const blobUrl = URL.createObjectURL(new Blob([data]));
                const link = ui("a", { href: blobUrl, download: file.base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") });
                document.body.append(link); link.click(); link.remove();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
            } }, "Download"));
            mine.replaceChildren(ui("div", { className: "lowcord-zip-preview-head" }, ui("strong", { textContent: file.base }), ...actions), body);
        }
        render();
        return { cleanup: releasePreview };
    }

    // ----- Scan and lifecycle ------------------------------------------------------------------
    function cardFor(row, attachment) {
        const wanted = basename(attachment.url);
        for (const link of row.querySelectorAll('a[href*="/attachments/"]')) {
            if (basename(link.href) !== wanted) continue;
            const card = link.closest('[class*="attachment_"]');
            if (card && row.contains(card) && !card.querySelector('[class*="imageWrapper_"], video')) return card;
        }
        return null;
    }
    function scan() {
        if (!extensions.enabled(ID)) return;
        const messages = window.Lowcord.store("MessageStore");
        if (!messages) return;
        for (const row of document.querySelectorAll('[id^="chat-messages-"]')) {
            if (!row.querySelector('a[href*="/attachments/"]')) continue;
            const match = /^chat-messages-(\d+)-(\d+)$/.exec(row.id);
            const attachments = match && messages.getMessage?.(match[1], match[2])?.attachments;
            for (const attachment of attachments ?? []) {
                if (!attachment?.url || !/\.zip$/i.test(attachment.filename ?? "") || !(attachment.size > 22)) continue;
                const card = cardFor(row, attachment);
                if (card) mount(card, attachment);
            }
        }
    }
    let frame = 0, stop, active = false;
    function dom(records) {
        if (frame || !window.Lowcord.domChanged(records, '[id^="chat-messages-"]')) return;
        frame = requestAnimationFrame(() => { frame = 0; scan(); });
    }
    function sync() {
        const on = extensions.enabled(ID);
        if (on === active) return;
        active = on;
        if (on) { stop = window.Lowcord.onDomChange(dom); scan(); }
        else {
            stop?.(); stop = undefined;
            if (frame) { cancelAnimationFrame(frame); frame = 0; }
            for (const close of [...panels]) close();
            for (const bar of document.querySelectorAll(".lowcord-zip")) bar.remove();
        }
    }
    window.addEventListener(extensions.changeEvent, sync);
    sync();
})();
