// Tabs: keep several chats open in Discord's top bar and switch between them
// like browser tabs. A tab is only a saved route (/channels/<guild>/<channel>,
// a message link, or a page such as /shop), so switching re-uses Discord's own
// router and no second copy of Discord runs. Navigating inside Discord moves
// the active tab, the same way a browser tab follows its links.
//
// Workspaces are named sets of tabs: switching one saves the current set and
// opens the other. Everything is kept in Lowcord's per-account storage.
(() => {
    const ID = "tabs";
    const { extensions } = window.Lowcord;
    const { enabled, ui, toast, changeEvent } = extensions;
    const store = name => window.Lowcord.store(name);
    const storage = window.Lowcord.storage;
    const key = "lowcord.tabs.v1";
    const mac = navigator.platform.startsWith("Mac");
    const maxTabs = 24, maxClosed = 10, maxRecent = 12, maxSpaces = 8;

    // ----- Routes --------------------------------------------------------------
    // Pages outside a chat that can be a tab. Anything else (login, settings
    // overlays, invites) is left alone.
    const pages = [
        { path: "/channels/@me", label: "Friends", icon: "friends" },
        { path: "/message-requests", label: "Message requests", icon: "requests" },
        { path: "/discovery", label: "Discover", icon: "discover" },
        { path: "/quest-home", label: "Quests", icon: "quests" },
        { path: "/shop", label: "Shop", icon: "shop" },
        { path: "/store", label: "Nitro", icon: "nitro" },
    ];
    const routable = /^\/(?:channels\/(?:@me|@favorites|\d+)(?:\/\d+){0,2}|message-requests|discovery(?:\/[\w-]+)*|quest-home|shop|store|activities|library)\/?$/;
    const clean = path => {
        if (typeof path !== "string") return null;
        const value = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
        return routable.test(value) ? value : null;
    };
    function parse(path) {
        const match = /^\/channels\/(@me|@favorites|\d+)(?:\/(\d+))?(?:\/(\d+))?$/.exec(path);
        if (!match) return { page: pages.find(page => path === page.path || path.startsWith(`${page.path}/`)) ?? null };
        return { guildId: match[1].startsWith("@") ? null : match[1], channelId: match[2] ?? null, messageId: match[3] ?? null, scope: match[1] };
    }
    // A Discord message link, from a copied link or an anchor in chat.
    function fromLink(href) {
        if (!/^(https?:\/\/|\/)/i.test(href)) return null;
        try {
            const url = new URL(href, location.origin);
            if (!/(^|\.)discord(app)?\.com$/.test(url.hostname)) return null;
            return clean(url.pathname);
        } catch { return null; }
    }

    // ----- State ---------------------------------------------------------------
    let uid = 0;
    const tabId = () => `t${Date.now().toString(36)}${(uid++).toString(36)}`;
    const blank = () => ({ id: tabId(), path: clean(location.pathname) ?? "/channels/@me" });
    function read() {
        let saved = null;
        try { saved = JSON.parse(storage?.getItem(key)); } catch {}
        const tabsOf = list => (Array.isArray(list) ? list : []).map(tab => ({ id: tabId(), path: clean(tab?.path) })).filter(tab => tab.path).slice(0, maxTabs);
        const spaces = (Array.isArray(saved?.spaces) ? saved.spaces : []).slice(0, maxSpaces).map((space, index) => {
            const tabs = tabsOf(space?.tabs);
            const name = typeof space?.name === "string" && space.name.trim() ? space.name.trim().slice(0, 40) : `Workspace ${index + 1}`;
            const active = Number.isInteger(space?.active) && tabs[space.active] ? tabs[space.active].id : tabs[0]?.id;
            return { id: `w${index}`, name, tabs, active };
        });
        if (!spaces.length) spaces.push({ id: "w0", name: "Main", tabs: [], active: undefined });
        const current = spaces.find(space => space.name === saved?.current) ?? spaces[0];
        const strings = list => (Array.isArray(list) ? list : []).map(clean).filter(Boolean);
        return { spaces, current: current.id, closed: strings(saved?.closed).slice(0, maxClosed), recent: strings(saved?.recent).slice(0, maxRecent) };
    }
    let state = read();
    const space = () => state.spaces.find(entry => entry.id === state.current) ?? state.spaces[0];
    const tabs = () => space().tabs;
    const activeTab = () => tabs().find(tab => tab.id === space().active) ?? tabs()[0];
    let saveTimer = 0;
    function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const data = {
                current: space().name,
                spaces: state.spaces.map(entry => ({ name: entry.name, tabs: entry.tabs.map(tab => ({ path: tab.path })),
                    active: Math.max(0, entry.tabs.findIndex(tab => tab.id === entry.active)) })),
                closed: state.closed, recent: state.recent,
            };
            try { storage?.setItem(key, JSON.stringify(data)); } catch {}
        }, 250);
    }
    function remember(path) {
        state.recent = [path, ...state.recent.filter(entry => entry !== path)].slice(0, maxRecent);
    }

    // ----- Labels and icons ----------------------------------------------------
    const icons = {
        text: "M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z",
        voice: "M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Zm-.28-4.28c-.4.33-.82-.03-.82-.55V8.08c0-.52.42-.88.82-.55a5.99 5.99 0 0 1 0 8.94Z",
        thread: "M12 2.81a1 1 0 0 1 0-1.41l.36-.36a1 1 0 0 1 1.41 0l9.2 9.2a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1.3.13l-9.54-6.72a1 1 0 0 1-.08-1.58l1-1L12 2.8ZM12 21.2a1 1 0 0 1 0 1.41l-.35.35a1 1 0 0 1-1.41 0l-9.2-9.19a1 1 0 0 1 0-1.41l.7-.7a1 1 0 0 1 1.3-.12l9.54 6.72a1 1 0 0 1 .07 1.58l-1 1 .35.36ZM15.66 16.8a1 1 0 0 1-1.38.28l-8.49-5.66A1 1 0 1 1 6.9 9.76l8.49 5.65a1 1 0 0 1 .27 1.39ZM17.1 14.25a1 1 0 1 0 1.11-1.66L9.73 6.93a1 1 0 0 0-1.11 1.66l8.49 5.66Z",
        forum: "M18.91 12.98a5.45 5.45 0 0 1 2.18 6.2c-.1.33-.09.68.1.96l.83 1.32a1 1 0 0 1-.84 1.54h-5.5A5.6 5.6 0 0 1 10 17.5a5.6 5.6 0 0 1 5.68-5.5c1.2 0 2.32.36 3.23.98ZM2.18 13.32a1 1 0 0 0-.1-.96l-.82-1.32A1 1 0 0 1 2.1 9.5h5.5a5.6 5.6 0 0 1 5.65 5.06A7.6 7.6 0 0 0 8 17.5c0 .58.07 1.15.2 1.69a5.5 5.5 0 0 1-6.02-5.87ZM8 2a7 7 0 0 1 6.99 7.39 7.64 7.64 0 0 0-7.35 3.35A5.5 5.5 0 1 1 8 2Z",
        message: "M12 22a10 10 0 1 0-8.45-4.64c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12Zm-4-9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm5.5-1.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm2.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
        friends: "M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-9 8.82c0-2.86 2.32-5.82 6.18-5.82h5.64C19.68 13 22 15.96 22 18.82 22 20.6 20.6 22 18.82 22H7.18A3.18 3.18 0 0 1 4 18.82ZM5.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM5 12.1a4.94 4.94 0 0 0-3 4.53A2.37 2.37 0 0 0 4.37 19H4.4a5.43 5.43 0 0 1-.4-1.99c0-1.86.58-3.6 1.6-4.97L5 12.1Z",
        requests: "M3 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H3Zm2 3h14v3h-3.5a1 1 0 0 0-.96.73l-.7 2.47h-3.68l-.7-2.47A1 1 0 0 0 8.5 9H5V6Z",
        discover: "M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm4.75-15.4-2.2 6.2a1.25 1.25 0 0 1-.75.75l-6.2 2.2a.5.5 0 0 1-.64-.64l2.2-6.2c.13-.35.4-.62.75-.75l6.2-2.2a.5.5 0 0 1 .64.64ZM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
        quests: "M8 3a3 3 0 0 0-3 3v1H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v4a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-4h1a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V6a3 3 0 0 0-3-3H8Zm4 4.5a1 1 0 0 1 1 1v2.5h2.5a1 1 0 1 1 0 2H13v2.5a1 1 0 1 1-2 0V13H8.5a1 1 0 1 1 0-2H11V8.5a1 1 0 0 1 1-1Z",
        shop: "M2.63 4.19A3 3 0 0 1 5.53 2H7a1 1 0 0 1 1 1v3.98a3.07 3.07 0 0 1-.3 1.33 2.97 2.97 0 0 1-2.33 1.66A2.9 2.9 0 0 1 2.04 6.6l.6-2.42ZM9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3.98a3 3 0 0 1-6 0V3Zm7 0a1 1 0 0 1 1-1h1.47a3 3 0 0 1 2.9 2.19l.6 2.42a2.9 2.9 0 0 1-3.33 3.38A2.97 2.97 0 0 1 16 6.98V3ZM3 11.53V20a2 2 0 0 0 2 2h4v-5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5h4a2 2 0 0 0 2-2v-8.47a4.9 4.9 0 0 1-3.5-.96 4.97 4.97 0 0 1-3.5 1.43 4.97 4.97 0 0 1-3.5-1.43A4.97 4.97 0 0 1 3 11.53Z",
        nitro: "M16.23 12c0 1.29-.95 2.34-2.13 2.34-1.17 0-2.12-1.05-2.12-2.34s.95-2.34 2.12-2.34c1.18 0 2.13 1.05 2.13 2.34ZM14.1 5.5a6.5 6.5 0 0 0-6.12 4.33H3.5a1 1 0 0 0 0 2h3.98A6.5 6.5 0 1 0 14.1 5.5Zm0 11a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9ZM2.5 8.5a1 1 0 0 1 1-1H7a1 1 0 0 1 0 2H3.5a1 1 0 0 1-1-1Zm1 6a1 1 0 0 0 0 2H7a1 1 0 1 0 0-2H3.5Z",
        page: "M4 4a2 2 0 0 1 2-2h8.59a2 2 0 0 1 1.41.59l3.41 3.41A2 2 0 0 1 20 7.41V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Z",
        plus: "M13 5a1 1 0 1 0-2 0v6H5a1 1 0 1 0 0 2h6v6a1 1 0 1 0 2 0v-6h6a1 1 0 1 0 0-2h-6V5Z",
        close: "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
        tab: "M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Zm2 3v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9H5Zm0-2h6V5H6a1 1 0 0 0-1 1v1Zm8 0h6V6a1 1 0 0 0-1-1h-5v2Z",
        workspace: "M2 5a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm12 0a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3V5ZM2 17a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-2Zm12-2a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3v-4Z",
    };
    const glyph = (name, size = 16) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        node.setAttribute("viewBox", "0 0 24 24"); node.setAttribute("width", size); node.setAttribute("height", size);
        node.setAttribute("aria-hidden", "true");
        node.innerHTML = `<path fill="currentColor" fill-rule="evenodd" d="${icons[name] ?? icons.page}"/>`;
        return node;
    };
    function userName(id) {
        const user = store("UserStore")?.getUser?.(id);
        return user?.globalName || user?.global_name || user?.username || "";
    }
    const cdn = "https://cdn.discordapp.com";
    function avatarOf(userId) {
        const user = store("UserStore")?.getUser?.(userId);
        if (!user) return null;
        try { const url = user.getAvatarURL?.(undefined, 32, false); if (url) return url; } catch {}
        return user.avatar ? `${cdn}/avatars/${user.id}/${user.avatar}.webp?size=32` : null;
    }
    function guildIcon(guild) {
        if (!guild?.icon) return null;
        try { const url = guild.getIconURL?.(32, false); if (url) return url; } catch {}
        return `${cdn}/icons/${guild.id}/${guild.icon}.webp?size=32`;
    }
    const kindOf = type => type === 2 || type === 13 ? "voice" : type === 10 || type === 11 || type === 12 ? "thread" : type === 15 || type === 16 ? "forum" : "text";
    // { label, detail, kind, image, initials, channelId } for a path.
    function describe(path) {
        const route = parse(path);
        if (route.page !== undefined) {
            const page = route.page;
            if (page) return { label: page.label, detail: "", kind: page.icon };
            const word = path.split("/")[1] ?? "";
            return { label: word.replace(/[-_]/g, " ").replace(/^./, letter => letter.toUpperCase()) || "Discord", detail: "", kind: "page" };
        }
        if (!route.channelId) {
            if (route.scope === "@me") return { label: "Friends", detail: "", kind: "friends" };
            if (route.scope === "@favorites") return { label: "Favorites", detail: "", kind: "page" };
            const guild = store("GuildStore")?.getGuild?.(route.guildId);
            return { label: guild?.name ?? "Server", detail: "Server", kind: "guild", image: guildIcon(guild), initials: guild?.acronym ?? guild?.name?.[0] ?? "?" };
        }
        const channel = store("ChannelStore")?.getChannel?.(route.channelId);
        const message = route.messageId ? { kind: "message" } : null;
        if (!route.guildId) {
            const recipients = channel?.recipients ?? channel?.rawRecipients?.map(user => user.id) ?? [];
            const name = channel?.name || recipients.map(id => typeof id === "string" ? userName(id) : id?.username).filter(Boolean).join(", ") || "Direct message";
            const image = recipients.length === 1 ? avatarOf(typeof recipients[0] === "string" ? recipients[0] : recipients[0]?.id)
                : channel?.icon ? `${cdn}/channel-icons/${channel.id}/${channel.icon}.webp?size=32` : null;
            return { label: name, detail: message ? "Message" : recipients.length > 1 ? "Group DM" : "Direct message", kind: message ? "message" : "dm",
                image, initials: name[0] ?? "?", channelId: route.channelId, round: true };
        }
        const guild = store("GuildStore")?.getGuild?.(route.guildId);
        const kind = message ? "message" : kindOf(channel?.type);
        return { label: channel?.name ?? "Channel", detail: guild?.name ?? "", kind, image: guildIcon(guild), initials: guild?.acronym ?? guild?.name?.[0] ?? "#",
            channelId: route.channelId, prefix: kind === "message" ? "message" : kind };
    }

    // ----- Unread, mentions and calls ------------------------------------------
    function unreadOf(channelId) {
        if (!channelId) return { unread: false, mentions: 0 };
        const reads = store("ReadStateStore");
        let mentions = 0, unread = false;
        try { mentions = reads?.getMentionCount?.(channelId) ?? 0; } catch {}
        try { unread = Boolean(reads?.hasUnread?.(channelId)); } catch {}
        return { unread, mentions };
    }
    function callChannel() {
        const rtc = store("RTCConnectionStore");
        if (rtc?.getState && rtc.getState() !== "RTC_CONNECTED") return null;
        return rtc?.getChannelId?.() ?? null;
    }

    // ----- Navigation ----------------------------------------------------------
    function go(path) {
        if (clean(location.pathname) === path) return;
        const transition = window.Lowcord.transitionTo;
        if (typeof transition === "function") { try { transition(path); return; } catch {} }
        history.pushState(history.state, "", path);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }
    // A route change moves the active tab, like following a link in a browser.
    let following = "";
    function routed() {
        if (!active) return;
        const path = clean(location.pathname);
        if (!path || path === following) return;
        following = path;
        const current = activeTab();
        if (!current) { space().tabs.push({ id: tabId(), path }); space().active = space().tabs[0].id; }
        else if (current.path !== path) {
            // A path already open in another tab selects that tab instead of
            // making a duplicate, so clicking a tabbed channel in the sidebar
            // lands on its tab.
            const other = tabs().find(tab => tab.path === path && tab.id !== current.id);
            if (other && !switching) space().active = other.id;
            else current.path = path;
        }
        remember(path);
        save();
        render();
    }
    let switching = false;
    function activate(id) {
        const tab = tabs().find(entry => entry.id === id);
        if (!tab) return;
        space().active = id;
        switching = true;
        try { go(tab.path); } finally { switching = false; }
        save();
        render();
    }
    function open(path, { background = false } = {}) {
        path = clean(path);
        if (!path) { toast("That can't open in a tab.", true); return; }
        const list = tabs();
        const existing = list.find(tab => tab.path === path);
        if (existing) { if (!background) activate(existing.id); else flash(existing.id); return; }
        if (list.length >= maxTabs) { toast(`You can have up to ${maxTabs} tabs. Close one to open another.`, true); return; }
        const index = list.findIndex(tab => tab.id === space().active);
        const tab = { id: tabId(), path };
        list.splice(index < 0 ? list.length : index + 1, 0, tab);
        state.closed = state.closed.filter(entry => entry !== path);
        save();
        if (background) { render(); flash(tab.id); }
        else activate(tab.id);
    }
    function close(id) {
        const list = tabs();
        const index = list.findIndex(tab => tab.id === id);
        if (index < 0 || list.length < 2) return;
        const [tab] = list.splice(index, 1);
        state.closed = [tab.path, ...state.closed.filter(entry => entry !== tab.path)].slice(0, maxClosed);
        if (space().active === id) activate((list[index] ?? list[index - 1]).id);
        else { save(); render(); }
    }
    function closeOthers(id, rightOnly = false) {
        const list = tabs();
        const index = list.findIndex(tab => tab.id === id);
        if (index < 0) return;
        const gone = rightOnly ? list.slice(index + 1) : list.filter(tab => tab.id !== id);
        if (!gone.length) return;
        state.closed = [...gone.map(tab => tab.path).reverse(), ...state.closed.filter(path => !gone.some(tab => tab.path === path))].slice(0, maxClosed);
        space().tabs = rightOnly ? list.slice(0, index + 1) : [list[index]];
        if (!space().tabs.some(tab => tab.id === space().active)) activate(id);
        else { save(); render(); }
    }
    function reopen() {
        const path = state.closed.find(entry => !tabs().some(tab => tab.path === entry));
        if (!path) { toast("No closed tabs to reopen.", true); return; }
        state.closed = state.closed.filter(entry => entry !== path);
        open(path);
    }
    function move(id, to) {
        const list = tabs();
        const from = list.findIndex(tab => tab.id === id);
        if (from < 0 || to < 0 || to >= list.length || from === to) return;
        const [tab] = list.splice(from, 1);
        list.splice(to, 0, tab);
        save(); render();
    }
    const select = offset => {
        const list = tabs();
        if (list.length < 2) return;
        const index = list.findIndex(tab => tab.id === space().active);
        activate(list[(index + offset + list.length) % list.length].id);
    };

    // ----- Workspaces ----------------------------------------------------------
    function switchSpace(id) {
        const target = state.spaces.find(entry => entry.id === id);
        if (!target || target.id === state.current) return;
        state.current = target.id;
        if (!target.tabs.length) target.tabs.push({ id: tabId(), path: "/channels/@me" });
        const tab = activeTab();
        save();
        activate(tab.id);
        toast(`Switched to ${target.name}`, false, null, 1600);
    }
    function saveSpace(name) {
        name = name.trim().slice(0, 40);
        if (!name) return;
        const existing = state.spaces.find(entry => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (existing && existing.id === state.current) { toast(`These tabs are already ${existing.name}.`); return; }
        if (!existing && state.spaces.length >= maxSpaces) { toast(`You can have up to ${maxSpaces} workspaces. Delete one first.`, true); return; }
        // The new workspace starts with a copy of these tabs; the one you were
        // in keeps its own.
        const copy = tabs().map(tab => ({ id: tabId(), path: tab.path }));
        const activeIndex = Math.max(0, tabs().findIndex(tab => tab.id === space().active));
        const target = existing ?? { id: `w${Date.now().toString(36)}`, name, tabs: [], active: undefined };
        target.tabs = copy; target.active = copy[activeIndex]?.id;
        if (!existing) state.spaces.push(target);
        state.current = target.id;
        save(); render();
        toast(`Saved ${copy.length} ${copy.length === 1 ? "tab" : "tabs"} as ${target.name}`, false, null, 2000);
    }
    function deleteSpace(id) {
        if (state.spaces.length < 2) return;
        const target = state.spaces.find(entry => entry.id === id);
        if (!target) return;
        if (target.id === state.current) switchSpace(state.spaces.find(entry => entry.id !== id).id);
        state.spaces = state.spaces.filter(entry => entry.id !== id);
        save(); render();
        toast(`Deleted ${target.name}`, false, null, 1600);
    }

    // ----- Tab bar -------------------------------------------------------------
    let active = false, strip = null, list = null, plus = null, chip = null, bar = null, resize = null;
    const barElement = () => document.querySelector('[class*="base_"] > [class^="bar_"], [class*="base_"] > [class*=" bar_"]');
    function build() {
        list = ui("div", { className: "lowcord-tabs-list", role: "tablist", "aria-label": "Tabs" });
        plus = ui("button", { type: "button", className: "lowcord-tabs-new", "aria-label": "Open in a new tab", title: `New tab (${mac ? "⌘T" : "Ctrl+T"})`,
            onClick: () => picker() }, glyph("plus", 16));
        chip = ui("button", { type: "button", className: "lowcord-tabs-space", hidden: true, title: "Switch workspace", onClick: () => picker({ query: "", only: "Workspaces" }) });
        strip = ui("div", { className: "lowcord-tabs" }, chip, list, plus);
        list.addEventListener("dragover", dragOver);
        list.addEventListener("drop", event => event.preventDefault());
    }
    function place() {
        const target = barElement();
        if (!target) { if (bar) bar.removeAttribute("data-lowcord-tabs"); bar = null; strip?.remove(); return; }
        if (!strip) build();
        if (bar !== target) {
            bar?.removeAttribute("data-lowcord-tabs");
            bar = target;
            resize?.disconnect();
            const trailing = bar.querySelector(':scope > [class*="trailing_"]');
            resize = new ResizeObserver(() => bar?.style.setProperty("--lowcord-tabs-end", `${Math.ceil(trailing?.getBoundingClientRect().width ?? 0) + 12}px`));
            if (trailing) resize.observe(trailing);
        }
        if (strip.parentElement !== bar) bar.append(strip);
        render();
    }
    function tabNode(tab, selected, call) {
        const info = describe(tab.path);
        const { unread, mentions } = unreadOf(info.channelId);
        const badge = mentions > 0 ? ui("span", { className: "lowcord-tab-badge", "aria-label": `${mentions} mentions` }, mentions > 99 ? "99+" : String(mentions))
            : unread && !selected ? ui("span", { className: "lowcord-tab-dot", "aria-label": "Unread" }) : null;
        let icon;
        if (info.image) icon = ui("img", { className: `lowcord-tab-icon${info.round ? " lowcord-tab-round" : ""}`, src: info.image, alt: "", draggable: "false", loading: "lazy" });
        else if (info.initials && (info.kind === "guild" || info.kind === "dm")) icon = ui("span", { className: `lowcord-tab-icon lowcord-tab-initials${info.round ? " lowcord-tab-round" : ""}` }, info.initials.slice(0, 2));
        else icon = ui("span", { className: "lowcord-tab-icon lowcord-tab-glyph" }, glyph(info.kind));
        const prefix = info.prefix ? ui("span", { className: "lowcord-tab-prefix" }, glyph(info.prefix, 14)) : null;
        const live = call && info.channelId === call ? ui("span", { className: "lowcord-tab-live", title: "You're connected to this call" }) : null;
        const label = ui("span", { className: "lowcord-tab-label" }, info.label);
        const shut = ui("button", { type: "button", className: "lowcord-tab-close", tabindex: "-1", "aria-label": `Close ${info.label}`,
            onClick: event => { event.stopPropagation(); close(tab.id); } }, glyph("close", 12));
        const title = [info.label, info.detail, info.kind === "message" ? "Opens at the saved message" : ""].filter(Boolean).join(" · ");
        const node = ui("div", { className: "lowcord-tab", role: "tab", tabindex: selected ? "0" : "-1", "aria-selected": String(selected), title, draggable: "true",
            "data-tab": tab.id, "data-unread": String(unread || mentions > 0),
            onClick: () => activate(tab.id),
            onAuxclick: event => { if (event.button === 1) { event.preventDefault(); close(tab.id); } },
            onMousedown: event => { if (event.button === 1) event.preventDefault(); },
            onContextmenu: event => { event.preventDefault(); event.stopPropagation(); tabMenu(tab, event); },
            onKeydown: event => {
                const keys = { ArrowRight: 1, ArrowLeft: -1 };
                if (keys[event.key]) { event.preventDefault(); select(keys[event.key]); list?.querySelector('[aria-selected="true"]')?.focus(); }
                else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); close(tab.id); }
            },
            onDragstart: event => { dragging = tab.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", location.origin + tab.path); node.classList.add("lowcord-tab-dragging"); },
            onDragend: () => { dragging = null; node.classList.remove("lowcord-tab-dragging"); save(); render(); } },
            icon, prefix, label, live, badge, tabs().length > 1 ? shut : null);
        return node;
    }
    let dragging = null;
    function dragOver(event) {
        if (!dragging) return;
        event.preventDefault();
        const over = event.target.closest?.(".lowcord-tab");
        const node = list.querySelector(`[data-tab="${dragging}"]`);
        if (!over || !node || over === node) return;
        // Move the node itself: re-rendering would drop the element being
        // dragged, and Chromium then never sends dragend.
        const rect = over.getBoundingClientRect();
        const after = event.clientX > rect.left + rect.width / 2;
        if (after ? over.nextElementSibling === node : over.previousElementSibling === node) return;
        over[after ? "after" : "before"](node);
        const order = [...list.children].map(child => child.dataset.tab);
        space().tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        lastKey = "";
    }
    let frame = 0, lastKey = "", closeable = null;
    // The main process turns Cmd/Ctrl+W into "close tab" while this is true,
    // before the window menu's Close shortcut sees it.
    function tellCloseable(value) {
        if (value === closeable) return;
        closeable = value;
        window.__LOWCORD_NATIVE__?.setTabsCloseable?.(value)?.catch?.(() => {});
    }
    const schedule = () => { if (active && !frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
    function render() {
        if (!active) return;
        tellCloseable(tabs().length > 1);
        if (!strip || !bar) return;
        const list_ = tabs();
        const shown = list_.length > 1;
        bar.toggleAttribute("data-lowcord-tabs", shown);
        strip.toggleAttribute("data-single", !shown);
        const multi = state.spaces.length > 1;
        chip.hidden = !multi;
        if (multi && chip.textContent !== space().name) chip.replaceChildren(glyph("workspace", 14), ui("span", {}, space().name));
        const call = callChannel();
        const current = activeTab();
        // Rebuild only when something a tab shows changed.
        const keyParts = shown ? list_.map(tab => {
            const info = describe(tab.path), read = unreadOf(info.channelId);
            return `${tab.id}|${tab.path}|${info.label}|${info.image ?? ""}|${read.unread}|${read.mentions}|${call === info.channelId}`;
        }) : [];
        const key = `${current?.id}|${keyParts.join(",")}`;
        if (key === lastKey) return;
        lastKey = key;
        if (!shown) { list.replaceChildren(); return; }
        const focused = list.contains(document.activeElement);
        list.replaceChildren(...list_.map(tab => tabNode(tab, tab.id === current?.id, call)));
        const selected = list.querySelector('[aria-selected="true"]');
        if (focused) selected?.focus();
        selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    function flash(id) {
        const node = list?.querySelector(`[data-tab="${id}"]`);
        if (!node) return;
        node.classList.remove("lowcord-tab-flash");
        void node.offsetWidth;
        node.classList.add("lowcord-tab-flash");
    }

    // ----- Small menus ---------------------------------------------------------
    let menu = null;
    function closeMenu() { menu?.remove(); menu = null; window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", menuKey, true); }
    const outside = event => { if (menu && !menu.contains(event.target)) closeMenu(); };
    const menuKey = event => {
        if (!menu) return;
        const items = [...menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
        const at = items.indexOf(document.activeElement);
        if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeMenu(); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopImmediatePropagation(); items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    };
    function showMenu(x, y, entries) {
        closeMenu();
        menu = ui("div", { className: "lowcord-tabs-menu", role: "menu" });
        for (const entry of entries) {
            if (entry === "-") { menu.append(ui("div", { className: "lowcord-tabs-menu-separator", role: "separator" })); continue; }
            const item = ui("div", { className: `lowcord-tabs-menu-item${entry.danger ? " lowcord-tabs-menu-danger" : ""}`, role: "menuitem", tabindex: "-1",
                "aria-disabled": String(Boolean(entry.disabled)),
                onClick: () => { if (entry.disabled) return; closeMenu(); entry.run(); },
                onKeydown: event => { if ((event.key === "Enter" || event.key === " ") && !entry.disabled) { event.preventDefault(); closeMenu(); entry.run(); } } },
                ui("span", {}, entry.label), entry.hint ? ui("span", { className: "lowcord-tabs-menu-hint" }, entry.hint) : null);
            menu.append(item);
        }
        document.body.append(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
        menu.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
        window.addEventListener("pointerdown", outside, true);
        window.addEventListener("keydown", menuKey, true);
    }
    const mod = mac ? "⌘" : "Ctrl+";
    function tabMenu(tab, event) {
        const list_ = tabs(), index = list_.indexOf(tab);
        showMenu(event.clientX, event.clientY, [
            { label: "New tab", hint: `${mod}T`, run: () => picker() },
            { label: "Duplicate into new workspace", run: () => picker({ mode: "name" }) },
            { label: "Copy link", run: () => { navigator.clipboard?.writeText(`https://discord.com${tab.path}`).then(() => toast("Link copied", false, null, 1400), () => toast("Couldn't copy the link.", true)); } },
            "-",
            { label: "Move left", disabled: index === 0, run: () => move(tab.id, index - 1) },
            { label: "Move right", disabled: index === list_.length - 1, run: () => move(tab.id, index + 1) },
            "-",
            { label: "Close tab", hint: `${mod}W`, disabled: list_.length < 2, run: () => close(tab.id) },
            { label: "Close other tabs", disabled: list_.length < 2, run: () => closeOthers(tab.id) },
            { label: "Close tabs to the right", disabled: index === list_.length - 1, run: () => closeOthers(tab.id, true) },
            { label: "Reopen closed tab", hint: `${mod}⇧T`.replace("+⇧", "+Shift+"), disabled: !state.closed.length, run: reopen },
        ]);
    }

    // ----- New tab picker ------------------------------------------------------
    let pick = null;
    function pageEntries() {
        return pages.map(page => ({ group: "Pages", label: page.label, path: page.path, kind: page.icon }));
    }
    function spaceEntries() {
        const list_ = state.spaces.map(entry => ({ group: "Workspaces", label: entry.name, kind: "workspace", detail: entry.id === state.current ? "Current" : `${entry.tabs.length} ${entry.tabs.length === 1 ? "tab" : "tabs"}`,
            run: () => switchSpace(entry.id), remove: state.spaces.length > 1 ? () => deleteSpace(entry.id) : null }));
        list_.push({ group: "Workspaces", label: "Save these tabs as a workspace…", match: "new workspace save tabs", kind: "plus", keep: true, run: () => pick?.name() });
        return list_;
    }
    function entryFor(path, group) {
        const info = describe(path);
        return { group, label: info.label, detail: info.detail, path, info };
    }
    function searchEntries() {
        const found = [];
        const palette = window.Lowcord.commandPalette;
        for (const entry of palette?.chats?.() ?? []) if (entry.path) found.push({ ...entry, info: describe(entry.path) });
        // Threads and posts you've opened before.
        for (const path of state.recent) if (!found.some(entry => entry.path === path)) found.push(entryFor(path, "Recent"));
        return found;
    }
    function suggestions() {
        const open_ = new Set(tabs().map(tab => tab.path));
        const result = [];
        const call = callChannel();
        if (call) {
            const channel = store("ChannelStore")?.getChannel?.(call);
            const path = `/channels/${channel?.guild_id ?? channel?.guildId ?? "@me"}/${call}`;
            if (!open_.has(path)) result.push({ ...entryFor(path, "Current call"), live: true });
        }
        for (const path of state.closed.filter(path => !open_.has(path)).slice(0, 4)) result.push(entryFor(path, "Recently closed"));
        for (const path of state.recent.filter(path => !open_.has(path) && !state.closed.includes(path) && path !== result[0]?.path).slice(0, 6)) result.push(entryFor(path, "Previous channels"));
        return [...result, ...pageEntries().filter(entry => !open_.has(entry.path)), ...spaceEntries()];
    }
    function rank(query, only) {
        const terms = query.trim().toLocaleLowerCase();
        if (!terms) return only === "Workspaces" ? spaceEntries() : suggestions();
        const score = window.Lowcord.commandPalette?.score ?? ((text, value) => text.toLocaleLowerCase().includes(value) ? 100 : -1);
        const linked = fromLink(query.trim());
        const pool = only === "Workspaces" ? spaceEntries() : [...searchEntries(), ...pageEntries(), ...spaceEntries()];
        const found = [];
        const seen = new Set();
        for (const entry of pool) {
            if (entry.path && seen.has(entry.path)) continue;
            const value = Math.max(score(entry.match ?? entry.label, terms), entry.detail ? score(`${entry.label} ${entry.detail}`, terms) - 20 : -1);
            if (value < 0) continue;
            if (entry.path) seen.add(entry.path);
            found.push([value, entry]);
        }
        found.sort((a, b) => b[0] - a[0]);
        const close_ = found[0]?.[0] >= 150 ? found.filter(([value]) => value >= 150) : found;
        const results = close_.slice(0, 40).map(([, entry]) => entry);
        // A pasted message link opens at that message.
        if (linked) results.unshift({ ...entryFor(linked, "Link"), detail: describe(linked).detail || "Discord link" });
        return results;
    }
    function picker({ query = "", only = null, mode = "search" } = {}) {
        if (pick) { pick.input.focus(); pick.input.select(); return; }
        if (window.Lowcord.privacy?.locked) return;
        closeMenu();
        const restore = document.activeElement;
        const input = ui("input", { type: "text", className: "lowcord-tabs-picker-input", role: "combobox", "aria-expanded": "true", "aria-controls": "lowcord-tabs-picker-list",
            "aria-autocomplete": "list", "aria-label": "Open in a new tab", placeholder: "Open in a new tab…", spellcheck: "false", autocomplete: "off", value: query });
        const results = ui("div", { className: "lowcord-tabs-picker-list", id: "lowcord-tabs-picker-list", role: "listbox", "aria-label": "Suggestions" });
        const empty = ui("p", { className: "lowcord-tabs-picker-empty", hidden: true }, "No matches. Paste a Discord message link to open it.");
        const panel = ui("div", { className: "lowcord-tabs-picker", role: "dialog", "aria-label": "New tab" },
            ui("div", { className: "lowcord-tabs-picker-search" }, glyph("discover", 18), input), results, empty);
        let entries = [], at = 0, naming = false;
        const choose = position => {
            const entry = entries[position];
            if (!entry) return;
            if (naming) { const name = input.value; if (!name.trim()) return; done(); saveSpace(name); return; }
            if (!entry.keep) done();
            if (entry.run) entry.run();
            else open(entry.path);
        };
        const highlight = (next, scroll = true) => {
            at = Math.max(0, Math.min(entries.length - 1, next));
            for (const row of results.querySelectorAll('[role="option"]')) row.setAttribute("aria-selected", String(Number(row.dataset.index) === at));
            const row = results.querySelector(`[data-index="${at}"]`);
            if (row) { input.setAttribute("aria-activedescendant", row.id); if (scroll) row.scrollIntoView({ block: "nearest" }); }
        };
        function iconFor(entry) {
            const info = entry.info;
            if (info?.image) return ui("img", { className: `lowcord-tabs-picker-icon${info.round ? " lowcord-tab-round" : ""}`, src: info.image, alt: "", loading: "lazy" });
            if (info?.initials && (info.kind === "guild" || info.kind === "dm")) return ui("span", { className: `lowcord-tabs-picker-icon lowcord-tab-initials${info.round ? " lowcord-tab-round" : ""}` }, info.initials.slice(0, 2));
            return ui("span", { className: "lowcord-tabs-picker-icon lowcord-tab-glyph" }, glyph(entry.kind ?? info?.kind ?? "page", 18));
        }
        function draw() {
            if (naming) {
                entries = [{ group: "Workspaces", label: input.value.trim() ? `Save as “${input.value.trim()}”` : "Type a name for this workspace", kind: "workspace" }];
            } else entries = rank(input.value, only);
            const rows = [];
            let group = "";
            for (const [index, entry] of entries.entries()) {
                if (entry.group !== group) { group = entry.group; rows.push(ui("div", { className: "lowcord-tabs-picker-group", role: "presentation" }, group)); }
                const prefix = entry.info?.prefix ? ui("span", { className: "lowcord-tab-prefix" }, glyph(entry.info.prefix, 14)) : null;
                const remove = entry.remove ? ui("button", { type: "button", className: "lowcord-tabs-picker-remove", "aria-label": `Delete ${entry.label}`, title: "Delete workspace",
                    onClick: event => { event.stopPropagation(); entry.remove(); draw(); } }, glyph("close", 12)) : null;
                rows.push(ui("div", { className: "lowcord-tabs-picker-item", role: "option", id: `lowcord-tabs-option-${index}`, "data-index": String(index), "aria-selected": "false",
                    onMousemove: () => { if (at !== index) highlight(index, false); }, onClick: () => choose(index) },
                    iconFor(entry),
                    ui("span", { className: "lowcord-tabs-picker-text" },
                        ui("span", { className: "lowcord-tabs-picker-label" }, prefix, entry.label, entry.live ? ui("span", { className: "lowcord-tab-live" }) : null),
                        entry.detail ? ui("span", { className: "lowcord-tabs-picker-detail" }, entry.detail) : null),
                    remove));
            }
            results.replaceChildren(...rows);
            empty.hidden = entries.length > 0;
            results.scrollTop = 0;
            highlight(0);
        }
        function done(restoreFocus = false) {
            if (pick?.panel !== panel) return;
            pick = null;
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("pointerdown", onOutside, true);
            panel.remove();
            if (restoreFocus) restore?.focus?.();
        }
        const onOutside = event => { if (!panel.contains(event.target) && !plus?.contains(event.target)) done(); };
        const onKey = event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (naming) { naming = false; input.value = ""; input.placeholder = "Open in a new tab…"; draw(); } else done(true); return; }
            if (event.target !== input) return;
            const step = { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? (event.ctrlKey && event.key === "n" ? 1 : event.ctrlKey && event.key === "p" ? -1 : 0);
            if (step) { event.preventDefault(); event.stopImmediatePropagation(); highlight(at + step); return; }
            if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault(); event.stopImmediatePropagation();
                // Shift+Enter opens in the background.
                if (!naming && event.shiftKey && entries[at]?.path) { const path = entries[at].path; done(); open(path, { background: true }); return; }
                choose(at); return;
            }
            event.stopPropagation();
        };
        input.addEventListener("input", draw);
        pick = { panel, input, close: done, name: () => { naming = true; input.value = ""; input.placeholder = "Name this workspace…"; draw(); input.focus(); } };
        // Under the + button when the bar is there, else centered near the top.
        const anchor = plus?.isConnected ? plus.getBoundingClientRect() : null;
        document.body.append(panel);
        const width = panel.getBoundingClientRect().width;
        if (anchor) {
            panel.style.top = `${Math.round(anchor.bottom + 6)}px`;
            panel.style.left = `${Math.round(Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8)))}px`;
        } else panel.classList.add("lowcord-tabs-picker-centered");
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("pointerdown", onOutside, true);
        if (mode === "name") pick.name(); else draw();
        input.focus();
    }

    // ----- Open in New Tab (right-click, middle-click, ⌘/Ctrl+click) ----------
    // The route a click or right-click points at, if any.
    function targetPath(target) {
        if (!(target instanceof Element)) return null;
        if (target.closest(".lowcord-tabs, .lowcord-tabs-picker")) return null;
        const anchor = target.closest("a[href]");
        if (anchor) {
            const href = anchor.getAttribute("href");
            const path = href.startsWith("/") ? clean(href) : fromLink(href);
            if (path) return path;
        }
        const guild = target.closest('[data-list-item-id^="guildsnav___"]')?.getAttribute("data-list-item-id")?.slice(12);
        if (guild && /^\d+$/.test(guild)) return `/channels/${guild}`;
        if (guild === "home") return "/channels/@me";
        const row = target.closest('li[id^="chat-messages-"]');
        if (row && !target.closest('a, [class*="reactions_"], img, video')) {
            const match = /^chat-messages-(\d+)-(\d+)$/.exec(row.id);
            if (match) {
                const channel = store("ChannelStore")?.getChannel?.(match[1]);
                return `/channels/${channel?.guild_id ?? channel?.guildId ?? "@me"}/${match[1]}/${match[2]}`;
            }
        }
        return null;
    }
    const tabPathIcon = icons.tab;
    let menuRequest = 0;
    function addMenuItem(found, path) {
        if (found.querySelector("#lowcord-open-tab")) return;
        const items = [...found.querySelectorAll('[role="menuitem"]')].filter(item => !/quickreact|quick-react|emoji/i.test(item.id));
        if (!items.length) return;
        const model = items.find(item => !item.querySelector("svg")) ?? items[0];
        const item = model.cloneNode(true);
        item.id = "lowcord-open-tab";
        item.removeAttribute("aria-disabled");
        item.removeAttribute("aria-labelledby");
        item.removeAttribute("aria-checked");
        item.className = [...item.classList].filter(name => !/^(focused|disabled|colorDanger|danger)_/.test(name)).join(" ");
        const suffix = /^item(_\w+)$/.exec([...item.classList].find(name => /^item_/.test(name)) ?? "")?.[1];
        const focusedClass = suffix ? `focused${suffix}` : "lowcord-open-tab-focused";
        const label = path.split("/").length > 4 ? "Open Message in New Tab" : "Open in New Tab";
        item.setAttribute("aria-label", label);
        const text = item.querySelector('[class*="label_"]') ?? item.querySelector("[data-text-variant]");
        if (text) text.textContent = label; else item.textContent = label;
        item.querySelectorAll('[class*="subtext_"], [class*="hint_"]').forEach(node => node.remove());
        const icon = item.querySelector("svg");
        if (icon) icon.innerHTML = `<path fill="currentColor" fill-rule="evenodd" d="${tabPathIcon}"/>`;
        const run = event => {
            event.preventDefault(); event.stopPropagation();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
            open(path);
        };
        item.addEventListener("click", run);
        item.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") run(event); });
        item.addEventListener("pointerenter", () => item.classList.add(focusedClass));
        item.addEventListener("pointerleave", () => item.classList.remove(focusedClass));
        // Messages: beside Copy Message Link. Chats and servers: at the top of
        // the group after "Mark as read", like Discord's own design.
        const copyLink = found.querySelector("#message-copy-link");
        if (copyLink) { copyLink.before(item); return; }
        const markRead = items.find(entry => /mark-(channel|guild)-read|mark-as-read|mark-unread/.test(entry.id));
        let next = markRead?.closest('[role="group"]')?.nextElementSibling;
        while (next && next.getAttribute("role") !== "group") next = next.nextElementSibling;
        const first = next?.querySelector('[role="menuitem"]');
        if (first) first.before(item);
        else if (markRead) markRead.after(item);
        else items[0].before(item);
    }
    function onContextMenu(event) {
        const request = ++menuRequest;
        document.getElementById("lowcord-open-tab")?.remove();
        const path = targetPath(event.target);
        if (!path) return;
        let frames = 0;
        const look = () => {
            if (request !== menuRequest || !active) return;
            const found = document.querySelector('[role="menu"]:not(.lowcord-tabs-menu)');
            if (!found) { if (++frames < 30) requestAnimationFrame(look); return; }
            addMenuItem(found, path);
        };
        requestAnimationFrame(() => requestAnimationFrame(look));
    }
    const isMod = event => mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    function onClick(event) {
        if (event.button !== 0 || !isMod(event) || event.altKey) return;
        const path = targetPath(event.target);
        if (!path || !event.target.closest('a[href], [data-list-item-id^="guildsnav___"]')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        open(path, { background: !event.shiftKey });
    }
    function onAuxClick(event) {
        if (event.button !== 1) return;
        const path = targetPath(event.target);
        if (!path || !event.target.closest('a[href], [data-list-item-id^="guildsnav___"]')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        open(path, { background: true });
    }
    const swallowMiddle = event => { if (event.button === 1 && targetPath(event.target) && event.target.closest('a[href], [data-list-item-id^="guildsnav___"]')) event.preventDefault(); };

    // ----- Shortcuts -----------------------------------------------------------
    function onKey(event) {
        if (!active || event.repeat && !/^(Tab|\[|\])$/.test(event.key)) return;
        if (window.Lowcord.privacy?.locked || document.querySelector(".lowcord-palette-backdrop, .lowcord-settings-backdrop")) return;
        const key = event.key.toLowerCase();
        const handled = () => { event.preventDefault(); event.stopImmediatePropagation(); };
        if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") { handled(); select(event.shiftKey ? -1 : 1); return; }
        if (!isMod(event) || event.altKey) return;
        if (key === "t" && !event.shiftKey) { handled(); picker(); return; }
        if (key === "t" && event.shiftKey) { handled(); reopen(); return; }
        if (key === "w" && !event.shiftKey && tabs().length > 1) { handled(); close(space().active); return; }
        if (mac && event.shiftKey && (event.key === "[" || event.key === "]" || event.code === "BracketLeft" || event.code === "BracketRight")) {
            handled(); select(event.code === "BracketLeft" || event.key === "[" ? -1 : 1); return;
        }
        if (!event.shiftKey && /^[1-9]$/.test(event.key) && tabs().length > 1) {
            handled();
            const list_ = tabs();
            activate((event.key === "9" ? list_[list_.length - 1] : list_[Number(event.key) - 1] ?? list_[list_.length - 1]).id);
        }
    }

    // ----- Lifecycle -----------------------------------------------------------
    let stopDom, stopNative, subscriptions = [];
    const originals = {};
    function hookHistory() {
        for (const name of ["pushState", "replaceState"]) {
            if (originals[name]) continue;
            const original = history[name];
            originals[name] = original;
            history[name] = function (...args) {
                const result = original.apply(this, args);
                queueMicrotask(routed);
                return result;
            };
        }
        window.addEventListener("popstate", routed);
    }
    function unhookHistory() {
        for (const [name, original] of Object.entries(originals)) {
            // Only restore when nothing wrapped it after us.
            if (history[name] !== original) history[name] = original;
            delete originals[name];
        }
        window.removeEventListener("popstate", routed);
    }
    function subscribe(name) {
        window.Lowcord.waitForStore(name, found => {
            if (!active || subscriptions.some(entry => entry.found === found) || !found.addChangeListener) return;
            found.addChangeListener(schedule);
            subscriptions.push({ found });
            schedule();
        });
    }
    function sync() {
        const next = enabled(ID);
        if (next === active) return;
        active = next;
        if (next) {
            state = read();
            following = "";
            if (!tabs().length) { const tab = blank(); space().tabs.push(tab); space().active = tab.id; }
            hookHistory();
            routed();
            window.addEventListener("contextmenu", onContextMenu, true);
            window.addEventListener("click", onClick, true);
            window.addEventListener("auxclick", onAuxClick, true);
            window.addEventListener("mousedown", swallowMiddle, true);
            window.addEventListener("keydown", onKey, true);
            stopDom = window.Lowcord.onDomChange(records => {
                if (!bar?.isConnected || !strip?.isConnected || window.Lowcord.domChanged(records, '[class*="base_"] > [class*="bar_"]')) place();
            });
            for (const name of ["ReadStateStore", "RTCConnectionStore", "ChannelStore", "GuildStore"]) subscribe(name);
            stopNative = window.__LOWCORD_NATIVE__?.onCloseTab?.(() => { if (active && tabs().length > 1 && !window.Lowcord.privacy?.locked) close(space().active); });
        } else {
            unhookHistory();
            stopNative?.(); stopNative = undefined; tellCloseable(false);
            window.removeEventListener("contextmenu", onContextMenu, true);
            window.removeEventListener("click", onClick, true);
            window.removeEventListener("auxclick", onAuxClick, true);
            window.removeEventListener("mousedown", swallowMiddle, true);
            window.removeEventListener("keydown", onKey, true);
            stopDom?.(); stopDom = undefined;
            for (const { found } of subscriptions) found.removeChangeListener?.(schedule);
            subscriptions = [];
            resize?.disconnect(); resize = null;
            bar?.removeAttribute("data-lowcord-tabs"); bar = null;
            strip?.remove(); strip = null; lastKey = "";
            closeMenu(); pick?.close();
            document.getElementById("lowcord-open-tab")?.remove();
        }
    }
    window.addEventListener(changeEvent, sync);
    window.Lowcord.tabs = {
        open, close: id => close(id ?? space().active), reopen, picker, select, saveSpace, switchSpace,
        get state() { return { tabs: tabs().map(tab => ({ ...tab })), active: space().active, workspace: space().name, workspaces: state.spaces.map(entry => entry.name), closed: [...state.closed] }; },
        // Command palette entries.
        paletteEntries() {
            if (!active) return [];
            const list_ = [
                { group: "Tabs", label: "New tab", detail: `${mod}T`, run: () => picker() },
                { group: "Tabs", label: "Reopen closed tab", detail: `${mac ? "⌘⇧T" : "Ctrl+Shift+T"}`, run: reopen },
                { group: "Tabs", label: "Save tabs as a workspace", match: "workspace save tabs new", run: () => picker({ mode: "name" }) },
            ];
            for (const entry of state.spaces) if (entry.id !== state.current) list_.push({ group: "Tabs", label: `Switch to workspace: ${entry.name}`, match: `workspace ${entry.name}`, detail: `${entry.tabs.length} tabs`, run: () => switchSpace(entry.id) });
            return list_;
        },
    };
    sync();
})();
