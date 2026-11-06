// Online friend count: a small "N Online" label under the Home button in the
// server list. Updated from the relationship and presence stores' change
// events, at most once a second; nothing polls. Clicking opens the Friends page.
(() => {
    const { extensions } = window.Lowcord;
    const { enabled, ui, changeEvent } = extensions;
    const store = name => window.Lowcord.store(name);
    const homeItem = () => document.querySelector('nav[aria-label="Servers sidebar"] [data-list-item-id="guildsnav___home"], [class*="guilds_"] [data-list-item-id="guildsnav___home"]')
        ?.closest('[class*="listItem_"]') ?? null;
    const away = new Set(["offline", "invisible", "unknown"]);

    function count() {
        const relationships = store("RelationshipStore"), presence = store("PresenceStore");
        if (!relationships || !presence?.getStatus) return null;
        const ids = relationships.getFriendIDs?.()
            ?? Object.entries(relationships.getRelationships?.() ?? {}).filter(([, type]) => type === 1).map(([id]) => id);
        let online = 0;
        for (const id of ids) if (!away.has(presence.getStatus(id))) online++;
        return online;
    }

    let node, active = false, stopDom, subscriptions = [], timer = 0, last = 0;
    function place() {
        const home = homeItem();
        if (!home) { node?.remove(); return false; }
        node ??= ui("button", { type: "button", className: "lowcord-online-friends",
            onClick: () => window.Lowcord.transitionTo?.("/channels/@me") });
        if (home.nextElementSibling !== node) home.after(node);
        return true;
    }
    function update() {
        if (!active) return;
        const online = count();
        if (online === null || !place()) { if (online === null) node?.remove(); return; }
        const text = `${online} Online`;
        if (node.textContent !== text) node.textContent = text;
        node.setAttribute("aria-label", `${online} ${online === 1 ? "friend" : "friends"} online. Open friends`);
    }
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
            update();
        });
    }
    function sync() {
        const next = enabled("onlineFriendCount");
        if (next === active) return;
        active = next;
        if (next) {
            subscribe("RelationshipStore"); subscribe("PresenceStore");
            stopDom = window.Lowcord.onDomChange(records => { if (window.Lowcord.domChanged(records, '[data-list-item-id="guildsnav___home"], .lowcord-online-friends')) update(); });
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
