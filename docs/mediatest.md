# RedGIFs picker — mediatest

Implemented the full improvement roadmap. This is an Electron extension using Discord's existing uploader and REST client. It adds no dependencies and does not patch Discord's source or attachment layout.

## Current behavior

- Bottom-right picker, 16px from the window edges. A single-column feed preserves portrait and landscape frames with `object-fit: contain`. Hover/focus starts one muted player after 140ms. Click/Enter queues the clip as a file. The badge shows actual elapsed/decoded duration; sideways pointer movement scrubs. Leaving, scrolling, hiding or closing releases playback.
- Scrubbing keeps only the latest pointer target while the decoder is seeking. `seeked` flushes that target; there is no seek polling loop. Playback resumes after pointer movement stops.
- HD is attempted first. The last source (usually SD) streams into a retained local file, even if it exceeds the upload budget. Compression consumes that same file, so there is no second SD download or Range-resume round trip. Upstream preview Range requests remain supported. Source files are capped at 256 MiB, encoding at ten minutes, and actual output bytes must fit below the smaller of 20,000,000 bytes and the chat allowance, with margin.
- Prepared files cross IPC as opaque capabilities and metadata. The renderer fetches the capability once as a Blob and hands a File to Discord. No arbitrary filesystem path or full byte-array payload crosses the bridge. Release, cancellation, window teardown and quit delete temporary files.
- Completed preview responses/ranges are cached on disk with a 128 MiB byte budget, including pending writes and leased readers. Streams use 64 KiB backpressure; no full-video buffer or speculative download is introduced. Unknown-length, incomplete, or over-budget responses are not retained. Five recent search result sets live in memory for one minute; each response mints fresh owner-scoped media capabilities. Quit clears both caches.
- The queue displays clip author/ID, destination, waiting position, upload percentage, and Cancel/Retry controls. Waiting clips can be removed; Pause lets the active transfer finish and holds later jobs. One file prepares/uploads/posts at a time, at most ten jobs. Browsing, searching, scrubbing and scrolling remain available. Failed jobs remain visible and do not block later jobs. Retry retains the original destination/reply and message nonce. Duplicate prevention is scoped to the destination chat; nonces distinguish separate clicks in the same millisecond.
- **Keep uploading when picker closes** is an explicit persisted option, initially off. Off preserves cancellation on close/channel change. On keeps transfers and captured destinations after the picker is removed. Reopening shows the queue. Hidden jobs retain no picker DOM. Jobs keep the background sleep hook busy, including preparation and waiting phases; quitting still stops them. Posting already accepted by Discord cannot be recalled by cancellation.
- Favorites store at most 200 clip IDs/authors; pinned niches store at most 30 IDs/names. No media URLs, video files, search history or feed history are persisted. Favorites refresh media capabilities when opened, at most four requests concurrently. Expired queued capabilities refresh only when needed, avoiding an extra API round trip for ordinary clicks.
- Near-bottom scrolling requests the next page, one request at a time. Only the visible cards and a small overscan region are mounted. Lightweight metadata and measured layout spacing retain earlier pages and scroll-back position. Load more remains available; failed paging shows Retry and stops automatic retry loops. Searches reject stale responses.

## Files

- `electron/redgifs.cjs`: API/auth, topic/niche search, metadata cache, capability ownership, bounded file preparation and protocol serving.
- `electron/redgifs-cache.cjs`: disposable disk preview cache, exact-range reuse, byte accounting, active-reader leases, cancellation and shutdown.
- `electron/video-compress.cjs`: installed FFmpeg detection and bounded local-file H.264/AAC conversion.
- `electron/main.cjs`, `scripts/build.mjs`: trusted main-frame bridge, CORS-enabled custom media protocol, preload injection and lifecycle cleanup.
- `src-tauri/injection/redgifs.js`, `redgifs.css`: picker, serial job worker, queue controls, saved collections and feed virtualization.
- `src-tauri/injection/background.js`: keep Discord awake for queued/preparing transfers.

## Verification

All automated media is neutral generated fixture content; no real Discord message was posted.

- 20 Node tests: auth/search/validation, HD/SD/compression and final size checks, no duplicate SD download, capability ownership, opaque file reads/releases, cancellation, real FFmpeg sample conversion, cache reuse/eviction/TTL/byte budgets, shutdown during file creation, active-reader accounting and saved-ID refresh.
- 29 Chromium picker tests: real hover playback/timer/scrubbing, rapid seek coalescing, serial uploads, progress with native `(loaded,total)` events, pause/cancel/retry, queue limit, fixed destinations, default close cancellation, optional survival/reopening, sleep protection, duplicate prevention by chat, favorites/pins, infinite paging, bounded card mounting and scroll-back restoration. The final queue-related subset is rerun after the last UI changes.
- 29 existing extension/native-upload fixture tests pass, including byte preservation, drafts, cancellation and server errors.
- Electron checks confirm codec decoding and opaque prepared-file fetching/release across the actual sandbox bridge. Builds compile Rust and preload successfully.
- A read-only live metadata check returned 21 topic results and successfully refreshed one ID through the desktop bridge. No live media was played/downloaded during that check. Read-only runtime inspection confirmed Discord emits `progress(uploadedBytes,totalBytes,delta)`.

