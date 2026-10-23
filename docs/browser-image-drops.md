# Browser image drops

Drag an image from a browser into the active conversation to attach the original
image through Discord's native paste/upload path. The user reviews it and presses
Send. Existing file drops, attachment layout, message text and ordinary link drags
keep their existing behavior. This is always available, with no new setting.

This is an Electron client feature, not a Toolcraft app: canvas, panels, controls,
layers, animation, export and persisted settings do not apply. Rendering remains
Discord's DOM. Only a drop does work; there is no polling or new DOM observer.

## Implementation and verification plan

1. Add `electron/image-drop.cjs`: fetch HTTP(S) image resources without browser
   CORS restrictions or credentials; validate type, bound streamed bytes (50 MiB),
   apply a timeout and preserve bytes/animation. Reject nonimages and unsafe URL
   schemes. Keep filenames safe and consistent with the returned media type.
2. Wire a trusted main-frame IPC handler in `electron/main.cjs`, expose the narrow
   bridge in `scripts/build.mjs`, and bundle `injection/image-drop.js`.
3. In the renderer, distinguish URL/HTML image drops from native file drops,
   internal drags, ordinary links and settings/dialogs. Prefer the image source
   over an enclosing link. Download once, clear the native overlay, then paste a
   File into the still-current composer. Show progress/failure through existing
   toasts. Discard results after chat changes or composer replacement.
4. Add node tests for the downloader, Chromium tests for drag metadata and native
   upload behavior, and an Electron test across the actual sandbox/IPC boundary.

Verification tier: integration (new native bridge and renderer event handling).
Run downloader node tests, browser-image-drop/upload/video-compression/extension
fixture tests, build the preload and run the targeted Electron test. Verify that
the real native bridge retrieves a cross-origin image without CORS headers and
that bytes reach a composer without sending. Rust tests are unrelated: Rust does
not change. No production Discord message is sent during verification.

Acceptance: linked image and URL-only image attach once; plain links and files
remain native; GIF bytes survive; failed/oversized downloads show an error;
chat switches discard late results; upload stays pending until Send; filename
anonymization still applies. Idle workload is event listeners only; download
memory is bounded and concurrent user drops are declined while one is running.

## Diagnosis and worklog

The native upload fixtures accept DataTransfer.files. The existing window drop
hooks in extensions.js and video-compression.js also process only files. Browser
image drags can instead contain text/html plus text/uri-list, leaving files empty.
The missing step is retrieving that image and handing a File to Discord. The
existing video-compression drop path demonstrates why an asynchronous drop replay
is unreliable: Discord's overlay expires, so prepared files use native paste.

Risks: images requiring the source browser's login cookies or blob URLs cannot
be retrieved from another app. Failures should explain this without sending a
link or navigating the window. Discord's native upload limit still applies.

Implemented the downloader, sandbox bridge and narrowly scoped drop adapter.
Pending downloads keep the background saver awake. URI-only nonimage resources
return their original payload to Discord's drop handler; linked images use the
image URL rather than the surrounding page. Downloads preserve original bytes,
including animated GIFs, without image decoding or conversion.

Verification completed: 7 downloader tests; 58 Chromium checks across image drops,
native uploads, video compression and extensions; 1 Electron bridge check. The
Rust/preload development build and `git diff --check` passed. The Electron check
used a cross-origin HTTP image with no CORS headers, verified every byte after
native IPC and confirmed that subframes receive no native bridge. No real account
or chat was used. Package-manager auto-install failed in this environment, so
Playwright was invoked directly from the already installed dependencies.

Helium follow-up: a real cross-app drag reached the conversation as uri-list,
HTML and chromium/x-drag-id, with no files. Lowcord accepted dragover, but
Discord's UploadArea.preventUnwantedDrop subsequently set effectAllowed and
dropEffect to none, so Chromium never emitted drop. The original fixture tests
dispatched drop directly and missed this acceptance phase. A regression with
Discord's body-level rejection behavior failed with effect=none and one native
rejection. The adapter now stops propagation for the browser string dragover
it accepts, keeping the copy operation active until drop. File drags continue
through the native handler.

Follow-up verification: 18 image-drop and native-upload checks passed. The new
regression sends dragEnter, dragOver and drop through Chromium's input protocol
with Helium's observed string types, against the body-level rejection handler.
It confirms that the rejection is bypassed and an attachment is prepared. The
preload rebuilt successfully; the running client was reloaded after confirming
its message draft was empty and there were no pending attachments. Temporary
drag diagnostics were removed before reload.

The user retried the same Helium image after the reload and confirmed that its
attachment preview appears in the DM.

Release verification found two older Electron bridge allowlists that omitted
`downloadDroppedImage`. Both assertions now include the new narrow IPC method;
the dedicated image-drop test already verifies its sandbox boundary and bytes.
