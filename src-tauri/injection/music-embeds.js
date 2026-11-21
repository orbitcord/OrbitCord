// Official players for music links. Observe only changed rows and composers;
// Discord owns sending, uploads, link permissions and native embed rendering.
(() => {
    const { musicLinks, socialLinks, extensions } = window.Lowcord;
    const rowSelector = '[id^="chat-messages-"]';
    const rowIdPattern = /^chat-messages-(\d+)-(\d+)$/;
    const musicHint = /spotify\.com|apple\.com/i;
    const editorSelector = '[contenteditable="true"][role="textbox"], textarea';
    const ownSelector = '.lowcord-music-embeds, .lowcord-music-draft';
    const rows = new Set(), drafts = new Map(), rowState = new WeakMap(), trackedRows = new Map();
    let frame, discoverDrafts = true, storeDirty = false, messageStore = null;

    function trackRow(row) {
        let entry = trackedRows.get(row);
        const id = row.id;
        if (entry) {
            if (entry.id !== id) {
                const match = rowIdPattern.exec(id);
                entry.id = id; entry.ch = match ? match[1] : null; entry.mid = match ? match[2] : null;
            }
            return entry;
        }
        const match = rowIdPattern.exec(id);
        entry = { id, ch: match ? match[1] : null, mid: match ? match[2] : null,
            msg: undefined, content: undefined, flags: undefined, embeds: undefined, embedsLen: undefined, hasSeen: false };
        trackedRows.set(row, entry);
        return entry;
    }
    function syncTrackedRows() {
        const list = document.querySelectorAll(rowSelector);
        for (let i = 0; i < list.length; i++) trackRow(list[i]);
        for (const row of trackedRows.keys()) if (!row.isConnected) trackedRows.delete(row);
    }
    function directEmbedHost(surface) {
        for (let child = surface.firstElementChild; child; child = child.nextElementSibling) {
            if (child.classList.contains('lowcord-music-embeds')) return child;
        }
        return null;
    }

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
        if (!row.isConnected) { trackedRows.delete(row); return; }
        const entry = trackRow(row);
        if (!entry.ch || !entry.mid) return;
        const surface = row.querySelector(':scope > [data-list-item-id^="chat-messages"]') ?? row.firstElementChild;
        const body = row.querySelector('[id^="message-content-"]');
        if (!surface || !body) return;
        const store = messageStore ?? window.Lowcord.store('MessageStore');
        const message = typeof store?.getMessage === 'function' ? store.getMessage(entry.ch, entry.mid) : null;
        // Record the message state we just reconciled so the next MessageStore
        // emit skips unchanged rows with zero allocations.
        entry.msg = message; entry.content = message?.content; entry.flags = message?.flags;
        entry.embeds = message?.embeds; entry.embedsLen = message?.embeds?.length; entry.hasSeen = true;
        // Render from the actual message markdown, not flattened DOM text:
        // Discord removes code fences and <suppressed-link> syntax in its DOM.
        if (!message || typeof message.content !== 'string') {
            directEmbedHost(surface)?.remove();
            rowState.delete(row); return;
        }
        const content = message.content;
        const suppressed = Boolean((message?.flags ?? 0) & 4);
        const prior = rowState.get(row);
        if (suppressed || !musicHint.test(content)) {
            if (prior?.host || directEmbedHost(surface)) {
                (prior?.host ?? directEmbedHost(surface))?.remove();
            }
            rowState.set(row, { signature: 'none', host: null });
            return;
        }
        const iframes = surface.querySelectorAll('iframe[src]:not([data-lowcord-music-player])');
        let native = null, nativeSig = '';
        if (iframes.length) {
            native = new Set();
            for (let i = 0; i < iframes.length; i++) {
                const key = musicLinks.parse(iframes[i].src)?.key;
                if (key) native.add(key);
            }
            if (native.size) nativeSig = [...native].join(',');
        }
        const signature = `${suppressed}:${content}:${nativeSig}`;
        if (prior?.signature === signature && (!prior.host || prior.host.isConnected)) return;
        const collected = musicLinks.collect(content, socialLinks.mapUrls);
        const items = native?.size ? collected.filter(item => !native.has(item.key)) : collected;
        let host = directEmbedHost(surface);
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
        const raw = editor.value ?? editor.textContent;
        const key = editor.value !== undefined ? raw : `${editor.childElementCount}:${raw}`;
        if (prior?.key === key && (!prior.host || prior.host.isConnected)) return;
        // Drafts without a Spotify or Apple Music URL never need innerText layout.
        if (!musicHint.test(raw)) {
            if (prior?.host) prior.host.remove();
            drafts.set(editor, { key, content: raw, host: null });
            return;
        }
        // An empty draft (most channel switches) has no links to lay out.
        const content = editor.value ?? (/[^\s\u200b\ufeff]/.test(raw) ? editor.innerText : '');
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
        if (!extensions.enabled('musicEmbeds')) { rows.clear(); storeDirty = false; return; }
        if (storeDirty && messageStore) {
            storeDirty = false;
            const getMessage = messageStore.getMessage;
            if (typeof getMessage === 'function') {
                for (const [row, entry] of trackedRows) {
                    if (!row.isConnected) { trackedRows.delete(row); continue; }
                    if (row.id !== entry.id) trackRow(row);
                    const message = entry.ch && entry.mid ? getMessage.call(messageStore, entry.ch, entry.mid) : undefined;
                    if (entry.hasSeen && entry.msg === message && entry.content === message?.content
                        && entry.flags === message?.flags && entry.embeds === message?.embeds
                        && entry.embedsLen === message?.embeds?.length) continue;
                    entry.msg = message; entry.content = message?.content; entry.flags = message?.flags;
                    entry.embeds = message?.embeds; entry.embedsLen = message?.embeds?.length; entry.hasSeen = true;
                    rows.add(row);
                }
            }
        }
        for (const row of rows) updateRow(row);
        rows.clear();
        for (const [editor, state] of drafts) {
            if (!editor.isConnected) { state.host?.remove(); drafts.delete(editor); }
        }
        // An observer keeps the nodes it watches alive: drop composers that
        // left the page by watching only the ones still on it.
        let staleEditor = false;
        for (const editor of watchedEditors) if (!editor.isConnected) { staleEditor = true; break; }
        if (staleEditor) {
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
            drafts.clear(); rows.clear(); trackedRows.clear(); storeDirty = false; return;
        }
        // Clear signatures on toggles so enabling after cleanup recreates cards.
        trackedRows.clear();
        const list = document.querySelectorAll(rowSelector);
        for (let i = 0; i < list.length; i++) {
            const row = list[i];
            trackRow(row); rowState.delete(row); rows.add(row);
        }
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
            syncTrackedRows();
            for (const row of trackedRows.keys()) rows.add(row);
            discoverDrafts = true; flush(); return;
        }
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (!target || target.closest(ownSelector)) continue;
            let hasAdded = false, hasRemoved = false;
            if (record.type === 'childList') {
                const added = record.addedNodes, removed = record.removedNodes;
                for (let j = 0; j < added.length; j++) {
                    const node = added[j];
                    if (node instanceof Element && !node.matches(ownSelector)) {
                        hasAdded = true;
                        if (node.matches(rowSelector)) { trackRow(node); rows.add(node); }
                        if (node.childElementCount > 0) {
                            const nested = node.querySelectorAll(rowSelector);
                            for (let k = 0; k < nested.length; k++) { trackRow(nested[k]); rows.add(nested[k]); }
                            if (!discoverDrafts && node.querySelector(editorSelector)) discoverDrafts = true;
                        }
                        if (!discoverDrafts && node.matches(editorSelector)) discoverDrafts = true;
                    }
                }
                for (let j = 0; j < removed.length; j++) {
                    const node = removed[j];
                    if (!(node instanceof Element && node.matches(ownSelector))) {
                        hasRemoved = true;
                        if (node instanceof Element) {
                            if (trackedRows.has(node)) trackedRows.delete(node);
                            if (node.childElementCount > 0) {
                                const nested = node.querySelectorAll(rowSelector);
                                for (let k = 0; k < nested.length; k++) trackedRows.delete(nested[k]);
                            }
                        }
                    }
                }
                if (!hasAdded && !hasRemoved) continue;
            }
            const row = target.closest(rowSelector);
            if (row) { trackRow(row); rows.add(row); }
            if (!discoverDrafts && target.closest('[class*="channelTextArea_"]')) discoverDrafts = true;
            if (hasRemoved && drafts.size) discoverDrafts = true;
        }
        // Already inside the shared frame callback: render in this frame.
        if (rows.size || discoverDrafts || storeDirty) flush();
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
        messageStore = store;
        // Store changes cover edits and suppression flags with no DOM change.
        // Most notifications are for messages in other channels: coalesce to
        // one per-frame pass over tracked rows without DOM queries or arrays.
        store.addChangeListener?.(() => {
            if (!extensions.enabled('musicEmbeds')) return;
            storeDirty = true;
            schedule();
        });
        refresh();
    });
    window.Lowcord.musicEmbeds = { refresh };
})();
