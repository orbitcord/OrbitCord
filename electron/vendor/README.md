`adguard-youtube.js` is adapted from AdGuard's Block YouTube Ads script as
distributed by Vencord's YoutubeAdblock plugin, retrieved 2026-10-05:
https://github.com/Vendicated/Vencord/blob/main/src/plugins/youtubeAdblock.desktop/adguard.js

Original project: https://github.com/AdguardTeam/BlockYouTubeAdsShortcut
Copyright AdGuard Team; GPL-3.0-or-later (see the repository's LICENSE).

OrbitCord changes: enable/disable and cleanup, bounded cycle-safe JSON traversal,
adSlots handling, current skip-button selectors, attribute observation and
throttled DOM handling. Bundled locally; no remote code is executed or fetched
at startup. YouTube changes may require updating this reviewed adaptation.
