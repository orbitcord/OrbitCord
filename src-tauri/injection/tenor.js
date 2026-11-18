// Bring back Tenor: Discord's GIF picker now searches Klipy. Its GIF API calls
// (search, trending, suggestions) are answered here from Tenor's public API, in
// the same shape Discord's own endpoints return, so the picker is untouched.
(() => {
    const extensions = window.Lowcord.extensions;
    if (!extensions?.addResponder) return;
    const id = "bringBackTenor";
    // The key tenor.com's own web client uses.
    const key = "AIzaSyAp4Ie-x-F5nLqwoqvDFrJGI4purWdGIVo";
    const cache = new Map(), ttl = 60_000;

    const tenorLocale = locale => (/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(locale ?? "") ? locale.replace("-", "_") : "en_US");
    const formatFor = format => (format === "webm" || format === "mp4" ? format : "tinygif");
    const limitFor = value => Math.min(50, Math.max(1, Number.parseInt(value, 10) || 50));

    async function tenor(endpoint, params) {
        const url = new URL(`https://tenor.googleapis.com/v2/${endpoint}`);
        for (const [name, value] of Object.entries({ ...params, key, client_key: "tenor_web", contentfilter: "off", prettyPrint: "false" }))
            url.searchParams.set(name, String(value));
        const hit = cache.get(url.href);
        if (hit && Date.now() - hit.time < ttl) return hit.data;
        const response = await window.__LOWCORD_NATIVE__?.fetchRemote?.(url.href, { as: "text", maxBytes: 4 * 1024 * 1024 });
        if (response?.status !== 200) throw new Error("Tenor request failed");
        const data = JSON.parse(response.body);
        cache.set(url.href, { time: Date.now(), data });
        if (cache.size > 40) cache.delete(cache.keys().next().value);
        return data;
    }

    function gif(result, format) {
        const media = result.media_formats ?? {};
        const main = media[format] ?? media.tinygif ?? Object.values(media)[0];
        if (!main?.url) return null;
        return { id: result.id, title: result.title ?? "", url: result.itemurl, src: main.url,
            gif_src: media.tinygif?.url ?? main.url, width: main.dims?.[0] ?? 0, height: main.dims?.[1] ?? 0,
            preview: media.gifpreview?.url ?? media.tinygif?.url ?? main.url };
    }
    const gifs = (data, format) => (data?.results ?? []).map(result => gif(result, format)).filter(Boolean);

    async function search(query) {
        const format = formatFor(query.get("media_format"));
        const data = await tenor("search", { q: query.get("q") ?? "", limit: limitFor(query.get("limit")), locale: tenorLocale(query.get("locale")),
            media_filter: `${format},tinygif,gifpreview`, searchfilter: "none", component: "web_desktop" });
        return gifs(data, format);
    }
    async function featured(query, limit) {
        const format = formatFor(query.get("media_format"));
        const data = await tenor("featured", { limit, locale: tenorLocale(query.get("locale")), media_filter: `${format},tinygif,gifpreview` });
        return gifs(data, format);
    }
    async function trending(query) {
        const [categories, preview] = await Promise.all([
            tenor("categories", { type: "trending", limit: 50, locale: tenorLocale(query.get("locale")) }),
            featured(query, 1),
        ]);
        return { categories: (categories?.tags ?? []).map(tag => ({ name: tag.searchterm, src: tag.image })).filter(tag => tag.name && tag.src), gifs: preview };
    }
    async function suggest(query) {
        const data = await tenor("autocomplete", { q: query.get("q") ?? "", limit: Math.min(20, limitFor(query.get("limit"))), locale: tenorLocale(query.get("locale")) });
        return data?.results ?? [];
    }
    async function trendingTerms(query) {
        const data = await tenor("trending_terms", { limit: Math.min(20, limitFor(query.get("limit"))), locale: tenorLocale(query.get("locale")) });
        return data?.results ?? [];
    }

    const routes = {
        "/gifs/search": search,
        "/gifs/trending": trending,
        "/gifs/trending-gifs": query => featured(query, limitFor(query.get("limit"))),
        "/gifs/suggest": suggest,
        "/gifs/trending-search": trendingTerms,
    };
    // A failed Tenor call returns null, which lets Discord's own request go ahead.
    extensions.addResponder(({ url, path }) => {
        if (!extensions.enabled(id) || !window.__LOWCORD_NATIVE__?.fetchRemote) return null;
        const handle = routes[path];
        return handle ? handle(url.searchParams).catch(error => { console.warn("[lowcord] Tenor:", error.message); return null; }) : null;
    });

    // Discord keeps the trending categories and the current results in its
    // store and fetches them once, so a switch would otherwise show the old
    // source until restart. Its own actions refetch them, through the hook above.
    const { find, filters } = window.Lowcord;
    let trendingAction, searchAction;
    const fetchTrending = () => trendingAction ??= find(filters.byCode("GIF_PICKER_TRENDING_FETCH_SUCCESS", "trendingGIFPreview"));
    const runSearch = () => searchAction ??= find(filters.byCode('"GIF_PICKER_QUERY"', "arguments.length>2"));
    function refetch() {
        cache.clear();
        try { fetchTrending()?.(); } catch (error) { console.warn("[lowcord] GIF source:", error); }
        const query = window.Lowcord.store("GIFPickerViewStore")?.getQuery?.();
        const search = runSearch();
        if (!query || typeof search !== "function") return;
        // Discord drops results for a query it already shows; clear it first.
        try { search("", null); search(query, null, true); } catch (error) { console.warn("[lowcord] GIF source:", error); }
    }
    let using = extensions.enabled(id);
    window.addEventListener(extensions.changeEvent, () => {
        const now = extensions.enabled(id);
        if (now === using) return;
        using = now;
        refetch();
        sync();
    });

    // A source menu beside the picker's search bar.
    const label = { tenor: "Tenor", klipy: "Klipy" };
    function sync() {
        const panel = document.getElementById("gif-picker-tab-panel");
        const input = panel?.querySelector('input[type="text"], input:not([type])');
        if (!input) return;
        const source = extensions.enabled(id) ? "tenor" : "klipy";
        // Discord's placeholder names Klipy; say which service is searched.
        input.dataset.lowcordPlaceholder ??= input.placeholder;
        const placeholder = source === "tenor" ? "Search Tenor" : input.dataset.lowcordPlaceholder;
        if (input.placeholder !== placeholder) input.placeholder = placeholder;
        let menu = panel.querySelector(".lowcord-gif-source");
        if (!menu) {
            const bar = input.closest('[class*="searchBar_"]') ?? input.parentElement;
            const row = bar?.parentElement;
            if (!row) return;
            menu = document.createElement("select");
            menu.className = "lowcord-gif-source";
            menu.setAttribute("aria-label", "GIF source");
            menu.title = "GIF source";
            for (const value of ["klipy", "tenor"]) menu.append(new Option(label[value], value));
            menu.addEventListener("change", () => {
                try { extensions.set(id, menu.value === "tenor"); }
                catch (error) { extensions.toast?.(error.message, true); sync(); }
            });
            // Discord's picker reacts to keys inside it; keep them on the menu.
            menu.addEventListener("keydown", event => event.stopPropagation());
            row.setAttribute("data-lowcord-gif-source-row", "");
            bar.after(menu);
        }
        if (menu.value !== source) menu.value = source;
    }
    window.Lowcord.onDomChange?.(sync);
    window.Lowcord.tenor = { search, trending, suggest, gif, tenorLocale };
})();
