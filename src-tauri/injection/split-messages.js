// Split long messages: Enter on a composer text over the length limit sends it
// as several messages, in order, instead of Discord's "message too long"
// prompt. One capture-phase keydown listener, present only while the extension
// is on; nothing runs per keystroke beyond the key check.
(() => {
    const { extensions } = window.Lowcord;
    const { enabled, toast, changeEvent } = extensions;
    const gap = 350, fenceReserve = 4;
    const store = name => window.Lowcord.store(name);
    let actions;
    const messageActions = () => actions ??= window.Lowcord.find(window.Lowcord.filters.byProps("sendMessage", "editMessage", "getSendMessageOptionsForReply"));

    // ----- Splitting ----------------------------------------------------------
    // Fenced ranges of `text`: [start, end) from the opening to the closing fence.
    function fences(text) {
        const found = [];
        let open = null, index = 0;
        for (const line of text.split("\n")) {
            const match = /^ {0,3}```(.*)$/.exec(line);
            if (match && open) { found.push({ ...open, end: index + line.length }); open = null; }
            else if (match && !match[1].includes("```")) open = { start: index, lang: match[1].trim().split(/\s/)[0] };
            index += line.length + 1;
        }
        if (open) found.push({ ...open, end: text.length });
        return found;
    }
    // Where to end the next chunk of `rest` (which starts with `prefix`, a
    // reopened fence). Returns { cut, skip, close, prefix }: the chunk is
    // rest.slice(0, cut) + close, and the next one starts after `skip` more characters.
    function nextCut(rest, limit, prefix) {
        const blocks = fences(rest);
        const inside = at => blocks.some(block => at > block.start && at < block.end);
        const head = rest.slice(0, limit);
        const minimum = Math.max(prefix.length + 1, Math.floor(limit * 0.2));
        const kinds = [/\n\n+/g, /\n/g, /([.!?…]+["')\]]*)[ \t]+/g, /[ \t]+/g];
        for (const [kind, pattern] of kinds.entries()) {
            let best = null, match;
            const floor = kind === 3 ? prefix.length + 1 : minimum;
            while ((match = pattern.exec(head))) {
                const cut = match[1] ? match.index + match[1].length : match.index;
                const skip = match[0].length - (cut - match.index);
                if (cut > limit) break;
                if (cut >= floor && cut <= limit && !inside(cut)) best = { cut, skip, close: "", prefix: "" };
            }
            if (best) return best;
        }
        // No clean break outside a code block: end just before one that starts in range.
        const before = blocks.find(block => block.start >= minimum && block.start < limit);
        if (before) return { cut: before.start, skip: 0, close: "", prefix: "" };
        // The break has to fall inside a code block: close the fence and reopen it.
        const block = blocks.find(item => item.start < limit && item.end > limit);
        if (block) {
            const room = rest.slice(0, limit - fenceReserve);
            let cut = room.lastIndexOf("\n");
            if (cut <= Math.max(prefix.length, block.start)) cut = room.search(/[ \t][^ \t]*$/);
            if (cut <= prefix.length) cut = room.length;
            const separator = /[\n \t]/.test(rest[cut] ?? "");
            return { cut, skip: separator ? 1 : 0, close: "\n```", prefix: `\`\`\`${block.lang}\n` };
        }
        let cut = limit;
        if (/[\ud800-\udbff]/.test(rest[cut - 1] ?? "")) cut--;
        return { cut, skip: 0, close: "", prefix: "" };
    }
    // Chunks of at most `limit` characters; `end` is where each one stops in `text`.
    function split(text, limit) {
        const chunks = [];
        let offset = 0, prefix = "";
        while (true) {
            const rest = prefix + text.slice(offset);
            if (rest.length <= limit) {
                if (rest.trim() && rest !== prefix) chunks.push({ content: rest.trim(), end: text.length });
                return chunks;
            }
            const { cut, skip, close, prefix: next } = nextCut(rest, limit, prefix);
            const content = rest.slice(0, cut).replace(/\s+$/, "") + close;
            if (content.trim()) chunks.push({ content, end: offset + cut - prefix.length + skip });
            offset += cut - prefix.length + skip;
            // Whitespace between chunks belongs to neither.
            while (!next && /\s/.test(text[offset] ?? "x") && offset < text.length) offset++;
            prefix = next;
            if (offset >= text.length) return chunks;
        }
    }

    // ----- Composer -----------------------------------------------------------
    // Discord's composer is a Slate editor, reached through its React props.
    function slateEditor(element) {
        const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
        let fiber = key && element[key];
        for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
            const editor = fiber.memoizedProps?.editor;
            if (typeof editor?.apply === "function" && Array.isArray(editor.children)) return editor;
        }
        return null;
    }
    // The composer's text as Discord would send it; null for anything unknown.
    function serialize(nodes) {
        const parts = [];
        for (const node of nodes) {
            if (typeof node.text === "string") { parts.push(node.text); continue; }
            switch (node.type) {
                case "userMention": parts.push(`<@${node.userId}>`); continue;
                case "roleMention": parts.push(`<@&${node.roleId}>`); continue;
                case "channelMention": parts.push(`<#${node.channelId}>`); continue;
                case "emoji": case "customEmoji": {
                    const emoji = node.emoji ?? {};
                    if (emoji.emojiId) parts.push(`<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.emojiId}>`);
                    else if (emoji.surrogate ?? emoji.name) parts.push(emoji.surrogate ?? emoji.name);
                    else return null;
                    continue;
                }
            }
            if (!Array.isArray(node.children)) return null;
            const inner = serialize(node.children);
            if (inner === null) return null;
            parts.push(inner);
        }
        return parts.join("");
    }
    function composerText(slate) {
        const lines = slate.children.map(block => serialize([block]));
        return lines.includes(null) ? null : lines.join("\n");
    }
    // Replaces the composer's content through the editor, one block per line.
    function setComposer(slate, text) {
        const type = slate.children[0]?.type ?? "line";
        const lines = text ? text.split("\n") : [""];
        for (let index = slate.children.length - 1; index >= 0; index--) slate.apply({ type: "remove_node", path: [index], node: slate.children[index] });
        lines.forEach((line, index) => slate.apply({ type: "insert_node", path: [index], node: { type, children: [{ text: line }] } }));
        const point = { path: [lines.length - 1, 0], offset: lines.at(-1).length };
        try { slate.apply({ type: "set_selection", properties: slate.selection ?? null, newProperties: { anchor: point, focus: point } }); } catch {}
    }

    // ----- Sending ------------------------------------------------------------
    const limitFor = () => {
        const user = store("UserStore")?.getCurrentUser?.();
        return (user?.premiumType ?? user?.premium_type ?? 0) > 0 ? 4000 : 2000;
    };
    let busy = false;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function onKey(event) {
        if (busy || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
            || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
        const editor = event.target instanceof Element ? event.target.closest('[role="textbox"]') : null;
        if (!editor?.closest('[class*="channelTextArea_"]') || editor.closest('[role="dialog"]')) return;
        // Discord's completion menus own Enter while open.
        if (editor.getAttribute("aria-expanded") === "true" || editor.getAttribute("aria-activedescendant")) return;
        const slate = slateEditor(editor);
        if (!slate) return;
        const text = composerText(slate);
        const limit = limitFor();
        if (text === null || text.length <= limit) return;
        const channelId = store("SelectedChannelStore")?.getChannelId?.();
        if (!channelId) return;
        if (store("UploadAttachmentStore")?.getUploads?.(channelId, 0)?.length) {
            toast("Attachments can't be split, so send the text separately.", true);
            return;
        }
        const send = messageActions()?.sendMessage;
        if (!send) return;
        const chunks = split(text, limit);
        if (chunks.length < 2) return;
        event.preventDefault(); event.stopImmediatePropagation();
        try { setComposer(slate, ""); }
        catch (error) { console.warn("[lowcord] split messages:", error); toast("Couldn't split this message. Try again.", true); return; }
        busy = true;
        const reply = store("PendingReplyStore")?.getPendingReply?.(channelId);
        if (reply) window.Lowcord.Dispatcher?.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
        let sent = 0;
        try {
            for (const [index, chunk] of chunks.entries()) {
                if (index) await sleep(gap);
                const options = index === 0 && reply?.message
                    ? { messageReference: { guild_id: reply.channel?.guild_id, channel_id: channelId, message_id: reply.message.id },
                        ...(reply.shouldMention === false ? { allowedMentions: { parse: ["users", "roles", "everyone"], replied_user: false } } : {}) }
                    : {};
                const result = await send(channelId, { content: chunk.content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, false, options);
                if (result?.ok === false) throw result;
                sent++;
            }
        } catch (failure) {
            console.warn("[lowcord] split messages:", failure);
            const unsent = text.slice(sent ? chunks[sent - 1].end : 0);
            try {
                const current = slateEditor(editor.isConnected ? editor : document.querySelector('[class*="channelTextArea_"] [role="textbox"]') ?? editor) ?? slate;
                if (!composerText(current)) setComposer(current, unsent);
            } catch {}
            toast(`Couldn't send the rest of the message (${sent} of ${chunks.length} sent). It is back in the box.`, true);
        } finally { busy = false; }
    }

    let active = false;
    function sync() {
        const next = enabled("splitMessages");
        if (next === active) return;
        active = next;
        if (next) window.addEventListener("keydown", onKey, true);
        else window.removeEventListener("keydown", onKey, true);
    }
    window.addEventListener(changeEvent, sync);
    sync();
})();
