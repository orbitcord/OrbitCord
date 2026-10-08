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
    // A full export scan runs only when the module cache grew, a lookup was
    // added, or 5 s passed (a cached module can still be filling its exports).
    const pending = new Set(), pendingStores = new Map();
    let timer, scannedModules = -1, scannedAt = 0;
    function poll() {
        const modules = wreq?.c ? Object.keys(wreq.c).length : 0;
        if (modules === scannedModules && Date.now() - scannedAt < 5000) return;
        scannedModules = modules; scannedAt = Date.now();
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
        scannedModules = -1; timer ??= setInterval(poll, 250);
    }
    function waitForStore(name, callback) {
        const waiting = pendingStores.get(name);
        if (waiting) { waiting.callbacks.add(callback); return; }
        const value = cached(`store:${name}`, filters.byStoreName(name));
        if (value) { callback(value); return; }
        const entry = { name, filter: filters.byStoreName(name), callbacks: new Set([callback]) };
        pendingStores.set(name, entry); pending.add(entry);
        scannedModules = -1; timer ??= setInterval(poll, 250);
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

    // One observer for every Lowcord feature. onDomMutation listeners get raw
    // records before paint; onDomChange listeners get one batch per frame of
    // structure and src changes. id/class records are only requested while a
    // before-paint listener needs them.
    const mutationListeners = new Set(), domListeners = new Set();
    let domFrame, domObserver, domRecords = [], observedAttributes = "";
    function domChanged(records, selector) {
        if (!Array.isArray(records)) return true;
        return records.some(record => {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (target?.closest(selector)) return true;
            return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element &&
                (node.matches(selector) || node.querySelector(selector)));
        });
    }
    function mutated(records) {
        for (const fn of mutationListeners) { try { fn(records); } catch (error) { console.error("[Lowcord]", error); } }
        if (!domListeners.size) return;
        const batch = mutationListeners.size ? records.filter(record => record.type === "childList" || record.attributeName === "src") : records;
        if (!batch.length) return;
        // A hidden window may not run rAF. Bound retained mutation records;
        // null requests a complete reconciliation after a large burst.
        if (domRecords !== null) domRecords = domRecords.length + batch.length > 1000 ? null : domRecords.concat(batch);
        domFrame ??= requestAnimationFrame(() => {
            domFrame = undefined;
            const records = domRecords; domRecords = [];
            for (const fn of domListeners) { try { fn(records); } catch (error) { console.error("[Lowcord]", error); } }
        });
    }
    function updateDomObserver() {
        if (!document.body) return;
        if (!domListeners.size && !mutationListeners.size) {
            domObserver?.disconnect(); domObserver = undefined; observedAttributes = "";
            if (domFrame !== undefined) cancelAnimationFrame(domFrame);
            domFrame = undefined; domRecords = [];
            return;
        }
        const attributes = mutationListeners.size ? ["id", "class", "src"] : ["src"];
        if (domObserver && observedAttributes === attributes.join()) return;
        // Pending records belong to the old filter; deliver them first.
        if (domObserver) { const records = domObserver.takeRecords(); if (records.length) mutated(records); }
        domObserver ??= new MutationObserver(mutated);
        domObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: attributes });
        observedAttributes = attributes.join();
    }
    function startDomObserver() {
        if (domObserver || !document.body) return;
        updateDomObserver();
        // Registrations made from document-start scripts could not see body.
        for (const fn of domListeners) { try { fn(); } catch (error) { console.error("[Lowcord]", error); } }
    }
    function listen(listeners, listener, initial) {
        listeners.add(listener);
        if (document.body) {
            updateDomObserver();
            if (initial) listener();
        } else document.addEventListener("DOMContentLoaded", startDomObserver, { once: true });
        return () => {
            if (!listeners.delete(listener)) return;
            updateDomObserver();
            if (!domListeners.size && !mutationListeners.size) document.removeEventListener("DOMContentLoaded", startDomObserver);
        };
    }
    const onDomChange = listener => listen(domListeners, listener, true);
    const onDomMutation = listener => listen(mutationListeners, listener, false);

    window.Lowcord = {
        // Discord deletes window.localStorage while it starts; the shim kept it.
        storage: window.__lowcordStorage,
        filters, find, waitFor, waitForStore, onDomChange, onDomMutation, domChanged,
        store: name => cached(`store:${name}`, filters.byStoreName(name)),
        get React() { return cached("react", value => filters.byProps("createElement", "useState", "useEffect")(value) && typeof value.version === "string"); },
        // 299 is React's invariant code shared by createRoot and createPortal.
        get createRoot() { return cached("createRoot", filters.byCode("(299));", ".onRecoverableError")); },
        get CloudUpload() { return cached("cloudUpload", value => typeof value?.prototype?.trackUploadFinished === "function"); },
        get RestAPI() { return cached("rest", value => typeof value === "object" && filters.byProps("del", "put", "post", "get", "patch")(value)); },
        get Dispatcher() { return cached("dispatcher", filters.byProps("dispatch", "subscribe", "unsubscribe")); },
    };
})();
