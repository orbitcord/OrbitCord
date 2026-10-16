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
