// Preprocess oversized local attachments before Discord's size validation. The
// native chooser/drop/paste, preview, upload and Send behavior stay in Discord.
(() => {
    const chunkSize = 1024 * 1024, maximumSource = 2 * 1024 ** 3;
    const composerSelector = '[class*="channelTextArea_"]';
    const ignored = new WeakSet();
    let active;
    const extensions = () => window.Lowcord.extensions;
    const channelId = () => window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    const mediaKind = file => /^image\/gif$/i.test(file.type) || /\.gif$/i.test(file.name) ? 'gif'
        : /^video\//i.test(file.type) || /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|ts|mts|m2ts|wmv|flv|ogv)$/i.test(file.name) ? 'video'
        : /^image\/(?:png|apng|jpeg|webp|avif|bmp|tiff)$/i.test(file.type) || /\.(png|apng|jpe?g|webp|avif|bmp|tiff?)$/i.test(file.name) ? 'image' : null;
    function status(batch) {
        const { ui } = extensions();
        const title = ui('strong', {}, 'Preparing media…');
        const detail = ui('span', {}, `Under ${batch.limit / 1_000_000} MB`);
        // Lucide circle + loader-circle (ISC); geometry kept from the library.
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            'stroke-width': '4.5', 'stroke-linecap': 'round', 'aria-hidden': 'true', class: 'lowcord-compression-ring' })) ring.setAttribute(key, value);
        const track = document.createElementNS(ring.namespaceURI, 'circle');
        for (const [key, value] of Object.entries({ cx: '12', cy: '12', r: '10', class: 'lowcord-compression-track' })) track.setAttribute(key, value);
        const arc = document.createElementNS(ring.namespaceURI, 'path');
        arc.setAttribute('d', 'M21 12a9 9 0 1 1-6.219-8.56');
        ring.append(track, arc);
        const button = ui('button', { type: 'button', onClick: () => cancel('Media compression cancelled. Attach the files again when ready.') }, 'Cancel');
        const root = ui('div', { className: 'lowcord-video-compression', role: 'status', 'aria-live': 'polite' },
            ring, ui('div', { className: 'lowcord-compression-copy' }, title, detail), button);
        document.body.append(root);
        const composer = document.querySelector(composerSelector);
        const place = () => {
            const rect = composer?.isConnected && composer.getBoundingClientRect();
            if (!rect || rect.width <= 0) return;
            root.style.setProperty('--lowcord-compression-width', `${rect.width}px`);
            root.style.setProperty('--lowcord-compression-center', `${rect.left + rect.width / 2}px`);
            root.style.bottom = `${Math.max(16, Math.min(window.innerHeight - rect.top + 16, window.innerHeight - root.offsetHeight - 16))}px`;
        };
        const observer = new ResizeObserver(place);
        if (composer) observer.observe(composer);
        window.addEventListener('resize', place);
        place();
        return {
            update(next, text, filename = '') { title.textContent = next; detail.textContent = text; detail.title = text; root.title = filename; },
            end() { observer.disconnect(); window.removeEventListener('resize', place); root.remove(); },
        };
    }
    function targetLimit(id) {
        const channel = window.Lowcord.store('ChannelStore')?.getChannel?.(id);
        // ChannelStore includes threads; unlike SelectedGuildStore this cannot
        // mistake a recently selected server for the current DM.
        if (!channel) return null;
        return channel.guild_id || channel.guildId ? 100_000_000 : 20_000_000;
    }
    async function native(action, ...args) {
        const result = await window.__LOWCORD_NATIVE__.videoCompression(action, ...args);
        if (result?.error) throw Object.assign(new Error(result.error), { code: result.error });
        return result;
    }
    function check(batch) {
        if (batch.cancelled || active !== batch || channelId() !== batch.channel || !extensions()?.enabled('compressVideos'))
            throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    }
    async function compress(file, batch, index, total) {
        check(batch);
        const kind = mediaKind(file), label = kind === 'gif' ? 'GIF' : kind;
        const headline = total === 1 ? `Compressing 1 ${label}` : `Compressing media ${index} of ${total}`;
        const detail = `${kind === 'image' ? 'PNG' : kind === 'gif' ? 'GIF' : 'MP4'} · under ${batch.limit / 1_000_000} MB`;
        batch.status.update(headline, detail, file.name);
        let id;
        try {
            ({ id } = await native('begin', { size: file.size, limit: batch.limit, kind }));
            batch.id = id; check(batch);
            for (let offset = 0; offset < file.size; offset += chunkSize) {
                check(batch);
                const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
                check(batch); await native('append', id, bytes);
            }
            check(batch);
            batch.status.update(headline, detail, file.name);
            const result = await native('finish', id);
            check(batch);
            if (!Number.isSafeInteger(result.size) || result.size < 12 || result.size >= batch.limit) throw new Error('invalid-output');
            const type = result.type || 'video/mp4';
            const extension = { 'video/mp4': 'mp4', 'image/png': 'png', 'image/gif': 'gif' }[type];
            if (kind === 'gif' && type !== 'image/gif') throw new Error('invalid-output');
            if (!extension || result.extension && result.extension !== extension) throw new Error('invalid-output');
            const parts = [];
            for (let offset = 0; offset < result.size; offset += chunkSize) {
                check(batch);
                const bytes = await native('read', id, offset);
                check(batch);
                if (!(bytes instanceof Uint8Array) || bytes.byteLength !== Math.min(chunkSize, result.size - offset)) throw new Error('incomplete-output');
                // Immutable Blob parts keep a full output-sized typed-array
                // buffer off the JS heap and can be shared by the final File.
                parts.push(new Blob([bytes]));
            }
            const name = file.name.replace(/\.[^.]*$/, '') + '.' + extension;
            return new File(parts, name, { type, lastModified: file.lastModified });
        } finally {
            if (id) await native('cancel', id).catch(() => {});
            if (batch.id === id) batch.id = null;
        }
    }
    function cancel(message) {
        const batch = active;
        if (!batch) return;
        batch.cancelled = true;
        batch.status.end();
        batch.unsubscribe?.();
        // Keep the batch busy until its in-flight IPC has settled. No new job
        // races cleanup of this window's previous temporary file.
        if (batch.id) void native('cancel', batch.id).catch(() => {});
        if (message) extensions()?.toast(message, true);
    }
    function errorMessage(error) {
        if (error.code === 'gif-too-large') return 'Couldn’t shrink this GIF below the upload limit. The original GIF was kept.';
        if (error.code === 'too-large') return 'Couldn’t shrink this media below the upload limit. Original files were kept.';
        if (error.code === 'ffmpeg-missing') return 'Install FFmpeg and restart Lowcord to compress media. Original files were kept.';
        if (error.code === 'unsupported-duration') return 'Couldn’t read this video or animation, or it exceeds six hours. Original files were kept.';
        if (error.code === 'encode-timeout') return 'Media compression took too long. Original files were kept.';
        return 'Couldn’t compress this media. Original files were kept; you can retry or choose another file.';
    }
    function intercept(event, files, replay) {
        if (ignored.has(event) || event.defaultPrevented || !extensions()?.enabled('compressVideos') || !window.__LOWCORD_NATIVE__?.videoCompression) return;
        const id = channelId(), limit = targetLimit(id);
        if (!id || !limit || !files.some(file => mediaKind(file) && file.size >= limit)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (active) { active.status.update('Media is still being prepared…', 'Wait or cancel before attaching more files.'); return true; }
        if (files.some(file => mediaKind(file) && file.size > maximumSource)) {
            extensions().toast('Media above 2 GB needs to be reduced first. Original files were kept.', true);
            replay(files); return true;
        }
        const batch = { channel: id, limit, cancelled: false };
        active = batch;
        batch.status = status(batch);
        const store = window.Lowcord.store('SelectedChannelStore');
        const changed = () => { if (channelId() !== id) cancel('Media compression cancelled because you switched chats.'); };
        if (typeof store?.addChangeListener === 'function') {
            store.addChangeListener(changed);
            batch.unsubscribe = () => store.removeChangeListener?.(changed);
        }
        void (async () => {
            try {
                const output = [], count = files.filter(file => mediaKind(file) && file.size >= limit).length;
                let index = 0;
                for (const file of files) output.push(mediaKind(file) && file.size >= limit ? await compress(file, batch, ++index, count) : file);
                check(batch);
                if (replay(output) === false) {
                    extensions().toast('The attachment composer closed. Please attach the files again.', true);
                    return;
                }
                extensions().toast('Media compressed and attached. Review it, then press Send.');
            } catch (error) {
                if (!batch.cancelled && channelId() === id && extensions()?.enabled('compressVideos')) {
                    const attached = replay(files);
                    extensions().toast(attached === false ? 'The attachment composer closed. Please attach the files again.' : errorMessage(error), true);
                }
            } finally {
                batch.status.end(); batch.unsubscribe?.();
                if (active === batch) active = null;
            }
        })();
        return true;
    }
    const transfer = files => {
        const data = new DataTransfer();
        for (const file of files) data.items.add(file);
        return data;
    };
    function dispatch(target, event) {
        ignored.add(event);
        target.dispatchEvent(event);
    }
    window.addEventListener('change', event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.closest(composerSelector) || input.closest('[role="dialog"]')) return;
        const files = [...input.files];
        const intercepted = intercept(event, files, output => {
            if (!input.isConnected) {
                const editor = document.querySelector(`${composerSelector} [contenteditable="true"][role="textbox"], ${composerSelector} textarea`);
                if (!editor) { extensions().toast('The attachment composer closed. Please attach the files again.', true); return; }
                for (const file of output) dispatch(editor, new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer([file]) }));
                return;
            }
            input.files = transfer(output).files;
            dispatch(input, new Event('change', { bubbles: true }));
        });
        if (intercepted) input.value = '';
    }, true);
    window.addEventListener('paste', event => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(composerSelector) || target.closest('[role="dialog"]')) return;
        intercept(event, [...(event.clipboardData?.files ?? [])], files => {
            const editor = target.isConnected ? target : document.querySelector(`${composerSelector} [role="textbox"]`) ?? target;
            // Discord accepts only the first file of a paste; replay one file
            // at a time so a mixed selection cannot silently lose attachments.
            for (const file of files) dispatch(editor, new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer([file]) }));
        });
    }, true);
    window.addEventListener('drop', event => {
        const target = event.target;
        if (!(target instanceof Element) || target.closest('[role="dialog"]') || !document.querySelector(composerSelector)
            || !target.closest(`${composerSelector}, main, [role="main"], [class*="uploadArea_"]`)) return;
        const editorSelector = `${composerSelector} [contenteditable="true"][role="textbox"], ${composerSelector} textarea`;
        const editor = document.querySelector(editorSelector);
        if (!editor) return;
        const intercepted = intercept(event, [...(event.dataTransfer?.files ?? [])], files => {
            const destination = editor.isConnected ? editor : document.querySelector(editorSelector);
            if (!destination) return false;
            // Discord's overlay is a sibling of main and forgets its active
            // drag after one second. An async drop replay would be ignored.
            // Deliver finished files through the native paste path instead.
            for (const file of files) dispatch(destination, new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, composed: true, clipboardData: transfer([file]),
            }));
        });
        if (intercepted) {
            // Let Discord's body-level drop cleanup close its overlay now,
            // without exposing the original oversized files to its uploader.
            dispatch(document.body, new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer([]) }));
        }
    }, true);
    window.addEventListener('keydown', event => {
        if (active && !active.cancelled && event.key === 'Enter' && !event.shiftKey && event.target instanceof Element && event.target.closest(composerSelector)) {
            event.preventDefault(); event.stopImmediatePropagation();
            active.status.update('Media compression is still running…', 'Wait for it to finish, or cancel before sending.');
        }
    }, true);
    window.addEventListener('submit', event => {
        if (active && !active.cancelled && event.target instanceof Element && event.target.querySelector(composerSelector)) {
            event.preventDefault(); event.stopImmediatePropagation();
        }
    }, true);
    window.addEventListener('lowcord-extensions-change', () => {
        if (!extensions()?.enabled('compressVideos')) cancel('Media compression cancelled.');
    });
    window.addEventListener('pagehide', () => cancel());
    window.Lowcord.videoCompression = { ignore: event => ignored.add(event), busy: () => Boolean(active) };
})();
