(() => {
    const extensions = window.Lowcord?.extensions;
    if (!extensions) return;
    const { ui } = extensions;
    const ID = "translate", outgoingKey = "lowcord.translate.outgoing";
    const languages = { af: "Afrikaans", ar: "Arabic", bg: "Bulgarian", bn: "Bengali", ca: "Catalan", cs: "Czech", da: "Danish", de: "German",
        el: "Greek", en: "English", es: "Spanish", et: "Estonian", fa: "Persian", fi: "Finnish", fr: "French", he: "Hebrew", hi: "Hindi",
        hr: "Croatian", hu: "Hungarian", id: "Indonesian", it: "Italian", ja: "Japanese", ko: "Korean", lt: "Lithuanian", lv: "Latvian",
        ms: "Malay", nl: "Dutch", no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian", sk: "Slovak",
        sl: "Slovenian", sr: "Serbian", sv: "Swedish", ta: "Tamil", th: "Thai", tr: "Turkish", uk: "Ukrainian", ur: "Urdu",
        vi: "Vietnamese", "zh-CN": "Chinese (Simplified)", "zh-TW": "Chinese (Traditional)" };
    const nameOf = code => languages[code] ?? (() => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; } })();
    const failure = "Couldn't translate this message, so try again later.";

    // ----- Translation -----------------------------------------------------------
    // Markup that must survive translation untouched: code, URLs, mentions, emoji.
    const protectedPattern = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>]+|<a?:\w+:\d+>|<(?:@[!&]?|#)\d+>|<t:-?\d+(?::\w)?>|@(?:everyone|here)/g;
    function protect(text) {
        const tokens = [];
        const masked = text.replace(protectedPattern, match => { tokens.push(match); return `⟦${tokens.length - 1}⟧`; });
        return { masked, tokens };
    }
    function restore(text, tokens) {
        return text.replace(/⟦\s*(\d+)\s*⟧/g, (whole, index) => tokens[Number(index)] ?? "");
    }
    function chunks(text, limit = 900) {
        const parts = [];
        for (let rest = text; rest.length;) {
            if (rest.length <= limit) { parts.push(rest); break; }
            let cut = rest.lastIndexOf("\n", limit);
            if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
            if (cut < limit / 2) cut = limit;
            parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
        }
        return parts;
    }
    // Google's gtx reply: [[[translated, original, ...], ...], null, detectedLanguage, ...].
    function parseReply(body) {
        const data = JSON.parse(body);
        if (!Array.isArray(data?.[0])) throw new Error("Unexpected reply");
        return { text: data[0].map(part => part?.[0] ?? "").join(""), language: typeof data[2] === "string" ? data[2] : "" };
    }
    async function translateText(text, target) {
        const native = window.__LOWCORD_NATIVE__;
        if (!native?.fetchRemote) throw new Error("Unavailable");
        const { masked, tokens } = protect(text);
        let language = "", out = "";
        for (const part of chunks(masked)) {
            if (!part.trim()) { out += part; continue; }
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(part)}`;
            const response = await native.fetchRemote(url, { as: "text" });
            if (response.status !== 200) throw new Error(`Status ${response.status}`);
            const reply = parseReply(response.body);
            language ||= reply.language; out += reply.text;
        }
        return { text: restore(out, tokens), language };
    }

    // ----- Message translations ------------------------------------------------------
    const cache = new Map(); // `${message}:${target}` -> { content, text, language }
    const shown = new Map(); // message id -> cache key, for the messages showing a translation
    const target = () => extensions.options.translateTarget || "en";
    function remember(key, value) {
        cache.delete(key); cache.set(key, value);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    function readable(text) {
        const users = window.Lowcord.store("UserStore");
        return text.replace(/<a?:(\w+):\d+>/g, ":$1:").replace(/<@[!]?(\d+)>/g, (whole, id) => {
            const user = users?.getUser?.(id);
            return user ? `@${user.globalName || user.username}` : whole;
        });
    }
    function messageOf(row) {
        const match = /^chat-messages-(\d+)-(\d+)$/.exec(row.id);
        return match && window.Lowcord.store("MessageStore")?.getMessage?.(match[1], match[2]);
    }
    function removeNodes() { for (const node of document.querySelectorAll(".lowcord-translation")) node.remove(); }
    function render(row, id, entry) {
        const anchor = row.querySelector('[id^="message-content-"]');
        if (!anchor) return;
        let node = anchor.nextElementSibling;
        if (!node?.classList.contains("lowcord-translation")) {
            node = ui("div", { className: "lowcord-translation" });
            anchor.after(node);
        }
        if (node.dataset.key === `${id}:${entry.text}`) return;
        node.dataset.key = `${id}:${entry.text}`;
        const from = entry.language && entry.language !== "auto" ? ` from ${nameOf(entry.language)}` : "";
        node.replaceChildren(
            ui("div", { className: "lowcord-translation-head" }, `Translated${from} · `,
                ui("button", { type: "button", className: "lowcord-translation-link", onClick: () => hide(id) }, "Show original")),
            ui("div", { className: "lowcord-translation-text", textContent: readable(entry.text) }));
    }
    function hide(id) {
        shown.delete(id);
        for (const row of document.querySelectorAll('[id^="chat-messages-"]')) if (row.id.endsWith(`-${id}`)) row.querySelector(".lowcord-translation")?.remove();
    }
    async function translateMessage(row, language = target()) {
        const message = messageOf(row);
        const content = message?.content?.trim();
        if (!message || !content) { extensions.toast("There's no text to translate.", true); return; }
        const key = `${message.id}:${language}`;
        let entry = cache.get(key);
        if (entry?.content !== content) {
            try { entry = { content, ...await translateText(content, language) }; }
            catch { extensions.toast(failure, true); return; }
            remember(key, entry);
        }
        if (!extensions.enabled(ID)) return;
        shown.set(message.id, key);
        render(row, message.id, entry);
    }
    function restoreShown() {
        if (!extensions.enabled(ID)) return;
        for (const row of document.querySelectorAll('[id^="chat-messages-"]')) {
            const id = /-(\d+)$/.exec(row.id)?.[1], key = id && shown.get(id);
            const entry = key && cache.get(key);
            if (entry) render(row, id, entry);
        }
    }

    // ----- Language picker -----------------------------------------------------------
    let picker;
    function closePicker() { picker?.remove(); picker = undefined; }
    function pickLanguage({ title, action, initial, onPick, onChange }) {
        closePicker();
        const select = ui("select", { className: "lowcord-translate-select", "aria-label": "Language" });
        const codes = new Set([...Object.keys(languages), initial]);
        for (const code of [...codes].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) select.append(ui("option", { value: code }, nameOf(code)));
        select.value = initial;
        const go = () => { const code = select.value; closePicker(); onPick(code); };
        picker = ui("div", { className: "lowcord-translate-picker", role: "dialog", "aria-label": title },
            ui("strong", {}, title), select,
            ui("div", { className: "lowcord-translate-buttons" },
                ui("button", { type: "button", className: "lowcord-translate-button", onClick: closePicker }, "Cancel"),
                ui("button", { type: "button", className: "lowcord-translate-button lowcord-translate-primary", onClick: go }, action)));
        select.addEventListener("change", () => onChange?.(select.value));
        picker.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.stopPropagation(); closePicker(); }
            else if (event.key === "Enter" && event.target === select) { event.preventDefault(); go(); }
        });
        extensions.mountComposerPopup(picker);
        select.focus();
    }

    // ----- Message context menu --------------------------------------------------------
    const globePath = "M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z";
    function addMenuItem(menu, id, label, run) {
        if (menu.querySelector(`#${id}`)) return;
        const model = ["#message-copy-text", "#message-copy-link", '[role="menuitem"]:not([id*="quickreact"])']
            .map(selector => menu.querySelector(selector)).find(Boolean);
        if (!model) return;
        const item = model.cloneNode(true);
        item.id = id;
        item.removeAttribute("aria-disabled");
        item.className = [...item.classList].filter(name => !/^(focused|disabled)_/.test(name)).join(" ") + " lowcord-translate-item";
        const suffix = /^item(_\w+)$/.exec([...item.classList].find(name => /^item_/.test(name)) ?? "")?.[1];
        const focusedClass = suffix ? `focused${suffix}` : "lowcord-copy-media-focused";
        const highlight = on => { item.classList.toggle(focusedClass, on); menu.toggleAttribute("data-lowcord-media-hover", on); };
        const text = item.querySelector('[data-text-variant], [class*="label_"]');
        item.removeAttribute("aria-labelledby");
        item.setAttribute("aria-label", label);
        if (text) text.textContent = label; else item.textContent = label;
        const icon = item.querySelector("svg");
        if (icon) icon.innerHTML = `<path fill="currentColor" d="${globePath}"/>`;
        const choose = event => {
            event.preventDefault(); event.stopPropagation();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
            run();
        };
        item.addEventListener("click", choose);
        item.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") choose(event); });
        item.addEventListener("pointerenter", () => highlight(true));
        item.addEventListener("pointerleave", () => highlight(false));
        item.addEventListener("focus", () => highlight(true));
        item.addEventListener("blur", () => highlight(false));
        model.before(item);
        const plain = getComputedStyle(item);
        menu.style.setProperty("--lowcord-menu-item-bg", plain.backgroundColor);
        menu.style.setProperty("--lowcord-menu-item-color", plain.color);
    }
    let menuRequest = 0;
    function onContextMenu(event) {
        const request = ++menuRequest;
        document.querySelectorAll("#message-lowcord-translate, #message-lowcord-translate-to").forEach(item => item.remove());
        if (!extensions.enabled(ID) || !(event.target instanceof Element)) return;
        const row = event.target.closest('[id^="chat-messages-"]');
        if (!row || !row.querySelector('[id^="message-content-"]') || event.target.closest('[class*="reactions_"]')) return;
        const id = /-(\d+)$/.exec(row.id)?.[1];
        let frames = 0;
        const look = () => {
            if (request !== menuRequest || !extensions.enabled(ID)) return;
            const menu = document.querySelector('#message[role="menu"]');
            if (!menu) { if (++frames < 30) requestAnimationFrame(look); return; }
            if (shown.has(id)) addMenuItem(menu, "message-lowcord-translate", "Show original", () => hide(id));
            else addMenuItem(menu, "message-lowcord-translate", "Translate", () => void translateMessage(row));
            // Translate-to opens the picker; the choice becomes the new default.
            addMenuItem(menu, "message-lowcord-translate-to", `Translate to ${nameOf(target())}…`, () => pickLanguage({
                title: "Translate message to", action: "Translate", initial: target(),
                onPick: code => { try { extensions.setOption("translateTarget", code); } catch {} void translateMessage(row, code); } }));
        };
        requestAnimationFrame(() => requestAnimationFrame(look));
    }

    // ----- Composer: translate before sending ----------------------------------------------
    const editorOf = () => document.querySelector('[class*="channelTextArea_"] [role="textbox"], [class*="channelTextArea_"] textarea');
    const readEditor = editor => (editor.value ?? editor.innerText ?? "").replace(/[​﻿]/g, "").trim();
    function writeEditor(editor, text) {
        editor.focus();
        if (editor.value !== undefined) {
            editor.value = text;
            editor.dispatchEvent(new Event("input", { bubbles: true }));
            return;
        }
        // Discord's composer is a Slate editor that repaints from its own model:
        // a DOM edit (even execCommand) shows the translation while the model
        // keeps the original, so Backspace edits text that isn't on screen.
        // Select everything in the model, then paste through Discord's handler.
        const slate = slateEditor(editor);
        if (slate?.children.length) {
            const edge = (nodes, path, last) => {
                const index = last ? nodes.length - 1 : 0, node = nodes[index];
                if (typeof node?.text === "string") return { path: [...path, index], offset: last ? node.text.length : 0 };
                return Array.isArray(node?.children) && node.children.length ? edge(node.children, [...path, index], last) : null;
            };
            const anchor = edge(slate.children, [], false), focus = edge(slate.children, [], true);
            if (anchor && focus) {
                slate.apply({ type: "set_selection", properties: slate.selection, newProperties: { anchor, focus } });
                const data = new DataTransfer();
                data.setData("text/plain", text);
                const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
                editor.dispatchEvent(paste);
                if (paste.defaultPrevented) return;
            }
        }
        document.execCommand("selectAll");
        document.execCommand("insertText", false, text);
    }
    function slateEditor(element) {
        const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
        let fiber = key && element[key];
        for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
            const editor = fiber.memoizedProps?.editor;
            if (typeof editor?.apply === "function" && Array.isArray(editor.children)) return editor;
        }
        return null;
    }
    function outgoing() { try { return window.Lowcord.storage?.getItem(outgoingKey) || "en"; } catch { return "en"; } }
    function composerTranslate() {
        const editor = editorOf();
        if (!editor || !readEditor(editor)) { extensions.toast("Type a message to translate first.", true); return; }
        pickLanguage({ title: "Translate your message to", action: "Translate", initial: outgoing(),
            onPick: async code => {
                try { window.Lowcord.storage?.setItem(outgoingKey, code); } catch {}
                const current = editorOf();
                if (!current) return;
                try {
                    const { text } = await translateText(readEditor(current), code);
                    if (extensions.enabled(ID)) writeEditor(editorOf() ?? current, text);
                } catch { extensions.toast(failure, true); }
            } });
    }
    extensions.addComposerAction({ id: ID, order: 3, label: "Translate before sending", path: globePath, run: composerTranslate });

    // ----- Lifecycle -------------------------------------------------------------------------
    let active = false;
    function sync() {
        const on = extensions.enabled(ID);
        if (on === active) return;
        active = on;
        if (on) {
            window.addEventListener("contextmenu", onContextMenu, true);
            stopDom = window.Lowcord.onDomChange(domChange);
        } else {
            window.removeEventListener("contextmenu", onContextMenu, true);
            stopDom?.(); stopDom = undefined;
            closePicker(); removeNodes(); shown.clear();
            document.querySelectorAll("#message-lowcord-translate, #message-lowcord-translate-to").forEach(item => item.remove());
        }
    }
    let stopDom;
    let frame = 0;
    function domChange(records) {
        if (!shown.size || frame || !window.Lowcord.domChanged(records, '[id^="chat-messages-"]')) return;
        frame = requestAnimationFrame(() => { frame = 0; restoreShown(); });
    }
    window.addEventListener(extensions.changeEvent, sync);
    window.Lowcord.translate = { protect, restore, parseReply, translateText };
    sync();
})();
