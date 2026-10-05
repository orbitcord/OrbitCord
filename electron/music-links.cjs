// Official player URLs only. Shared with the renderer so paste normalization
// and embed detection agree about the song, including Apple album ?i= links.
function createMusicLinks() {
    function parse(value) {
        let url;
        try { url = new URL(value); } catch { return null; }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
        if (url.hostname === 'open.spotify.com') {
            const path = url.pathname.replace(/^\/intl-[\w-]+\//, '/').replace(/^\/embed\//, '/');
            const match = /^\/(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]{22})\/?$/.exec(path)
                ?? /^\/user\/[^/]+\/(playlist)\/([a-zA-Z0-9]{22})\/?$/.exec(path);
            if (!match) return null;
            const [, type, id] = match;
            return { key: `spotify:${type}:${id}`, service: 'Spotify', url: `https://open.spotify.com/${type}/${id}`,
                src: `https://open.spotify.com/embed/${type}/${id}`, height: ['track', 'episode'].includes(type) ? 152 : 352 };
        }
        if (['music.apple.com', 'embed.music.apple.com', 'itunes.apple.com'].includes(url.hostname)) {
            const match = /^\/([a-z]{2})\/(album|song|playlist)\/(?:[^/]+\/)?([\w.-]+)\/?$/i.exec(url.pathname);
            if (!match) return null;
            const [, country, type, id] = match;
            if (type === 'playlist' ? !/^pl\.[\w.-]+$/.test(id) : !/^\d+$/.test(id)) return null;
            const song = type === 'album' && /^\d+$/.test(url.searchParams.get('i') ?? '') ? url.searchParams.get('i') : null;
            const path = url.pathname.replace(/\/$/, '') + (song ? `?i=${song}` : '');
            return { key: `apple:${country.toLowerCase()}:${song ? 'song' : type}:${song ?? id}`, service: 'Apple Music',
                url: `https://music.apple.com${path}`, src: `https://embed.music.apple.com${path}`,
                height: type === 'song' || song ? 175 : 450 };
        }
        return null;
    }
    function collect(content, mapUrls) {
        const items = new Map();
        mapUrls(content, value => {
            const item = parse(value);
            if (item && items.size < 4) items.set(item.key, item);
            return value;
        });
        return [...items.values()];
    }
    function normalize(content, mapUrls) {
        return mapUrls(content, value => parse(value)?.url ?? value);
    }
    return { parse, collect, normalize };
}
if (typeof module !== 'undefined' && module.exports) module.exports = createMusicLinks();
else window.Lowcord.musicLinks = createMusicLinks();
