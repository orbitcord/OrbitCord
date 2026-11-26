// Command palette: Cmd/Ctrl+Shift+K opens one search box for chats, servers
// and every OrbitCord action. Discord's quick switcher keeps Cmd/Ctrl+K; the
// palette's last entry hands its query to that switcher. The index is built
// when it opens and dropped when it closes.
(() => {
    const ID = "commandPalette";
    const { extensions } = window.Lowcord;
    const { enabled, ui, toast, changeEvent } = extensions;
    const store = name => window.Lowcord.store(name);
    const mac = navigator.platform.startsWith("Mac");
    const limit = 60;

    // ----- Matching ------------------------------------------------------------
    // Higher is better; -1 is no match. Prefix beats word start beats substring
    // beats letters in order, and shorter labels win ties.
    function score(text, query) {
        if (!query) return 0;
        const value = text.toLocaleLowerCase();
        if (value.startsWith(query)) return 400 - value.length;
        const at = value.indexOf(query);
        if (at > 0 && /[\s#@:\-_/.]/.test(value[at - 1])) return 300 - value.length;
        if (at > 0) return 200 - at - value.length / 10;
        let last = -1, gaps = 0;
        for (const letter of query) {
            const found = value.indexOf(letter, last + 1);
            if (found === -1) return -1;
            if (last !== -1) gaps += found - last - 1;
            last = found;
        }
        return 100 - gaps - value.length / 10;
    }

    // ----- Entries -------------------------------------------------------------
    const go = path => () => window.Lowcord.transitionTo?.(path);
    // A chat entry keeps its path so Tabs can open it in a tab.
    const chat = (entry, path) => ({ ...entry, path, run: go(path) });
    function userName(id) {
        const user = store("UserStore")?.getUser?.(id);
        return user?.globalName || user?.global_name || user?.username || "Unknown user";
    }
    function chats() {
        const list = [];
        const channels = store("ChannelStore"), guilds = store("GuildStore")?.getGuilds?.() ?? {}, guildChannels = store("GuildChannelStore");
        const privateChannels = channels?.getSortedPrivateChannels?.() ?? Object.values(channels?.getMutablePrivateChannels?.() ?? {});
        for (const [index, channel] of privateChannels.entries()) {
            const recipients = channel.recipients ?? channel.rawRecipients?.map(user => user.id) ?? [];
            const name = channel.name || recipients.map(id => typeof id === "string" ? userName(id) : id.username).join(", ");
            if (!name) continue;
            list.push(chat({ group: "Direct messages", label: name, detail: recipients.length > 1 ? "Group DM" : "Direct message", recent: index }, `/channels/@me/${channel.id}`));
        }
        for (const guild of Object.values(guilds)) {
            list.push(chat({ group: "Servers", label: guild.name, detail: "Server" }, `/channels/${guild.id}`));
            const groups = guildChannels?.getChannels?.(guild.id);
            for (const { channel } of [...groups?.SELECTABLE ?? [], ...groups?.VOCAL ?? []]) {
                if (!channel?.name) continue;
                const voice = channel.type === 2 || channel.type === 13;
                list.push(chat({ group: "Channels", label: `${voice ? "🔊 " : "#"}${channel.name}`, match: channel.name, detail: guild.name }, `/channels/${guild.id}/${channel.id}`));
            }
        }
        return list;
    }
    function actions() {
        const list = [];
        const settings = window.__lowcordOpenSettings;
        for (const action of extensions.composerActions ?? []) {
            if (enabled(action.id)) list.push({ group: "Actions", label: action.label, detail: "Message bar", suggested: true, run: () => action.run() });
        }
        list.push(...window.Lowcord.tabs?.paletteEntries?.() ?? []);
        list.push({ group: "Actions", label: "Mark all as read", detail: "Every unread server", suggested: true, run: () => window.Lowcord.readAll?.markAll() });
        if (enabled("mediaGallery") && window.Lowcord.mediaGallery) list.push({ group: "Actions", label: "Media gallery", detail: "This chat's photos and videos", run: () => window.Lowcord.mediaGallery.toggle() });
        const privacy = window.Lowcord.privacy;
        if (privacy?.state.appLock) list.push({ group: "Actions", label: "Lock OrbitCord", detail: privacy.shortcutText?.(privacy.state.lockShortcut) ?? "", run: () => privacy.lockNow() });
        const native = window.__LOWCORD_NATIVE__;
        if (native?.accounts) list.push({ group: "Actions", label: "Open another account", detail: "New window", run: () => native.accounts("new") });
        for (const page of settings?.pages ?? []) {
            list.push({ group: "Settings", label: `OrbitCord Settings: ${page.title}`, match: `settings ${page.title}`, detail: "Settings", suggested: page.id === "extensions", run: () => settings(page.id) });
        }
        const themes = window.__lowcordThemes;
        for (const theme of themes?.catalog ?? []) {
            if (theme.id === "nitro") continue;
            const current = themes.state.id === theme.id;
            list.push({ group: "Themes", label: `Theme: ${theme.name}`, match: `theme ${theme.name}`, detail: current ? "Current" : theme.scheme === "light" ? "Light" : "Dark",
                run: () => { try { themes.set({ id: theme.id }); } catch (error) { toast(error.message, true); } } });
        }
        for (const extension of extensions.catalog) {
            if (extension.id === ID) continue;
            const on = enabled(extension.id);
            list.push({ group: "Extensions", label: `${on ? "Turn off" : "Turn on"} ${extension.title}`, match: `${extension.title} ${on ? "off disable" : "on enable"}`,
                detail: on ? "On" : "Off", run: () => {
                    try { extensions.set(extension.id, !on); toast(`${extension.title} ${on ? "off" : "on"}`, false, 1600); }
                    catch (error) { toast(error.message, true); }
                } });
        }
        return list;
    }
    function rank(index, query) {
        const terms = query.trim().toLocaleLowerCase();
        if (!terms) {
            const recent = index.filter(entry => entry.recent !== undefined && entry.recent < 6);
            return [...index.filter(entry => entry.suggested), ...recent].slice(0, limit);
        }
        const found = [];
        for (const entry of index) {
            const value = Math.max(score(entry.match ?? entry.label, terms), entry.match ? score(entry.label, terms) : -1);
            if (value >= 0) found.push([value + (entry.group === "Direct messages" ? 15 : 0) - (entry.recent ?? 0) / 100, entry]);
        }
        found.sort((a, b) => b[0] - a[0]);
        // Letters-in-order matches only count when nothing contains the words.
        const close = found[0]?.[0] >= 150 ? found.filter(([value]) => value >= 150) : found;
        // Keep each group together, groups ordered by their best match.
        const groups = new Map();
        for (const [, entry] of close.slice(0, limit)) {
            if (!groups.has(entry.group)) groups.set(entry.group, []);
            groups.get(entry.group).push(entry);
        }
        const results = [...groups.values()].flat();
        results.push({ group: "Discord", label: `Search Discord's quick switcher for "${query.trim()}"`, detail: "Messages, members and more",
            run: () => {
                try { window.Lowcord.Dispatcher?.dispatch({ type: "QUICKSWITCHER_SHOW", query: query.trim(), queryMode: null }); }
                catch { toast("Discord's quick switcher isn't available here.", true); }
            } });
        return results;
    }

    // ----- Dialog --------------------------------------------------------------
    let open = null;
    function show() {
        if (open) { open.input.focus(); open.input.select(); return; }
        const restoreFocus = document.activeElement;
        const index = [...actions(), ...chats()];
        const input = ui("input", { type: "text", className: "lowcord-palette-input", role: "combobox", "aria-expanded": "true", "aria-controls": "lowcord-palette-list",
            "aria-autocomplete": "list", "aria-label": "Search chats and actions", placeholder: "Jump to a chat or run an action…", spellcheck: "false", autocomplete: "off" });
        const list = ui("div", { className: "lowcord-palette-list", id: "lowcord-palette-list", role: "listbox", "aria-label": "Results" });
        const empty = ui("p", { className: "lowcord-palette-empty", hidden: true }, "No matches");
        const hint = ui("footer", { className: "lowcord-palette-hint" },
            ui("span", {}, ui("kbd", {}, "↑"), ui("kbd", {}, "↓"), " to choose"), ui("span", {}, ui("kbd", {}, "↵"), " to open"), ui("span", {}, ui("kbd", {}, "esc"), " to close"));
        const panel = ui("div", { className: "lowcord-palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" }, input, list, empty, hint);
        const backdrop = ui("div", { className: "lowcord-palette-backdrop" }, panel);
        let results = [], active = 0;
        const select = (next, scroll = true) => {
            active = Math.max(0, Math.min(results.length - 1, next));
            for (const [position, row] of [...list.children].filter(node => node.role === "option").entries()) row.setAttribute("aria-selected", String(position === active));
            const row = list.querySelector(`#lowcord-palette-option-${active}`);
            if (row) { input.setAttribute("aria-activedescendant", row.id); if (scroll) row.scrollIntoView({ block: "nearest" }); }
            else input.removeAttribute("aria-activedescendant");
        };
        function render() {
            results = rank(index, input.value);
            const rows = [];
            let group = "";
            for (const [position, entry] of results.entries()) {
                if (entry.group !== group) { group = entry.group; rows.push(ui("div", { className: "lowcord-palette-group", role: "presentation" }, group)); }
                const row = ui("div", { className: "lowcord-palette-item", role: "option", id: `lowcord-palette-option-${position}`, "aria-selected": "false",
                    onMousemove: () => { if (active !== position) select(position, false); }, onClick: () => run(position) },
                    ui("span", { className: "lowcord-palette-label" }, entry.label), entry.detail ? ui("span", { className: "lowcord-palette-detail" }, entry.detail) : null);
                rows.push(row);
            }
            list.replaceChildren(...rows);
            empty.hidden = results.length > 0;
            list.scrollTop = 0;
            select(0);
        }
        function run(position) {
            const entry = results[position];
            close();
            if (!entry) return;
            // After closing, so actions that open their own dialog take focus.
            try { entry.run(); } catch (error) { console.warn("[lowcord] command palette:", error); toast("That didn't work. Try again.", true); }
        }
        function close(restore = false) {
            if (open?.backdrop !== backdrop) return;
            open = null;
            window.removeEventListener("keydown", onKey, true);
            backdrop.remove();
            if (restore) restoreFocus?.focus?.();
        }
        const onKey = event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(true); return; }
            if (event.target !== input) return;
            const page = Math.max(1, Math.floor(list.clientHeight / 40));
            const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[event.key] ?? (event.ctrlKey && event.key === "n" ? 1 : event.ctrlKey && event.key === "p" ? -1 : 0);
            if (step) { event.preventDefault(); event.stopImmediatePropagation(); select(active + step); return; }
            if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); run(active); return; }
            // Typing stays in the palette instead of reaching Discord's own shortcuts.
            event.stopPropagation();
        };
        input.addEventListener("input", render);
        backdrop.addEventListener("mousedown", event => { if (event.target === backdrop) close(true); });
        open = { backdrop, input, close };
        render();
        document.body.append(backdrop);
        window.addEventListener("keydown", onKey, true);
        input.focus();
    }

    // Only one Lowcord dialog at a time, and never over the app lock.
    const blocked = () => window.Lowcord.privacy?.locked || document.querySelector(".lowcord-capture-preview-backdrop, .lowcord-settings-backdrop");
    window.addEventListener("keydown", event => {
        if (event.key.toLowerCase() !== "k" || !event.shiftKey || event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
        if (!enabled(ID) || event.repeat) return;
        if (open) { event.preventDefault(); event.stopImmediatePropagation(); open.close(true); return; }
        if (blocked()) return;
        event.preventDefault(); event.stopImmediatePropagation();
        show();
    }, true);
    window.addEventListener(changeEvent, () => { if (!enabled(ID)) open?.close(); });
    window.Lowcord.commandPalette = { open: show, close: () => open?.close(), score, chats, get isOpen() { return Boolean(open); } };
})();
