// The picker is created only on demand. Browsing uses main-process requests;
// the only Discord integration is its existing file uploader and REST client.
(() => {
    const { extensions, storage } = window.Lowcord;
    const { ui } = extensions;
    let current, working = false, nonceSequence = 0n;
    const transfer = { queue: [], jobs: new Map(), sent: new Set(), nonces: new Map(), paused: false };
    const storageKey = 'lowcord.redgifs.saved.v1';
    const layoutKey = 'lowcord.redgifs.layout.v1';
    const categories = ['videos', 'explore', 'creators', 'niches', 'favorites'];
    const categoryNames = { videos: 'Trending', explore: 'Explore', creators: 'Creators', niches: 'Niches', favorites: 'Favorites' };
    // Favorites holds two lists: saved clips and saved creators.
    const savedClips = state => state.mode === 'favorites' && !state.creator && state.favoriteKind === 'clips';
    const creatorList = state => !state.creator && (state.mode === 'creators' || (state.mode === 'favorites' && state.favoriteKind === 'creators'));
    const directory = state => state.mode === 'niches' || creatorList(state);
    const queryKey = state => state.mode === 'favorites' ? `favorites-${state.favoriteKind}` : state.mode;
    // Collections are stored oldest first; show the newest saved first.
    const newest = list => list.slice().reverse();
    let saved;
    // Discord deletes window.localStorage during startup; use the handle
    // retained by Lowcord's preload, as the other settings pages do.
    try { saved = JSON.parse(storage.getItem(storageKey)); } catch {}
    saved = { favorites: Array.isArray(saved?.favorites) ? saved.favorites.slice(0, 200).filter(x => typeof x?.id === 'string' && /^[a-z0-9]{1,100}$/i.test(x.id)).map(x => ({ id: x.id, author: String(x.author || '').slice(0, 100) })) : [],
        niches: Array.isArray(saved?.niches) ? saved.niches.slice(0, 30).filter(x => typeof x?.id === 'string' && /^[a-z0-9_-]{1,100}$/i.test(x.id)).map(x => ({ id: x.id, name: String(x.name || '').slice(0, 160) })) : [],
        creators: Array.isArray(saved?.creators) ? saved.creators.slice(0, 100).filter(x => typeof x?.id === 'string' && /^[a-z0-9_-]{1,100}$/i.test(x.id)).map(x => ({ id: x.id,
            name: String(x.name || '').slice(0, 160), verified: x.verified === true,
            ...(Number.isFinite(x.followers) ? { followers: x.followers } : {}), ...(Number.isFinite(x.videos) ? { videos: x.videos } : {}) })) : [],
        background: saved?.background === true };
    const limits = { favorites: 200, niches: 30, creators: 100 };
    const savedLabels = { favorites: 'favorite', niches: 'pinned niche', creators: 'favorite creator' };
    function persist() { try { storage.setItem(storageKey, JSON.stringify(saved)); } catch { extensions.toast('Could not save RedGIFs preferences.', true); } }
    function toggleSaved(kind, item) {
        const index = saved[kind].findIndex(x => x.id === item.id);
        if (index >= 0) saved[kind].splice(index, 1);
        else if (saved[kind].length < limits[kind]) saved[kind].push(kind === 'favorites' ? { id: item.id, author: String(item.author || '').slice(0, 100) }
            : kind === 'creators' ? { id: item.id, name: String(item.name || '').slice(0, 160), verified: item.verified === true,
                ...(Number.isFinite(item.followers) ? { followers: item.followers } : {}), ...(Number.isFinite(item.videos) ? { videos: item.videos } : {}) }
                : { id: item.id, name: String(item.name || '').slice(0, 160) });
        else { extensions.toast('Saved collection is full. Remove an item first.', true); return; }
        persist();
        if (current) {
            for (const entry of current.items) updateStar(current, entry);
            pinned(current); favoriteControls(current);
            if (kind !== 'niches' && current.mode === 'favorites' && !current.creator && (kind === 'favorites') === (current.favoriteKind === 'clips')) void search(current, true);
        }
    }
    function updateStar(state, item) {
        if (!item.star) return;
        const on = saved[item.saveKind].some(x => x.id === item.id);
        setIcon(item.star, 'star'); item.star.setAttribute('aria-pressed', String(on));
        item.star.setAttribute('aria-label', `${on ? 'Remove' : 'Save'} ${savedLabels[item.saveKind]} ${item.name || item.author || item.id}`);
    }
    function favoriteControls(state) {
        state.favoriteKinds.hidden = state.mode !== 'favorites' || Boolean(state.creator);
        for (const button of state.favoriteKinds.children) {
            button.setAttribute('aria-pressed', String(button.dataset.kind === state.favoriteKind));
            button.lastChild.textContent = String(saved[button.dataset.kind === 'clips' ? 'favorites' : 'creators'].length);
        }
        const creator = state.creator, on = Boolean(creator && saved.creators.some(x => x.id === creator.id));
        state.creatorSave.hidden = !creator;
        state.creatorSave.setAttribute('aria-pressed', String(on));
        state.creatorSave.setAttribute('aria-label', `${on ? 'Remove' : 'Save'} favorite creator ${creator?.name || creator?.id || ''}`);
        state.creatorSave.lastChild.textContent = on ? 'Saved' : 'Save';
    }
    function pinned(state) {
        state.pins.replaceChildren(...saved.niches.map(niche => ui('button', { type: 'button',
            onClick: () => mode(state, 'videos', niche) }, `# ${niche.name}`)));
        state.pins.hidden = state.mode === 'favorites' || state.mode === 'creators' || !saved.niches.length;
    }
    const paths = {
        close: 'M6 6l12 12M18 6 6 18',
        search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
        play: 'm9 5 11 7-11 7Z',
        back: 'm14 6-6 6 6 6',
        niche: 'M9 3 7 21M17 3l-2 18M3 9h18M2 15h18',
        creator: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
        verified: 'm9 11 3 3L22 4M21 12v.9A10 10 0 1 1 15.1 3',
        star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
        options: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6',
        pause: 'M9 5v14M15 5v14',
        retry: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6',
        down: 'm6 9 6 6 6-6',
        upload: 'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',
        remove: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
        minimize: 'M5 12h14',
        resize: 'm21 9-12 12m12-6-6 6',
    };
    function icon(name, size = 18) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
            stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) node.setAttribute(key, value);
        if (name === 'grip') {
            // Lucide grip-vertical (ISC; electron/licenses/lucide.txt).
            for (const x of [9, 15]) for (const y of [5, 12, 19]) {
                const dot = document.createElementNS(node.namespaceURI, 'circle');
                dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '1'); node.append(dot);
            }
        } else {
            const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', paths[name]); node.append(path);
        }
        return node;
    }
    function setIcon(button, name) {
        if (button.dataset.icon === name) return;
        button.dataset.icon = name; button.replaceChildren(icon(name, 14));
    }
    const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
    const duration = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const selectedChannel = () => window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    const messages = {
        'ffmpeg-missing': 'HD and SD are too large. Install FFmpeg to compress this video, then try again.',
        'encode-busy': 'Another video is being compressed. Try again when it finishes.',
        'busy': 'The previous video is still stopping. Try again in a moment.',
        'encode-timeout': 'Compression took too long. Try a shorter video.',
        'unsupported-duration': 'This video cannot be compressed. Choose a video under ten minutes.',
        'too-large': 'This video could not be made small enough. Choose another video.',
        'expired': 'This preview expired. Search again to refresh it.',
        'rate-limited': 'RedGIFs is limiting requests. Wait a moment and try again.',
    };
    const errorText = code => messages[code] || 'Could not load this video. Try again.';
    function uploadLimit(channelId) {
        const mb = 1024 * 1024;
        const premium = window.Lowcord.store('UserStore')?.getCurrentUser?.()?.premiumType;
        const guild = window.Lowcord.store('ChannelStore')?.getChannel?.(channelId)?.guild_id;
        const tier = guild ? window.Lowcord.store('GuildStore')?.getGuild?.(guild)?.premiumTier : 0;
        return Math.min(20_000_000, Math.max(premium === 2 ? 500 * mb : premium === 1 || premium === 3 ? 50 * mb : 10 * mb,
            tier === 3 ? 100 * mb : tier === 2 ? 50 * mb : 0));
    }
    function destinationName(channelId) {
        const channel = window.Lowcord.store('ChannelStore')?.getChannel?.(channelId);
        const recipient = channel?.getRecipientId?.() || channel?.recipients?.[0];
        const user = recipient && window.Lowcord.store('UserStore')?.getUser?.(recipient);
        return channel?.name || user?.globalName || user?.username || `Chat ${channelId}`;
    }
    const alive = state => current === state && extensions.enabled('redgifsPicker') && selectedChannel() === state.channelId;
    function readLayout() {
        try {
            const value = JSON.parse(storage.getItem(layoutKey));
            if (value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
                && value.width >= 320 && value.width <= 640 && value.height >= 280 && value.height <= 960) return value;
        } catch {}
        return null;
    }
    function saveLayout(state) {
        try {
            if (state.layout) storage.setItem(layoutKey, JSON.stringify(state.layout));
            else storage.removeItem(layoutKey);
        } catch { extensions.toast('Could not save the RedGIFs picker position.', true); }
    }
    function layoutSnapshot(state) {
        const box = state.node.getBoundingClientRect();
        return { x: box.x, y: box.y,
            width: state.collapsed ? state.layout.width : Math.max(320, box.width),
            height: state.collapsed ? state.layout.height : Math.max(280, box.height) };
    }
    function placePicker(state) {
        const size = state.collapsed ? { width: 220, height: 44 } : state.layout || { width: 420, height: 680 };
        state.node.style.width = `min(${size.width}px, calc(100vw - 32px))`;
        state.node.style.height = `min(${size.height}px, calc(100vh - 32px))`;
        // CSS clamps immediately during viewport changes, before resize events
        // run. Keep the preferred size so a wider window restores that space.
        for (const [axis, edge, viewport, length] of [['x', 'left', 'vw', 'width'], ['y', 'top', 'vh', 'height']]) {
            state.node.style[edge] = state.layout ? `clamp(16px, ${state.layout[axis]}px, calc(100${viewport} - min(${size[length]}px, calc(100${viewport} - 32px)) - 16px))` : '';
        }
        state.node.style.right = state.layout ? 'auto' : '';
        state.node.style.bottom = state.layout ? 'auto' : '';
        if (!state.layoutFrame) state.layoutFrame = requestAnimationFrame(() => {
            state.layoutFrame = null;
            if (alive(state) && !state.collapsed) renderWindow(state);
        });
    }
    function collapsePicker(state, value) {
        finishGesture(state, false);
        state.layout = layoutSnapshot(state);
        state.collapsed = value;
        stopPreview(state); clearTimeout(state.scrollTimer);
        state.body.hidden = value; state.resize.hidden = value;
        state.node.toggleAttribute('data-collapsed', value);
        state.collapse.setAttribute('aria-expanded', String(!value));
        state.collapse.setAttribute('aria-label', value ? 'Restore RedGIFs picker' : 'Collapse RedGIFs picker');
        state.collapse.title = value ? 'Restore picker' : 'Collapse picker';
        setIcon(state.collapse, value ? 'down' : 'minimize');
        state.options.hidden = true; state.optionsButton.setAttribute('aria-expanded', 'false');
        placePicker(state); saveLayout(state);
        state.collapse.focus({ preventScroll: true });
    }
    function resetLayout(state) {
        finishGesture(state, false);
        if (state.collapsed) collapsePicker(state, false);
        state.layout = null; placePicker(state); saveLayout(state);
    }
    function beginGesture(state, event, action) {
        if (!alive(state) || event.button !== 0 || event.isPrimary === false || (action === 'resize' && state.collapsed)) return;
        if (action === 'move' && event.target.closest('button') && !event.target.closest('.lowcord-redgifs-drag')) return;
        event.preventDefault(); event.stopPropagation();
        finishGesture(state, false);
        const control = event.currentTarget;
        state.gesture = { action, control, pointer: event.pointerId, x: event.clientX, y: event.clientY,
            start: layoutSnapshot(state), previous: state.layout && { ...state.layout } };
        stopPreview(state); clearTimeout(state.scrollTimer);
        state.node.dataset.gesture = action;
        (action === 'move' ? state.drag : state.resize).focus({ preventScroll: true });
        control.setPointerCapture(event.pointerId);
    }
    function gestureMove(state, event) {
        const gesture = state.gesture;
        if (!gesture || event.pointerId !== gesture.pointer) return;
        event.preventDefault(); event.stopPropagation();
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y, start = gesture.start;
        state.layout = gesture.action === 'move' ? { ...start,
            x: Math.max(16, Math.min(innerWidth - state.node.offsetWidth - 16, start.x + dx)),
            y: Math.max(16, Math.min(innerHeight - state.node.offsetHeight - 16, start.y + dy)) }
            : { ...start, width: Math.max(320, Math.min(640, innerWidth - start.x - 16, start.width + dx)),
                height: Math.max(280, Math.min(960, innerHeight - start.y - 16, start.height + dy)) };
        placePicker(state);
    }
    function finishGesture(state, commit) {
        const gesture = state.gesture;
        if (!gesture) return;
        state.gesture = null; delete state.node.dataset.gesture;
        if (gesture.control.hasPointerCapture(gesture.pointer)) gesture.control.releasePointerCapture(gesture.pointer);
        if (commit) saveLayout(state);
        else { state.layout = gesture.previous; placePicker(state); }
    }
    function keyboardLayout(state, event, action) {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Home') { resetLayout(state); return; }
        const start = layoutSnapshot(state), step = event.shiftKey ? 40 : 10;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        state.layout = action === 'move' ? { ...start,
            x: Math.max(16, Math.min(innerWidth - state.node.offsetWidth - 16, start.x + dx)),
            y: Math.max(16, Math.min(innerHeight - state.node.offsetHeight - 16, start.y + dy)) }
            : { ...start, width: Math.max(320, Math.min(640, innerWidth - start.x - 16, start.width + dx)),
                height: Math.max(280, Math.min(960, innerHeight - start.y - 16, start.height + dy)) };
        stopPreview(state); placePicker(state); saveLayout(state);
    }
    function status(state, text, quiet = false) {
        if (current !== state) return;
        state.status.textContent = text; state.status.hidden = !text || quiet;
    }
    function playbackTime(state) {
        const item = state.previewing;
        if (!item) return;
        const total = Number.isFinite(state.video.duration) && state.video.duration > 0 ? state.video.duration : item.duration;
        if (!Number.isFinite(total) || total <= 0) return;
        item.duration = total;
        const elapsed = Math.max(0, Math.min(total, state.video.currentTime || 0));
        const text = `${duration(elapsed)} / ${duration(total)}`;
        if (item.timer.textContent !== text) item.timer.textContent = text;
        item.timer.hidden = false;
        item.button.style.setProperty('--lowcord-redgifs-progress', String(elapsed / total));
    }
    function applyScrub(state) {
        state.scrubFrame = undefined;
        const item = state.scrubItem, video = state.video;
        if (!alive(state) || document.hidden || !item || state.previewing !== item) return;
        // A move before metadata arrives is retained, with no polling loop.
        if (!Number.isFinite(video.duration) || video.duration <= 0 || video.readyState < 1) return;
        const box = item.button.getBoundingClientRect();
        if (!box.width || video.seeking) return;
        state.scrubPending = false;
        const fraction = Math.max(0, Math.min(1, (state.scrubX - box.left) / box.width));
        video.pause(); item.button.dataset.scrubbing = 'true';
        video.currentTime = Math.min(Math.max(0, video.duration - .01), fraction * video.duration);
        playbackTime(state);
        clearTimeout(state.resumeTimer);
        state.resumeTimer = setTimeout(() => {
            if (!alive(state) || document.hidden || state.previewing !== item) return;
            delete item.button.dataset.scrubbing;
            state.scrubItem = null;
            video.play().catch(() => {});
        }, 180);
    }
    function scrub(state, item, event) {
        if (!alive(state) || document.hidden || state.previewTarget !== item || event.pointerType === 'touch') return;
        if (state.pointerX == null) { state.pointerX = event.clientX; return; }
        if (Math.abs(event.clientX - state.pointerX) < 2) return;
        state.pointerX = event.clientX; state.scrubItem = item; state.scrubX = event.clientX; state.scrubPending = true;
        clearTimeout(state.resumeTimer);
        if (state.scrubFrame === undefined) state.scrubFrame = requestAnimationFrame(() => applyScrub(state));
    }
    function releaseVideo(state) {
        clearTimeout(state.previewTimer);
        clearTimeout(state.resumeTimer);
        if (state.scrubFrame !== undefined) cancelAnimationFrame(state.scrubFrame);
        state.scrubFrame = undefined; state.scrubItem = null; state.scrubPending = false; state.pointerX = null;
        if (state.previewing) {
            const item = state.previewing;
            delete item.button.dataset.previewing; delete item.button.dataset.scrubbing;
            item.button.style.removeProperty('--lowcord-redgifs-progress');
            item.timer.textContent = item.duration != null ? duration(item.duration) : '';
            item.timer.hidden = item.duration == null;
        }
        state.previewing = null;
        state.video.pause(); state.video.removeAttribute('src'); state.video.load();
        state.video.remove();
    }
    function stopPreview(state, item) {
        if (!item || state.previewing === item || state.previewTarget === item) {
            state.previewTarget = null; releaseVideo(state);
        }
    }
    function preview(state, item) {
        if (!alive(state) || document.hidden || state.collapsed || state.gesture || !item.preview || state.previewTarget === item) return;
        stopPreview(state);
        state.previewTarget = item;
        // A brief hover intent avoids opening streams while crossing tiles.
        state.previewTimer = setTimeout(() => {
            if (!alive(state) || state.previewTarget !== item || !item.button.isConnected) return;
            state.previewing = item;
            state.video.src = item.preview;
            item.button.append(state.video);
            state.video.play().catch(() => {});
        }, 140);
    }
    function scrolled(state) {
        if (state.collapsed || state.gesture) return;
        if (!state.viewportFrame) state.viewportFrame = requestAnimationFrame(() => {
            state.viewportFrame = null; renderWindow(state);
            if (!state.collapsed && !state.gesture && !state.more.hidden && state.more.textContent !== 'Retry' && !state.loading
                && state.results.scrollHeight - state.results.scrollTop - state.results.clientHeight < 500) void search(state, false);
        });
        stopPreview(state); clearTimeout(state.scrollTimer);
        // Pointer/focus events can arrive before a scroll's final event. Resume
        // only the tile still under the pointer or visibly keyboard-focused.
        state.scrollTimer = setTimeout(() => {
            if (!alive(state)) return;
            let button = state.results.querySelector('.lowcord-redgifs-thumb:hover');
            if (!button && document.activeElement?.matches('.lowcord-redgifs-thumb')) {
                const focused = document.activeElement, box = focused.getBoundingClientRect(), bounds = state.results.getBoundingClientRect();
                if (box.bottom > bounds.top && box.top < bounds.bottom) button = focused;
            }
            const item = state.items.find(entry => entry.button === button);
            if (item) preview(state, item);
        }, 120);
    }
    function mode(state, value, niche = null, creator = null, kind = state.favoriteKind) {
        if (!alive(state)) return;
        if (value === 'favorites' && !creator) window.__LOWCORD_NATIVE__.redgifsCancel?.('browse').catch(() => {});
        if (!state.niche && !state.creator) state.queries[queryKey(state)] = state.input.value;
        state.mode = value; state.niche = niche; state.creator = creator; state.favoriteKind = kind;
        state.input.value = niche || creator ? '' : state.queries[queryKey(state)] || '';
        state.input.placeholder = savedClips(state) ? 'Search saved videos' : value === 'favorites' && !creator ? 'Search saved creators'
            : creatorList(state) ? 'Search creators' : value === 'niches' ? 'Search niches' : 'Search topics';
        for (const tab of state.tabs) { const selected = tab.dataset.mode === value; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
        state.grid.classList.toggle('lowcord-redgifs-niches', directory(state));
        state.grid.classList.toggle('lowcord-redgifs-favorites', savedClips(state));
        state.grid.classList.toggle('lowcord-redgifs-creators', creatorList(state));
        state.favoritesHelp.hidden = !savedClips(state) && !creatorList(state);
        state.favoritesHelp.textContent = savedClips(state) ? 'Hover to preview · Click to send' : 'Choose a creator to browse their videos';
        pinned(state); favoriteControls(state);
        state.results.setAttribute('aria-labelledby', `lowcord-redgifs-tab-${value}`);
        void search(state, true);
    }
    function close() {
        const state = current;
        if (!state) return;
        current = undefined;
        finishGesture(state, false);
        clearTimeout(state.scrollTimer);
        if (state.layoutFrame) cancelAnimationFrame(state.layoutFrame);
        if (state.viewportFrame) cancelAnimationFrame(state.viewportFrame);
        if (!saved.background || !extensions.enabled('redgifsPicker')) cancelAll();
        window.__LOWCORD_NATIVE__?.redgifsCancel?.('browse').catch(() => {});
        stopPreview(state);
        state.channelStore?.removeChangeListener?.(state.channelChanged);
        window.removeEventListener('keydown', state.key, true);
        window.removeEventListener('resize', state.place);
        window.removeEventListener('blur', state.blur);
        document.removeEventListener('visibilitychange', state.visibility);
        state.stopDom?.();
        state.node.remove();
        for (const job of [...transfer.jobs.values(), transfer.activeJob].filter(Boolean)) job.row = job.detail = job.action = job.remove = null;
        if (state.editor?.isConnected) state.editor.focus({ preventScroll: true });
    }
    async function search(state, reset) {
        if (!alive(state) || (state.loading && !reset)) return;
        const generation = ++state.generation;
        if (reset) {
            clearTimeout(state.scrollTimer);
            stopPreview(state);
            state.query = state.input.value.trim(); state.page = 0; state.items = [];
            state.grid.replaceChildren(); state.windowStart = -1; state.windowEnd = -1;
            state.results.scrollTop = 0;
        }
        const back = state.creator ? state.mode === 'favorites' ? 'Favorites' : 'Creators' : 'Niches';
        state.back.hidden = !state.niche && !state.creator;
        state.back.setAttribute('aria-label', `Back to ${back.toLowerCase()}`);
        state.back.lastChild.textContent = back;
        state.resultHeading.hidden = state.mode !== 'favorites' && state.mode !== 'creators' && !state.query && !state.niche && !state.creator;
        state.grid.setAttribute('aria-label', directory(state) ? `RedGIFs ${state.mode === 'niches' ? 'niches' : 'creators'}` : 'RedGIFs videos');
        state.heading.textContent = state.niche?.name || state.creator?.name || state.creator?.id || (state.mode === 'favorites' ? 'Saved videos' : state.mode === 'creators'
            ? state.query ? `Creators for ${state.query}` : 'Trending creators' : state.mode === 'niches'
            ? state.query ? `Niches for ${state.query}` : 'Popular niches'
            : state.query ? `Videos for ${state.query}` : 'Trending videos');
        favoriteControls(state);
        state.loading = true; state.more.disabled = true;
        state.results.setAttribute('aria-busy', 'true');
        status(state, directory(state) ? state.mode === 'niches' ? 'Finding niches...' : 'Finding creators...' : 'Finding videos...');
        try {
            const query = state.query.toLowerCase();
            const favorites = newest(savedClips(state) ? saved.favorites : saved.creators).filter(item => !query
                || `${item.author ?? item.name} ${item.id}`.toLowerCase().includes(query));
            if (state.mode === 'favorites' && !state.creator) state.heading.textContent = `${favorites.length} saved${savedClips(state) ? '' : ` creator${favorites.length === 1 ? '' : 's'}`}${state.query ? ' matching this search' : ''}`;
            const result = savedClips(state) ? await favoritePage(state, favorites, generation)
                : state.mode === 'favorites' && !state.creator ? { creators: favorites.slice(state.page * 24, (state.page + 1) * 24), more: (state.page + 1) * 24 < favorites.length }
                : await window.__LOWCORD_NATIVE__.redgifsSearch(state.query, state.page + 1,
                    { mode: state.creator ? 'creators' : state.mode, ...(state.niche ? { nicheId: state.niche.id } : {}), ...(state.creator ? { creator: state.creator.id } : {}) });
            if (!alive(state) || generation !== state.generation) return;
            if (result.error) throw new Error(result.error);
            state.page++;
            const ids = new Set(state.items.map(item => item.id));
            for (const source of state.mode === 'niches' ? result.niches : directory(state) ? result.creators : result.items) {
                const item = { ...source };
                if (ids.has(item.id)) continue;
                ids.add(item.id); state.items.push(item);
            }
            renderWindow(state, true);
            state.more.hidden = !result.more;
            state.more.textContent = 'Load more';
            status(state, state.items.length ? '' : savedClips(state) ? state.query ? 'No saved videos match this search.' : 'No saved videos yet. Star a video to add it here.'
                : state.mode === 'favorites' && !state.creator ? state.query ? 'No saved creators match this search.' : 'No saved creators yet. Star a creator to add them here.'
                : state.mode === 'niches' ? 'No niches found. Try another topic.' : directory(state) ? 'No creators found. Try another name.' : 'No videos found. Try another topic or browse Niches.');
        } catch (error) {
            if (alive(state) && generation === state.generation) {
                status(state, errorText(error.message)); state.more.hidden = false; state.more.textContent = 'Retry';
            }
        } finally {
            if (current === state && generation === state.generation) {
                state.loading = false; state.more.disabled = false; state.results.setAttribute('aria-busy', 'false');
            }
        }
    }
    async function favoritePage(state, favorites, generation) {
        const page = favorites.slice(state.page * 24, (state.page + 1) * 24), items = new Array(page.length);
        let next = 0;
        // Refresh at most four IDs at a time; stop requesting on navigation.
        await Promise.all(Array.from({ length: Math.min(4, page.length) }, async () => {
            while (next < page.length && alive(state) && state.generation === generation) {
                const index = next++;
                const favorite = page[index];
                try {
                    const fresh = await window.__LOWCORD_NATIVE__.redgifsResolve(favorite.id);
                    if (fresh.error) throw new Error(fresh.error);
                    items[index] = { ...fresh, id: favorite.id };
                } catch (error) {
                    items[index] = { ...favorite, unavailable: error.message || 'failed' };
                }
            }
        }));
        return { items: items.filter(Boolean), more: (state.page + 1) * 24 < favorites.length };
    }
    function createCard(state, item) {
        if (creatorList(state)) {
            const parts = item.id.split(/[_-]+/).filter(Boolean);
            const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : item.id.slice(0, 2)).toUpperCase();
            let color = 0;
            for (const char of item.id) color = (color * 31 + char.charCodeAt(0)) >>> 0;
            const colors = ['#386b40', '#29689a', '#875e20', '#7052a0', '#237577', '#99455d'];
            item.button = ui('button', { type: 'button', className: 'lowcord-redgifs-creator',
                'aria-label': `Browse creator ${item.name || item.id}`, title: `@${item.id}${item.verified ? ' · Verified' : ''}`,
                onClick: () => mode(state, state.mode, null, item) },
                ui('span', { className: 'lowcord-redgifs-monogram', 'aria-hidden': 'true', style: `background:${colors[color % colors.length]}` }, initials),
                ui('span', { className: 'lowcord-redgifs-creator-copy' },
                    ui('span', { className: 'lowcord-redgifs-creator-name' }, ui('strong', {}, `@${item.id}`),
                        ...(item.verified ? [ui('span', { className: 'lowcord-redgifs-verified', role: 'img', 'aria-label': 'Verified' }, icon('verified', 12))] : [])),
                    ui('span', { className: 'lowcord-redgifs-creator-stats' },
                        ...(item.followers != null ? [ui('span', {}, `${compact.format(item.followers)} followers`)] : []),
                        ...(item.videos != null ? [ui('span', {}, `${compact.format(item.videos)} videos`)] : []))));
            return item.button;
        }
        if (savedClips(state) && item.unavailable) {
            item.button = ui('button', { type: 'button', className: 'lowcord-redgifs-thumb lowcord-redgifs-unavailable',
                'aria-label': `Retry favorite ${item.author || item.id}`, title: errorText(item.unavailable),
                onClick: () => void search(state, true) }, icon('retry', 22), ui('span', {}, 'Retry preview'));
            return item.button;
        }
        if (directory(state) || item.unavailable) {
            const creator = state.mode === 'creators';
            const name = item.name || item.author || item.id;
            const detail = item.unavailable ? `${errorText(item.unavailable)} Click to retry.`
                : [item.videos != null ? `${compact.format(item.videos)} videos` : null,
                    creator ? item.followers != null ? `${compact.format(item.followers)} followers` : null
                        : item.subscribers != null ? `${compact.format(item.subscribers)} members` : null].filter(Boolean).join(' · ');
            item.button = ui('button', { type: 'button', className: 'lowcord-redgifs-niche',
                'aria-label': item.unavailable ? `Retry favorite ${name}` : `Browse ${creator ? 'creator' : 'niche'} ${name}`,
                onClick: () => item.unavailable ? void search(state, true) : creator ? mode(state, 'creators', null, item) : mode(state, 'videos', item) },
                ui('span', { className: 'lowcord-redgifs-niche-icon' }, icon(item.unavailable ? 'retry' : creator ? 'creator' : 'niche', 20)),
                ui('span', { className: 'lowcord-redgifs-niche-copy' }, ui('strong', {}, `${name}${creator && item.verified ? ' · Verified' : ''}`), ui('span', {}, detail)),
                icon('back', 16));
            return item.button;
        }
        const label = item.author ? `Send video by ${item.author}` : `Send video ${item.id}`;
        const ratio = item.width > 0 && item.height > 0 ? Math.max(.25, Math.min(4, item.width / item.height)) : 9 / 16;
        item.timer = ui('span', { className: 'lowcord-redgifs-duration', hidden: item.duration == null }, item.duration != null ? duration(item.duration) : '');
        const button = ui('button', { type: 'button', className: 'lowcord-redgifs-thumb', 'aria-label': label,
            style: `--lowcord-redgifs-ratio:${ratio}`,
            onPointerenter: event => { preview(state, item); state.pointerX = event.clientX; },
            onPointermove: event => scrub(state, item, event), onPointerleave: () => stopPreview(state, item),
            onFocus: () => preview(state, item), onBlur: () => stopPreview(state, item),
            onClick: () => void send(state, item) },
            ...(item.poster ? [ui('img', { src: item.poster, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' })] : []),
            ui('span', { className: 'lowcord-redgifs-play' }, icon('play', 22)),
            item.timer,
            ui('span', { className: 'lowcord-redgifs-progress', 'aria-hidden': 'true' }),
            ...(savedClips(state) ? [] : [ui('span', { className: 'lowcord-redgifs-author' }, item.author || 'Preview video')]));
        item.button = button; syncTile(state, item); return button;
    }
    function renderWindow(state, force = false) {
        if (!alive(state) || state.collapsed) return;
        const width = state.grid.clientWidth || 360, top = state.results.scrollTop;
        const favorites = savedClips(state), creators = creatorList(state);
        const columns = favorites ? 3 : creators ? 2 : 1;
        const tileWidth = (width - (columns - 1) * 8) / columns;
        const gap = favorites ? 6 : 8;
        const offsets = [0];
        for (let index = 0; index < state.items.length; index += columns) {
            const item = state.items[index];
            const ratio = item.width > 0 && item.height > 0 ? Math.max(.25, Math.min(4, item.width / item.height)) : 9 / 16;
            offsets.push(offsets[offsets.length - 1] + (favorites ? tileWidth * 8 / 9 + 18 : creators ? 72 : directory(state) || item.unavailable ? 56 : Math.min(420, width / ratio)) + gap);
        }
        // Grids virtualize whole rows so removing/adding a page cannot
        // shift the remaining cards into the wrong columns.
        const rows = offsets.length - 1, overscan = columns > 1 ? 300 : 900;
        let startRow = 0, endRow;
        while (startRow < rows && offsets[startRow + 1] < top - overscan) startRow++;
        endRow = startRow;
        while (endRow < rows && offsets[endRow] < top + state.results.clientHeight + overscan) endRow++;
        const start = startRow * columns, end = Math.min(state.items.length, endRow * columns);
        if (!force && start === state.windowStart && end === state.windowEnd && width === state.windowWidth) return;
        state.windowStart = start; state.windowEnd = end; state.windowWidth = width;
        for (let i = 0; i < state.items.length; i++) {
            const item = state.items[i];
            if ((i < start || i >= end) && item.card) {
                if (item.card.contains(document.activeElement)) state.results.focus({ preventScroll: true });
                stopPreview(state, item); item.card.remove(); item.card = item.button = item.star = item.timer = null;
            }
        }
        if (!state.topSpacer?.isConnected) {
            state.topSpacer = ui('div', { className: 'lowcord-redgifs-spacer', 'aria-hidden': 'true' });
            state.bottomSpacer = ui('div', { className: 'lowcord-redgifs-spacer', 'aria-hidden': 'true' });
            state.grid.replaceChildren(state.topSpacer, state.bottomSpacer);
        }
        state.topSpacer.style.height = `${offsets[startRow]}px`;
        state.bottomSpacer.style.height = `${Math.max(0, offsets[rows] - offsets[endRow])}px`;
        const cards = state.items.slice(start, end).map((item, index) => {
            if (!item.card) {
                const button = createCard(state, item);
                item.saveKind = state.mode === 'niches' ? 'niches' : creators ? 'creators' : 'favorites';
                item.star = ui('button', { type: 'button', className: 'lowcord-redgifs-star', onClick: () => toggleSaved(item.saveKind, item) });
                updateStar(state, item);
                item.card = ui('div', { className: `lowcord-redgifs-card${!favorites && (directory(state) || item.unavailable) ? ' lowcord-redgifs-niche-card' : ''}` },
                    button, item.star, ...(favorites ? [ui('span', { className: 'lowcord-redgifs-favorite-author', title: item.author || item.id }, item.author ? `@${item.author}` : item.id)] : []));
            }
            const row = Math.floor((start + index) / columns);
            item.card.style.height = `${offsets[row + 1] - offsets[row] - gap}px`;
            return item.card;
        });
        // Keep overlapping cards connected: detaching a playing video would
        // pause it, and detaching a focused button would lose keyboard focus.
        let anchor = state.topSpacer.nextSibling;
        for (const card of cards) {
            if (card === anchor) anchor = anchor.nextSibling;
            else state.grid.insertBefore(card, anchor);
        }
    }
    function uploadFile(file, channelId, signal, progress) {
        return new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const upload = new window.Lowcord.CloudUpload({ file, isThumbnail: false, platform: 1 }, channelId);
            let done = false;
            const finish = (error) => {
                if (done) return;
                done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
                if (error) { try { upload.cancel?.(); } catch {} reject(error); }
                else resolve(upload);
            };
            const abort = () => finish(new Error('cancelled'));
            const timer = setTimeout(() => finish(new Error('upload-failed')), 120_000);
            signal.addEventListener('abort', abort, { once: true });
            upload.on('progress', (value, total) => {
                const ratio = Number.isFinite(total) && total > 0 ? value / total
                    : typeof value === 'number' ? value : value?.total ? value.loaded / value.total : value?.progress;
                if (Number.isFinite(ratio)) progress(Math.max(0, Math.min(100, Math.round(ratio <= 1 ? ratio * 100 : ratio))));
            });
            upload.on('complete', () => { progress(100); finish(); });
            upload.on('error', () => finish(new Error('upload-failed')));
            try { Promise.resolve(upload.upload()).catch(finish); } catch (error) { finish(error); }
        });
    }
    function syncTile(state, item) {
        const identity = `${state.channelId}:${item.id}`;
        const job = transfer.jobs.get(identity);
        item.sent = transfer.sent.has(identity);
        if (!item.button || item.unavailable || directory(state)) return;
        item.button.disabled = Boolean(job && !['failed', 'cancelled'].includes(job.phase)) || item.sent;
        item.button.toggleAttribute('data-queued', job?.phase === 'queued');
        item.button.toggleAttribute('data-sending', Boolean(job && ['preparing', 'uploading', 'posting'].includes(job.phase)));
        item.button.toggleAttribute('data-sent', item.sent);
    }
    function cancelAll() {
        transfer.queue.length = 0;
        transfer.activeJob?.abort.abort(); transfer.jobs.clear();
        window.__LOWCORD_NATIVE__?.redgifsCancel?.('prepare').catch(() => {});
        queueStatus();
    }
    function cancelJob(job) {
        if (job.phase === 'posting') return;
        transfer.queue = transfer.queue.filter(item => item !== job);
        job.abort.abort();
        if (transfer.activeJob === job) window.__LOWCORD_NATIVE__?.redgifsCancel?.('prepare').catch(() => {});
        else transfer.jobs.delete(job.identity);
        job.phase = 'cancelled'; queueStatus();
    }
    function retryJob(job) {
        if (working && transfer.activeJob === job) return;
        job.abort = new AbortController(); job.phase = 'queued'; job.percent = 0;
        transfer.queue.push(job); queueStatus(); void pump();
    }
    function queueStatus() {
        const state = current;
        if (!state) return;
        for (const item of state.items) if (state.mode !== 'niches') syncTile(state, item);
        const jobs = [...transfer.jobs.values()];
        state.queueStatus.hidden = !jobs.length;
        const pauseLabel = transfer.paused ? 'Resume queue' : 'Pause queue';
        state.pause.setAttribute('aria-label', pauseLabel); state.pause.title = pauseLabel;
        setIcon(state.pause, transfer.paused ? 'play' : 'pause');
        const summary = transfer.activeJob && jobs.includes(transfer.activeJob) ? transfer.activeJob : jobs[0];
        const phaseFor = job => {
            const position = transfer.queue.indexOf(job);
            return position >= 0 ? `${transfer.paused ? 'Paused' : 'Waiting'} · #${position + 1}`
                : job.phase === 'uploading' ? `Uploading ${job.percent || 0}%` : job.phase === 'preparing' ? 'Preparing'
                    : job.phase === 'posting' ? 'Sending' : job.phase === 'failed' ? 'Failed' : 'Cancelled';
        };
        state.queueSummary.textContent = summary ? `${phaseFor(summary)} → ${summary.destination}` : '';
        state.queueCount.textContent = String(jobs.length); state.queueCount.hidden = jobs.length < 2;
        if (!jobs.length) { state.queueList.hidden = true; state.queueToggle.setAttribute('aria-expanded', 'false'); }
        state.queueToggle.setAttribute('aria-label', state.queueList.hidden ? 'Show upload queue' : 'Hide upload queue');
        for (const row of [...state.queueList.children]) if (!jobs.some(job => job.identity === row.dataset.id)) row.remove();
        for (const job of jobs) {
            if (!job.row || !job.row.isConnected) {
                job.detail = ui('span', {});
                job.action = ui('button', { type: 'button', className: 'lowcord-redgifs-icon', onClick: () => ['failed', 'cancelled'].includes(job.phase) ? retryJob(job) : cancelJob(job) });
                job.remove = ui('button', { type: 'button', className: 'lowcord-redgifs-icon', 'aria-label': 'Remove', title: 'Remove', onClick: () => { transfer.jobs.delete(job.identity); queueStatus(); } }, icon('remove', 14));
                job.row = ui('div', { className: 'lowcord-redgifs-job', 'data-id': job.identity }, ui('span', { className: 'lowcord-redgifs-job-copy' }, ui('strong', {}, job.label), job.detail), job.action, job.remove);
                state.queueList.append(job.row);
            }
            job.detail.textContent = `${phaseFor(job)} → ${job.destination}`;
            const actionLabel = ['failed', 'cancelled'].includes(job.phase) ? 'Retry' : 'Cancel';
            job.action.setAttribute('aria-label', actionLabel); job.action.title = actionLabel;
            setIcon(job.action, actionLabel === 'Retry' ? 'retry' : 'close');
            job.action.disabled = job.phase === 'posting';
            job.remove.hidden = !['failed', 'cancelled'].includes(job.phase);
            job.row.title = job.error || job.id;
        }
    }
    function send(state, item) {
        const identity = `${state.channelId}:${item.id}`;
        if (!alive(state) || transfer.sent.has(identity) || (transfer.jobs.has(identity) && !['failed', 'cancelled'].includes(transfer.jobs.get(identity).phase))) return;
        if (transfer.jobs.has(identity)) { retryJob(transfer.jobs.get(identity)); return; }
        if (!window.Lowcord.CloudUpload || !window.Lowcord.RestAPI) {
            status(state, 'Discord is still loading its uploader. Try again in a moment.'); return;
        }
        if (transfer.jobs.size >= 10) { extensions.toast('The upload queue is full. Wait for a video to finish.', true); return; }
        const reply = window.Lowcord.store('PendingReplyStore')?.getPendingReply?.(state.channelId);
        const reference = reply ? { channel_id: state.channelId, message_id: reply.message.id,
            ...(reply.channel?.guild_id ? { guild_id: reply.channel.guild_id } : {}) } : undefined;
        const nonce = transfer.nonces.get(identity) ?? String((BigInt(Date.now()) - 1420070400000n) << 22n | (++nonceSequence & 0x3fffffn));
        transfer.nonces.set(identity, nonce);
        while (transfer.nonces.size > 256) transfer.nonces.delete(transfer.nonces.keys().next().value);
        const job = { identity, id: item.id, label: item.author || item.id, key: item.key, channelId: state.channelId, limit: uploadLimit(state.channelId),
            reference, nonce, phase: 'queued', abort: new AbortController(),
            destination: destinationName(state.channelId) };
        transfer.jobs.set(identity, job); transfer.queue.push(job);
        queueStatus(); void pump();
    }
    async function pump() {
        if (working || transfer.paused || !extensions.enabled('redgifsPicker')) return;
        working = true;
        try {
            while (transfer.queue.length && !transfer.paused && extensions.enabled('redgifsPicker')) {
                const job = transfer.queue.shift();
                transfer.activeJob = job; job.phase = 'preparing'; queueStatus();
                let posting = false, handle;
                try {
                    let result = await window.__LOWCORD_NATIVE__.redgifsPrepare(job.key, job.limit);
                    // Only refresh expired capabilities; ordinary clicks reuse
                    // their search metadata without an extra API round trip.
                    if (result.error === 'expired' && window.__LOWCORD_NATIVE__.redgifsResolve) {
                        job.abort.signal.throwIfAborted();
                        const fresh = await window.__LOWCORD_NATIVE__.redgifsResolve(job.id);
                        job.abort.signal.throwIfAborted();
                        if (fresh.error) throw new Error(fresh.error);
                        job.key = fresh.key;
                        result = await window.__LOWCORD_NATIVE__.redgifsPrepare(job.key, job.limit);
                    }
                    handle = result.handle;
                    job.abort.signal.throwIfAborted();
                    if (result.error) throw new Error(result.error);
                    const response = await fetch(result.url, { credentials: 'omit', signal: job.abort.signal });
                    if (!response.ok) throw new Error('expired');
                    const blob = await response.blob();
                    const file = new File([blob], result.name, { type: 'video/mp4' });
                    if (!file.size || file.size >= job.limit) throw new Error('too-large');
                    await window.__LOWCORD_NATIVE__.redgifsRelease(handle); handle = undefined;
                    job.phase = 'uploading'; queueStatus();
                    const upload = await uploadFile(file, job.channelId, job.abort.signal, percent => {
                        if (job.percent !== percent) { job.percent = percent; queueStatus(); }
                    });
                    job.abort.signal.throwIfAborted();
                    posting = true; job.phase = 'posting'; queueStatus();
                    await window.Lowcord.RestAPI.post({ url: `/channels/${job.channelId}/messages`, body: {
                        channel_id: job.channelId, content: '', type: 0, sticker_ids: [], nonce: job.nonce, enforce_nonce: true,
                        attachments: [{ id: '0', filename: upload.filename, uploaded_filename: upload.uploadedFilename }],
                        allowed_mentions: { parse: [], replied_user: false },
                        ...(job.reference ? { message_reference: job.reference } : {}),
                    } });
                    transfer.sent.add(job.identity); transfer.jobs.delete(job.identity);
                    while (transfer.sent.size > 256) transfer.sent.delete(transfer.sent.values().next().value);
                    extensions.toast(`Video sent to ${job.destination}.`);
                    if (current) status(current, 'Video sent.', true);
                } catch (error) {
                    if (job.abort.signal.aborted) job.phase = 'cancelled';
                    else {
                        job.phase = 'failed';
                        job.error = posting ? 'Could not confirm sending. Retry uses the same message nonce to avoid duplicates.'
                            : error.message === 'upload-failed' ? 'Upload failed. Try again.' : errorText(error.message);
                        if (current) status(current, job.error);
                        extensions.toast(job.error, true);
                    }
                } finally {
                    if (handle) await window.__LOWCORD_NATIVE__.redgifsRelease(handle).catch(() => {});
                    transfer.activeJob = null; queueStatus();
                }
            }
        } finally { working = false; }
    }
    function open() {
        if (current) { close(); return; }
        if (!extensions.enabled('redgifsPicker')) return;
        if (!window.__LOWCORD_NATIVE__?.redgifsSearch) { extensions.toast('RedGIFs needs the desktop app.', true); return; }
        const editor = document.querySelector('[class*="channelTextArea_"] [contenteditable="true"][role="textbox"]');
        const channelId = selectedChannel();
        if (!editor || !channelId) { extensions.toast('Open a chat to browse RedGIFs.', true); return; }
        const input = ui('input', { type: 'search', placeholder: 'Search topics', 'aria-label': 'Search RedGIFs', maxlength: '200' });
        const searchButton = ui('button', { type: 'submit', className: 'lowcord-redgifs-search-submit', 'aria-label': 'Search', title: 'Search' }, icon('search', 15));
        const form = ui('form', { className: 'lowcord-redgifs-search', onSubmit: event => {
            event.preventDefault();
            state.niche = null; state.creator = null; void search(state, true);
        }, onKeydown: event => { event.stopPropagation(); } }, input, searchButton);
        const tabs = categories.map(value => ui('button', { type: 'button', role: 'tab',
            className: 'lowcord-redgifs-tab', id: `lowcord-redgifs-tab-${value}`, 'data-mode': value,
            'aria-selected': String(value === 'videos'), 'aria-controls': 'lowcord-redgifs-results', tabindex: value === 'videos' ? '0' : '-1',
            onClick: () => mode(state, value), onKeydown: event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault(); const order = categories;
                const next = order[(order.indexOf(value) + (event.key === 'ArrowLeft' ? order.length - 1 : 1)) % order.length];
                const target = event.key === 'Home' ? 'videos' : event.key === 'End' ? 'favorites' : next;
                mode(state, target); tabs.find(tab => tab.dataset.mode === target).focus();
            } }, categoryNames[value]));
        const tablist = ui('div', { className: 'lowcord-redgifs-tabs', role: 'tablist', 'aria-label': 'Search category' }, ...tabs);
        const heading = ui('span', { className: 'lowcord-redgifs-heading' });
        const back = ui('button', { type: 'button', className: 'lowcord-redgifs-back', 'aria-label': 'Back to niches', hidden: true,
            onClick: () => mode(state, state.creator ? state.mode : 'niches') }, icon('back', 12), 'Niches');
        const favoriteKinds = ui('div', { className: 'lowcord-redgifs-segments', role: 'group', 'aria-label': 'Saved type', hidden: true },
            ...[['clips', 'Clips'], ['creators', 'Creators']].map(([kind, label]) => ui('button', { type: 'button', 'data-kind': kind, 'aria-pressed': String(kind === 'clips'),
                onClick: () => { if (state.favoriteKind !== kind) mode(state, 'favorites', null, null, kind); } }, label, ' ', ui('span', {}))));
        const creatorSave = ui('button', { type: 'button', className: 'lowcord-redgifs-creator-save', hidden: true,
            onClick: () => { if (state.creator) toggleSaved('creators', state.creator); } }, icon('star', 12), ui('span', {}, 'Save'));
        const grid = ui('div', { className: 'lowcord-redgifs-grid', 'aria-label': 'RedGIFs videos' });
        const more = ui('button', { type: 'button', className: 'lowcord-redgifs-more', hidden: true, onClick: () => void search(state, false) }, 'Load more');
        const results = ui('div', { className: 'lowcord-redgifs-results', id: 'lowcord-redgifs-results', role: 'tabpanel', tabindex: '-1',
            'aria-labelledby': 'lowcord-redgifs-tab-videos', onScroll: () => scrolled(state) }, grid, more);
        const video = ui('video', { className: 'lowcord-redgifs-hover-video', loop: '', playsinline: '', preload: 'none', 'aria-hidden': 'true' });
        video.muted = true;
        const pause = ui('button', { type: 'button', className: 'lowcord-redgifs-icon', 'aria-label': 'Pause queue', title: 'Pause queue',
            onClick: () => { transfer.paused = !transfer.paused; queueStatus(); if (!transfer.paused) void pump(); } }, icon('pause', 14));
        const queueSummary = ui('span', { className: 'lowcord-redgifs-queue-summary', role: 'status', 'aria-live': 'polite' });
        const queueCount = ui('span', { className: 'lowcord-redgifs-queue-count', hidden: true });
        const queueList = ui('div', { className: 'lowcord-redgifs-queue-list', id: 'lowcord-redgifs-queue-list', hidden: true });
        const queueToggle = ui('button', { type: 'button', className: 'lowcord-redgifs-queue-toggle',
            'aria-label': 'Show upload queue', 'aria-expanded': 'false', 'aria-controls': 'lowcord-redgifs-queue-list',
            onClick: () => { queueList.hidden = !queueList.hidden; queueToggle.setAttribute('aria-expanded', String(!queueList.hidden));
                queueToggle.setAttribute('aria-label', queueList.hidden ? 'Show upload queue' : 'Hide upload queue'); } },
            icon('upload', 14), queueSummary, queueCount, icon('down', 12));
        const uploadStatus = ui('section', { className: 'lowcord-redgifs-queue', 'aria-label': 'Upload queue', hidden: true },
            queueList, ui('div', { className: 'lowcord-redgifs-queue-bar' }, queueToggle, pause));
        const background = ui('input', { type: 'checkbox', 'aria-label': 'Keep uploading when picker closes', onChange: () => { saved.background = background.checked; persist(); } });
        background.checked = saved.background;
        const preference = ui('label', { className: 'lowcord-redgifs-preference' }, background, 'Keep uploading when picker closes');
        const options = ui('div', { className: 'lowcord-redgifs-options', id: 'lowcord-redgifs-options', hidden: true }, preference,
            ui('p', {}, 'Hover to preview · Move sideways to scrub · Click to send'),
            ui('button', { type: 'button', className: 'lowcord-redgifs-reset', onClick: () => resetLayout(state) }, 'Reset picker size and position'));
        const optionsButton = ui('button', { type: 'button', className: 'lowcord-redgifs-icon', 'aria-label': 'Picker options', title: 'Options',
            'aria-expanded': 'false', 'aria-controls': 'lowcord-redgifs-options', onClick: () => {
                options.hidden = !options.hidden; optionsButton.setAttribute('aria-expanded', String(!options.hidden));
            } }, icon('options', 16));
        const pins = ui('div', { className: 'lowcord-redgifs-pins', 'aria-label': 'Pinned niches', hidden: true });
        const statusNode = ui('p', { className: 'lowcord-redgifs-status', hidden: true, role: 'status', 'aria-live': 'polite' });
        const favoritesHelp = ui('p', { className: 'lowcord-redgifs-favorites-help', hidden: true }, 'Hover to preview · Click to send');
        const closeButton = ui('button', { type: 'button', className: 'lowcord-redgifs-icon', 'aria-label': 'Close RedGIFs', title: 'Close', onClick: close }, icon('close'));
        const collapse = ui('button', { type: 'button', className: 'lowcord-redgifs-icon', 'aria-label': 'Collapse RedGIFs picker', title: 'Collapse picker',
            'aria-expanded': 'true', 'aria-controls': 'lowcord-redgifs-body', onClick: () => collapsePicker(state, !state.collapsed) }, icon('minimize', 14));
        const drag = ui('button', { type: 'button', className: 'lowcord-redgifs-icon lowcord-redgifs-drag', 'aria-label': 'Move RedGIFs picker',
            title: 'Drag to move · Arrow keys to move · Home to reset', onKeydown: event => keyboardLayout(state, event, 'move') }, icon('grip', 16));
        const resize = ui('button', { type: 'button', className: 'lowcord-redgifs-resize', 'aria-label': 'Resize RedGIFs picker',
            title: 'Drag to resize · Arrow keys to resize · Home to reset', onKeydown: event => keyboardLayout(state, event, 'resize'),
            onPointerdown: event => beginGesture(state, event, 'resize') }, icon('resize', 16));
        const resultHeading = ui('div', { className: 'lowcord-redgifs-result-heading', hidden: true }, back, heading, creatorSave);
        const body = ui('div', { className: 'lowcord-redgifs-body', id: 'lowcord-redgifs-body' }, form, tablist, favoriteKinds,
            resultHeading, pins, results, uploadStatus, statusNode, favoritesHelp, options);
        const header = ui('header', { className: 'lowcord-redgifs-titlebar', onPointerdown: event => beginGesture(state, event, 'move') },
            drag, ui('h2', {}, ui('span', {}, 'Red'), 'GIFs'), collapse, closeButton);
        form.append(optionsButton);
        const node = ui('section', { className: 'lowcord-redgifs', role: 'dialog', 'aria-label': 'RedGIFs picker',
            onPointerdown: event => {
                if (!options.hidden && !options.contains(event.target) && !optionsButton.contains(event.target)) {
                    options.hidden = true; optionsButton.setAttribute('aria-expanded', 'false');
                }
            }, onPointermove: event => gestureMove(state, event),
            onPointerup: event => { if (event.pointerId === state.gesture?.pointer) finishGesture(state, true); },
            onPointercancel: () => finishGesture(state, false),
            onLostpointercapture: () => finishGesture(state, true) }, header, body, resize);
        const state = { node, input, searchButton, grid, more, video, status: statusNode,
            editor, channelId, query: '', page: 0, items: [], generation: 0, abort: new AbortController(),
            mode: 'videos', niche: null, creator: null, favoriteKind: 'clips', favoriteKinds, creatorSave, queries: {}, tabs, results, heading, back, queueStatus: uploadStatus,
            pins, pause, queueList, queueToggle, queueSummary, queueCount, resultHeading, favoritesHelp,
            body, header, drag, collapse, resize, options, optionsButton, layout: readLayout(), collapsed: false };
        video.addEventListener('playing', () => { if (state.previewing) state.previewing.button.dataset.previewing = 'true'; });
        for (const event of ['loadeddata', 'seeked']) video.addEventListener(event, () => {
            if (state.previewing && video.readyState >= 2) state.previewing.button.dataset.previewing = 'true';
        });
        for (const event of ['timeupdate', 'durationchange', 'seeked']) video.addEventListener(event, playbackTime.bind(null, state));
        video.addEventListener('seeked', () => {
            if (state.scrubPending) applyScrub(state);
        });
        video.addEventListener('loadedmetadata', () => {
            playbackTime(state);
            if (state.scrubItem && state.scrubItem === state.previewing) {
                if (state.scrubFrame !== undefined) cancelAnimationFrame(state.scrubFrame);
                applyScrub(state);
            }
        });
        state.key = event => {
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopImmediatePropagation();
                if (state.gesture) finishGesture(state, false);
                else if (!options.hidden) { options.hidden = true; optionsButton.setAttribute('aria-expanded', 'false'); optionsButton.focus(); }
                else close();
            }
        };
        state.channelChanged = () => { if (selectedChannel() !== channelId) close(); };
        state.channelStore = window.Lowcord.store('SelectedChannelStore');
        state.channelStore?.addChangeListener?.(state.channelChanged);
        state.visibility = () => {
            if (document.hidden) stopPreview(state);
        };
        state.blur = () => finishGesture(state, false);
        state.place = () => {
            if (!editor.isConnected || selectedChannel() !== channelId) { close(); return; }
            placePicker(state);
        };
        current = state; document.body.append(node); state.place();
        state.stopDom = window.Lowcord.onDomChange(() => { if (current === state && (!editor.isConnected || selectedChannel() !== channelId)) close(); });
        window.addEventListener('keydown', state.key, true);
        window.addEventListener('resize', state.place);
        window.addEventListener('blur', state.blur);
        document.addEventListener('visibilitychange', state.visibility);
        pinned(state); queueStatus(); input.focus(); void search(state, true);
    }
    window.addEventListener(extensions.changeEvent, () => { if (!extensions.enabled('redgifsPicker')) { close(); cancelAll(); } });
    extensions.addComposerAction({ id: 'redgifsPicker', order: 5, label: 'RedGIFs',
        path: 'M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm5 4v10l8-5-8-5Z', run: open });
    window.Lowcord.redgifs = { open, close, busy: () => working || transfer.queue.length > 0 };
    window.addEventListener('pagehide', cancelAll);
})();
