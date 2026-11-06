// Smooth animations for what CSS can't tell apart: a message that just
// arrived, versus messages drawn when a channel opens or history loads, and a
// reaction just added, versus reactions drawn with their message; and a side
// panel opened or closed beside a chat, versus one drawn with it when switching
// chats. Rides the shared per-frame DOM batch, so it adds no observer, and
// animates through the Web Animations API, which leaves nothing behind.
(() => {
    const extensions = window.Lowcord?.extensions;
    if (!extensions) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const easeOut = "cubic-bezier(.23, 1, .32, 1)";
    const active = () => extensions.enabled("smoothAnimations") && !reduced.matches
        && !document.documentElement.classList.contains("reduce-motion") && document.visibilityState === "visible";
    const isMessage = node => node instanceof HTMLElement && node.tagName === "LI" && node.id.startsWith("chat-messages-");
    const isReaction = node => node instanceof HTMLElement && /(?:^|\s)reaction_/.test(node.className);

    function arrive(message) {
        // Own messages sit on the right in bubble layouts and grow from there.
        const right = message.querySelector(':scope > [data-lowcord-align="right"]');
        message.animate([{ opacity: 0, transform: "translateY(8px) scale(.98)", transformOrigin: right ? "bottom right" : "bottom left" },
            { opacity: 1, transform: "none", transformOrigin: right ? "bottom right" : "bottom left" }], { duration: 240, easing: easeOut });
    }
    function react(reaction) {
        reaction.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }],
            { duration: 260, easing: "cubic-bezier(.34, 1.4, .64, 1)" });
    }

    // Side panels, such as Show User Profile in a DM, push in from the right.
    // The panel keeps its full width, so its content never squeezes, while its
    // right margin eases from minus its width to zero and the chat narrows in
    // step. Discord removes a closed panel at once, so closing runs the same
    // motion backwards on an inert copy. The row clips only while a panel is offset.
    const panelEase = "cubic-bezier(.32, .72, 0, 1)";
    const closing = "data-lowcord-closing";
    const isPanel = node => node instanceof HTMLElement && node.tagName === "ASIDE"
        && /(?:^|\s)aside_/.test(node.className) && !node.hasAttribute(closing);
    const clipping = new WeakMap(); // row -> [panels moving, its own overflow-x]
    let panelWidth = 320;
    function push(panel, row, from, to, duration) {
        const [count, overflow] = clipping.get(row) ?? [0, row.style.overflowX];
        clipping.set(row, [count + 1, overflow]);
        row.style.overflowX = "clip";
        const animation = panel.animate([{ marginRight: `${from}px` }, { marginRight: `${to}px` }],
            { duration, easing: panelEase, fill: "forwards" });
        const done = () => {
            const [left, original] = clipping.get(row);
            if (left > 1) clipping.set(row, [left - 1, original]);
            else { clipping.delete(row); row.style.overflowX = original; }
        };
        animation.finished.then(() => { animation.cancel(); done(); }, done);
        return animation;
    }
    function open(panel) {
        const row = panel.parentElement;
        panelWidth = panel.offsetWidth || panelWidth;
        // Reopened while closing: carry on from where the copy had got to.
        let from = -panelWidth;
        for (const copy of row.querySelectorAll(`:scope > [${closing}]`)) {
            from = Math.max(from, parseFloat(getComputedStyle(copy).marginRight) || from);
            copy.remove();
        }
        push(panel, row, from, 0, 340);
    }
    function close(panel, row, next) {
        const copy = panel.cloneNode(true);
        copy.setAttribute(closing, ""); copy.setAttribute("aria-hidden", "true");
        copy.inert = true; copy.style.pointerEvents = "none";
        for (const node of [copy, ...copy.querySelectorAll("[id]")]) node.removeAttribute("id");
        row.insertBefore(copy, next?.parentNode === row ? next : null);
        const animation = push(copy, row, 0, -panelWidth, 260);
        animation.finished.then(() => copy.remove(), () => copy.remove());
    }

    window.Lowcord.onDomChange(records => {
        // No records: the first call, or a burst too large to sort through.
        if (!Array.isArray(records) || !records.length || !active()) return;
        const added = [], removed = new Set(), reactions = [], panels = [], drawn = new Set(), closed = [];
        for (const record of records) {
            if (record.type !== "childList") continue;
            const target = record.target;
            for (const node of record.addedNodes) {
                if (isPanel(node)) panels.push(node);
                else if (node instanceof HTMLElement) drawn.add(node);
            }
            for (const node of record.removedNodes) if (isPanel(node)) closed.push({ panel: node, row: target, next: record.nextSibling });
            if (target instanceof HTMLElement && target.dataset.listId === "chat-messages") {
                for (const node of record.addedNodes) if (isMessage(node)) added.push(node);
                for (const node of record.removedNodes) if (isMessage(node)) removed.add(node);
                continue;
            }
            if (!(target instanceof Element) || !target.closest('[data-list-id="chat-messages"]')) continue;
            // Discord may wrap each reaction; look inside what joined a reactions row.
            for (const node of record.addedNodes) {
                if (!(node instanceof HTMLElement) || !node.closest('[class*="reactions_"]')) continue;
                if (isReaction(node)) reactions.push(node);
                else reactions.push(...node.querySelectorAll('[class*="reaction_"]'));
            }
        }
        // One or two new messages at the end of the list are arrivals. A
        // message swapped in for one that left (a sent message getting its
        // id) has already been seen, and a batch of many is a channel or
        // history loading.
        if (added.length && added.length <= 2 && !removed.size) {
            for (const message of added) {
                if (!message.isConnected) continue;
                let next = message.nextElementSibling;
                while (next && !isMessage(next)) next = next.nextElementSibling;
                if (!next || added.includes(next)) arrive(message);
            }
        }
        // Opened or closed beside a chat already on screen. A panel drawn with a
        // new chat, or replaced in place, belongs to switching chats.
        const steady = row => row?.isConnected && [...row.children].some(node => !isPanel(node) && !node.hasAttribute(closing))
            && ![...row.children].some(node => drawn.has(node));
        for (const panel of panels) {
            const row = panel.parentElement;
            if (panel.isConnected && steady(row) && !closed.some(entry => entry.row === row)) open(panel);
        }
        for (const { panel, row, next } of closed) {
            if (steady(row) && !panels.some(other => other.parentElement === row)) close(panel, row, next);
        }
        // Reactions on a message that was already on screen.
        if (reactions.length <= 3) {
            for (const reaction of reactions) {
                const message = reaction.closest('li[id^="chat-messages-"]');
                if (reaction.isConnected && message && !added.includes(message)) react(reaction);
            }
        }
    });
})();