## Performance observations

These are controlled local measurements, not whole-app speed claims or an end-to-end live-network benchmark.

- Three repeated completed-preview reads make one CDN request in the backend fixture. Five subsequent warm reads transfer zero extra CDN bytes. With an injected 25ms CDN delay and the 11,346-byte neutral MP4, first cold metadata/response time was 38.07ms; median warm response time was 0.41ms. Cold CPU was 17.33ms including initialization; median warm CPU was 0.60ms. Process peak RSS was 50.34 MiB. The fixed 140ms hover-intent delay is unchanged; these figures measure backend response readiness, not first decoded frame.
- A separate 18 MiB file microbenchmark compared a reference reproducing the previous `readFile → Uint8Array → structured clone → Uint8Array → File` copies with the new capability/stream/Blob path, in separate Node processes, three samples each. Median peak RSS fell from 145.09 to 123.84 MiB. Median elapsed time increased from 22.09 to 24.07ms and CPU from 20.69 to 21.55ms. This supports the memory reduction, not a CPU/latency improvement claim; real Electron IPC overhead is not modeled by the Node structured-clone reference.
- The rapid-scrub test sends 25 positions while a seek is pending: no intermediate assignments are made, and one final assignment applies the latest position on `seeked`. The previous per-frame behavior could issue one assignment for each frame.
- The oversized-source fixture verifies exactly one SD request before compression. Output size/signature checks remain in place. Virtualized tests keep fewer than 16 cards mounted while retaining previous pages.

## Diagnoses and limits

Topic search must use API `tags`, not the ignored `search_text`. Niche search uses `best_match` with a query and `subscribers` when browsing; niche feeds use `recent`. Current CDN host `media.redgifs.com` is accepted alongside older exact `thumbsN.redgifs.com` hosts.

The new prepared-file fetch initially failed in real Electron because the custom scheme lacked `corsEnabled`; Chromium reported that the scheme was unsupported for cross-origin fetch. Enabling CORS support on the capability-based scheme fixed the sandbox test. Protocol replacement in the test itself requires reloading after navigation because Chromium caches the loader factory.

FFmpeg is installed on this Mac but is not bundled. Other computers require an installed H.264/AAC-capable FFmpeg for oversized SD clips. Interrupted/incomplete preview ranges are deliberately discarded rather than finishing downloads in the background. Live posting remains a manual verification step. Existing unrelated edits are preserved; no commit was requested or made.

## Compact layout revision, 2026-10-16

User feedback identified oversized stars/buttons and too much space devoted to the header and queue. The picker now places its small wordmark, search field, Options and Close on one 30px row. Tabs sit directly beneath it. Idle headings, subtitle, help footer and the always-visible background-upload checkbox are removed from the main layout. Options contains the existing setting and hover/scrub instructions; Escape dismisses Options before closing the picker.

Upload activity defaults to one compact summary row with phase/percentage, captured destination, job count and Pause/Resume. Expanding it reveals compact per-clip Cancel/Retry/Remove controls; rows have no large button labels or nested panel background. Queue behavior and destinations are unchanged. Favorite buttons use a 14px SVG inside a 24px target. Niche stars are vertically centered, separated from their chevrons, and niche rows are 56px tall. Virtualized row heights and 8px gaps match the CSS.

Verification: all 29 existing picker checks pass, plus a new layout test covers normal and 520×400 windows, header height, media-space ratio, centered stars/chevron separation, collapsed queue height, expanded row height, and Options/Escape behavior. Media uses over 80% of the normal-size picker with a collapsed active upload; no outer-panel scrolling is needed at the minimum window size. Neutral screenshots were inspected for niche and upload states. No real messages were posted.

## Feed and favorites fixes, 2026-10-17

