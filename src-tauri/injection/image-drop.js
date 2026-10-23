// Only fill the URL -> File gap for external browser image drags. Actual file
// drops and the attachment composer remain entirely under Discord's control.
(() => {
    const composerSelector = '[class*="channelTextArea_"]';
    const editorSelector = `${composerSelector} [contenteditable="true"][role="textbox"], ${composerSelector} textarea`;
    const selected = () => window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    const toast = (message, error = false) => window.Lowcord.extensions?.toast(message, error);
    const replayed = new WeakSet();
    let internal = false, active;
    window.addEventListener('dragstart', () => { internal = true; }, true);
    window.addEventListener('dragend', () => { internal = false; }, true);

    function destination(event) {
        const target = event.target;
        if (internal || !(target instanceof Element) || target.closest('[role="dialog"]')
            || !target.closest(`${composerSelector}, main, [role="main"], [class*="uploadArea_"]`)) return null;
        return document.querySelector(editorSelector);
    }
    function source(data) {
        const uri = data.getData('text/uri-list').split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'))?.trim();
        const html = data.getData('text/html');
        if (html.length > 256 * 1024) return null;
        let value = uri;
        if (html) {
            const template = document.createElement('template');
            template.innerHTML = html;
            const image = template.content.querySelector('img[src]');
            // A browser link also supplies uri-list. Only an image should turn
            // into an attachment; prefer its src over an enclosing link's URL.
            if (!image) return null;
            value = image.getAttribute('src');
            try { value = new URL(value, template.content.querySelector('base[href]')?.getAttribute('href') || uri).href; } catch { return null; }
        }
        if (!value || value.length > 16384) return null;
        try {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
        } catch { return null; }
    }
    window.addEventListener('dragover', event => {
        const types = event.dataTransfer?.types ?? [];
        if (types.includes('Files') || !types.some(type => type === 'text/uri-list' || type === 'text/html')
            || !destination(event)) return;
        // Drag data is protected until drop. Opt into receiving it, then decide
        // whether it is an image once the browser exposes the actual payload.
        event.preventDefault();
        // Discord's body-level UploadArea rejects uri-list drags by resetting
        // effectAllowed/dropEffect to none. Keep this accepted external drag
        // from reaching that handler, otherwise Chromium never emits drop.
        event.stopImmediatePropagation();
        event.dataTransfer.dropEffect = 'copy';
    }, true);
    window.addEventListener('drop', event => {
        if (replayed.has(event) || event.defaultPrevented || !window.__LOWCORD_NATIVE__?.downloadDroppedImage || event.dataTransfer?.files.length) return;
        const editor = destination(event), channel = selected();
        if (!editor || !channel || !event.dataTransfer) return;
        const url = source(event.dataTransfer);
        if (!url) return;
        // URI-only drags can also be ordinary links. If the resource is not an
        // image, return the original string payload to Discord's drop handler.
        const strings = [...event.dataTransfer.types].map(type => [type, event.dataTransfer.getData(type)]);
        const explicitImage = Boolean(event.dataTransfer.getData('text/html'));
        const originalTarget = event.target;
        const replayLink = () => {
            const data = new DataTransfer();
            for (const [type, value] of strings) data.setData(type, value);
            const replay = new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: data,
                clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey });
            replayed.add(replay);
            (originalTarget.isConnected ? originalTarget : editor).dispatchEvent(replay);
        };
        event.preventDefault(); event.stopImmediatePropagation();
        // The asynchronous result uses paste; allow native drop cleanup to
        // remove Discord's overlay without inserting the original URL.
        document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
        if (active) { toast('An image is still downloading. Please wait before dropping another.', true); return; }
        const job = { cancelled: false };
        active = job;
        const store = window.Lowcord.store('SelectedChannelStore');
        const changed = () => { if (selected() !== channel) job.cancelled = true; };
        store?.addChangeListener?.(changed);
        toast('Downloading image…');
        void (async () => {
            try {
                const result = await window.__LOWCORD_NATIVE__.downloadDroppedImage(url);
                if (job.cancelled || selected() !== channel) { toast('Image was not attached because you switched chats.', true); return; }
                if (result?.error) {
                    if (result.error === 'not-image' && !explicitImage) { replayLink(); return; }
                    toast(result.error === 'too-large' ? 'This image exceeds the 50 MB download limit.'
                        : 'Couldn’t download that image. Try saving it in your browser, then attach the file.', true);
                    return;
                }
                if (!editor.isConnected || document.querySelector(editorSelector) !== editor) {
                    toast('The message composer closed. Please drop the image again.', true); return;
                }
                const data = new DataTransfer();
                data.items.add(new File([result.data], result.name, { type: result.type }));
                editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: data }));
            } catch {
                toast('Couldn’t attach that image. Try saving it in your browser, then attach the file.', true);
            } finally {
                store?.removeChangeListener?.(changed);
                if (active === job) active = null;
            }
        })();
    }, true);
    window.Lowcord.imageDrop = { busy: () => Boolean(active) };
})();
