(() => {
    const extensions = window.Lowcord?.extensions;
    if (!extensions) return;
    const { ui } = extensions;
    const ID = "embedMoreImages";
    const pattern = /\.(bmp|dib|ico|cur|avif|apng|jfif|jpe|jif|jfi|webp)$/i;
    const MAX_SIZE = 20 * 1024 * 1024, FALLBACK_CAP = 16 * 1024 * 1024;
    const basename = url => { try { return decodeURIComponent(new URL(url).pathname.split("/").pop()); } catch { return ""; } };

    // The file card Discord drew for an attachment: the card around the link to its URL.
    function cardFor(row, attachment) {
        const wanted = basename(attachment.url);
        for (const link of row.querySelectorAll('a[href*="/attachments/"]')) {
            if (basename(link.href) !== wanted) continue;
            const card = link.closest('[class*="attachment_"]');
            if (card && row.contains(card) && !card.querySelector('[class*="imageWrapper_"], video')) return card;
        }
        return null;
    }
    function open(url) {
        const native = window.__LOWCORD_NATIVE__;
        if (native?.openExternal) void native.openExternal(url); else window.open(url, "_blank", "noopener");
    }
    function embed(card, attachment) {
        const next = card.nextElementSibling;
        if (next?.classList.contains("lowcord-embed-image") && next.dataset.attachment === attachment.id) return;
        const image = ui("img", { alt: attachment.filename, loading: "lazy", decoding: "async", draggable: "false" });
        const button = ui("button", { type: "button", className: "lowcord-embed-image-button", "aria-label": `Open ${attachment.filename}`,
            onClick: () => open(attachment.url) }, image);
        const box = ui("div", { className: "lowcord-embed-image" }, button);
        box.dataset.attachment = attachment.id;
        const sources = [attachment.url, attachment.proxy_url].filter(Boolean);
        let step = 0;
        image.addEventListener("error", async () => {
            if (!box.isConnected) return;
            if (++step < sources.length) { image.src = sources[step]; return; }
            // Last resort: the main process fetches the bytes and the page decodes a data URL.
            try {
                const result = await window.__LOWCORD_NATIVE__?.fetchRemote?.(attachment.url, { as: "dataUrl", maxBytes: FALLBACK_CAP });
                if (result?.status === 200 && box.isConnected) { image.src = result.body; return; }
            } catch {}
            box.remove();
        });
        image.src = sources[0];
        card.after(box);
    }
    const rowIdPattern = /^chat-messages-(\d+)-(\d+)$/;
    function scanRow(row, messages) {
        const match = rowIdPattern.exec(row.id);
        const attachments = match && messages.getMessage?.(match[1], match[2])?.attachments;
        if (!attachments?.length) return;
        for (const attachment of attachments) {
            if (!attachment?.url || !pattern.test(attachment.filename ?? "") || !(attachment.size <= MAX_SIZE)) continue;
            const card = cardFor(row, attachment);
            if (card) embed(card, attachment);
        }
    }
    function scan(targets) {
        if (!extensions.enabled(ID)) return;
        const messages = window.Lowcord.store("MessageStore");
        if (!messages) return;
        if (targets) {
            for (const row of targets) {
                if (row.isConnected && row.getElementsByTagName("a").length && row.querySelector('a[href*="/attachments/"]')) scanRow(row, messages);
            }
            return;
        }
        const links = document.querySelectorAll('[id^="chat-messages-"] a[href*="/attachments/"]');
        if (!links.length) return;
        const seen = new Set();
        for (let i = 0; i < links.length; i++) {
            const row = links[i].closest('[id^="chat-messages-"]');
            if (row && !seen.has(row)) { seen.add(row); scanRow(row, messages); }
        }
    }
    let stop, active = false;
    function dom(records) {
        if (!Array.isArray(records)) { scan(); return; }
        if (!window.Lowcord.domChanged(records, '[id^="chat-messages-"]')) return;
        const targets = new Set();
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            if (record.type !== "childList") continue;
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            const row = target?.closest('[id^="chat-messages-"]');
            if (row) targets.add(row);
            const added = record.addedNodes;
            for (let j = 0; j < added.length; j++) {
                const node = added[j];
                if (!(node instanceof Element)) continue;
                if (node.matches('[id^="chat-messages-"]')) targets.add(node);
                else if (node.childElementCount > 0) {
                    const nested = node.querySelectorAll('[id^="chat-messages-"]');
                    for (let k = 0; k < nested.length; k++) targets.add(nested[k]);
                }
            }
        }
        if (targets.size) scan(targets);
    }
    function sync() {
        const on = extensions.enabled(ID);
        if (on === active) return;
        active = on;
        if (on) { stop = window.Lowcord.onDomChange(dom); scan(); }
        else {
            stop?.(); stop = undefined;
            for (const box of document.querySelectorAll(".lowcord-embed-image")) box.remove();
        }
    }
    window.addEventListener(extensions.changeEvent, sync);
    sync();
})();