- Root cause: Videos called generic `/v2/gifs/search?order=trending`, which is different from the site's home Trending feed. The renamed Trending tab now calls `/v2/feeds/trending/popular`. Explore uses the site's verified-video search (`type=g`, `order=trending`, `verified=y`). Creators uses `/v2/creators/search`, with name search, counts, pagination, and browsing a creator's videos through `/v2/users/:username/search`. These routes and response shapes were checked against the current public site scripts and live metadata.
- Root cause: one shared query carried a topic into Favorites, where the filter searches author names. Two failing Chromium reproductions confirmed the inherited query and the loss of healthy favorites when another lookup rejected. Tabs now remember independent queries. Each saved-ID failure keeps a removable, retryable row; a failure cannot reject the whole batch. Removing a favorite immediately refreshes the collection. ID search and a useful empty state are included. Refresh concurrency stays capped at four.
- Root cause: optional-ID regex checks coerced missing IDs to the valid string `undefined`, then dereferenced malformed entries. Saved entries now require string IDs. API normalization also skips malformed/null records, and pagination uses the upstream page size rather than the number of surviving video records.
- Root cause: the queue's down chevron rotated upward when expanded. The queue now opens above its bottom summary bar: collapsed points up, expanded points down. All five tabs fit at 360px window width, and keyboard arrows/Home/End include the new tabs.

Verification: 23 Node tests, 34 Chromium picker tests, 37 related extension/upload tests, and the real Electron RedGIFs sandbox/MP4 test pass. `node scripts/build.mjs` passes. Inspected neutral screenshots of creator discovery and the upward queue at 360×520. Live service checks returned Trending, Explore, Creators, creator videos, and Niches; refreshing a feed ID produced a fresh capability. No live media was downloaded or posted. No dependency changes or commit.

Risks: RedGIFs can change its feeds/API, and ranking can differ by the site's experiment or session. Trending follows the site's default popular variation. Live Discord posting remains manual; upload and playback checks use neutral fixtures.

## Preference persistence fix, 2026-10-17

Root cause: RedGIFs used the global `localStorage` directly, even though Discord removes that property at startup. The catch showed “Could not save RedGIFs preferences.” The picker still displayed the in-memory favorite, which hid the fact that it had not been written to disk. Other Lowcord settings already use the Storage handle captured by the preload.

RedGIFs now reads and writes `Lowcord.storage`. A Chromium regression reproduced the failure by deleting `window.localStorage`: the stored value was null after starring a video, pinning a niche, and toggling background uploads. With the fix, all three preferences are persisted and no error toast is emitted. All 35 picker checks, 23 backend checks, and the preload/native build pass. Compact Favorites design alternatives are mockups awaiting selection; the existing Favorites layout is unchanged in this fix.

Risks: favorites added before this fix may exist only in the running picker's memory; rebuilding cannot recover preferences that were never persisted.

## Favorites contact sheet, 2026-10-17

Implemented the selected third mockup as a three-column Favorites gallery. Near-square 9:8 previews, creator captions, duration badges, filled stars, a saved count and a short interaction hint replace the tall single-column Favorites feed. At the normal 420×680 picker size twelve thumbnails fit completely. Other browsing tabs retain their existing full-width video presentation.

The virtualizer now measures complete rows, with a smaller 300px overscan for Favorites. It mounts only nearby tiles, restores earlier rows on scroll-back, and keeps one shared preview player. Failed saved-video lookups occupy a compact retry tile that can still be removed. Pinned niche chips are omitted in Favorites. Thumbnail posters crop to fill; moving video previews retain the complete frame.

Verification: all 38 Chromium picker checks and the build pass. New checks cover a 360px-wide window, twelve visible previews, captions/counts, hover scrubbing, keyboard sending, removal/filtering without accidental sends, and pagination/virtualization over 80 favorites. The interaction test also checks page/console errors. Visual comparison and iteration evidence are recorded in `design-qa.md`. No dependencies or live posting were added; no commit or app restart was requested.

## Compact Creators gallery, 2026-10-17

Implemented the approved compact revision of Creators option two: two columns, 72px cards, 28px colored monograms beside handles, available follower/video counts, verification indicators and browse chevrons. Fourteen complete creators fit the standard picker. Long handles truncate with a full title, missing counts are omitted, and the directory footer explains browsing. Creator video feeds retain their existing preview/send behavior.

Creator virtualization now uses two-card rows and a 300px overscan, with full-width spacers to preserve alignment across pagination and scroll-back. No additional API calls, media downloads, dependencies or preview players are needed. Pinned niche chips are hidden in this directory.

Verification: 39 Chromium picker tests pass, including compact/narrow layout, long names, missing counts, verification accessibility labels, 79 creators across four pages with an odd final page, bounded mounted cards, row restoration, keyboard opening, and back navigation. Build, syntax and whitespace checks pass. Source/rendered visual evidence is in `design-qa.md`. No live messages or commit included.

## Native picture-in-picture, 2026-10-18

Added the default-enabled Picture-in-picture extension. Chat attachment videos, inline social videos and opened video dialogs expose one shared 30px hover control, positioned outside Discord's React-owned attachment layout. Alt+P toggles PiP for the selected/playing chat video, except while typing. It uses Chromium's native PiP window and the existing video decoder, audio, playback position and controls. Live call streams, autoplay GIF loops and RedGIFs picker previews are excluded.

