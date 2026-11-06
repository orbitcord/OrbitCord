// Mark all as read: a round button under Home in the server list that
// acknowledges every unread server channel at once. Shown only while something
// is unread. It listens to Discord's read-state stores (throttled to once a
// second) only while the extension is on, and removes itself when it is off.
(() => {
    const { extensions } = window.Lowcord;
    const { enabled, toast, ui, changeEvent } = extensions;
    const store = name => window.Lowcord.store(name);
    const tick = "M1.5 12.5l4.5 4.5L14 8.5M9.5 15.5l1.5 1.5L21 7.5";
    const homeItem = () => document.querySelector('nav[aria-label="Servers sidebar"] [data-list-item-id="guildsnav___home"], [class*="guilds_"] [data-list-item-id="guildsnav___home"]')
        ?.closest('[class*="listItem_"]') ?? null;

    // Unread, unmuted text channels across servers (direct messages excluded).
    function unreadChannels() {
        const guilds = store("GuildStore")?.getGuilds?.() ?? {};
        const reads = store("ReadStateStore"), settings = store("UserGuildSettingsStore"), channels = store("GuildChannelStore");
        if (!reads || !channels) return [];
        const found = [];
        for (const guildId of Object.keys(guilds)) {
            if (settings?.isMuted?.(guildId)) continue;
            const groups = channels.getChannels?.(guildId);
            for (const { channel } of groups?.SELECTABLE ?? []) {
                if (!channel || channel.type === 15 || channel.type === 16) continue;
                if (!reads.hasUnread?.(channel.id) || settings?.isChannelMuted?.(guildId, channel.id)) continue;
                const messageId = reads.lastMessageId?.(channel.id);
                if (messageId) found.push({ channelId: channel.id, messageId });
            }
        }
        return found;
    }
    // A cheap check for the button's visibility: per-server unread flags.
    function anyUnread() {
        const guilds = store("GuildStore")?.getGuilds?.() ?? {};
        const flags = store("GuildReadStateStore"), settings = store("UserGuildSettingsStore");
        if (!flags?.hasUnread) return unreadChannels().length > 0;
        return Object.keys(guilds).some(id => flags.hasUnread(id) && !settings?.isMuted?.(id));
    }

    let busy = false;
    async function markAll() {
        if (busy) return;
        const channels = unreadChannels();
        if (!channels.length) { update(); return; }
        busy = true;
        try {
            const bulk = window.Lowcord.find(window.Lowcord.filters.byProps("bulkAck"));
            let done = false;
            if (bulk) {
                try { bulk.bulkAck(channels.map(({ channelId, messageId }) => ({ channelId, messageId, readStateType: 0 }))); done = true; }
                catch (error) { console.warn("[lowcord] mark all as read:", error); }
            }
            if (!done) {
                const rest = window.Lowcord.RestAPI;
                if (!rest) { toast("Couldn't mark everything as read. Try again.", true); return; }
                for (let index = 0; index < channels.length; index += 100) {
                    const batch = channels.slice(index, index + 100);
                    await rest.post({ url: "/read-states/ack-bulk", body: {
                        read_states: batch.map(({ channelId, messageId }) => ({ channel_id: channelId, message_id: messageId, read_state_type: 0 })) } });
                    // Update Discord's own state now rather than at its next sync.
                    try { window.Lowcord.Dispatcher?.dispatch({ type: "BULK_ACK", context: "APP",
                        channels: batch.map(({ channelId, messageId }) => ({ channelId, messageId, readStateType: 0 })) }); } catch {}
                }
            }
            toast(`Marked ${channels.length} ${channels.length === 1 ? "channel" : "channels"} as read`);
        } catch (failure) {
            console.warn("[lowcord] mark all as read:", failure);
            toast("Couldn't mark everything as read. Try again.", true);
        } finally { busy = false; update(); }
    }

    let node, active = false, stopDom, subscriptions = [], timer = 0, last = 0;
    function build() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "12"); svg.setAttribute("height", "12"); svg.setAttribute("aria-hidden", "true");
        svg.innerHTML = `<path d="${tick}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
        return ui("div", { className: "lowcord-readall" },
            ui("button", { type: "button", className: "lowcord-readall-button", "aria-label": "Mark all as read", title: "Mark all as read", onClick: markAll }, svg, ui("span", {}, "Read all")));
    }
    function place() {
        if (!active) return;
        const home = homeItem();
        if (!home) { node?.remove(); return; }
        node ??= build();
        const anchor = home.nextElementSibling?.classList.contains("lowcord-online-friends") ? home.nextElementSibling : home;
        if (anchor.nextElementSibling !== node) anchor.after(node);
    }
    function update() {
        if (!active) return;
        place();
        if (node) node.hidden = !anyUnread();
    }
    // Trailing throttle: at most one update a second however fast the stores change.
    function changed() {
        const wait = last + 1000 - Date.now();
        if (wait <= 0) { last = Date.now(); update(); }
        else if (!timer) timer = setTimeout(() => { timer = 0; last = Date.now(); update(); }, wait);
    }
    function subscribe(name) {
        window.Lowcord.waitForStore(name, found => {
            if (!active || subscriptions.some(entry => entry.found === found) || !found.addChangeListener) return;
            found.addChangeListener(changed);
            subscriptions.push({ found });
        });
    }
    function sync() {
        const next = enabled("readAll");
        if (next === active) return;
        active = next;
        if (next) {
            for (const name of ["ReadStateStore", "GuildReadStateStore", "UserGuildSettingsStore", "GuildStore"]) subscribe(name);
            stopDom = window.Lowcord.onDomChange(records => { if (window.Lowcord.domChanged(records, '[data-list-item-id="guildsnav___home"], .lowcord-readall, .lowcord-online-friends')) update(); });
            update();
        } else {
            stopDom?.(); stopDom = undefined;
            for (const { found } of subscriptions) found.removeChangeListener?.(changed);
            subscriptions = [];
            clearTimeout(timer); timer = 0;
            node?.remove(); node = undefined;
        }
    }
    window.addEventListener(changeEvent, sync);
    sync();
})();
