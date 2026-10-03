// Read-only access to Discord's own modules. One entry is pushed into the
// webpack chunk queue before Discord's runtime boots; the runtime then hands
// it `__webpack_require__`, whose module cache is searched on demand. Nothing
// in Discord's source is rewritten.
(() => {
    let wreq;
    const chunks = (window.webpackChunkdiscord_app ??= []);
    chunks.push([[Symbol("lowcord")], {}, require => { wreq = require; }]);

    function* exportsOf() {
        if (!wreq?.c) return;
        for (const id in wreq.c) {
            const exports = wreq.c[id]?.exports;
            if (exports == null || exports === window) continue;
            yield exports;
            if (typeof exports !== "object") continue;
            for (const key in exports) {
                let value;
                try { value = exports[key]; } catch { continue; }
                if (value != null && value !== exports && value !== window) yield value;
            }
        }
    }
    // Discord's translation table is a Proxy that answers every property name;
    // anything that has a made-up property is skipped.
    const probe = "__lowcordProbe__";
    function find(filter) {
        for (const value of exportsOf()) {
            try { if (value[probe] === undefined && filter(value)) return value; } catch {}
        }
        return null;
    }
    const filters = {
        byProps: (...props) => value => props.every(prop => typeof value?.[prop] === "function"),
        byStoreName: name => value => value?.constructor?.displayName === name,
        byCode: (...code) => value => typeof value === "function"
            && code.every(part => Function.prototype.toString.call(value).includes(part)),
    };

    // Modules load as Discord needs them, so pending lookups retry until found.
    const pending = new Set();
    let timer;
    function poll() {
        for (const entry of pending) {
            const value = find(entry.filter);
            if (value) { pending.delete(entry); entry.callback(value); }
        }
        if (!pending.size) { clearInterval(timer); timer = undefined; }
    }
    function waitFor(filter, callback) {
        const value = find(filter);
        if (value) { callback(value); return; }
        pending.add({ filter, callback });
        timer ??= setInterval(poll, 250);
    }
    const cache = new Map();
    function cached(key, filter) {
        if (!cache.has(key)) {
            const value = find(filter);
            if (!value) return null;
            cache.set(key, value);
        }
        return cache.get(key);
    }

    // One batched observer for Lowcord features that need to notice new UI.
    const domListeners = new Set();
    let domFrame;
    function onDomChange(listener) {
        domListeners.add(listener);
        if (domListeners.size === 1) {
            const start = () => new MutationObserver(() => {
                domFrame ??= requestAnimationFrame(() => {
                    domFrame = undefined;
                    for (const fn of domListeners) { try { fn(); } catch (error) { console.error("[Lowcord]", error); } }
                });
            }).observe(document.body, { childList: true, subtree: true });
            if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
        }
        listener();
    }

    window.Lowcord = {
        // Discord deletes window.localStorage while it starts; the shim kept it.
        storage: window.__lowcordStorage,
        filters, find, waitFor, onDomChange,
        waitForStore: (name, callback) => waitFor(filters.byStoreName(name), callback),
        store: name => cached(`store:${name}`, filters.byStoreName(name)),
        get React() { return cached("react", value => filters.byProps("createElement", "useState", "useEffect")(value) && typeof value.version === "string"); },
        // 299 is React's invariant code shared by createRoot and createPortal.
        get createRoot() { return cached("createRoot", filters.byCode("(299));", ".onRecoverableError")); },
        get CloudUpload() { return cached("cloudUpload", value => typeof value?.prototype?.trackUploadFinished === "function"); },
        get RestAPI() { return cached("rest", value => typeof value === "object" && filters.byProps("del", "put", "post", "get", "patch")(value)); },
        get Dispatcher() { return cached("dispatcher", filters.byProps("dispatch", "subscribe", "unsubscribe")); },
    };
})();