Cross-frame embedded videos get a native right-click Picture-in-picture menu. The action runs only inside the frame belonging to the trusted Discord window; no native bridge is injected into external players and their Permissions Policy still applies. The source video must be loaded and remain available: Discord unmounting it or navigating away can end native PiP. This is a playback control, not a downloader or a persistent duplicate player.

Discord's disablePictureInPicture flag is overridden only after an explicit action, retained while PiP is open (restoring it early closes the window), then restored on exit. Main-page disabling closes PiP and removes the control. Source removal releases observers/DOM references. No intervals, new dependencies, attachment wrapping or grid styling are introduced. Background sleep respects open PiP, including paused/muted media in embedded frames.

Verification: three PiP Chromium regressions pass for DM/server controls, unchanged layout/playback, shortcut typing guard, settings, failures/retry, source removal, viewer videos and preview exclusions. Thirty existing extension tests pass. Three real Electron checks pass for native opening/closing, minimized playback, opt-out restoration, background busy state, embedded-frame PiP without bridge access, and MP4/AAC/WebM/GIF decoding. Build, syntax and whitespace checks pass. Inspected `/tmp/lowcord-picture-in-picture-control.png` to confirm control placement; no live Discord messages sent. Platform-native checks ran on macOS; Windows/Linux use the same Chromium API but were not exercised here.

## Download linked videos, 2026-10-18

Added the default-enabled Download linked videos extension. Right-clicking a video or a direct video-file link adds Download video… to Discord's message menu; the media gallery exposes the same action for actual video files. Open video viewers and embedded players expose a native download item beside PiP when the player has a downloadable source. Signed query parameters and the selected video's source are preserved. Reopening a message menu over another video clears stale actions before installing the new target's actions.

The sandboxed downloadMedia bridge accepts HTTP(S) resource URLs and Lowcord's existing social-media capability URLs, checks the sender's trusted main frame and account window, and uses that window's native Chromium download session. No file bytes are copied through JavaScript IPC or buffered in the renderer. The normal save dialog chooses the destination; attachment upload/delete/layout remain native. Copy Media Link and Download linked videos have independent toggles. Arbitrary web-page links, MSE/blob URLs, streaming manifests, local-file/script URLs and URLs containing credentials are excluded. This saves exposed media files, not segmented streaming services.

Verification: 33 Chromium extension/download checks passed, plus targeted checks after menu retargeting and accessibility labels changed. New coverage checks selected video versus neighboring video, <source> fallback, signed direct links, social capability URLs, unsupported sources, independent settings, keyboard activation, retry and gallery original URLs. Three real Electron checks passed for file byte equality, preserved URLs, cancellation, native viewer/embedded menus, bridge shape and existing decoding. Native download coverage also saves a video through the custom lowcord-media protocol and verifies the exact bytes. Build, syntax and whitespace checks pass. No real media was downloaded and no Discord messages were sent; all saved files are neutral fixtures in disposable test directories.

## PiP control polish, 2026-10-18

Replaced the heavy filled PiP glyph with Lucide's outline picture-in-picture-2 icon; its ISC notice ships in `electron/licenses/lucide.txt`. The control is 28×28px with a centered 16px glyph, explicit button resets, a softer surface and equal 8px top/right insets. Positioning measures the actual button width rather than relying on the previous hard-coded offset. Attachment layout stays unchanged. All three PiP fixture tests pass, including measured glyph centering, dimensions/insets and unchanged playback/attachment bounds. Build and whitespace checks pass; inspected the updated control screenshot at `/tmp/lowcord-picture-in-picture-control.png`.

## Movable RedGIFs picker, 2026-10-18

Implemented selected window-management option three inside the existing app: drag its title bar, resize from the lower-right corner, and collapse to a small movable bar. Size and position persist in a separate validated layout key through Lowcord's retained storage handle. CSS clamps the picker within 16px of the viewport edges when the window shrinks. Arrow keys move/resize focused handles, Shift increases the step, Home resets, and Escape/blur cancels an active gesture. Picker options includes a reset action.

Collapsed browsing releases hover playback while preserving the selected tab/query and uploads. Resizing reflows complete virtualized rows; position changes share one scheduled render and introduce no polling, new window or attachment-layout changes. The dedicated title bar adds 28px of chrome; the existing media proportions, 72px creator cards and typography are preserved. At default size twelve creators or nine complete Favorites thumbnails remain visible, with additional media revealed by scrolling or resizing taller.

Verification: all 43 Chromium picker tests pass, including new movement/resize persistence, reset, keyboard/cancel, narrow-window bounds, retained draft and browse state, and an upload finishing while collapsed. Existing media send/search/favorites/queue checks pass. Build, syntax and whitespace checks pass. Source and rendered panel/full/collapsed/narrow screenshots were compared together; `design-qa.md` records the passing visual review. No live messages sent and no commit included.
