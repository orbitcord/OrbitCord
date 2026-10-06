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
    const pending = new Set(), pendingStores = new Map();
    let timer;
    function poll() {
        const unresolved = new Set(pending), resolved = [];
        // Enumerate exports once, rather than once for every pending feature.
        for (const value of exportsOf()) {
            try { if (value[probe] !== undefined) continue; } catch { continue; }
            for (const entry of unresolved) {
                try { if (!entry.filter(value)) continue; } catch { continue; }
                unresolved.delete(entry); resolved.push([entry, value]);
            }
            if (!unresolved.size) break;
        }
        for (const [entry, value] of resolved) {
            pending.delete(entry);
            if (entry.name) { pendingStores.delete(entry.name); cache.set(`store:${entry.name}`, value); }
            for (const callback of entry.callbacks) {
                try { callback(value); } catch (error) { console.error("[Lowcord]", error); }
            }
        }
        if (!pending.size) { clearInterval(timer); timer = undefined; }
    }
    function waitFor(filter, callback) {
        const value = find(filter);
        if (value) { callback(value); return; }
        pending.add({ filter, callbacks: new Set([callback]) });
        timer ??= setInterval(poll, 250);
    }
    function waitForStore(name, callback) {
        const waiting = pendingStores.get(name);
        if (waiting) { waiting.callbacks.add(callback); return; }
        const value = cached(`store:${name}`, filters.byStoreName(name));
        if (value) { callback(value); return; }
        const entry = { name, filter: filters.byStoreName(name), callbacks: new Set([callback]) };
        pendingStores.set(name, entry); pending.add(entry);
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
    let domFrame, domObserver, domRecords = [];
    function domChanged(records, selector) {
        if (!Array.isArray(records)) return true;
        return records.some(record => {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (target?.closest(selector)) return true;
            return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element &&
                (node.matches(selector) || node.querySelector(selector)));
        });
    }
    function startDomObserver() {
        if (!domListeners.size || domObserver || !document.body) return;
        domObserver = new MutationObserver(records => {
            // A hidden window may not run rAF. Bound retained mutation records;
            // null requests a complete reconciliation after a large burst.
            if (domRecords !== null) domRecords = domRecords.length + records.length > 1000 ? null : domRecords.concat(records);
            domFrame ??= requestAnimationFrame(() => {
                domFrame = undefined;
                const records = domRecords; domRecords = [];
                for (const fn of domListeners) { try { fn(records); } catch (error) { console.error("[Lowcord]", error); } }
            });
        });
        domObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
        // Registrations made from document-start scripts could not see body.
        for (const fn of domListeners) { try { fn(); } catch (error) { console.error("[Lowcord]", error); } }
    }
    function onDomChange(listener) {
        domListeners.add(listener);
        if (document.body) {
            if (domObserver) listener(); else startDomObserver();
        } else document.addEventListener("DOMContentLoaded", startDomObserver, { once: true });
        return () => {
            domListeners.delete(listener);
            if (!domListeners.size) {
                domObserver?.disconnect(); domObserver = undefined;
                if (domFrame !== undefined) cancelAnimationFrame(domFrame);
                domFrame = undefined; domRecords = [];
                document.removeEventListener("DOMContentLoaded", startDomObserver);
            }
        };
    }

    window.Lowcord = {
        // Discord deletes window.localStorage while it starts; the shim kept it.
        storage: window.__lowcordStorage,
        filters, find, waitFor, waitForStore, onDomChange, domChanged,
        store: name => cached(`store:${name}`, filters.byStoreName(name)),
        get React() { return cached("react", value => filters.byProps("createElement", "useState", "useEffect")(value) && typeof value.version === "string"); },
        // 299 is React's invariant code shared by createRoot and createPortal.
        get createRoot() { return cached("createRoot", filters.byCode("(299));", ".onRecoverableError")); },
        get CloudUpload() { return cached("cloudUpload", value => typeof value?.prototype?.trackUploadFinished === "function"); },
        get RestAPI() { return cached("rest", value => typeof value === "object" && filters.byProps("del", "put", "post", "get", "patch")(value)); },
        get Dispatcher() { return cached("dispatcher", filters.byProps("dispatch", "subscribe", "unsubscribe")); },
    };
})();
