// Privacy controls use native Discord flows. No Discord module is rewritten.
(() => {
    const core = window.LowcordPrivacyCore;
    if (!core || !window.Lowcord || window.Lowcord.privacy) return;
    const storage = window.Lowcord.storage;
    const key = 'lowcord.privacy.v1', eventName = 'lowcord-privacy-change';
    const composerSelector = '[class*="channelTextArea_"]';
    const editorSelector = `${composerSelector} [contenteditable="true"][role="textbox"], ${composerSelector} textarea`;
    const defaults = { metadata: true, inspector: true, walkAway: true, coverAsk: false, appLock: false, lockAfter: 5 };
    const lockDelays = [0, 1, 5, 15];
    const read = (name, fallback) => { try { return JSON.parse(storage.getItem(name)) ?? fallback; } catch { return fallback; } };
    // Only known boolean preferences; retired keys in old saves are dropped.
    const saved = read(key, {});
    const valid = (name, value) => name === 'lockAfter' ? lockDelays.includes(value) : typeof defaults[name] === 'boolean' && typeof value === 'boolean';
    let state = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, valid(name, saved?.[name]) ? saved[name] : value]));
    let queue, queueTimer, account, lastInspection;
    const reportKey = 'lowcord.privacy.report.v1';
    const report = new core.PrivacyReport({ load: () => read(reportKey, null), save: value => storage.setItem(reportKey, JSON.stringify(value)) });
    window.addEventListener('pagehide', () => report.flush());
    const changed = () => window.dispatchEvent(new Event(eventName));
    const toast = (text, error = false, duration) => window.Lowcord.extensions?.toast(text, error, null, duration);
    const currentUser = () => window.Lowcord.store('UserStore')?.getCurrentUser?.()?.id;
    const channelId = () => window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    function set(patch) {
        const next = { ...state };
        for (const [name, value] of Object.entries(patch)) if (valid(name, value)) next[name] = value;
        // App lock needs a passcode to fall back on.
        if (next.appLock && !passcode) next.appLock = false;
        storage.setItem(key, JSON.stringify(next)); state = next;
        if (!state.appLock) hideLock(); else armIdleLock();
        syncNative(); changed();
    }
    function syncNative() {
        window.__LOWCORD_NATIVE__?.privacyPreferences?.({ inspector: state.inspector })
            ?.catch(() => toast('Could not apply native privacy preferences.', true));
    }
    // Readable chat name for rule labels and the expiry picker.
    function chatName(channel) {
        if (!channel) return 'Unknown chat';
        if (channel.name) return channel.guild_id ? `#${channel.name}` : channel.name;
        const users = window.Lowcord.store('UserStore');
        const names = (channel.recipients ?? []).map(id => users?.getUser?.(id)).map(user => user?.globalName || user?.username).filter(Boolean);
        return names.length ? names.slice(0, 3).join(', ') : 'Direct message';
    }

    // ----- App lock: a passcode (and Touch ID where available) over Discord ----
    // Only a PBKDF2-SHA256 hash of the passcode is stored, never the passcode.
    const lockKey = 'lowcord.privacy.lock.v1';
    let passcode = read(lockKey, null);
    if (!(typeof passcode?.salt === 'string' && typeof passcode?.hash === 'string')) passcode = null;
    const bytesToText = bytes => btoa(String.fromCharCode(...bytes)), textToBytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const passcodeValid = code => /^\d{4,8}$/.test(code);
    async function derive(code, salt) {
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
        return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, material, 256));
    }
    async function setPasscode(code) {
        if (!passcodeValid(code)) throw new Error('Use 4 to 8 digits.');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        passcode = { v: 1, salt: bytesToText(salt), hash: bytesToText(await derive(code, salt)) };
        storage.setItem(lockKey, JSON.stringify(passcode));
        changed();
    }
    function clearPasscode() { passcode = null; storage.setItem(lockKey, 'null'); }
    async function checkPasscode(code) {
        if (!passcode || !passcodeValid(code)) return false;
        const hash = await derive(code, textToBytes(passcode.salt)), expected = textToBytes(passcode.hash);
        let diff = hash.length ^ expected.length;
        for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
        return diff === 0;
    }
    const touchAvailable = async () => { try { return Boolean(await window.__LOWCORD_NATIVE__?.touchIdAvailable?.()); } catch { return false; } };
    async function touchVerify(reason) {
        try { return (await window.__LOWCORD_NATIVE__?.touchId?.(reason))?.ok === true; } catch { return false; }
    }

    // Wrong-guess throttle: 5 misses, then 30 seconds.
    let misses = 0, blockedUntil = 0, lockEl = null, lockReturnFocus = null, idleTimer = 0, awaySince = 0, lockBusy = false;
    const svgIcon = (paths, size = 24) => {
        const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
        for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
            'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
        for (const d of paths) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
        return svg;
    };
    const lockPaths = ['M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z', 'M8 11V8a4 4 0 0 1 8 0v3'];
    const fingerPaths = ['M12 11v3a6 6 0 0 1-1 3', 'M8 14a4 4 0 0 1 8 0c0 2-.5 4-1.5 5.5', 'M5 13a7 7 0 0 1 14 0c0 2-.3 3.5-.8 5', 'M7 6.5A8 8 0 0 1 12 5a8 8 0 0 1 5 1.5'];
    const setInert = value => { if (document.body) document.body.inert = value; };
    function unlock() {
        if (!lockEl) return;
        lockEl.remove(); lockEl = null; misses = 0; setInert(false);
        window.removeEventListener('keydown', trapKeys, true); window.removeEventListener('keyup', trapKeys, true); window.removeEventListener('keypress', trapKeys, true);
        const previous = lockReturnFocus; lockReturnFocus = null;
        if (previous?.isConnected) try { previous.focus({ preventScroll: true }); } catch {}
        changed();
    }
    const hideLock = unlock;
    function trapKeys(event) {
        if (!lockEl) return;
        if (event.target instanceof Node && lockEl.contains(event.target)) {
            // Keep typed digits and shortcuts away from Discord's own listeners.
            if (event.key !== 'Tab') event.stopPropagation();
            else if (event.type === 'keydown') {
                const items = [...lockEl.querySelectorAll('button:not([disabled]), input:not([disabled])')].filter(item => !item.closest('[hidden]'));
                if (!items.length) { event.preventDefault(); return; }
                const first = items[0], last = items[items.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
            return;
        }
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === 'keydown') [...lockEl.querySelectorAll('input:not([disabled]), button:not([disabled])')].find(item => !item.closest('[hidden]'))?.focus();
    }
    // Discord's own logout action; false (and the lock stays) if it cannot be found.
    function logOut() {
        let actions = null;
        try { actions = window.Lowcord.find?.(window.Lowcord.filters?.byProps?.('logout')); } catch {}
        if (typeof actions?.logout !== 'function') return false;
        clearPasscode(); set({ appLock: false }); unlock();
        try { actions.logout(); } catch { toast('Couldn\u2019t log out. Try Log out in Discord settings.', true); }
        return true;
    }
    function lock() {
        if (lockEl || !state.appLock || !passcode) return;
        lockReturnFocus = document.activeElement;
        const el = document.createElement('div');
        el.className = 'lowcord-lock'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'lowcord-lock-title');
        // Inline so the cover holds before the stylesheet has loaded.
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:var(--background-primary,#313338);color:var(--text-normal,#f2f3f5)';
        const card = document.createElement('form'); card.className = 'lowcord-lock-card'; card.noValidate = true;
        const mark = document.createElement('span'); mark.className = 'lowcord-lock-mark'; mark.append(svgIcon(lockPaths, 28));
        const title = document.createElement('h2'); title.id = 'lowcord-lock-title'; title.textContent = 'Lowcord is locked';
        const hint = document.createElement('p'); hint.className = 'lowcord-lock-hint'; hint.textContent = 'Enter your passcode to continue.';
        const touch = document.createElement('button'); touch.type = 'button'; touch.className = 'lowcord-lock-touch'; touch.hidden = true;
        touch.append(svgIcon(fingerPaths, 18), document.createTextNode('Unlock with Touch ID'));
        const input = document.createElement('input'); input.type = 'password'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.maxLength = 8;
        input.className = 'lowcord-lock-input'; input.setAttribute('aria-label', 'Passcode'); input.setAttribute('aria-describedby', 'lowcord-lock-message');
        const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'lowcord-lock-submit'; submit.textContent = 'Unlock';
        const message = document.createElement('p'); message.id = 'lowcord-lock-message'; message.className = 'lowcord-lock-message'; message.setAttribute('role', 'alert');
        const forgot = document.createElement('button'); forgot.type = 'button'; forgot.className = 'lowcord-lock-forgot'; forgot.textContent = 'Forgot passcode?';
        const main = document.createElement('div'); main.className = 'lowcord-lock-main'; main.append(hint, touch, input, submit, message, forgot);
        // Recovery: removing the lock requires logging out of Discord.
        const recover = document.createElement('div'); recover.className = 'lowcord-lock-main'; recover.hidden = true;
        const recoverText = document.createElement('p'); recoverText.className = 'lowcord-lock-hint'; recoverText.textContent = 'Log out of Discord to remove the lock. You\u2019ll sign in again with your Discord account.';
        const recoverMessage = document.createElement('p'); recoverMessage.className = 'lowcord-lock-message'; recoverMessage.setAttribute('role', 'alert');
        const logoutButton = document.createElement('button'); logoutButton.type = 'button'; logoutButton.className = 'lowcord-lock-danger'; logoutButton.textContent = 'Log out';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'lowcord-lock-submit'; cancel.textContent = 'Cancel';
        recover.append(recoverText, logoutButton, cancel, recoverMessage);
        forgot.addEventListener('click', () => { main.hidden = true; recover.hidden = false; recoverMessage.textContent = ''; logoutButton.focus(); });
        cancel.addEventListener('click', () => { recover.hidden = true; main.hidden = false; input.focus(); });
        logoutButton.addEventListener('click', () => {
            if (!logOut()) { recoverMessage.textContent = 'Couldn\u2019t log out, so quit Lowcord and try again.'; return; }
        });
        card.append(mark, title, main, recover); el.append(card);
        let timer = 0;
        const show = text => { message.textContent = text; };
        const refreshBlock = () => {
            clearTimeout(timer);
            const left = Math.ceil((blockedUntil - Date.now()) / 1000);
            if (left > 0) { input.disabled = submit.disabled = true; show(`Too many tries. Try again in ${left}s.`); timer = setTimeout(refreshBlock, 1000); return; }
            if (input.disabled) { input.disabled = submit.disabled = false; show(''); input.focus(); }
        };
        const tryTouch = async () => {
            if (lockBusy || !lockEl) return; lockBusy = true; touch.disabled = true;
            try { if (await touchVerify('Unlock Lowcord')) { clearTimeout(timer); unlock(); } else input.focus(); }
            finally { lockBusy = false; touch.disabled = false; }
        };
        touch.addEventListener('click', tryTouch);
        card.addEventListener('submit', async event => {
            event.preventDefault();
            if (Date.now() < blockedUntil || !input.value) return;
            const code = input.value; submit.disabled = true;
            const ok = await checkPasscode(code); submit.disabled = false;
            if (ok) { clearTimeout(timer); unlock(); return; }
            input.value = ''; misses++;
            card.classList.remove('is-shaking'); void card.offsetWidth; card.classList.add('is-shaking');
            if (misses >= 5) { misses = 0; blockedUntil = Date.now() + 30000; refreshBlock(); }
            else { show('Wrong passcode'); input.focus(); }
        });
        lockEl = el; document.documentElement.append(el); setInert(true);
        window.addEventListener('keydown', trapKeys, true); window.addEventListener('keyup', trapKeys, true); window.addEventListener('keypress', trapKeys, true);
        if (document.activeElement && document.activeElement !== document.body) try { document.activeElement.blur(); } catch {}
        refreshBlock();
        if (!input.disabled) input.focus();
        // Auto-prompt once; the button stays for another try.
        touchAvailable().then(available => { if (available && lockEl === el) { touch.hidden = false; if (!input.disabled) tryTouch(); } });
        changed();
    }
    // Lock again after being away from the window (blurred or hidden) for the chosen time.
    function armIdleLock() {
        clearTimeout(idleTimer);
        if (!state.appLock || !state.lockAfter || !awaySince) return;
        idleTimer = setTimeout(lock, Math.max(0, awaySince + state.lockAfter * 60000 - Date.now()));
    }
    function leave() { if (!awaySince) { awaySince = Date.now(); armIdleLock(); } }
    function back() {
        clearTimeout(idleTimer);
        // Timers can stall during sleep, so compare the clock too.
        if (awaySince && state.appLock && state.lockAfter && Date.now() - awaySince >= state.lockAfter * 60000) lock();
        awaySince = 0;
    }
    window.addEventListener('blur', leave); window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', () => document.hidden ? leave() : back());
    // Cover Discord before it paints anything, on every start.
    if (state.appLock && passcode) {
        lock();
        if (!document.body) document.addEventListener('DOMContentLoaded', () => { if (lockEl) setInert(true); }, { once: true });
    }

    // ----- Local metadata preparation before native upload staging ------------
    const replayed = new WeakSet(), prepared = new WeakSet(); let preparing = false, delivering = false, bypassCover = false;
    const supportedImage = file => /\.(?:jpe?g|png|apng|webp|gif)$/i.test(file.name) || /^image\/(?:jpeg|png|apng|webp|gif)$/.test(file.type);
    // MP4, MOV and HEIF. Anything else, including WebM, uploads unchanged.
    const boxImage = file => /\.(?:heic|heif|avif)$/i.test(file.name) || /^image\/(?:heic|heif|avif)$/.test(file.type);
    const boxMedia = file => boxImage(file) || /\.(?:mp4|m4v|mov|3gp)$/i.test(file.name) || /^video\/(?:mp4|quicktime|3gpp)$/.test(file.type);
    async function cleanBoxMedia(file) {
        const media = window.LowcordPrivacyMedia;
        const patches = await media.plan(async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), file.size);
        if (!patches) return null;
        return new File([media.apply(file, patches)], file.name, { type: file.type, lastModified: 0 });
    }
    const counted = (amount, name) => `${amount} ${name}${amount === 1 ? '' : 's'}`;
    const transfer = files => { const data = new DataTransfer(); for (const file of files) data.items.add(file); return data; };
    function dispatch(target, event) { replayed.add(event); target.dispatchEvent(event); }
    function preprocess(event, files, replay) {
        // Other hooks (anonymous file names) replay our cleaned files as new File
        // objects while we deliver them; those events must pass straight through.
        const cover = state.coverAsk && !bypassCover ? window.Lowcord.imageCover : null;
        if (delivering || replayed.has(event) || event.defaultPrevented || !state.metadata && !cover || !window.__LOWCORD_NATIVE__?.sanitizeImage) return;
        const cleanable = file => state.metadata && (supportedImage(file) || boxMedia(file));
        if (!files.some(file => !prepared.has(file) && (cleanable(file) || cover?.supports(file)))) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (preparing) { toast('Wait for the current images to finish preparing.', true); return true; }
        preparing = true;
        const channel = channelId();
        void (async () => {
            const output = [], off = ' To attach it unchanged, turn off Remove media metadata in Privacy & Security.';
            let images = 0, videos = 0;
            try {
                for (let file of files) {
                    if (prepared.has(file)) { output.push(file); continue; }
                    if (cover?.supports(file)) {
                        file = await cover.review(file);
                        if (!file) continue;
                    }
                    if (!cleanable(file)) { output.push(file); continue; }
                    if (boxMedia(file)) {
                        // Never imply other formats (WebM, documents) were cleaned.
                        let clean;
                        try { clean = await cleanBoxMedia(file); }
                        catch { throw new Error(`Could not safely remove metadata from ${file.name}. No files were attached.${off}`); }
                        if (!clean) { output.push(file); continue; }
                        prepared.add(clean); output.push(clean);
                        if (boxImage(file)) images++; else videos++;
                        continue;
                    }
                    if (file.size > 64 * 1024 * 1024) throw new Error(`${file.name} is larger than 64 MiB, the limit for metadata removal. No files were attached.${off}`);
                    const result = await window.__LOWCORD_NATIVE__.sanitizeImage(new Uint8Array(await file.arrayBuffer()));
                    if (result?.status !== 'processed' || !(result.bytes instanceof Uint8Array)) throw new Error(`${file.name}: ${result?.reason || 'Could not remove image metadata.'} No files were attached.${off}`);
                    const clean = new File([result.bytes], file.name, { type: result.type, lastModified: 0 });
                    prepared.add(clean); output.push(clean); images++;
                }
                if (!output.length) return;
                if (channelId() !== channel) throw new Error('Chat changed. Attach the images again in the intended chat.');
                delivering = true;
                try { if (replay(output) === false) throw new Error('The message box closed. Attach the images again.'); }
                finally { delivering = false; }
                if (images) report.add('images', images);
                if (videos) report.add('videos', videos);
                if (images || videos) toast(`Metadata removed from ${[images && counted(images, 'image'), videos && counted(videos, 'video')].filter(Boolean).join(' and ')}.`, false, 1800);
            } catch (error) { toast(error.message, true); }
            finally { preparing = false; }
        })(); return true;
    }
    // Cover image details hands its result back through the normal paste path,
    // so metadata removal and anonymous names still run. It was already reviewed.
    function attach(files) {
        const editor = document.querySelector(editorSelector);
        if (!editor) return false;
        bypassCover = true;
        try { for (const file of files) editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer([file]) })); }
        finally { bypassCover = false; }
        return true;
    }
    window.addEventListener('change', event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.closest(composerSelector) || input.closest('[role="dialog"]')) return;
        if (preprocess(event, [...input.files], files => {
            if (!input.isConnected) return false;
            input.files = transfer(files).files; dispatch(input, new Event('change', { bubbles: true }));
        })) input.value = '';
    }, true);
    window.addEventListener('paste', event => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest(composerSelector) || target.closest('[role="dialog"]')) return;
        preprocess(event, [...(event.clipboardData?.files ?? [])], files => {
            const editor = target.isConnected ? target : document.querySelector(editorSelector);
            if (!editor) return false;
            for (const file of files) dispatch(editor, new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer([file]) }));
        });
    }, true);
    window.addEventListener('drop', event => {
        const target = event.target;
        if (!(target instanceof Element) || target.closest('[role="dialog"]') || !document.querySelector(editorSelector)
            || !target.closest(`${composerSelector}, main, [role="main"], [class*="uploadArea_"]`)) return;
        if (preprocess(event, [...(event.dataTransfer?.files ?? [])], files => {
            const editor = document.querySelector(editorSelector); if (!editor) return false;
            for (const file of files) dispatch(editor, new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer([file]) }));
        })) dispatch(document.body, new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer([]) }));
    }, true);
    window.addEventListener('keydown', event => {
        if (preparing && event.key === 'Enter' && !event.shiftKey && event.target instanceof Element && event.target.closest(composerSelector)) {
            event.preventDefault(); event.stopImmediatePropagation(); toast('Images are still being prepared.');
        }
    }, true);

    // ----- Own-message expiry, scoped to the signed-in user -------------------
    function scheduleExpiry() {
        clearTimeout(queueTimer);
        if (!queue || !queue.state.rules.length) return;
        queueTimer = setTimeout(async () => {
            // Runs while minimized to the tray too; one request per wake at most.
            if (currentUser() !== account || navigator.onLine === false) { scheduleExpiry(); return; }
            try { await queue.tick(); } catch { toast('Could not save expiry progress. Cleanup is paused.', true); return; }
            scheduleExpiry();
        }, queue.nextDelay());
    }
    function attachAccount() {
        const owner = currentUser(); if (!/^\d{1,24}$/.test(owner ?? '') || owner === account) return;
        clearTimeout(queueTimer); account = owner;
        const storageKey = `lowcord.expiry.${owner}`;
        queue = new core.ExpiryQueue({ owner, load: () => read(storageKey, null),
            save: value => storage.setItem(storageKey, JSON.stringify(value)), changed: () => { changed(); scheduleExpiry(); },
            remove: async (message, author, rule) => {
                if (currentUser() !== author) throw Object.assign(new Error('Account changed'), { code: 'ownership' });
                const api = window.Lowcord.RestAPI;
                if (!api?.get || !api?.del || !api?.patch) throw new Error('Discord is not ready');
                // GET /messages/:id is bot-only; user clients read one message
                // through history around it, as Discord's own jump does.
                const response = await api.get({ url: `/channels/${message.channel}/messages`, query: { around: message.id, limit: 1 }, retries: 0 });
                const found = Array.isArray(response.body) ? response.body.find(item => item?.id === message.id) : null;
                if (!found) throw Object.assign(new Error('Message no longer exists'), { status: 404 });
                if (currentUser() !== author || found.author?.id !== author || message.preserved || !rule
                    || !queue.state.rules.some(item => item.id === message.rule)) throw Object.assign(new Error('Ownership changed'), { code: 'ownership' });
                const url = `/channels/${message.channel}/messages/${message.id}`;
                // Attachment rules remove only the files; text stays. A message
                // with nothing but attachments has nothing left, so it is deleted.
                if (rule.attachmentsOnly && found.content?.trim()) {
                    if (found.attachments?.length) await api.patch({ url, body: { attachments: [] }, retries: 0 });
                } else await api.del({ url, retries: 0 });
                report.add('expired');
            } });
        scheduleExpiry(); changed();
    }
    window.Lowcord.waitFor(window.Lowcord.filters.byProps('dispatch', 'subscribe', 'unsubscribe'), dispatcher => {
        dispatcher.subscribe('MESSAGE_CREATE', event => {
            if (!queue || event.optimistic || event.message?.state === 'SENDING') return;
            try { queue.observe({ ...event.message, guild_id: event.message?.guild_id ?? window.Lowcord.store('ChannelStore')?.getChannel?.(event.message?.channel_id)?.guild_id }); }
            catch (error) { toast(error.message, true); }
        });
    });
    window.addEventListener('online', scheduleExpiry);

    // ----- Walk-away protection: mute and stop sharing when the computer locks --
    let walkedAway = null;
    function protectVoice() {
        const store = window.Lowcord.store, media = store('MediaEngineStore'), streaming = store('ApplicationStreamingStore');
        const stream = () => streaming?.getCurrentUserActiveStream?.();
        const inCall = () => Boolean(store('SelectedChannelStore')?.getVoiceChannelId?.());
        if (!inCall() && !stream()) return;
        const actions = window.Lowcord.find(window.Lowcord.filters.byProps('toggleSelfMute', 'setVideoEnabled'));
        const done = new Set(walkedAway?.done), attempts = [];
        const attempt = (label, needed, stop) => { if (!needed()) return; try { stop(); } catch {} attempts.push([label, needed]); };
        attempt('microphone muted', () => inCall() && media?.isSelfMute?.() === false, () => actions.toggleSelfMute({ playSoundEffect: false, location: 'Walk-away protection' }));
        attempt('camera turned off', () => media?.isVideoEnabled?.() === true, () => actions.setVideoEnabled(false));
        attempt('screen share stopped', () => Boolean(stream()), () => {
            // The same two steps as Discord's stop-streaming button.
            const { streamType, guildId, channelId: channel, ownerId } = stream();
            const streamKey = (streamType === 'call' ? [streamType, channel, ownerId] : [streamType, guildId, channel, ownerId]).join(':');
            window.Lowcord.Dispatcher.dispatch({ type: 'STREAM_CLOSE', streamKey, canShowFeedback: false });
            window.Lowcord.Dispatcher.dispatch({ type: 'STREAM_STOP', streamKey, appContext: 'APP' });
        });
        // Say what actually happened: Discord's stores report the result.
        setTimeout(() => {
            const failed = attempts.filter(([, needed]) => needed()).map(([label]) => label);
            for (const [label, needed] of attempts) if (!needed()) done.add(label);
            walkedAway = { done: [...done], failed };
            if (attempts.length) report.add('walkAway');
        }, 250);
    }
    function walkAwayChanged(value) {
        if (value === 'away') { lock(); if (state.walkAway) protectVoice(); return; }
        const summary = walkedAway;
        if (!summary) return;
        walkedAway = null;
        const sentence = list => { const text = list.join(', '); return text[0].toUpperCase() + text.slice(1); };
        if (summary.failed.length) toast(`While your computer was locked, OrbitCord could not confirm: ${summary.failed.join(', ')}. Check your call.`, true, null, 15000);
        else if (summary.done.length) toast(`${sentence(summary.done)} when your computer locked.`, false, null, 15000);
    }

    // ----- Settings page: a protection list and one detail pane ----------------
    const durations = [[1, '1 hour'], [24, '24 hours'], [168, '7 days'], [720, '30 days'], [2160, '90 days']];
    const duration = hours => durations.find(([value]) => value === hours)?.[1] ?? `${hours} hours`;
    const cdn = (path, hash) => hash ? `https://cdn.discordapp.com/${path}/${hash}.webp?size=64` : null;
    const guildName = id => window.Lowcord.store('GuildStore')?.getGuild?.(id)?.name ?? 'Server';
    function ruleTarget(rule) {
        if (rule.scope === 'server') return window.Lowcord.store('GuildStore')?.getGuild?.(rule.target)?.name ?? `Server ${rule.target}`;
        const channel = window.Lowcord.store('ChannelStore')?.getChannel?.(rule.target);
        if (!channel) return `Chat ${rule.target}`;
        return channel.guild_id ? `${chatName(channel)} · ${guildName(channel.guild_id)}` : chatName(channel);
    }
    const messagePath = message => `/channels/${window.Lowcord.store('ChannelStore')?.getChannel?.(message.channel)?.guild_id ?? '@me'}/${message.channel}/${message.id}`;
    // Servers in sidebar order and DMs by recent activity, for the rule picker.
    function expiryTargets(kind) {
        const store = window.Lowcord.store;
        if (kind === 'server') {
            const guilds = store('GuildStore');
            const ids = store('SortedGuildStore')?.getFlattenedGuildIds?.() ?? Object.keys(guilds?.getGuilds?.() ?? {});
            return ids.map(id => guilds?.getGuild?.(id)).filter(Boolean).map(guild => ({ id: guild.id, name: guild.name, image: cdn(`icons/${guild.id}`, guild.icon) }));
        }
        const channels = store('ChannelStore'), users = store('UserStore');
        return (store('PrivateChannelSortStore')?.getPrivateChannelIds?.() ?? []).slice(0, 300).map(id => channels?.getChannel?.(id)).filter(Boolean).map(channel => {
            const user = channel.recipients?.length === 1 ? users?.getUser?.(channel.recipients[0]) : null;
            return { id: channel.id, name: chatName(channel), image: channel.icon ? cdn(`channel-icons/${channel.id}`, channel.icon) : user ? cdn(`avatars/${user.id}`, user.avatar) : null };
        });
    }
    const serverChannels = guildId => (window.Lowcord.store('GuildChannelStore')?.getChannels?.(guildId)?.SELECTABLE ?? [])
        .map(item => item.channel).filter(channel => channel?.id && channel.name);
    const icons = {
        walkAway: ['M12 2a3 3 0 0 0-3 3v4M15 9.3V5a3 3 0 0 0-5.7-1.3', 'M19 11a7 7 0 0 1-1 3.6M5 11a7 7 0 0 0 11 5.7', 'M12 18v3', 'M3 3l18 18'],
        cover: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M7 13h7v4H7z'],
        report: ['M4 20V10M10 20V4M16 20v-7M22 20H2'],
        traces: ['M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', 'M10 11v5M14 11v5'],
        metadata: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M11 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', 'm21 16-5-5-9 9'],
        expiry: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v5l3 2'],
        inspector: ['M14 3H6v18h12V7l-4-4Z', 'M14 3v4h4M9 13h6M9 17h4'],
        shield: ['M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z', 'm9 12 2 2 4-4'], chevron: ['m9 6 6 6-6 6'], appLock: lockPaths,
        removed: ['M6 12h12'], kept: ['m5 12 5 5 9-10'], file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z', 'M14 3v5h5'],
        search: ['M20 20l-4.5-4.5M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z'], open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    };
    const groups = [['Uploads', ['metadata', 'inspector', 'cover']], ['Messages', ['expiry']], ['This device', ['appLock', 'walkAway', 'traces']]];
    const titles = { metadata: 'Media metadata', cover: 'Cover image details', expiry: 'Message expiry', inspector: 'Attachment inspector', appLock: 'App lock', walkAway: 'Walk-away protection', traces: 'Leave no trace' };
    const reportGroups = [['Blocked', [['analytics', 'Analytics requests'], ['typing', 'Typing indicators']]],
        ['Cleaned', [['links', 'Link trackers'], ['images', 'Images'], ['videos', 'Videos'], ['files', 'File names']]],
        ['Protected', [['covered', 'Images covered'], ['expired', 'Messages expired'], ['downloads', 'Risky downloads'], ['walkAway', 'Calls protected']]]];
    const reportTotal = () => Object.values(report.totals).reduce((sum, value) => sum + value, 0);
    const protectionCount = () => { const count = reportTotal(); return `${count.toLocaleString()} protection${count === 1 ? '' : 's'}`; };
    const bytes = value => value < 1024 ** 2 ? `${Math.round(value / 1024)} KB` : value < 1024 ** 3 ? `${Math.round(value / 1024 ** 2)} MB` : `${(value / 1024 ** 3).toFixed(1)} GB`;
    function SettingsPanel() {
        const R = window.Lowcord.React, h = R.createElement;
        const current = window.Lowcord.store('ChannelStore')?.getChannel?.(channelId());
        const [, rerender] = R.useState(0), [open, setOpen] = R.useState(null), [showReport, setShowReport] = R.useState(false), [error, setError] = R.useState('');
        const [lockMode, setLockMode] = R.useState(null), [codes, setCodes] = R.useState({ current: '', next: '', confirm: '' }), [touchOk, setTouchOk] = R.useState(false), [touchHere, setTouchHere] = R.useState(false);
        const [kind, setKind] = R.useState(current && !current.guild_id ? 'dm' : 'server');
        const [target, setTarget] = R.useState(current ? current.guild_id ?? current.id : '');
        const [ruleChannel, setRuleChannel] = R.useState(current?.guild_id ? current.id : '');
        const [traces, setTraces] = R.useState(null), [clearing, setClearing] = R.useState(false);
        const [query, setQuery] = R.useState(''), [hours, setHours] = R.useState(24), [attachments, setAttachments] = R.useState(false);
        R.useEffect(() => { const update = () => rerender(n => n + 1); window.addEventListener(eventName, update); attachAccount(); return () => window.removeEventListener(eventName, update); }, []);
        R.useEffect(() => {
            window.__LOWCORD_NATIVE__?.traces?.('status').then(setTraces).catch(() => setError('Could not read stored data.'));
        }, [open === 'traces']);
        R.useEffect(() => { touchAvailable().then(setTouchHere); }, []);
        const act = action => { try { action(); setError(''); } catch (e) { setError(e.message); } };
        const icon = (name, size = 18) => h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, ...icons[name].map(d => h('path', { key: d, d })));
        const button = (label, click, primary = false, props = {}) => h('button', { type: 'button', className: `lowcord-button${primary ? ' lowcord-button-primary' : ''}`, onClick: click, ...props }, label);
        const toggle = (name, label) => h('input', { type: 'checkbox', role: 'switch', className: 'lowcord-privacy-switch', 'aria-label': label, checked: state[name], onChange: e => act(() => set({ [name]: e.target.checked })) });
        const badge = (text, tone = '') => h('span', { className: `lowcord-privacy-badge${tone ? ` is-${tone}` : ''}` }, text);
        const section = (label, ...children) => h('div', { className: 'lowcord-privacy-section' }, h('h3', null, label), h('div', { className: 'lowcord-privacy-card' }, ...children));
        const facts = rows => h('dl', { className: 'lowcord-privacy-facts' }, ...rows.map(([term, value]) => h('div', { key: term }, h('dt', null, term), h('dd', null, value))));
        const list = (kind, items) => h('ul', { className: `lowcord-privacy-points is-${kind}` }, ...items.map(text => h('li', { key: text }, icon(kind, 16), text)));
        const note = text => h('p', { className: 'lowcord-privacy-note' }, text);
        const actions = (...children) => h('div', { className: 'lowcord-privacy-actions' }, ...children);
        const segmented = (label, value, options, change) => h('div', { className: 'lowcord-privacy-segmented', role: 'group', 'aria-label': label },
            ...options.map(([id, text]) => h('button', { key: id, type: 'button', 'aria-pressed': value === id ? 'true' : 'false', onClick: () => change(id) }, text)));
        const avatar = (item, round) => h('span', { className: `lowcord-privacy-avatar${round ? ' is-round' : ''}`, 'aria-hidden': 'true' },
            item.image ? h('img', { src: item.image, alt: '', loading: 'lazy' }) : item.name.replace(/^#/, '').trim().charAt(0).toUpperCase());
        const queued = queue?.state.messages.filter(m => !m.preserved).length ?? 0;
        const header = (name, description) => h('p', { key: name, className: 'lowcord-privacy-lede' }, description);

        // One headline figure, its caption and an action: the report and storage share it.
        const total = (figure, caption, action) => h('div', { className: 'lowcord-privacy-card lowcord-privacy-total' },
            h('p', null, h('strong', null, figure), h('span', null, caption)), action);
        const stats = (label, rows) => h('div', { className: 'lowcord-privacy-section' }, h('h3', null, label),
            h('dl', { className: 'lowcord-privacy-stats' }, ...rows.map(([key, text]) => h('div', { key, className: report.totals[key] ? '' : 'is-zero' },
                h('dt', null, text), h('dd', null, report.totals[key].toLocaleString())))));

        function expiryPreview(label) {
            const after = `After ${duration(hours)}`;
            const ghost = text => h('div', { className: 'lowcord-privacy-ghost' }, text);
            const file = removed => removed ? h('span', { className: 'lowcord-privacy-file is-removed' }, icon('removed', 14), 'Attachment removed')
                : h('span', { className: 'lowcord-privacy-file' }, icon('file', 14), 'beach.jpg');
            const message = (who, body, mine = true) => h('div', { className: 'lowcord-privacy-msg' },
                h('span', { className: `lowcord-privacy-face is-${mine ? 'brand' : 'green'}`, 'aria-hidden': 'true' }, mine ? 'Y' : 'S'),
                h('div', null, h('strong', null, mine ? 'You' : 'Sam'), ...body));
            const column = (title, later) => h('div', { className: 'lowcord-privacy-chat' }, h('p', { className: 'lowcord-privacy-chat-title' }, title),
                later && !attachments ? ghost('Message deleted') : message('You', [h('p', { key: 'text' }, 'Plans for Saturday?')]),
                later ? attachments ? message('You', [h('p', { key: 'text' }, 'The view from here'), h('span', { key: 'file' }, file(true))]) : ghost('Message deleted')
                    : message('You', [h('p', { key: 'text' }, 'The view from here'), h('span', { key: 'file' }, file(false))]),
                later ? ghost('Message deleted') : message('You', [h('span', { key: 'file' }, file(false))]),
                message('Sam', [h('p', { key: 'text' }, 'Looks amazing')], false));
            return h('div', { className: 'lowcord-privacy-preview', role: 'img', 'aria-label': `Preview of your messages in ${label} now and ${after.toLowerCase()}` },
                column(`Now · ${label}`, false), h('span', { className: 'lowcord-privacy-arrow', 'aria-hidden': 'true' }, '→'), column(after, true));
        }
        function expiryPane() {
            const targets = expiryTargets(kind);
            const shown = query.trim() ? targets.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase())) : targets;
            const chosen = targets.find(item => item.id === target);
            const channels = kind === 'server' && chosen ? serverChannels(chosen.id) : [];
            const chosenChannel = channels.find(channel => channel.id === ruleChannel);
            const label = !chosen ? 'this chat' : kind === 'server' ? chosenChannel ? `#${chosenChannel.name}` : chosen.name : chosen.name;
            const pick = id => { setTarget(id); setRuleChannel(''); };
            const addRule = () => {
                if (!queue) throw new Error('Discord is still loading. Try again in a moment.');
                if (!chosen) throw new Error(`Choose a ${kind === 'server' ? 'server' : 'direct message'} first.`);
                const scope = kind === 'server' && !chosenChannel ? 'server' : 'channel', id = chosenChannel?.id ?? chosen.id;
                queue.addRule({ id: `${scope}:${id}`, scope, target: id, hours, attachmentsOnly: attachments });
            };
            return [header('expiry', 'Deletes your new messages in a server or direct message after a set time. Only message IDs and deadlines are stored, never what you wrote.'),
                section('Where',
                    segmented('Rule applies to', kind, [['server', 'Servers'], ['dm', 'Direct messages']], value => { setKind(value); setTarget(''); setRuleChannel(''); setQuery(''); }),
                    h('label', { className: 'lowcord-privacy-search' }, icon('search', 16),
                        h('input', { type: 'search', value: query, placeholder: kind === 'server' ? 'Search servers' : 'Search direct messages', 'aria-label': kind === 'server' ? 'Search servers' : 'Search direct messages', onChange: e => setQuery(e.target.value) })),
                    h('div', { className: 'lowcord-privacy-picker', role: 'radiogroup', 'aria-label': kind === 'server' ? 'Servers' : 'Direct messages' },
                        shown.length ? shown.map(item => h('button', { key: item.id, type: 'button', role: 'radio', 'aria-checked': item.id === target ? 'true' : 'false', onClick: () => pick(item.id) },
                            avatar(item, kind === 'dm'), h('span', null, item.name), item.id === target ? icon('kept', 16) : null))
                            : h('p', { className: 'lowcord-privacy-empty' }, query ? 'No matches.' : kind === 'server' ? 'No servers yet.' : 'No direct messages yet.')),
                    channels.length ? h('label', { className: 'lowcord-privacy-field' }, h('span', null, 'Channels'),
                        h('span', { className: 'lowcord-privacy-select' }, h('select', { 'aria-label': 'Channel', value: ruleChannel, onChange: e => setRuleChannel(e.target.value) },
                            h('option', { value: '' }, 'Every channel in this server'), ...channels.map(channel => h('option', { key: channel.id, value: channel.id }, `#${channel.name}`))))) : null),
                section('When and what',
                    h('div', { className: 'lowcord-privacy-field' }, h('span', null, 'Delete after'), segmented('Delete after', hours, durations, setHours)),
                    h('div', { className: 'lowcord-privacy-field' }, h('span', null, 'Remove'),
                        segmented('Remove', attachments ? 'files' : 'all', [['all', 'Whole message'], ['files', 'Only attachments']], value => setAttachments(value === 'files')))),
                section('Preview', expiryPreview(label),
                    h('p', { className: 'lowcord-privacy-summary' }, chosen
                        ? `Your new messages in ${label} will ${attachments ? 'lose their attachments' : 'be deleted'} ${duration(hours)} after you send them. Messages with only attachments are deleted.`.replace(attachments ? '' : ' Messages with only attachments are deleted.', '')
                        : `Choose a ${kind === 'server' ? 'server' : 'direct message'} above.`),
                    actions(button('Create rule', () => act(addRule), true, { disabled: !chosen }))),
                queue?.state.rules.length ? section('Active rules', ...queue.state.rules.map(rule => h('div', { key: rule.id, className: 'lowcord-privacy-line' },
                    h('span', null, h('strong', null, ruleTarget(rule)), h('span', null, `${rule.scope === 'server' ? 'Whole server' : 'Chat'} · after ${duration(rule.hours)}${rule.attachmentsOnly ? ' · attachments only' : ''}`)),
                    button('Remove rule', () => act(() => queue.removeRule(rule.id)))))) : null,
                queue?.state.messages.length ? section('Tracked messages', ...queue.state.messages.slice(0, 100).map(message => h('div', { key: message.id, className: 'lowcord-privacy-line' },
                    h('span', null, h('a', { href: messagePath(message), onClick: e => { e.preventDefault(); window.Lowcord.transitionTo?.(messagePath(message)); } }, `Message ${message.id}`),
                        h('span', null, message.preserved ? 'Preserved' : `Deletes ${new Date(message.deadline).toLocaleString()}`)),
                    button(message.preserved ? 'Resume expiry' : 'Preserve', () => act(() => queue.preserve(message.id, !message.preserved)))))) : null,
                queue?.lastError ? h('p', { role: 'status', className: 'lowcord-privacy-note is-warn' }, queue.lastError) : null,
                note('Rules apply to messages you send while OrbitCord is running, and cleanup resumes when it reopens. Other people’s messages are never touched. Deletion is permanent; others may keep copies.')];
        }
        const details = {
            cover: () => [header('cover', 'Hides names, addresses, faces and anything else in an image before it reaches the message box.'),
                section('How to use it', facts([['Message bar', 'Open the actions button and choose Cover image details'], ['Ask before attaching', 'When on, each image you paste, drop or choose opens the editor first']])),
                note('Covered areas are replaced with solid pixels, so they cannot be recovered from the attached file. Animated images are not supported.')],
            walkAway: () => [header('walkAway', 'Protects your call if you step away. When your computer locks or sleeps, OrbitCord turns off what others can hear and see.'),
                section('What happens', list('kept', ['Your microphone is muted', 'Your camera turns off', 'Your screen share stops'])),
                note('You stay in the call, and nothing turns back on by itself. Linux has no lock signal, so there it responds to sleep only.')],
            traces: () => {
                const native = window.__LOWCORD_NATIVE__?.traces;
                const save = next => native('set', { clearOnQuit: traces.clearOnQuit, signOut: traces.signOut, ...next }).then(setTraces).catch(() => setError('Could not save this choice.'));
                const row = (label, name, disabled) => h('label', { className: 'lowcord-privacy-line' }, h('span', null, h('strong', null, label)),
                    h('input', { type: 'checkbox', role: 'switch', className: 'lowcord-privacy-switch', 'aria-label': label, disabled: !traces || disabled, checked: Boolean(traces?.[name]), onChange: e => void save({ [name]: e.target.checked }) }));
                return [header('traces', 'Removes what OrbitCord keeps on this computer, for shared or borrowed machines.'),
                    native ? section('When OrbitCord quits', row('Clear cached media', 'clearOnQuit'), row('Also sign out', 'signOut', !traces?.clearOnQuit)) : note('Available in the OrbitCord app.'),
                    native ? h('div', { className: 'lowcord-privacy-section' }, h('h3', null, 'Stored now'),
                        total(traces ? bytes(traces.cacheBytes) : '…', 'Cached media on this computer',
                            button(clearing ? 'Clearing…' : 'Clear now', () => { setClearing(true); native('clear').then(setTraces).catch(() => setError('Could not clear cached media.')).finally(() => setClearing(false)); }, false, { disabled: clearing || !traces?.cacheBytes }))) : null,
                    note('The next launch is slower while the cache rebuilds. Your own downloads are not touched, and this cannot run if OrbitCord crashes or is force quit.')];
            },
            report: () => {
                const count = reportTotal();
                return [header('report', `What OrbitCord has done on this account since ${new Date(report.since).toLocaleDateString(undefined, { dateStyle: 'long' })}.`),
                    total(count.toLocaleString(), count === 1 ? 'protection' : 'protections', button('Reset', () => act(() => { report.reset(); changed(); }), false, { disabled: !count, 'aria-label': 'Reset report' })),
                    ...reportGroups.map(([label, rows]) => h(R.Fragment, { key: label }, stats(label, rows))),
                    note('Only totals are stored, on this device. This shows what OrbitCord did, not that nothing else could see your activity.')];
            },
            metadata: () => [header('metadata', 'Removes hidden details from images and videos before they upload. What people see and hear is not changed.'),
                section('What changes', h('div', { className: 'lowcord-privacy-columns' },
                    h('div', null, h('h4', null, 'Removed'), list('removed', ['Location', 'Camera and lens', 'Date taken', 'Author and comments', 'Editing history', 'GPS and sensor tracks in videos'])),
                    h('div', null, h('h4', null, 'Kept'), list('kept', ['Orientation', 'Animation', 'Color profile'])))),
                section('Supported files', facts([['Images', 'JPEG, PNG, APNG, WebP, GIF, HEIC, HEIF, AVIF'], ['Videos', 'MP4, MOV, 3GP'], ['Size limit', '64 MiB for JPEG, PNG, WebP and GIF'],
                    ['Other files', 'WebM, MKV and documents upload unchanged.']])),
                note('Only file metadata is removed. Anything visible in the image itself stays as it is.')],
            appLock: () => {
                const enabled = state.appLock, mode = enabled ? lockMode : lockMode ?? 'setup';
                const field = (name, label, autoComplete) => h('label', { key: name, className: 'lowcord-privacy-field' }, h('span', null, label),
                    h('input', { type: 'password', inputMode: 'numeric', maxLength: 8, autoComplete: autoComplete ?? 'off', className: 'lowcord-privacy-input', 'aria-label': label, value: codes[name],
                        onChange: e => setCodes({ ...codes, [name]: e.target.value.replace(/\D/g, '') }) }));
                const reset = () => { setLockMode(null); setCodes({ current: '', next: '', confirm: '' }); setTouchOk(false); };
                const submit = async () => {
                    try {
                        if (mode !== 'setup' && !touchOk && !await checkPasscode(codes.current)) throw new Error('Wrong passcode.');
                        if (mode === 'disable') { set({ appLock: false }); clearPasscode(); }
                        else {
                            if (!passcodeValid(codes.next)) throw new Error('Use 4 to 8 digits.');
                            if (codes.next !== codes.confirm) throw new Error('Passcodes do not match.');
                            await setPasscode(codes.next); set({ appLock: true });
                        }
                        reset(); setError('');
                    } catch (e) { setError(e.message); }
                };
                const verify = async () => { if (await touchVerify(mode === 'disable' ? 'Turn off app lock' : 'Change the Lowcord passcode')) { setTouchOk(true); setError(''); } else setError('Touch ID did not confirm. Enter your passcode instead.'); };
                const form = mode ? section(mode === 'setup' ? 'Set a passcode' : mode === 'change' ? 'Change passcode' : 'Turn off app lock',
                    mode !== 'setup' && !touchOk ? field('current', 'Current passcode', 'current-password') : null,
                    mode !== 'setup' && !touchOk && touchHere ? button('Use Touch ID instead', verify) : null,
                    mode !== 'setup' && touchOk ? note('Confirmed with Touch ID.') : null,
                    mode !== 'disable' ? field('next', 'New passcode (4 to 8 digits)') : null,
                    mode !== 'disable' ? field('confirm', 'Confirm passcode') : null,
                    actions(enabled ? button('Cancel', reset) : null, button(mode === 'disable' ? 'Turn off' : mode === 'change' ? 'Save passcode' : 'Turn on app lock', () => void submit(), true))) : null;
                return [header('appLock', 'Covers Lowcord with a lock screen when it starts, when your computer locks and after you have been away. Voice calls are not interrupted; walk-away protection handles those.'),
                    enabled ? section('When it locks', facts([['On start', 'Always'], ['Computer locks', 'Always'],
                        ['Away from the window', h('span', { className: 'lowcord-privacy-select' }, h('select', { 'aria-label': 'Lock after being away', value: String(state.lockAfter), onChange: e => act(() => set({ lockAfter: Number(e.target.value) })) },
                            ...lockDelays.map(value => h('option', { key: value, value: String(value) }, value ? `After ${value} minute${value === 1 ? '' : 's'}` : 'Never'))))],
                        ['Unlock with', touchHere ? 'Touch ID or passcode' : 'Passcode']])) : null,
                    form,
                    enabled && !mode ? actions(button('Change passcode', () => setLockMode('change')), button('Turn off', () => setLockMode('disable'))) : null,
                    note('Your passcode is stored only as a salted hash on this device and cannot be recovered. If you forget it, “Forgot passcode?” on the lock screen removes the lock by logging you out of Discord. Closing the lock screen with a keyboard shortcut is blocked; the lock does not encrypt Discord’s data on disk.')];
            },
            expiry: expiryPane,
            inspector: () => [header('inspector', 'After a download, explains disguised programs, misleading file names and risky ZIP contents. Nothing is opened, extracted or uploaded.'),
                section('Last download', lastInspection
                    ? h('div', { role: 'status' }, h('div', { className: 'lowcord-privacy-line is-first' }, h('strong', null, lastInspection.name),
                        badge(lastInspection.status === 'checked' ? 'No issues found' : lastInspection.status === 'warning' ? 'Needs care' : 'Unable to inspect', lastInspection.status === 'warning' ? 'danger' : lastInspection.status === 'checked' ? '' : 'warn')),
                        lastInspection.reasons.length ? h('ul', { className: 'lowcord-privacy-reasons' }, ...lastInspection.reasons.map(reason => h('li', { key: reason }, reason))) : null)
                    : h('p', { className: 'lowcord-privacy-empty' }, 'No downloads checked yet.')),
                section('What is checked', facts([['Disguised files', 'Programs named like photos or documents'], ['Archives', 'Scripts, shortcuts and unsafe paths inside ZIP files'], ['Not checked', 'Encrypted or unsupported archives show Unable to inspect']])),
                note('This is not an antivirus scan. “No issues found” never means a file is safe.')],
        };
        // Each row is a button that opens its details, with the switch beside it so no control nests in another.
        const rowText = {
            metadata: 'Remove location and camera details from images and videos',
            inspector: !state.inspector ? 'Check downloads for disguised or risky files' : lastInspection?.status === 'warning' ? 'Last download needs care' : 'Check downloads for disguised or risky files',
            cover: state.coverAsk ? 'Asks before each image is attached' : 'Hide names and faces in an image before it is attached',
            expiry: queue?.state.rules.length ? `${queued} queued · deletes your new messages after a set time` : 'Delete your new messages after a set time',
            appLock: state.appLock ? `Locks on start and when your computer locks${state.lockAfter ? `, and after ${state.lockAfter} min away` : ''}` : 'Require a passcode to open Lowcord',
            walkAway: 'Mute and stop sharing when your computer locks',
            traces: traces?.clearOnQuit ? 'Clears cached media when OrbitCord quits' : 'Clear cached media when OrbitCord quits',
        };
        const lockSwitch = h('input', { type: 'checkbox', role: 'switch', className: 'lowcord-privacy-switch', 'aria-label': 'App lock', 'aria-checked': state.appLock, checked: state.appLock,
            onChange: e => { setOpen('appLock'); setLockMode(e.target.checked ? 'setup' : 'disable'); setCodes({ current: '', next: '', confirm: '' }); setTouchOk(false); setError(''); } });
        const rules = queue?.state.rules.length ?? 0;
        const controls = {
            metadata: () => toggle('metadata', 'Remove media metadata'), inspector: () => toggle('inspector', 'Attachment inspector'),
            cover: () => toggle('coverAsk', 'Ask before attaching images'), walkAway: () => toggle('walkAway', 'Walk-away protection'), appLock: () => lockSwitch,
            expiry: () => badge(`${rules} rule${rules === 1 ? '' : 's'}`), traces: () => badge(traces?.clearOnQuit ? 'On quit' : 'Off'),
        };
        const row = name => {
            const expanded = open === name, body = `lowcord-privacy-body-${name}`, titleId = `lowcord-privacy-title-${name}`;
            return h('div', { key: name, className: `lowcord-privacy-row${expanded ? ' is-open' : ''}` },
                h('div', { className: 'lowcord-privacy-row-head' },
                    h('button', { type: 'button', id: titleId, className: 'lowcord-privacy-row-main', 'aria-expanded': expanded ? 'true' : 'false', 'aria-controls': body,
                        onClick: () => { setOpen(expanded ? null : name); setError(''); } },
                        h('span', { className: 'lowcord-privacy-tile' }, icon(name)),
                        h('span', { className: 'lowcord-privacy-item-text' }, h('strong', null, titles[name]), h('span', { className: name === 'inspector' && state.inspector && lastInspection?.status === 'warning' ? 'is-warn' : '' }, rowText[name])),
                        h('span', { className: 'lowcord-privacy-chevron', 'aria-hidden': 'true' }, icon('chevron', 16))),
                    controls[name]()),
                expanded ? h('div', { id: body, className: 'lowcord-privacy-row-body', role: 'region', 'aria-labelledby': titleId }, ...details[name]()) : null);
        };
        const enabledCount = [state.metadata, state.inspector, state.coverAsk, state.walkAway, state.appLock, Boolean(traces?.clearOnQuit), rules > 0].filter(Boolean).length;
        return h('section', { className: 'lowcord-privacy-page' },
            h('div', { className: 'lowcord-privacy-status' },
                h('span', { className: 'lowcord-privacy-tile is-brand' }, icon('shield', 20)),
                h('div', { className: 'lowcord-privacy-item-text' }, h('strong', null, `${enabledCount} of 7 protections on`),
                    h('span', null, `${protectionCount()} since ${new Date(report.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · Everything runs on this device`)),
                h('button', { type: 'button', className: 'lowcord-button', 'aria-expanded': showReport ? 'true' : 'false', 'aria-controls': 'lowcord-privacy-report', onClick: () => setShowReport(!showReport) }, showReport ? 'Hide report' : 'View report')),
            showReport ? h('div', { id: 'lowcord-privacy-report', className: 'lowcord-privacy-report', role: 'region', 'aria-label': 'Privacy report' }, ...details.report()) : null,
            ...groups.map(([label, names]) => h('div', { key: label, className: 'lowcord-privacy-group', role: 'group', 'aria-labelledby': `lowcord-privacy-group-${label.replace(/ /g, '-')}` },
                h('h2', { id: `lowcord-privacy-group-${label.replace(/ /g, '-')}` }, label), h('div', { className: 'lowcord-privacy-list' }, ...names.map(row)))),
            error ? h('p', { role: 'alert', className: 'lowcord-privacy-note is-error' }, error) : null);
    }
    window.Lowcord.privacy = { get state() { return { ...state }; }, set, eventName, SettingsPanel,
        get queue() { return queue; }, attachAccount, attach, report, count: (name, amount) => report.add(name, amount), walkAwayChanged,
        lock, logOut, get locked() { return Boolean(lockEl); }, setPasscode, checkPasscode };
    const ready = () => {
        syncNative();
        window.Lowcord.waitForStore('UserStore', store => { attachAccount(); store.addChangeListener?.(attachAccount); });
        window.__LOWCORD_NATIVE__?.onWalkAway?.(walkAwayChanged);
        window.__LOWCORD_NATIVE__?.onAttachmentInspection?.(result => {
            lastInspection = result; changed();
            if (result?.status === 'warning') report.add('downloads');
            // Warnings get a native dialog from the main process; files that
            // could not be fully inspected get a quieter notice, never "safe".
            if (result?.status === 'uninspectable') toast(`Unable to fully inspect ${result.name}. ${result.reasons?.[0] ?? ''}`.trim(), true);
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
