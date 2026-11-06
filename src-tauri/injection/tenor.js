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

    // Discord keeps trending results in its store; refetch them when the switch flips.
    window.addEventListener(extensions.changeEvent, () => { cache.clear(); });
    window.Lowcord.tenor = { search, trending, suggest, gif, tenorLocale };
})();
