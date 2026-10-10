// Official players for music links. Observe only changed rows and composers;
// Discord owns sending, uploads, link permissions and native embed rendering.
(() => {
    const { musicLinks, socialLinks, extensions } = window.Lowcord;
    const rowSelector = '[id^="chat-messages-"]';
    const editorSelector = '[contenteditable="true"][role="textbox"], textarea';
    const ownSelector = '.lowcord-music-embeds, .lowcord-music-draft';
    const rows = new Set(), drafts = new Map(), rowState = new WeakMap();
    let frame, discoverDrafts = true;

    function player(item, draft) {
        const card = document.createElement('section');
        card.className = 'lowcord-music-player';
        card.dataset.musicKey = item.key;
        card.setAttribute('aria-label', `${item.service} preview`);
        const header = document.createElement('header');
        const title = document.createElement('strong'); title.textContent = item.service;
        const link = document.createElement('a'); link.href = item.url;
        link.textContent = `Open in ${item.service}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
        header.append(title, link);
        const iframe = document.createElement('iframe');
        iframe.dataset.lowcordMusicPlayer = 'true';
        iframe.title = `${item.service} player`;
        iframe.src = item.src; iframe.height = String(item.height);
        iframe.loading = draft ? 'eager' : 'lazy';
        iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms');
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        card.append(header, iframe);
        return card;
    }
    function reconcile(host, items, draft) {
        const desired = new Set(items.map(item => item.key));
        for (const card of [...host.children]) if (!desired.has(card.dataset.musicKey)) card.remove();
        for (const item of items) {
            let card = [...host.children].find(card => card.dataset.musicKey === item.key);
            if (!card) card = player(item, draft);
            // Reorder only when needed; moving an existing iframe reloads it.
            const index = items.indexOf(item);
            if (host.children[index] !== card) host.insertBefore(card, host.children[index] ?? null);
        }
    }
    function updateRow(row) {
        if (!row.isConnected) return;
        const ids = /^chat-messages-(\d+)-(\d+)$/.exec(row.id);
        if (!ids) return;
        const surface = row.querySelector(':scope > [data-list-item-id^="chat-messages"]') ?? row.firstElementChild;
        const body = row.querySelector('[id^="message-content-"]');
        if (!surface || !body) return;
        const store = window.Lowcord.store('MessageStore');
        const message = typeof store?.getMessage === 'function' ? store.getMessage(ids[1], ids[2]) : null;
        // Render from the actual message markdown, not flattened DOM text:
        // Discord removes code fences and <suppressed-link> syntax in its DOM.
        if (!message || typeof message.content !== 'string') {
            surface.querySelector(':scope > .lowcord-music-embeds')?.remove();
            rowState.delete(row); return;
        }
        const content = message.content;
        const suppressed = Boolean((message?.flags ?? 0) & 4);
        const native = new Set([...surface.querySelectorAll('iframe[src]:not([data-lowcord-music-player])')]
            .map(iframe => musicLinks.parse(iframe.src)?.key).filter(Boolean));
        const signature = `${suppressed}:${content}:${[...native].join(',')}`;
        const prior = rowState.get(row);
        if (prior?.signature === signature && (!prior.host || prior.host.isConnected)) return;
        const items = suppressed ? [] : musicLinks.collect(content, socialLinks.mapUrls).filter(item => !native.has(item.key));
        let host = surface.querySelector(':scope > .lowcord-music-embeds');
        if (!items.length) { host?.remove(); host = null; }
        else {
            if (!host) {
                host = document.createElement('div'); host.className = 'lowcord-music-embeds';
                surface.append(host);
            }
            reconcile(host, items, false);
        }
        rowState.set(row, { signature, host });
    }
    function updateDraft(editor) {
        if (!editor.isConnected) return;
        const bar = editor.closest('[class*="channelTextArea_"]');
        if (!bar || editor.closest('[role="dialog"]')) return;
        // Slate renders separate lines as blocks; textContent joins their URLs
        // together. innerText keeps the line breaks in contenteditable drafts,
        // but it forces a layout, and this runs on most page changes. Read it
        // only when the text or the number of lines changed.
        const prior = drafts.get(editor);
        const key = editor.value ?? `${editor.childElementCount}:${editor.textContent}`;
        if (prior?.key === key && (!prior.host || prior.host.isConnected)) return;
        // An empty draft (most channel switches) has no links to lay out.
        const content = editor.value ?? (/[^\s\u200b\ufeff]/.test(editor.textContent) ? editor.innerText : '');
        if (prior?.content === content && (!prior.host || prior.host.isConnected)) { prior.key = key; return; }
        const items = musicLinks.collect(content, socialLinks.mapUrls);
        let host = prior?.host;
        if (!items.length) { host?.remove(); host = null; }
        else {
            if (!host?.isConnected) {
                host = document.createElement('div'); host.className = 'lowcord-music-draft';
                host.setAttribute('aria-label', 'Music link preview');
                // Discord's bottom bar is a horizontal flex row. A sibling of
                // the text area steals its width and stretches it to the
                // player's height; place the preview above that entire row.
                (bar.closest('[class*="channelBottomBarArea_"]') ?? bar).before(host);
            }
            reconcile(host, items, true);
        }
        drafts.set(editor, { key, content, host });
    }
    function flush() {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        if (!extensions.enabled('musicEmbeds')) { rows.clear(); return; }
        for (const row of rows) updateRow(row);
        rows.clear();
        for (const [editor, state] of drafts) {
            if (!editor.isConnected) { state.host?.remove(); drafts.delete(editor); }
        }
        // An observer keeps the nodes it watches alive: drop composers that
        // left the page by watching only the ones still on it.
        if ([...watchedEditors].some(editor => !editor.isConnected)) {
            draftText.disconnect();
            for (const editor of watchedEditors) {
                if (editor.isConnected) draftText.observe(editor, { characterData: true, subtree: true });
                else watchedEditors.delete(editor);
            }
        }
        if (discoverDrafts) {
            discoverDrafts = false;
            document.querySelectorAll('[class*="channelTextArea_"] [contenteditable="true"][role="textbox"], [class*="channelTextArea_"] textarea').forEach(editor => {
                if (!watchedEditors.has(editor)) { watchedEditors.add(editor); draftText.observe(editor, { characterData: true, subtree: true }); }
                updateDraft(editor);
            });
        }
    }
    function schedule() { frame ??= requestAnimationFrame(flush); }
    function refresh() {
        if (!extensions.enabled('musicEmbeds')) {
            document.querySelectorAll(ownSelector).forEach(host => host.remove());
            draftText.disconnect(); watchedEditors.clear();
            drafts.clear(); rows.clear(); return;
        }
        // Clear signatures on toggles so enabling after cleanup recreates cards.
        document.querySelectorAll(rowSelector).forEach(row => { rowState.delete(row); rows.add(row); });
        discoverDrafts = true; schedule();
    }
    function input(event) {
        const target = event.target instanceof Element ? event.target : null;
        const editor = target?.closest(editorSelector);
        if (editor?.closest('[class*="channelTextArea_"]') && extensions.enabled('musicEmbeds')) {
            // Let Discord finish the native edit before reading the Slate text.
            queueMicrotask(() => updateDraft(editor));
        }
    }
    document.addEventListener('input', input, true);
    window.addEventListener(extensions.changeEvent, refresh);
    // Slate can rewrite a draft's text nodes without an input event (send,
    // draft restore). Watch text only inside known composers, not the page.
    const draftText = new MutationObserver(() => { discoverDrafts = true; schedule(); });
    const watchedEditors = new Set();
    function domChanged(records) {
        if (!Array.isArray(records)) {
            document.querySelectorAll(rowSelector).forEach(row => rows.add(row));
            discoverDrafts = true; flush(); return;
        }
        for (const record of records) {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (!target || target.closest(ownSelector)) continue;
            const added = [...record.addedNodes].filter(node => node instanceof Element && !node.matches(ownSelector));
            const removed = [...record.removedNodes].filter(node => !(node instanceof Element && node.matches(ownSelector)));
            if (record.type === 'childList' && !added.length && !removed.length) continue;
            const row = target.closest(rowSelector);
            if (row) rows.add(row);
            if (target.closest('[class*="channelTextArea_"]')) discoverDrafts = true;
            for (const node of added) {
                if (node.matches(rowSelector)) rows.add(node);
                node.querySelectorAll(rowSelector).forEach(row => rows.add(row));
                if (node.matches(editorSelector) || node.querySelector(editorSelector)) discoverDrafts = true;
            }
            if (removed.length && drafts.size) discoverDrafts = true;
        }
        // Already inside the shared frame callback: render in this frame.
        if (rows.size || discoverDrafts) flush();
    }
    let stopObserving;
    function observe() {
        const on = extensions.enabled('musicEmbeds');
        if (on && !stopObserving) stopObserving = window.Lowcord.onDomChange(domChanged);
        else if (!on && stopObserving) { stopObserving(); stopObserving = undefined; }
    }
    window.addEventListener(extensions.changeEvent, observe);
    function start() { observe(); refresh(); }
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    window.Lowcord.waitForStore('MessageStore', store => {
        // Store changes cover edits and suppression flags with no DOM change.
        store.addChangeListener?.(() => {
            if (!extensions.enabled('musicEmbeds')) return;
            document.querySelectorAll(rowSelector).forEach(row => rows.add(row));
            schedule();
        });
        refresh();
    });
    window.Lowcord.musicEmbeds = { refresh };
})();
