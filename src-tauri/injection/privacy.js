// Privacy controls use native Discord flows. No Discord module is rewritten.
(() => {
    const core = window.LowcordPrivacyCore;
    if (!core || !window.Lowcord || window.Lowcord.privacy) return;
    const storage = window.Lowcord.storage;
    const key = 'lowcord.privacy.v1', eventName = 'lowcord-privacy-change';
    const composerSelector = '[class*="channelTextArea_"]';
    const editorSelector = `${composerSelector} [contenteditable="true"][role="textbox"], ${composerSelector} textarea`;
    const defaults = { metadata: true, inspector: true };
    const read = (name, fallback) => { try { return JSON.parse(storage.getItem(name)) ?? fallback; } catch { return fallback; } };
    // Only known boolean preferences; retired keys in old saves are dropped.
    const saved = read(key, {});
    const valid = (name, value) => typeof defaults[name] === 'boolean' && typeof value === 'boolean';
    let state = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, valid(name, saved?.[name]) ? saved[name] : value]));
    let queue, queueTimer, account, lastInspection;
    const changed = () => window.dispatchEvent(new Event(eventName));
    const toast = (text, error = false, duration) => window.Lowcord.extensions?.toast(text, error, null, duration);
    const currentUser = () => window.Lowcord.store('UserStore')?.getCurrentUser?.()?.id;
    const channelId = () => window.Lowcord.store('SelectedChannelStore')?.getChannelId?.();
    function set(patch) {
        const next = { ...state };
        for (const [name, value] of Object.entries(patch)) if (valid(name, value)) next[name] = value;
        storage.setItem(key, JSON.stringify(next)); state = next;
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

    // ----- Local metadata preparation before native upload staging ------------
    const replayed = new WeakSet(), prepared = new WeakSet(); let preparing = false, delivering = false;
    const supportedImage = file => /\.(?:jpe?g|png|apng|webp|gif)$/i.test(file.name) || /^image\/(?:jpeg|png|apng|webp|gif)$/.test(file.type);
    const transfer = files => { const data = new DataTransfer(); for (const file of files) data.items.add(file); return data; };
    function dispatch(target, event) { replayed.add(event); target.dispatchEvent(event); }
    function preprocess(event, files, replay) {
        // Other hooks (anonymous file names) replay our cleaned files as new File
        // objects while we deliver them; those events must pass straight through.
        if (delivering || replayed.has(event) || event.defaultPrevented || !state.metadata || !window.__LOWCORD_NATIVE__?.sanitizeImage) return;
        if (!files.some(file => supportedImage(file) && !prepared.has(file))) {
            if (files.some(file => !prepared.has(file) && /^(?:image|video)\//.test(file.type)))
                toast('Metadata was not removed: only JPEG, PNG, WebP and GIF are supported. Other media is attached unchanged.', true);
            return;
        }
        event.preventDefault(); event.stopImmediatePropagation();
        if (preparing) { toast('Wait for the current images to finish preparing.', true); return true; }
        preparing = true;
        const channel = channelId();
        void (async () => {
            const output = [], off = ' To attach it unchanged, turn off Remove media metadata in Privacy & Security.';
            let cleaned = 0, unchanged = 0;
            try {
                for (const file of files) {
                    if (prepared.has(file)) { output.push(file); continue; }
                    // Never imply other formats (HEIC, video, documents) were cleaned.
                    if (!supportedImage(file)) { output.push(file); if (/^(?:image|video)\//.test(file.type)) unchanged++; continue; }
                    if (file.size > 64 * 1024 * 1024) throw new Error(`${file.name} is larger than 64 MiB, the limit for metadata removal. No files were attached.${off}`);
                    const result = await window.__LOWCORD_NATIVE__.sanitizeImage(new Uint8Array(await file.arrayBuffer()));
                    if (result?.status !== 'processed' || !(result.bytes instanceof Uint8Array)) throw new Error(`${file.name}: ${result?.reason || 'Could not remove image metadata.'} No files were attached.${off}`);
                    const clean = new File([result.bytes], file.name, { type: result.type, lastModified: 0 });
                    prepared.add(clean); output.push(clean); cleaned++;
                }
                if (channelId() !== channel) throw new Error('Chat changed. Attach the images again in the intended chat.');
                delivering = true;
                try { if (replay(output) === false) throw new Error('The message box closed. Attach the images again.'); }
                finally { delivering = false; }
                toast([`Metadata removed from ${cleaned} image${cleaned === 1 ? '' : 's'}.`,
                    unchanged ? `${unchanged} other media file${unchanged === 1 ? ' was' : 's were'} attached unchanged: metadata removal supports JPEG, PNG, WebP and GIF only.` : ''].filter(Boolean).join(' '), Boolean(unchanged), unchanged ? undefined : 1800);
            } catch (error) { toast(error.message, true); }
            finally { preparing = false; }
        })(); return true;
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
        metadata: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M11 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', 'm21 16-5-5-9 9'],
        expiry: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v5l3 2'],
        inspector: ['M14 3H6v18h12V7l-4-4Z', 'M14 3v4h4M9 13h6M9 17h4'],
        removed: ['M6 12h12'], kept: ['m5 12 5 5 9-10'], file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z', 'M14 3v5h5'],
        search: ['M20 20l-4.5-4.5M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z'], open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    };
    const protections = ['metadata', 'expiry', 'inspector'];
    const titles = { metadata: 'Media metadata', expiry: 'Message expiry', inspector: 'Attachment inspector' };
    function SettingsPanel() {
        const R = window.Lowcord.React, h = R.createElement;
        const current = window.Lowcord.store('ChannelStore')?.getChannel?.(channelId());
        const [, rerender] = R.useState(0), [selected, select] = R.useState('metadata'), [error, setError] = R.useState('');
        const [kind, setKind] = R.useState(current && !current.guild_id ? 'dm' : 'server');
        const [target, setTarget] = R.useState(current ? current.guild_id ?? current.id : '');
        const [ruleChannel, setRuleChannel] = R.useState(current?.guild_id ? current.id : '');
        const [query, setQuery] = R.useState(''), [hours, setHours] = R.useState(24), [attachments, setAttachments] = R.useState(false);
        R.useEffect(() => { const update = () => rerender(n => n + 1); window.addEventListener(eventName, update); attachAccount(); return () => window.removeEventListener(eventName, update); }, []);
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
        const status = {
            metadata: [state.metadata ? 'On' : 'Off'],
            expiry: [queue?.state.rules.length ? `${queue.state.rules.length} rule${queue.state.rules.length === 1 ? '' : 's'} · ${queued} queued` : 'No rules'],
            inspector: [!state.inspector ? 'Off' : lastInspection?.status === 'warning' ? 'Last download needs care' : 'On', state.inspector && lastInspection?.status === 'warning' ? 'warn' : ''],
        };
        // Keyed per pane: a reused switch would animate when changing panes.
        const header = (name, description, control) => h('div', { key: name, className: 'lowcord-privacy-head' },
            h('h2', { id: 'lowcord-privacy-detail-title' }, titles[name]), control ?? null, h('p', null, description));

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
            metadata: () => [header('metadata', 'Removes hidden details from images before they upload. The picture itself is not changed.', toggle('metadata', 'Remove media metadata')),
                section('What changes', h('div', { className: 'lowcord-privacy-columns' },
                    h('div', null, h('h4', null, 'Removed'), list('removed', ['Location', 'Camera and lens', 'Date taken', 'Author and comments', 'Editing history'])),
                    h('div', null, h('h4', null, 'Kept'), list('kept', ['Orientation', 'Animation', 'Color profile'])))),
                section('Supported files', facts([['Formats', 'JPEG, PNG, APNG, WebP, GIF'], ['Size limit', '64 MiB per image'],
                    ['Other files', 'HEIC, video and documents upload unchanged. You are told when that happens.']])),
                note('Only file metadata is removed. Anything visible in the image itself stays as it is.')],
            expiry: expiryPane,
            inspector: () => [header('inspector', 'After a download, explains disguised programs, misleading file names and risky ZIP contents. Nothing is opened, extracted or uploaded.', toggle('inspector', 'Attachment inspector')),
                section('Last download', lastInspection
                    ? h('div', { role: 'status' }, h('div', { className: 'lowcord-privacy-line is-first' }, h('strong', null, lastInspection.name),
                        badge(lastInspection.status === 'checked' ? 'No issues found' : lastInspection.status === 'warning' ? 'Needs care' : 'Unable to inspect', lastInspection.status === 'warning' ? 'danger' : lastInspection.status === 'checked' ? '' : 'warn')),
                        lastInspection.reasons.length ? h('ul', { className: 'lowcord-privacy-reasons' }, ...lastInspection.reasons.map(reason => h('li', { key: reason }, reason))) : null)
                    : h('p', { className: 'lowcord-privacy-empty' }, 'No downloads checked yet.')),
                section('What is checked', facts([['Disguised files', 'Programs named like photos or documents'], ['Archives', 'Scripts, shortcuts and unsafe paths inside ZIP files'], ['Not checked', 'Encrypted or unsupported archives show Unable to inspect']])),
                note('This is not an antivirus scan. “No issues found” never means a file is safe.')],
        };
        return h('section', { className: 'lowcord-privacy-page' },
            h('div', { className: 'lowcord-privacy-intro' }, h('h1', null, 'Privacy & Security'),
                h('p', null, 'Choose a protection to see exactly what it changes. Everything runs on this device.')),
            h('div', { className: 'lowcord-privacy-split' },
                h('nav', { className: 'lowcord-privacy-nav', 'aria-label': 'Protections' }, h('div', { className: 'lowcord-privacy-group' },
                    ...protections.map(name => h('button', { key: name, type: 'button', className: 'lowcord-privacy-item', 'aria-current': selected === name ? 'true' : undefined, onClick: () => { select(name); setError(''); } },
                        h('span', { className: 'lowcord-privacy-tile' }, icon(name)),
                        h('span', { className: 'lowcord-privacy-item-text' }, h('strong', null, titles[name]), h('span', { className: status[name][1] ? `is-${status[name][1]}` : '' }, status[name][0])))))),
                h('section', { className: 'lowcord-privacy-detail', 'aria-labelledby': 'lowcord-privacy-detail-title' }, ...details[selected](),
                    error ? h('p', { role: 'alert', className: 'lowcord-privacy-note is-error' }, error) : null)));
    }
    window.Lowcord.privacy = { get state() { return { ...state }; }, set, eventName, SettingsPanel,
        get queue() { return queue; }, attachAccount };
    const ready = () => {
        syncNative();
        window.Lowcord.waitForStore('UserStore', store => { attachAccount(); store.addChangeListener?.(attachAccount); });
        window.__LOWCORD_NATIVE__?.onAttachmentInspection?.(report => {
            lastInspection = report; changed();
            // Warnings get a native dialog from the main process; files that
            // could not be fully inspected get a quieter notice, never "safe".
            if (report?.status === 'uninspectable') toast(`Unable to fully inspect ${report.name}. ${report.reasons?.[0] ?? ''}`.trim(), true);
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
