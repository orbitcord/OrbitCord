// Read-only access to Discord's own modules. One entry is pushed into the
// webpack chunk queue before Discord's runtime boots; the runtime then hands
// it `__webpack_require__`, whose module cache is searched on demand. Nothing
// in Discord's source is rewritten.
(() => {
    let wreq;
    const chunks = (window.webpackChunkdiscord_app ??= []);
    chunks.push([[Symbol("lowcord")], {}, require => { wreq = require; }]);

    // Discord's translation table is a Proxy that answers every property name;
    // anything that has a made-up property is skipped.
    const probe = "__lowcordProbe__";
    const cache = new Map(), misses = new Map();
    const isReal = value => {
        try { return value[probe] === undefined; } catch { return false; }
    };
    const moduleCount = () => wreq?.c ? Object.keys(wreq.c).length : 0;

    // Scans webpack exports with minimal per-value overhead: skips primitives,
    // avoids closure indirection, and checks the translation-proxy probe only
    // when a candidate actually matches the filter.
    function find(filter) {
        const modules = wreq?.c;
        if (!modules) return null;
        for (const id in modules) {
            const exports = modules[id]?.exports;
            if (exports == null || exports === window) continue;
            const type = typeof exports;
            if (type !== "object" && type !== "function") continue;
            try { if (filter(exports) && isReal(exports)) return exports; } catch {}
            if (type !== "object") continue;
            for (const key in exports) {
                let value;
                try { value = exports[key]; } catch { continue; }
                if (value == null || value === exports || value === window) continue;
                const valueType = typeof value;
                if (valueType !== "object" && valueType !== "function") continue;
                try { if (filter(value) && isReal(value)) return value; } catch {}
            }
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
        const modules = moduleCount();
        const now = Date.now();
        if (modules === scannedModules && now - scannedAt < 5000) return;
        scannedModules = modules; scannedAt = now;
        const unresolvedStores = new Map(), unresolvedFilters = [], resolved = [];
        for (const entry of pending) {
            if (entry.name) unresolvedStores.set(entry.name, entry);
            else unresolvedFilters.push(entry);
        }
        const raw = wreq?.c;
        if (raw && (unresolvedStores.size || unresolvedFilters.length)) {
            const hasFilters = unresolvedFilters.length > 0;
            outer: for (const id in raw) {
                const exports = raw[id]?.exports;
                if (exports == null || exports === window) continue;
                const type = typeof exports;
                if (type !== "object" && type !== "function") continue;
                if (unresolvedStores.size && type === "object") {
                    let name;
                    try { name = exports.constructor?.displayName; } catch {}
                    if (name) {
                        const entry = unresolvedStores.get(name);
                        if (entry && isReal(exports)) {
                            unresolvedStores.delete(name); resolved.push([entry, exports]);
                            if (!unresolvedStores.size && !unresolvedFilters.length) break;
                        }
                    }
                }
                if (hasFilters && unresolvedFilters.length) {
                    let real;
                    for (let i = unresolvedFilters.length - 1; i >= 0; i--) {
                        const entry = unresolvedFilters[i];
                        let matched = false;
                        try { matched = Boolean(entry.filter(exports)); } catch {}
                        if (!matched) continue;
                        real ??= isReal(exports);
                        if (!real) break;
                        unresolvedFilters.splice(i, 1); resolved.push([entry, exports]);
                    }
                    if (!unresolvedStores.size && !unresolvedFilters.length) break;
                }
                if (type !== "object") continue;
                for (const key in exports) {
                    let value;
                    try { value = exports[key]; } catch { continue; }
                    if (value == null || value === exports || value === window) continue;
                    const valueType = typeof value;
                    if (valueType !== "object" && valueType !== "function") continue;
                    if (unresolvedStores.size && valueType === "object") {
                        let name;
                        try { name = value.constructor?.displayName; } catch {}
                        if (name) {
                            const entry = unresolvedStores.get(name);
                            if (entry && isReal(value)) {
                                unresolvedStores.delete(name); resolved.push([entry, value]);
                                if (!unresolvedStores.size && !unresolvedFilters.length) break outer;
                            }
                        }
                    }
                    if (hasFilters && unresolvedFilters.length) {
                        let real;
                        for (let i = unresolvedFilters.length - 1; i >= 0; i--) {
                            const entry = unresolvedFilters[i];
                            let matched = false;
                            try { matched = Boolean(entry.filter(value)); } catch {}
                            if (!matched) continue;
                            real ??= isReal(value);
                            if (!real) break;
                            unresolvedFilters.splice(i, 1); resolved.push([entry, value]);
                        }
                        if (!unresolvedStores.size && !unresolvedFilters.length) break outer;
                    }
                }
            }
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
    // A lookup that found nothing is not repeated until the module cache grows
    // or a second passes: clicks, keys and uploads look up stores Discord may
    // not have loaded, and each miss would scan the whole cache again.
    function cached(key, filter) {
        if (cache.has(key)) return cache.get(key);
        const modules = moduleCount(), miss = misses.get(key);
        if (miss && miss.modules === modules && Date.now() - miss.at < 1000) return null;
        const value = find(filter);
        if (!value) { misses.set(key, { modules, at: Date.now() }); return null; }
        misses.delete(key);
        cache.set(key, value);
        return value;
    }

    // One observer for every Lowcord feature. onDomMutation listeners get raw
    // records before paint; onDomChange listeners get one batch per frame of
    // structure and src changes. id/class records are only requested while a
    // before-paint listener needs them.
    const mutationListeners = new Set(), domListeners = new Set();
    let domFrame, domObserver, domRecords = [], observedAttributes = "";
    const batchCache = new WeakMap();
    function nodeMatches(nodes, selector) {
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node instanceof Element && (node.matches(selector) || (node.childElementCount > 0 && node.querySelector(selector)))) return true;
        }
        return false;
    }
    function batchFor(records) {
        let info = batchCache.get(records);
        if (info) return info;
        const targets = new Set(), elements = new Set();
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            if (target) targets.add(target);
            if (record.type === "childList") {
                const added = record.addedNodes;
                for (let j = 0; j < added.length; j++) if (added[j] instanceof Element) elements.add(added[j]);
                const removed = record.removedNodes;
                for (let j = 0; j < removed.length; j++) if (removed[j] instanceof Element) elements.add(removed[j]);
            }
        }
        info = { targets: [...targets], elements: [...elements], results: new Map() };
        batchCache.set(records, info);
        return info;
    }
    function domChanged(records, selector) {
        if (!Array.isArray(records)) return true;
        const len = records.length;
        if (!len) return false;
        // Small batches skip Set/Map allocations entirely; larger bursts are
        // indexed once and shared across every listener in the frame.
        if (len <= 4) {
            for (let i = 0; i < len; i++) {
                const record = records[i];
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                if (target?.closest(selector)) return true;
                if (record.type === "childList" && (nodeMatches(record.addedNodes, selector) || nodeMatches(record.removedNodes, selector))) return true;
            }
            return false;
        }
        const info = batchFor(records);
        const hit = info.results.get(selector);
        if (hit !== undefined) return hit;
        let matched = false;
        const { targets, elements } = info;
        for (let i = 0; i < targets.length; i++) {
            if (targets[i].closest(selector)) { matched = true; break; }
        }
        if (!matched) {
            for (let i = 0; i < elements.length; i++) {
                const node = elements[i];
                if (node.matches(selector) || (node.childElementCount > 0 && node.querySelector(selector))) { matched = true; break; }
            }
        }
        info.results.set(selector, matched);
        return matched;
    }
    function mutated(records) {
        for (const fn of mutationListeners) { try { fn(records); } catch (error) { console.error("[Lowcord]", error); } }
        if (!domListeners.size) return;
        let count = 0;
        if (mutationListeners.size) {
            for (let i = 0; i < records.length; i++) {
                const r = records[i];
                if (r.type === "childList" || r.attributeName === "src") count++;
            }
            if (!count) return;
        } else {
            count = records.length;
            if (!count) return;
        }
        // A hidden window may not run rAF. Bound retained mutation records;
        // null requests a complete reconciliation after a large burst.
        if (domRecords !== null) {
            if (domRecords.length + count > 1000) domRecords = null;
            else if (mutationListeners.size) {
                for (let i = 0; i < records.length; i++) {
                    const r = records[i];
                    if (r.type === "childList" || r.attributeName === "src") domRecords.push(r);
                }
            } else {
                for (let i = 0; i < records.length; i++) domRecords.push(records[i]);
            }
        }
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
        // Discord's router: opens a path such as /channels/@me/<channel>/<message>.
        get transitionTo() { return cached("transitionTo", filters.byCode("transitionTo -")); },
        get Dispatcher() { return cached("dispatcher", filters.byProps("dispatch", "subscribe", "unsubscribe")); },
    };
})();
