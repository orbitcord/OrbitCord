const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const adguard = readFileSync(join(__dirname, 'vendor', 'adguard-youtube.js'), 'utf8');

function frameKind(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    if (['www.youtube.com', 'www.youtube-nocookie.com', 'youtube.com'].includes(url.hostname)
        && url.pathname.startsWith('/embed/')) return 'youtube';
    if (url.hostname === 'open.spotify.com' && /^\/(?:intl-[\w-]+\/)?embed\//.test(url.pathname)) return 'music';
    if (url.hostname === 'embed.music.apple.com') return 'music';
    return null;
}

function youtubeControls() {
    if (document.getElementById('lowcord-youtube-controls')) return;
    const style = document.createElement('style');
    style.id = 'lowcord-youtube-controls';
    // In compact embeds YouTube's vertical slider extends over the bottom
    // controls. Both bars have z-index: 2, so the later bottom bar intercepts
    // the pointer and closes the slider halfway down. Raise only the top bar
    // with an expanded volume slider; native hover, dragging and menus stay
    // owned by YouTube. CSS also covers controls mounted after dom-ready.
    style.textContent = `#player-controls .player-controls-top:has(.ytdVolumeControlsSliderContainerExpanded) { z-index: 3 !important; }`;
    (document.head ?? document.documentElement).append(style);
}

// Runs only in official media frames. Detached Audio objects use the same play
// prototype as DOM audio, so previews are covered without a polling loop.
function musicVolume(settings) {
    if (window.__lowcordMusicVolume) { window.__lowcordMusicVolume.set(settings); return; }
    const proto = HTMLMediaElement.prototype, original = proto.play;
    const prior = new WeakMap(), tracked = new Set();
    let state = { enabled: false, volume: 0.5 }, changing = false;
    function apply(media) {
        if (!(media instanceof HTMLMediaElement)) return;
        if (!prior.has(media)) { prior.set(media, media.volume); tracked.add(new WeakRef(media)); }
        changing = true;
        try { media.volume = Math.min(prior.get(media), state.volume); } finally { changing = false; }
    }
    function play(...args) { if (state.enabled) apply(this); return Reflect.apply(original, this, args); }
    function playing(event) { if (state.enabled) apply(event.target); }
    function volumeChanged(event) {
        if (state.enabled && !changing && event.target.volume > state.volume) apply(event.target);
    }
    function set(next) {
        state = next;
        if (state.enabled) {
            proto.play = play;
            document.addEventListener('play', playing, true);
            document.addEventListener('volumechange', volumeChanged, true);
            document.querySelectorAll('audio,video').forEach(apply);
        } else {
            if (proto.play === play) proto.play = original;
            document.removeEventListener('play', playing, true);
            document.removeEventListener('volumechange', volumeChanged, true);
        }
        for (const reference of tracked) {
            const media = reference.deref();
            if (!media) { tracked.delete(reference); continue; }
            if (state.enabled) apply(media);
            else { media.volume = prior.get(media); prior.delete(media); tracked.delete(reference); }
        }
    }
    window.__lowcordMusicVolume = { set };
    set(settings);
}

function setupEmbedPlugins(contents) {
    let settings = { youtubeAdblock: true, musicEmbeds: true, musicVolume: 50 };
    async function apply(frame) {
        try {
            if (frame === contents.mainFrame) return;
            const kind = frameKind(frame.url);
            if (kind === 'youtube') await frame.executeJavaScript(`(${youtubeControls.toString()})();\nwindow.__lowcordAdguardEnabled=${settings.youtubeAdblock};\n${adguard}`);
            if (kind === 'music' || kind === 'youtube') await frame.executeJavaScript(`(${musicVolume.toString()})(${JSON.stringify({ enabled: kind === 'youtube' || settings.musicEmbeds, volume: settings.musicVolume / 100 })})`);
        } catch { /* A virtualized or navigating embed may already be gone. */ }
    }
    contents.on('frame-created', (_event, { frame }) => {
        frame?.on('dom-ready', () => {
            void apply(frame);
            // Watch Together sometimes initializes the player after a child.
            if (frame.parent) void apply(frame.parent);
        });
    });
    return {
        set(next) {
            if (!next || typeof next.youtubeAdblock !== 'boolean' || typeof next.musicEmbeds !== 'boolean'
                || !Number.isFinite(next.musicVolume) || next.musicVolume < 0 || next.musicVolume > 100) throw new Error('Invalid embed preferences');
            settings = { youtubeAdblock: next.youtubeAdblock, musicEmbeds: next.musicEmbeds, musicVolume: next.musicVolume };
            for (const frame of contents.mainFrame.framesInSubtree) void apply(frame);
        },
    };
}
module.exports = { setupEmbedPlugins, frameKind, musicVolume, youtubeControls };
