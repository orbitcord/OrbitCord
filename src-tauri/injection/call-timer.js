// Call timer: elapsed time in the voice connection panel while connected.
// The start is kept in Lowcord's storage with the channel, so a reload during
// a call continues the count. One interval runs only while connected and the
// window is visible.
(() => {
    const { extensions } = window.Lowcord;
    const { enabled, changeEvent } = extensions;
    const store = name => window.Lowcord.store(name);
    const key = "lowcord.callTimer.v1";
    const storage = window.Lowcord.storage;
    const stale = 60_000;

    const read = () => { try { return JSON.parse(storage?.getItem(key)) ?? null; } catch { return null; } };
    const write = value => { try { if (value) storage?.setItem(key, JSON.stringify(value)); else storage?.removeItem(key); } catch {} };
    // The voice channel while the connection is up; null otherwise.
    function connectedChannel() {
        const rtc = store("RTCConnectionStore");
        if (rtc?.getState && rtc.getState() !== "RTC_CONNECTED") return null;
        return rtc?.getChannelId?.() ?? store("SelectedChannelStore")?.getVoiceChannelId?.() ?? null;
    }
    const pad = value => String(value).padStart(2, "0");
    function format(ms) {
        const total = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(total / 3600);
        return hours ? `${hours}:${pad(Math.floor(total % 3600 / 60))}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
    }

    let active = false, session = null, node, interval = 0, stopDom, subscriptions = [], ticks = 0;
    function place() {
        const status = document.querySelector('[class*="rtcConnectionStatus_"]');
        if (!status) { node?.remove(); return; }
        if (!node) {
            node = document.createElement("div");
            node.className = "lowcord-call-timer";
            node.setAttribute("role", "timer");
            node.setAttribute("aria-label", "Time in call");
        }
        if (node.parentElement !== status) status.append(node);
    }
    function paint() {
        if (!session) return;
        place();
        if (!node) return;
        const text = format(Date.now() - session.start);
        if (node.textContent !== text) node.textContent = text;
        if (++ticks % 10 === 0) write({ ...session, seen: Date.now() });
    }
    function run() {
        const going = Boolean(session) && document.visibilityState === "visible";
        if (going && !interval) interval = setInterval(paint, 1000);
        else if (!going && interval) { clearInterval(interval); interval = 0; }
        if (going) paint();
    }
    function changed() {
        if (!active) return;
        const channelId = connectedChannel();
        if (!channelId) {
            if (session) { session = null; write(null); node?.remove(); node = undefined; stopDom?.(); stopDom = undefined; }
            run();
            return;
        }
        if (session?.channelId === channelId) return;
        const saved = read();
        // A saved start counts only if it was seen alive a moment ago.
        session = saved?.channelId === channelId && Date.now() - (saved.seen ?? 0) < stale && saved.start <= Date.now()
            ? { channelId, start: saved.start } : { channelId, start: Date.now() };
        write({ ...session, seen: Date.now() });
        stopDom ??= window.Lowcord.onDomChange(records => { if (window.Lowcord.domChanged(records, '[class*="rtcConnectionStatus_"]')) place(); });
        node?.remove(); node = undefined;
        run();
    }
    const visibility = () => { if (active) run(); };
    function subscribe(name) {
        window.Lowcord.waitForStore(name, found => {
            if (!active || subscriptions.some(entry => entry.found === found) || !found.addChangeListener) return;
            found.addChangeListener(changed);
            subscriptions.push({ found });
            changed();
        });
    }
    function sync() {
        const next = enabled("callTimer");
        if (next === active) return;
        active = next;
        if (next) {
            subscribe("RTCConnectionStore"); subscribe("SelectedChannelStore");
            document.addEventListener("visibilitychange", visibility);
            changed();
        } else {
            document.removeEventListener("visibilitychange", visibility);
            for (const { found } of subscriptions) found.removeChangeListener?.(changed);
            subscriptions = [];
            clearInterval(interval); interval = 0;
            stopDom?.(); stopDom = undefined;
            node?.remove(); node = undefined;
            session = null;
        }
    }
    window.addEventListener(changeEvent, sync);
    sync();
})();
