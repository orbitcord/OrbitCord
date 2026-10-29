// The Reddit picker is created only on demand. Listings and media go through
// main-process requests in Reddit's own session; the only Discord integration
// is its existing file uploader and REST client, as in the RedGIFs picker.
(() => {
    const { extensions, storage } = window.Lowcord;
    const { ui } = extensions;
    const native = (action, ...args) => window.__LOWCORD_NATIVE__.reddit(action, ...args);
    let current, working = false, nonceSequence = 0n, account;
    const transfer = { queue: [], jobs: new Map(), sent: new Set(), active: null };
    const storageKey = 'lowcord.reddit.saved.v1', layoutKey = 'lowcord.reddit.layout.v1';
    const tabs = ['home', 'popular', 'subreddits', 'saved'];
    const tabNames = { home: 'Home', popular: 'Popular', subreddits: 'Subreddits', saved: 'Saved' };
    const sortOptions = [['hot', 'week', 'Hot'], ['new', 'week', 'New'], ['top', 'week', 'Top · week'], ['top', 'all', 'Top · all time'], ['rising', 'week', 'Rising']];
    let saved;
    // Discord deletes window.localStorage during startup; use the handle
    // retained by Lowcord's preload, as the other settings pages do.
    try { saved = JSON.parse(storage.getItem(storageKey)); } catch {}
    saved = { subreddits: Array.isArray(saved?.subreddits) ? saved.subreddits.filter(name => typeof name === 'string' && /^[a-z0-9_]{2,21}$/i.test(name)).slice(0, 30) : [],
        spoilerNsfw: saved?.spoilerNsfw === true };
    function persist() { try { storage.setItem(storageKey, JSON.stringify(saved)); } catch { extensions.toast('Could not save Reddit preferences.', true); } }

    const paths = {
        close: 'M6 6l12 12M18 6 6 18', search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', back: 'm14 6-6 6 6 6',
        star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z', play: 'm9 5 11 7-11 7Z',
        options: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6', resize: 'm21 9-12 12m12-6-6 6', upload: 'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',
        user: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0', check: 'm5 12 5 5 9-10', next: 'm10 6 6 6-6 6', grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
    };
    function icon(name, size = 14) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
            'stroke-width': name === 'grip' ? '3' : '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) node.setAttribute(key, value);
        const path = document.createElementNS(node.namespaceURI, 'path'); path.setAttribute('d', paths[name]); node.append(path);
        return node;
    }
    const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
    const duration = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const selectedChannel = () => window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    const messages = {
        'ffmpeg-missing': 'This video is over the upload limit. Install FFmpeg to compress it, then try again.',
        'encode-busy': 'Another video is being compressed. Try again when it finishes.',
        'busy': 'Cancelling the previous post. Try again in a moment.',
        'encode-timeout': 'Compression took too long. Try a shorter video.',
        'unsupported-duration': 'This video cannot be compressed. Choose a video under ten minutes.',
        'too-large': 'This post is still over the upload limit after compression. Choose another post.',
        'expired': 'This preview expired. Search again to refresh it.',
        'rate-limited': 'Reddit is limiting requests. Wait a moment and try again.',
        'forbidden': 'Reddit blocked this request. The community may be private, banned or require you to sign in.',
        'not-found': 'Reddit could not find this community.',
        'signed-out': 'Log in to Reddit to see your saved posts.',
    };
    const errorText = code => messages[code] || 'Could not load Reddit. Try again.';
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
    const alive = state => current === state && extensions.enabled('redditPicker') && selectedChannel() === state.channelId;
    const directory = state => state.mode === 'subreddits' && !state.subreddit;

    // ----- Layout: drag the title bar, resize from the corner ---------------
    function readLayout() {
        try {
            const value = JSON.parse(storage.getItem(layoutKey));
            if (value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
                && value.width >= 320 && value.width <= 720 && value.height >= 320 && value.height <= 960) return value;
        } catch {}
        return null;
    }
    function place(state) {
        const size = state.layout || { width: 440, height: 680 };
        state.node.style.width = `min(${size.width}px, calc(100vw - 32px))`;
        state.node.style.height = `min(${size.height}px, calc(100vh - 32px))`;
        for (const [axis, edge, viewport, length] of [['x', 'left', 'vw', 'width'], ['y', 'top', 'vh', 'height']]) {
            state.node.style[edge] = state.layout ? `clamp(16px, ${state.layout[axis]}px, calc(100${viewport} - min(${size[length]}px, calc(100${viewport} - 32px)) - 16px))` : '';
        }
        state.node.style.right = state.node.style.bottom = state.layout ? 'auto' : '';
    }
    function snapshot(state) {
        const box = state.node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: Math.max(320, box.width), height: Math.max(320, box.height) };
    }
    function moved(state, start, action, dx, dy) {
        state.layout = action === 'move' ? { ...start,
            x: Math.max(16, Math.min(innerWidth - state.node.offsetWidth - 16, start.x + dx)),
            y: Math.max(16, Math.min(innerHeight - state.node.offsetHeight - 16, start.y + dy)) }
            : { ...start, width: Math.max(320, Math.min(720, innerWidth - start.x - 16, start.width + dx)),
                height: Math.max(320, Math.min(960, innerHeight - start.y - 16, start.height + dy)) };
        place(state);
    }
    function saveLayout(state) {
        try { if (state.layout) storage.setItem(layoutKey, JSON.stringify(state.layout)); else storage.removeItem(layoutKey); } catch {}
    }
    function beginGesture(state, event, action) {
        if (event.button !== 0 || (action === 'move' && event.target.closest('button:not(.lowcord-reddit-drag)'))) return;
        event.preventDefault();
        const control = event.currentTarget, start = snapshot(state), x = event.clientX, y = event.clientY;
        stopPreview(state);
        state.node.dataset.gesture = action;
        control.setPointerCapture(event.pointerId);
        const move = next => moved(state, start, action, next.clientX - x, next.clientY - y);
        const end = () => {
            control.removeEventListener('pointermove', move); control.removeEventListener('lostpointercapture', end);
            delete state.node.dataset.gesture; saveLayout(state);
        };
        control.addEventListener('pointermove', move); control.addEventListener('lostpointercapture', end);
    }
    function keyboardLayout(state, event, action) {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Home') state.layout = null, place(state);
        else {
            const step = event.shiftKey ? 40 : 10;
            moved(state, snapshot(state), action, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
                event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
        }
        saveLayout(state);
    }

    // ----- Browsing -----------------------------------------------------------
    function status(state, value) {
        if (current !== state) return;
        state.status.textContent = value; state.status.hidden = !value;
    }
    function showAccount(state) {
        state.accountButton.replaceChildren(icon('user'), ui('span', {}, account ? `u/${account.name}` : 'Log in'));
        state.accountButton.setAttribute('aria-label', account ? `Signed in as u/${account.name}. Account options` : 'Log in to Reddit');
        state.logout.hidden = !account;
        state.accountNote.textContent = account ? `Signed in as u/${account.name}. Reddit's mature content setting applies.`
            : 'Not signed in. Log in to see your feed, subscriptions and saved posts.';
    }
    async function login(state) {
        status(state, 'Finish logging in to Reddit in the new window.');
        const result = await native('login').catch(() => ({ error: 'failed' }));
        if (result.error) { status(state, errorText(result.error)); return; }
        account = result.account;
        if (current !== state) return;
        showAccount(state); status(state, account ? '' : 'Reddit login was closed before signing in.');
        void search(state, true);
    }
    async function logout(state) {
        state.options.hidden = true;
        const result = await native('logout').catch(() => ({ error: 'failed' }));
        if (result.error) { status(state, 'Could not log out of Reddit. Try again.'); return; }
        account = null;
        if (current !== state) return;
        showAccount(state); extensions.toast('Logged out of Reddit.');
        void search(state, true);
    }
    function pins(state) {
        state.pins.replaceChildren(...saved.subreddits.map(name => ui('button', { type: 'button',
            'aria-current': String(state.subreddit === name), onClick: () => openSubreddit(state, name) }, `r/${name}`)));
        state.pins.hidden = !saved.subreddits.length || state.mode === 'saved';
    }
    function toggleSubreddit(state, name) {
        const index = saved.subreddits.findIndex(value => value.toLowerCase() === name.toLowerCase());
        if (index >= 0) saved.subreddits.splice(index, 1);
        else if (saved.subreddits.length < 30) saved.subreddits.push(name);
        else { extensions.toast('You can pin up to 30 subreddits. Remove one first.', true); return; }
        persist();
        if (current === state) { pins(state); heading(state); for (const item of state.items) if (item.star) updateStar(item); }
    }
    const pinnedName = name => saved.subreddits.some(value => value.toLowerCase() === name.toLowerCase());
    function updateStar(item) {
        const on = pinnedName(item.id);
        item.star.setAttribute('aria-pressed', String(on));
        item.star.setAttribute('aria-label', `${on ? 'Unpin' : 'Pin'} r/${item.id}`);
    }
    function heading(state) {
        state.back.hidden = !state.subreddit;
        state.pin.hidden = !state.subreddit;
        if (state.subreddit) {
            const on = pinnedName(state.subreddit);
            state.pin.setAttribute('aria-pressed', String(on));
            state.pin.setAttribute('aria-label', `${on ? 'Unpin' : 'Pin'} r/${state.subreddit}`);
        }
        state.heading.textContent = state.subreddit ? `r/${state.subreddit}${state.query ? ` · "${state.query}"` : ''}`
            : state.query ? directory(state) ? `Subreddits for "${state.query}"` : `Posts for "${state.query}"`
            : { home: account ? 'Your home feed' : 'Popular posts', popular: 'Popular posts',
                subreddits: account ? 'Your subscriptions' : 'Popular subreddits', saved: 'Your saved posts' }[state.mode];
        state.sort.hidden = directory(state) || (state.mode === 'saved' && !state.subreddit);
    }
    function setMode(state, value) {
        if (!alive(state)) return;
        state.mode = value; state.subreddit = null; state.input.value = '';
        for (const tab of state.tabs) { const on = tab.dataset.mode === value; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; }
        state.input.placeholder = value === 'subreddits' ? 'Search subreddits' : 'Search posts';
        void search(state, true);
    }
    function openSubreddit(state, name) {
        if (!alive(state)) return;
        state.parentMode = state.subreddit ? state.parentMode : state.mode;
        state.subreddit = name; state.input.value = ''; state.input.placeholder = `Search r/${name}`;
        void search(state, true);
    }
    async function search(state, reset) {
        if (!alive(state) || (state.loading && !reset) || (!reset && !state.after)) return;
        const generation = ++state.generation;
        if (reset) {
            closeGallery(state); stopPreview(state);
            state.query = state.input.value.trim(); state.after = null; state.items = []; state.ids = new Set(); state.pagesWithoutMedia = 0;
            state.grid.replaceChildren(); state.results.scrollTop = 0;
        }
        state.grid.classList.toggle('lowcord-reddit-communities', directory(state));
        heading(state); pins(state);
        state.loading = true; state.more.hidden = true; state.signin.hidden = true;
        state.results.setAttribute('aria-busy', 'true');
        status(state, directory(state) ? 'Finding subreddits…' : 'Finding posts…');
        try {
            const [sort, time] = state.sort.value.split(':');
            const result = await native('search', state.query, state.after,
                { mode: state.mode, sort, time, ...(state.subreddit ? { subreddit: state.subreddit } : {}) });
            if (!alive(state) || generation !== state.generation) return;
            if (result.error) throw new Error(result.error);
            if (result.account?.name !== account?.name) { account = result.account; showAccount(state); heading(state); }
            state.after = result.after;
            const cards = [];
            for (const item of directory(state) ? result.communities : result.items) {
                if (state.ids.has(item.id) || state.items.length >= 500) continue;
                state.ids.add(item.id); state.items.push(item); cards.push(card(state, item));
            }
            state.grid.append(...cards);
            state.more.hidden = !state.after || state.items.length >= 500;
            state.more.textContent = 'Load more';
            // Text-only pages can leave nothing to show; read on until media appears.
            if (!cards.length && state.after && state.pagesWithoutMedia++ < 3) { state.loading = false; return search(state, false); }
            state.pagesWithoutMedia = 0;
            status(state, state.items.length ? '' : directory(state) ? 'No subreddits found. Try another name.'
                : state.mode === 'saved' ? 'No saved posts with photos or videos.' : 'No photo or video posts here. Try another sort or subreddit.');
        } catch (error) {
            if (alive(state) && generation === state.generation) {
                status(state, errorText(error.message));
                if (error.message !== 'signed-out') { state.more.hidden = false; state.more.textContent = 'Retry'; }
                state.signin.hidden = error.message !== 'signed-out';
            }
        } finally {
            if (current === state && generation === state.generation) {
                state.loading = false; state.results.setAttribute('aria-busy', 'false');
            }
        }
    }
    function card(state, item) {
        if (directory(state)) {
            item.star = ui('button', { type: 'button', className: 'lowcord-reddit-star', onClick: () => toggleSubreddit(state, item.id) }, icon('star'));
            updateStar(item);
            return ui('div', { className: 'lowcord-reddit-community' },
                ui('button', { type: 'button', className: 'lowcord-reddit-community-open', 'aria-label': `Browse ${item.name}`, onClick: () => openSubreddit(state, item.id) },
                    ui('strong', {}, item.name, ...(item.nsfw ? [ui('span', { className: 'lowcord-reddit-nsfw' }, 'NSFW')] : [])),
                    ui('span', {}, [item.subscribers != null ? `${compact.format(item.subscribers)} members` : '', item.title].filter(Boolean).join(' · '))),
                item.star);
        }
        const badge = item.kind === 'gallery' ? `Gallery · ${item.count}${item.animated ? ` · ${item.animated} GIF${item.animated > 1 ? 's' : ''}` : ''}` : item.kind === 'redgifs' ? 'RedGIFs'
            : item.kind === 'gif' ? 'GIF' : item.kind === 'video' ? item.duration ? duration(item.duration) : 'Video' : '';
        item.button = ui('button', { type: 'button', className: 'lowcord-reddit-tile',
            'aria-label': item.kind === 'gallery' ? `Open gallery of ${item.count} from r/${item.subreddit}: ${item.title}`
                : `Send ${item.kind} from r/${item.subreddit}: ${item.title}`, title: item.title,
            onPointerenter: () => preview(state, item), onPointerleave: () => stopPreview(state, item),
            onFocus: () => preview(state, item), onBlur: () => stopPreview(state, item),
            onClick: () => item.kind === 'gallery' ? openGallery(state, item) : send(state, item),
            onContextmenu: event => item.kind === 'gallery' && galleryMenu(state, event, item) },
            ...(item.poster ? [ui('img', { src: item.poster, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' })] : []),
            ui('span', { className: 'lowcord-reddit-badges' }, ...(item.nsfw ? [ui('span', { className: 'lowcord-reddit-nsfw' }, 'NSFW')] : []),
                ...(badge ? [ui('span', {}, badge)] : [])),
            ...(item.preview || item.redgifs || item.animation ? [ui('span', { className: 'lowcord-reddit-play' }, icon('play', 20))] : []),
            ui('span', { className: 'lowcord-reddit-caption' }, ui('strong', {}, item.title || 'Untitled'), ui('span', {}, `r/${item.subreddit}`)));
        sync(state, item);
        return item.button;
    }
    function stopPreview(state, item) {
        if (item && state.previewing !== item && state.previewTarget !== item) return;
        clearTimeout(state.previewTimer);
        if (state.previewing) delete state.previewing.button.dataset.previewing;
        const still = state.previewTarget?.button?.querySelector('img[data-animated]');
        if (still) { still.src = state.previewTarget.poster; delete still.dataset.animated; }
        state.previewing = state.previewTarget = null;
        state.video.pause(); state.video.removeAttribute('src'); state.video.load(); state.video.remove();
    }
    function preview(state, item) {
        if (!alive(state) || document.hidden || state.node.dataset.gesture || state.previewTarget === item
            || !(item.preview || item.redgifs || item.animation) || !item.button || item.button.disabled) return;
        stopPreview(state);
        state.previewTarget = item;
        // A brief hover intent avoids opening streams while crossing tiles.
        state.previewTimer = setTimeout(async () => {
            if (!alive(state) || state.previewTarget !== item || !item.button.isConnected) return;
            const image = item.button.querySelector('img');
            if (item.animation && image) { image.dataset.animated = ''; image.src = item.animation; return; }
            // RedGIFs links play RedGIFs' own preview, looked up on first hover.
            if (!item.preview && item.redgifs) {
                const found = await window.__LOWCORD_NATIVE__.redgifsResolve?.(item.redgifs).catch(() => null);
                if (!found?.preview || found.error) return;
                item.preview = found.preview;
                if (!alive(state) || state.previewTarget !== item) return;
            }
            state.previewing = item;
            state.video.src = item.preview; item.button.append(state.video);
            state.video.play().catch(() => {});
        }, 160);
    }

    // ----- Right-click menu ------------------------------------------------------
    function closeMenu(state) { state.menu?.remove(); state.menu = null; }
    function contextMenu(state, event, entries) {
        event.preventDefault(); event.stopPropagation();
        closeMenu(state);
        const menu = state.menu = ui('div', { className: 'lowcord-reddit-menu', role: 'menu', onKeydown: keyEvent => {
            const items = [...menu.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
            if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') { keyEvent.preventDefault(); items[(index + (keyEvent.key === 'ArrowUp' ? items.length - 1 : 1)) % items.length]?.focus(); }
            else if (keyEvent.key === 'Tab') closeMenu(state);
        } }, ...entries.map(([label, action, disabled]) => ui('button', { type: 'button', role: 'menuitem', disabled: Boolean(disabled),
            onClick: () => { closeMenu(state); action(); } }, label)));
        state.node.append(menu);
        const bounds = state.node.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(event.clientX - bounds.left, bounds.width - menu.offsetWidth - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(event.clientY - bounds.top, bounds.height - menu.offsetHeight - 4))}px`;
        menu.querySelector('button')?.focus({ preventScroll: true });
    }
    const sendLabel = (item, entry) => `Send this ${entry?.animated ? 'GIF' : entry?.type === 'video' ? 'video' : 'image'}`;
    function sendSome(state, item, selection) {
        if (!selection.length) return;
        // A single item keeps the gallery open so more can be sent one by one.
        if (selection.length > 1 && state.gallery?.item === item) closeGallery(state);
        send(state, item, selection);
        if (state.gallery?.item === item) status(state, `Sending item ${selection[0] + 1} of ${item.items.length}…`);
    }
    function galleryMenu(state, event, item) {
        const first = item.items?.[0];
        if (!first) return;
        contextMenu(state, event, [
            [sendLabel(item, first).replace('this', 'the first'), () => sendSome(state, item, [first.index])],
            [`Send all ${Math.min(10, item.items.length)}`, () => sendSome(state, item, item.items.slice(0, 10).map(entry => entry.index))],
            ['Open gallery', () => openGallery(state, item)],
        ]);
    }
    function itemMenu(state, event, view, position) {
        const entry = view.item.items[position], picked = view.picked.has(entry.index);
        contextMenu(state, event, [
            [sendLabel(view.item, entry), () => sendSome(state, view.item, [entry.index])],
            [picked ? 'Remove from selection' : 'Add to selection', () => pick(state, view, entry.index), !picked && view.picked.size >= 10],
            [`Send all ${Math.min(10, view.item.items.length)}`, () => sendSome(state, view.item, view.item.items.slice(0, 10).map(item => item.index))],
        ]);
    }

    // ----- Gallery: view each item, send it or pick several --------------------
    // One media element at a time; the strip shows Reddit's small stills.
    function openGallery(state, item) {
        if (!alive(state) || !item.items?.length) return;
        closeGallery(state);
        stopPreview(state);
        const view = { item, index: 0, picked: new Set() };
        view.stage = ui('div', { className: 'lowcord-reddit-stage', onContextmenu: event => itemMenu(state, event, view, view.index) });
        view.counter = ui('span', { className: 'lowcord-reddit-counter' });
        view.toggle = ui('button', { type: 'button', className: 'lowcord-reddit-pick', onClick: () => pick(state, view, item.items[view.index].index) });
        view.sendOne = ui('button', { type: 'button', className: 'lowcord-reddit-send-one', onClick: () => sendSome(state, item, [item.items[view.index].index]) });
        view.previous = ui('button', { type: 'button', className: 'lowcord-reddit-nav lowcord-reddit-previous', 'aria-label': 'Previous item',
            onClick: () => show(state, view, view.index - 1) }, icon('back', 18));
        view.next = ui('button', { type: 'button', className: 'lowcord-reddit-nav lowcord-reddit-next', 'aria-label': 'Next item',
            onClick: () => show(state, view, view.index + 1) }, icon('next', 18));
        view.thumbs = item.items.map((entry, position) => {
            const check = ui('span', { className: 'lowcord-reddit-check', title: 'Select', onClick: event => { event.stopPropagation(); pick(state, view, entry.index); } }, icon('check', 12));
            const button = ui('button', { type: 'button', role: 'option', className: 'lowcord-reddit-thumb', onClick: event => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey) pick(state, view, entry.index);
                    show(state, view, position);
                }, onDblclick: () => sendSome(state, item, [entry.index]), onContextmenu: event => itemMenu(state, event, view, position) },
                entry.thumb ? ui('img', { src: entry.thumb, alt: '', loading: 'lazy', draggable: 'false' }) : ui('span', { className: 'lowcord-reddit-thumb-empty' }, icon('play', 14)),
                ...(entry.animated ? [ui('span', { className: 'lowcord-reddit-thumb-gif' }, 'GIF')] : []), check);
            return button;
        });
        view.strip = ui('div', { className: 'lowcord-reddit-strip', role: 'listbox', 'aria-label': 'Gallery items', 'aria-multiselectable': 'true' }, ...view.thumbs);
        view.all = ui('button', { type: 'button', className: 'lowcord-reddit-link', onClick: () => {
            view.picked = new Set(view.picked.size ? [] : item.items.slice(0, 10).map(entry => entry.index));
            refresh(state, view);
        } });
        view.note = ui('span', { className: 'lowcord-reddit-gallery-note' });
        view.send = ui('button', { type: 'button', className: 'lowcord-reddit-send', onClick: () => {
            sendSome(state, item, view.picked.size ? [...view.picked].sort((a, b) => a - b) : item.items.slice(0, 10).map(entry => entry.index));
        } });
        view.node = ui('div', { className: 'lowcord-reddit-gallery', role: 'group', 'aria-label': `Gallery: ${item.title}`, tabindex: '-1',
            onKeydown: event => {
                if (event.target.closest('video, .lowcord-reddit-menu')) return;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(state, view, view.index + (event.key === 'ArrowLeft' ? -1 : 1)); }
                else if (event.key === ' ' && !event.target.closest('button')) { event.preventDefault(); pick(state, view, item.items[view.index].index); }
                else if (event.key === 'Enter' && !event.target.closest('button')) { event.preventDefault(); sendSome(state, item, [item.items[view.index].index]); }
            } },
            ui('div', { className: 'lowcord-reddit-gallery-bar' },
                ui('button', { type: 'button', className: 'lowcord-reddit-back', onClick: () => closeGallery(state) }, icon('back', 12), 'Back'),
                ui('span', { className: 'lowcord-reddit-gallery-title', title: item.title }, item.title || 'Gallery'), view.counter),
            ui('div', { className: 'lowcord-reddit-viewer' }, view.stage, view.previous, view.next, view.toggle, view.sendOne),
            view.strip,
            ui('div', { className: 'lowcord-reddit-gallery-actions' }, view.all, view.note, view.send));
        state.gallery = view;
        state.node.append(view.node);
        show(state, view, 0);
        view.node.focus({ preventScroll: true });
    }
    function closeGallery(state) {
        const view = state.gallery;
        if (!view) return;
        closeMenu(state);
        state.gallery = null;
        const media = view.stage.firstChild;
        if (media?.tagName === 'VIDEO') { media.pause(); media.removeAttribute('src'); media.load(); }
        view.node.remove();
        view.item.button?.focus({ preventScroll: true });
    }
    function show(state, view, index) {
        const items = view.item.items;
        view.index = (index + items.length) % items.length;
        const entry = items[view.index];
        const old = view.stage.firstChild;
        if (old?.tagName === 'VIDEO') { old.pause(); old.removeAttribute('src'); old.load(); }
        // Animated items loop silently, as they play on Reddit.
        const media = entry.type === 'video'
            ? ui('video', { src: entry.src, autoplay: '', loop: '', playsinline: '', controls: '', 'aria-label': `Item ${view.index + 1}` })
            : ui('img', { src: entry.src, alt: `Item ${view.index + 1}`, draggable: 'false' });
        if (media.tagName === 'VIDEO') { media.muted = true; media.play().catch(() => {}); }
        view.stage.replaceChildren(media);
        view.thumbs.forEach((thumb, position) => thumb.toggleAttribute('data-current', position === view.index));
        view.thumbs[view.index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        view.previous.hidden = view.next.hidden = items.length < 2;
        refresh(state, view);
    }
    function pick(state, view, index) {
        if (view.picked.has(index)) view.picked.delete(index);
        else if (view.picked.size < 10) view.picked.add(index);
        else { status(state, 'Discord sends at most 10 files in one message. Unselect one first.'); return; }
        refresh(state, view);
    }
    function refresh(state, view) {
        const items = view.item.items, entry = items[view.index], on = view.picked.has(entry.index);
        view.counter.textContent = `${view.index + 1} / ${items.length}`;
        view.toggle.replaceChildren(icon('check', 12), on ? 'Selected' : 'Select');
        view.toggle.setAttribute('aria-pressed', String(on));
        const single = transfer.jobs.get(`${state.channelId}:${view.item.id}:${entry.index}`), done = transfer.sent.has(`${state.channelId}:${view.item.id}:${entry.index}`);
        view.sendOne.disabled = done || Boolean(single && single.phase !== 'failed');
        view.sendOne.replaceChildren(icon(done ? 'check' : 'upload', 12), done ? 'Sent' : single && single.phase !== 'failed' ? 'Sending\u2026' : single ? 'Retry' : sendLabel(view.item, entry));
        view.thumbs.forEach((thumb, position) => {
            const picked = view.picked.has(items[position].index);
            thumb.setAttribute('aria-selected', String(picked));
            thumb.setAttribute('aria-label', `Item ${position + 1}${items[position].animated ? ', GIF' : ''}${picked ? ', selected' : ''}`);
        });
        view.all.textContent = view.picked.size ? 'Clear selection' : items.length > 10 ? 'Select first 10' : 'Select all';
        view.note.textContent = view.picked.size ? `${view.picked.size} selected` : 'Right-click an item for more';
        view.send.textContent = view.picked.size ? `Send ${view.picked.size} selected` : `Send all ${Math.min(10, items.length)}`;
    }

    // ----- Sending ------------------------------------------------------------
    // A gallery can be sent again with other items, so its tile stays open.
    function sync(state, item) {
        if (!item.button) return;
        const prefix = `${state.channelId}:${item.id}`;
        const mine = identity => identity === prefix || identity.startsWith(`${prefix}:`);
        const job = [...transfer.jobs.values()].find(entry => mine(entry.identity));
        const sent = [...transfer.sent].some(mine);
        item.button.disabled = item.kind !== 'gallery' && (Boolean(job && job.phase !== 'failed') || sent);
        item.button.dataset.state = job ? job.phase : sent ? 'sent' : '';
        if (state.gallery?.item === item) refresh(state, state.gallery);
    }
    function queueStatus() {
        const state = current;
        if (!state) return;
        if (!directory(state)) for (const item of state.items) sync(state, item);
        const jobs = [...transfer.jobs.values()].filter(job => job.phase !== 'failed');
        state.queue.hidden = !jobs.length;
        const job = transfer.active ?? jobs[0];
        if (!job) return;
        const phase = job.phase === 'preparing' ? job.compressing ? 'Downloading and compressing' : 'Downloading'
            : job.phase === 'uploading' ? `Uploading ${job.percent || 0}%` : job.phase === 'posting' ? 'Sending' : 'Waiting';
        state.queueText.textContent = `${phase} → ${job.destination}${jobs.length > 1 ? ` · ${jobs.length - 1} more` : ''}`;
        state.queueCancel.disabled = job.phase === 'posting';
    }
    function cancelAll() {
        transfer.queue.length = 0;
        transfer.active?.abort.abort();
        transfer.jobs.clear();
        window.__LOWCORD_NATIVE__?.reddit?.('cancel', 'prepare').catch(() => {});
        window.__LOWCORD_NATIVE__?.redgifsCancel?.('prepare').catch(() => {});
        queueStatus();
    }
    function send(state, item, selection = null) {
        const identity = `${state.channelId}:${item.id}${selection ? `:${selection.join(',')}` : ''}`, failed = transfer.jobs.get(identity);
        if (!alive(state) || transfer.sent.has(identity) || (failed && failed.phase !== 'failed')) return;
        // A retry keeps its nonce, so a send that did reach Discord is not repeated.
        if (failed) { failed.phase = 'queued'; failed.percent = 0; transfer.queue.push(failed); queueStatus(); void pump(); return; }
        if (!window.Lowcord.CloudUpload || !window.Lowcord.RestAPI) { status(state, 'Discord is still loading its uploader. Try again in a moment.'); return; }
        // Failed jobs wait for a retry click; they do not fill the queue.
        if ([...transfer.jobs.values()].filter(entry => entry.phase !== 'failed').length >= 10) { extensions.toast('The upload queue is full. Wait for a post to finish.', true); return; }
        while (transfer.jobs.size >= 50) transfer.jobs.delete(transfer.jobs.keys().next().value);
        const reply = window.Lowcord.store('PendingReplyStore')?.getPendingReply?.(state.channelId);
        const reference = reply ? { channel_id: state.channelId, message_id: reply.message.id,
            ...(reply.channel?.guild_id ? { guild_id: reply.channel.guild_id } : {}) } : undefined;
        const job = { identity, item, channelId: state.channelId, limit: uploadLimit(state.channelId), reference, phase: 'queued',
            nonce: String((BigInt(Date.now()) - 1420070400000n) << 22n | (++nonceSequence & 0x3fffffn)),
            spoiler: saved.spoilerNsfw && (item.nsfw || item.spoiler), selection, abort: new AbortController(), destination: destinationName(state.channelId) };
        transfer.jobs.set(identity, job); transfer.queue.push(job);
        queueStatus(); void pump();
    }
    function uploadFile(file, channelId, signal, progress) {
        return new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const upload = new window.Lowcord.CloudUpload({ file, isThumbnail: false, platform: 1 }, channelId);
            let done = false;
            const finish = error => {
                if (done) return;
                done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
                if (error) { try { upload.cancel?.(); } catch {} reject(error); } else resolve(upload);
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
    // Prepared files as File objects. RedGIFs links go through its own service.
    async function prepare(job) {
        const signal = job.abort.signal, nativeApi = window.__LOWCORD_NATIVE__;
        if (job.item.redgifs) {
            const found = await nativeApi.redgifsResolve(job.item.redgifs);
            if (found.error) throw new Error(found.error);
            signal.throwIfAborted();
            const result = await nativeApi.redgifsPrepare(found.key, job.limit);
            if (result.error) throw new Error(result.error);
            try { return [await fetchFile(result.url, result.name, result.type, signal)]; }
            finally { await nativeApi.redgifsRelease(result.handle).catch(() => {}); }
        }
        const selection = job.selection ?? undefined;
        let result = await native('prepare', job.item.key, job.limit, selection);
        if (result.error === 'expired') {
            signal.throwIfAborted();
            const fresh = await native('resolve', job.item.id);
            if (fresh.error) throw new Error(fresh.error);
            job.item.key = fresh.key;
            result = await native('prepare', job.item.key, job.limit, selection);
        }
        if (result.error) throw new Error(result.error);
        try {
            const files = [];
            for (const file of result.files) files.push(await fetchFile(file.url, file.name, file.type, signal));
            return files;
        } finally { await native('release', result.handle).catch(() => {}); }
    }
    async function fetchFile(url, name, type, signal) {
        const response = await fetch(url, { credentials: 'omit', signal });
        if (!response.ok) throw new Error('expired');
        return new File([await response.blob()], name, { type });
    }
    async function pump() {
        if (working || !extensions.enabled('redditPicker')) return;
        working = true;
        try {
            while (transfer.queue.length && extensions.enabled('redditPicker')) {
                const job = transfer.queue.shift();
                transfer.active = job; job.phase = 'preparing'; queueStatus();
                // Compression can take a while; say so once it is plausible.
                const slow = setTimeout(() => { job.compressing = true; queueStatus(); }, 4000);
                let posting = false;
                try {
                    const files = (await prepare(job)).map(file => job.spoiler && !file.name.startsWith('SPOILER_')
                        ? new File([file], `SPOILER_${file.name}`, { type: file.type }) : file);
                    clearTimeout(slow);
                    job.abort.signal.throwIfAborted();
                    if (!files.length || files.some(file => !file.size || file.size >= job.limit)) throw new Error('too-large');
                    job.phase = 'uploading'; queueStatus();
                    const uploads = [];
                    for (const [index, file] of files.entries()) {
                        uploads.push(await uploadFile(file, job.channelId, job.abort.signal, percent => {
                            const total = Math.round((index * 100 + percent) / files.length);
                            if (job.percent !== total) { job.percent = total; queueStatus(); }
                        }));
                    }
                    job.abort.signal.throwIfAborted();
                    posting = true; job.phase = 'posting'; queueStatus();
                    await window.Lowcord.RestAPI.post({ url: `/channels/${job.channelId}/messages`, body: {
                        channel_id: job.channelId, content: '', type: 0, sticker_ids: [], nonce: job.nonce, enforce_nonce: true,
                        attachments: uploads.map((upload, index) => ({ id: String(index), filename: upload.filename, uploaded_filename: upload.uploadedFilename })),
                        allowed_mentions: { parse: [], replied_user: false },
                        ...(job.reference ? { message_reference: job.reference } : {}),
                    } });
                    transfer.sent.add(job.identity); transfer.jobs.delete(job.identity);
                    while (transfer.sent.size > 256) transfer.sent.delete(transfer.sent.values().next().value);
                    extensions.toast(`Sent to ${job.destination}.`);
                } catch (error) {
                    clearTimeout(slow);
                    if (job.abort.signal.aborted) transfer.jobs.delete(job.identity);
                    else {
                        // Failed jobs stay so a click retries with the same nonce.
                        job.phase = 'failed'; job.abort = new AbortController();
                        const message = posting ? 'Could not confirm sending. Click the post again to retry without a duplicate.'
                            : error.message === 'upload-failed' ? 'Upload failed. Try again.' : errorText(error.message);
                        if (current) status(current, message);
                        extensions.toast(message, true);
                    }
                } finally { transfer.active = null; queueStatus(); }
            }
        } finally { working = false; }
    }

    // ----- Window -------------------------------------------------------------
    function close() {
        const state = current;
        if (!state) return;
        closeGallery(state);
        current = undefined;
        stopPreview(state);
        window.__LOWCORD_NATIVE__?.reddit?.('cancel', 'browse').catch(() => {});
        state.channelStore?.removeChangeListener?.(state.channelChanged);
        window.removeEventListener('keydown', state.key, true);
        document.removeEventListener('visibilitychange', state.visibility);
        state.stopDom?.();
        state.node.remove();
        if (state.editor?.isConnected) state.editor.focus({ preventScroll: true });
    }
    function open() {
        if (current) { close(); return; }
        if (!extensions.enabled('redditPicker')) return;
        if (!window.__LOWCORD_NATIVE__?.reddit) { extensions.toast('Reddit needs the desktop app.', true); return; }
        const editor = document.querySelector('[class*="channelTextArea_"] [contenteditable="true"][role="textbox"]');
        const channelId = selectedChannel();
        if (!editor || !channelId) { extensions.toast('Open a chat to browse Reddit.', true); return; }
        const state = { channelId, editor, mode: 'home', subreddit: null, query: '', after: null, items: [], ids: new Set(),
            generation: 0, pagesWithoutMedia: 0, layout: readLayout() };
        state.input = ui('input', { type: 'search', placeholder: 'Search posts', 'aria-label': 'Search Reddit', maxlength: '200' });
        state.sort = ui('select', { className: 'lowcord-reddit-sort', 'aria-label': 'Sort posts', onChange: () => void search(state, true) },
            ...sortOptions.map(([sort, time, label]) => ui('option', { value: `${sort}:${time}` }, label)));
        const form = ui('form', { className: 'lowcord-reddit-search', onSubmit: event => { event.preventDefault(); void search(state, true); },
            onKeydown: event => event.stopPropagation() }, icon('search'), state.input, state.sort);
        state.tabs = tabs.map(value => ui('button', { type: 'button', role: 'tab', className: 'lowcord-reddit-tab', 'data-mode': value,
            'aria-selected': String(value === 'home'), tabindex: value === 'home' ? '0' : '-1', 'aria-controls': 'lowcord-reddit-results',
            onClick: () => setMode(state, value), onKeydown: event => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                event.preventDefault();
                const next = tabs[(tabs.indexOf(value) + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length];
                setMode(state, next); state.tabs.find(tab => tab.dataset.mode === next).focus();
            } }, tabNames[value]));
        state.back = ui('button', { type: 'button', className: 'lowcord-reddit-back', hidden: true, 'aria-label': 'Back',
            onClick: () => setMode(state, state.parentMode ?? 'home') }, icon('back', 12), 'Back');
        state.heading = ui('span', { className: 'lowcord-reddit-heading' });
        state.pin = ui('button', { type: 'button', className: 'lowcord-reddit-star', hidden: true, onClick: () => toggleSubreddit(state, state.subreddit) }, icon('star'));
        state.pins = ui('div', { className: 'lowcord-reddit-pins', 'aria-label': 'Pinned subreddits', hidden: true });
        state.grid = ui('div', { className: 'lowcord-reddit-grid' });
        state.more = ui('button', { type: 'button', className: 'lowcord-reddit-more', hidden: true, onClick: () => {
            if (state.more.textContent === 'Retry' && !state.items.length) void search(state, true); else void search(state, false);
        } }, 'Load more');
        state.results = ui('div', { className: 'lowcord-reddit-results', id: 'lowcord-reddit-results', role: 'tabpanel', tabindex: '-1', onScroll: () => {
            stopPreview(state); closeMenu(state);
            if (!state.loading && !state.more.hidden && state.more.textContent !== 'Retry'
                && state.results.scrollHeight - state.results.scrollTop - state.results.clientHeight < 600) void search(state, false);
        } }, state.grid, state.more);
        state.video = ui('video', { className: 'lowcord-reddit-video', loop: '', playsinline: '', preload: 'none', 'aria-hidden': 'true' });
        state.video.muted = true;
        state.video.addEventListener('playing', () => { if (state.previewing) state.previewing.button.dataset.previewing = 'true'; });
        state.status = ui('p', { className: 'lowcord-reddit-status', role: 'status', 'aria-live': 'polite', hidden: true });
        state.signin = ui('button', { type: 'button', className: 'lowcord-reddit-more', hidden: true, onClick: () => void login(state) }, 'Log in to Reddit');
        state.queueText = ui('span', { className: 'lowcord-reddit-queue-text' });
        state.queueCancel = ui('button', { type: 'button', className: 'lowcord-reddit-icon', 'aria-label': 'Cancel uploads', title: 'Cancel uploads', onClick: cancelAll }, icon('close'));
        state.queue = ui('div', { className: 'lowcord-reddit-queue', role: 'status', 'aria-live': 'polite', hidden: true }, icon('upload'), state.queueText, state.queueCancel);
        const spoilers = ui('input', { type: 'checkbox', onChange: () => { saved.spoilerNsfw = spoilers.checked; persist(); } });
        spoilers.checked = saved.spoilerNsfw;
        state.accountNote = ui('p', {});
        state.logout = ui('button', { type: 'button', className: 'lowcord-reddit-link', onClick: () => void logout(state) }, 'Log out of Reddit');
        state.options = ui('div', { className: 'lowcord-reddit-options', id: 'lowcord-reddit-options', hidden: true }, state.accountNote, state.logout,
            ui('label', { className: 'lowcord-reddit-preference' }, spoilers, 'Send NSFW and spoiler posts as spoilers'),
            ui('p', {}, 'Click a post to send it. For albums, select which photos or videos to send. Videos over the upload limit are compressed below 20 MB.'));
        state.accountButton = ui('button', { type: 'button', className: 'lowcord-reddit-account', 'aria-controls': 'lowcord-reddit-options', onClick: () => {
            if (!account) { void login(state); return; }
            state.options.hidden = !state.options.hidden;
        } });
        const optionsButton = ui('button', { type: 'button', className: 'lowcord-reddit-icon', 'aria-label': 'Picker options', title: 'Options',
            'aria-controls': 'lowcord-reddit-options', onClick: () => { state.options.hidden = !state.options.hidden; } }, icon('options', 16));
        const drag = ui('button', { type: 'button', className: 'lowcord-reddit-icon lowcord-reddit-drag', 'aria-label': 'Move Reddit picker',
            title: 'Drag to move · Arrow keys to move · Home to reset', onKeydown: event => keyboardLayout(state, event, 'move') }, icon('grip', 16));
        const resize = ui('button', { type: 'button', className: 'lowcord-reddit-resize', 'aria-label': 'Resize Reddit picker',
            title: 'Drag to resize · Arrow keys to resize · Home to reset', onKeydown: event => keyboardLayout(state, event, 'resize'),
            onPointerdown: event => beginGesture(state, event, 'resize') }, icon('resize', 16));
        const header = ui('header', { className: 'lowcord-reddit-titlebar', onPointerdown: event => beginGesture(state, event, 'move') },
            drag, ui('h2', {}, 'Reddit'), state.accountButton, optionsButton,
            ui('button', { type: 'button', className: 'lowcord-reddit-icon', 'aria-label': 'Close Reddit', title: 'Close', onClick: close }, icon('close', 16)));
        state.node = ui('section', { className: 'lowcord-reddit', role: 'dialog', 'aria-label': 'Reddit picker', onPointerdown: event => {
            if (state.menu && !state.menu.contains(event.target)) closeMenu(state);
            if (!state.options.hidden && !state.options.contains(event.target) && !event.target.closest('[aria-controls="lowcord-reddit-options"]')) state.options.hidden = true;
        } }, header, form, ui('div', { className: 'lowcord-reddit-tabs', role: 'tablist', 'aria-label': 'Reddit feeds' }, ...state.tabs),
            ui('div', { className: 'lowcord-reddit-result-heading' }, state.back, state.heading, state.pin), state.pins,
            state.results, state.signin, state.queue, state.status, state.options, resize);
        state.key = event => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (state.menu) { closeMenu(state); state.gallery?.node.focus({ preventScroll: true }); }
            else if (!state.options.hidden) state.options.hidden = true; else if (state.gallery) closeGallery(state); else close();
        };
        state.channelChanged = () => { if (selectedChannel() !== channelId) close(); };
        state.channelStore = window.Lowcord.store('SelectedChannelStore');
        state.channelStore?.addChangeListener?.(state.channelChanged);
        state.visibility = () => { if (document.hidden) stopPreview(state); };
        current = state; document.body.append(state.node); place(state);
        state.stopDom = window.Lowcord.onDomChange(() => { if (current === state && (!editor.isConnected || selectedChannel() !== channelId)) close(); });
        window.addEventListener('keydown', state.key, true);
        document.addEventListener('visibilitychange', state.visibility);
        showAccount(state); queueStatus(); state.input.focus();
        void search(state, true);
    }
    window.addEventListener(extensions.changeEvent, () => { if (!extensions.enabled('redditPicker')) { close(); cancelAll(); } });
    extensions.addComposerAction({ id: 'redditPicker', order: 6, label: 'Reddit',
        path: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-3 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-6.2 5a.75.75 0 0 0-.6 1.2A4.9 4.9 0 0 0 12 18.4a4.9 4.9 0 0 0 3.8-1.7.75.75 0 1 0-1.2-.9 3.4 3.4 0 0 1-2.6 1.1 3.4 3.4 0 0 1-2.6-1.1.75.75 0 0 0-.6-.3Z', run: open });
    window.Lowcord.reddit = { open, close, busy: () => working || transfer.queue.length > 0 };
    window.addEventListener('pagehide', cancelAll);
})();
