/* eslint-disable */

/**
 * This file is part of AdGuard's Block YouTube Ads (https://github.com/AdguardTeam/BlockYouTubeAdsShortcut).
 *
 * Copyright (C) AdGuard Team
 *
 * AdGuard's Block YouTube Ads is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * AdGuard's Block YouTube Ads is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with AdGuard's Block YouTube Ads.  If not, see <http://www.gnu.org/licenses/>.
 */
(() => {
    // OrbitCord adaptation: reversible settings, bounded JSON traversal and
    // one throttled observer per YouTube frame. No remote executable updates.
    if (window.__lowcordAdguard) {
        window.__lowcordAdguard.set(window.__lowcordAdguardEnabled === true);
        return;
    }

    const hiddenCSS = [
        "#__ffYoutube1",
        "#__ffYoutube2",
        "#__ffYoutube3",
        "#__ffYoutube4",
        "#feed-pyv-container",
        "#feedmodule-PRO",
        "#homepage-chrome-side-promo",
        "#merch-shelf",
        "#offer-module",
        '#pla-shelf > ytd-pla-shelf-renderer[class="style-scope ytd-watch"]',
        "#pla-shelf",
        "#premium-yva",
        "#promo-info",
        "#promo-list",
        "#promotion-shelf",
        "#related > ytd-watch-next-secondary-results-renderer > #items > ytd-compact-promoted-video-renderer.ytd-watch-next-secondary-results-renderer",
        "#search-pva",
        "#shelf-pyv-container",
        "#video-masthead",
        "#watch-branded-actions",
        "#watch-buy-urls",
        "#watch-channel-brand-div",
        "#watch7-branded-banner",
        "#YtKevlarVisibilityIdentifier",
        "#YtSparklesVisibilityIdentifier",
        ".carousel-offer-url-container",
        ".companion-ad-container",
        ".GoogleActiveViewElement",
        '.list-view[style="margin: 7px 0pt;"]',
        ".promoted-sparkles-text-search-root-container",
        ".promoted-videos",
        ".searchView.list-view",
        ".sparkles-light-cta",
        ".watch-extra-info-column",
        ".watch-extra-info-right",
        ".ytd-carousel-ad-renderer",
        ".ytd-compact-promoted-video-renderer",
        ".ytd-companion-slot-renderer",
        ".ytd-merch-shelf-renderer",
        ".ytd-player-legacy-desktop-watch-ads-renderer",
        ".ytd-promoted-sparkles-text-search-renderer",
        ".ytd-promoted-video-renderer",
        ".ytd-search-pyv-renderer",
        ".ytd-video-masthead-ad-v3-renderer",
        ".ytp-ad-action-interstitial-background-container",
        ".ytp-ad-action-interstitial-slot",
        ".ytp-ad-image-overlay",
        ".ytp-ad-overlay-container",
        ".ytp-ad-progress",
        ".ytp-ad-progress-list",
        '[class*="ytd-display-ad-"]',
        '[layout*="display-ad-"]',
        'a[href^="http://www.youtube.com/cthru?"]',
        'a[href^="https://www.youtube.com/cthru?"]',
        "ytd-action-companion-ad-renderer",
        "ytd-banner-promo-renderer",
        "ytd-compact-promoted-video-renderer",
        "ytd-companion-slot-renderer",
        "ytd-display-ad-renderer",
        "ytd-promoted-sparkles-text-search-renderer",
        "ytd-promoted-sparkles-web-renderer",
        "ytd-search-pyv-renderer",
        "ytd-single-option-survey-renderer",
        "ytd-video-masthead-ad-advertiser-info-renderer",
        "ytd-video-masthead-ad-v3-renderer",
        "YTM-PROMOTED-VIDEO-RENDERER",
    ];
    const nativeParse = JSON.parse;
    const nativeJson = Response.prototype.json;
    let active = false, observer, timer, skipTimer, style;
    const adKeys = new Set(['adPlacements', 'playerAds', 'adSlots']);
    function strip(root) {
        if (!active || !root || typeof root !== 'object') return root;
        const queue = [root], seen = new WeakSet();
        let budget = 4096;
        while (queue.length && budget-- > 0) {
            const object = queue.pop();
            if (!object || typeof object !== 'object' || seen.has(object)) continue;
            seen.add(object);
            for (const key of Object.keys(object)) {
                if (adKeys.has(key)) object[key] = [];
                else if (object[key] && typeof object[key] === 'object') queue.push(object[key]);
            }
        }
        return root;
    }
    const parse = function (...args) { return strip(Reflect.apply(nativeParse, this, args)); };
    const json = async function (...args) { return strip(await Reflect.apply(nativeJson, this, args)); };
    function skip() {
        timer = undefined;
        if (!active) return;
        const player = document.querySelector('.ad-showing');
        if (!player) return;
        const video = player.querySelector('video') ?? document.querySelector('video');
        if (video && Number.isFinite(video.duration) && video.duration > 0) {
            try { video.currentTime = video.duration; } catch {}
        }
        const click = () => {
            if (active && document.querySelector('.ad-showing'))
                document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')?.click();
        };
        click();
        clearTimeout(skipTimer);
        skipTimer = setTimeout(click, 100);
    }
    function schedule() { if (!timer) timer = setTimeout(skip, 100); }
    function set(enabled) {
        if (active === enabled) return;
        active = enabled;
        if (active) {
            JSON.parse = parse;
            Response.prototype.json = json;
            strip(window.ytInitialPlayerResponse);
            if (window.ytplayer?.config?.args?.player_response) {
                try { window.ytplayer.config.args.player_response = JSON.stringify(parse(window.ytplayer.config.args.player_response)); } catch {}
            }
            style = document.createElement('style');
            style.textContent = hiddenCSS.join(',') + '{display:none!important}';
            (document.head ?? document.documentElement).append(style);
            observer = new MutationObserver(schedule);
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
            document.addEventListener('loadedmetadata', schedule, true);
            skip();
        } else {
            if (JSON.parse === parse) JSON.parse = nativeParse;
            if (Response.prototype.json === json) Response.prototype.json = nativeJson;
            observer?.disconnect(); style?.remove();
            clearTimeout(timer); clearTimeout(skipTimer); timer = undefined;
            document.removeEventListener('loadedmetadata', schedule, true);
        }
    }
    window.__lowcordAdguard = { set };
    set(window.__lowcordAdguardEnabled === true);
})();
