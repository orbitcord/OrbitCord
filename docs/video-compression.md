# Automatic media attachments

## Preserve GIF uploads — 2026-10-23

- Root cause: oversized GIFs shared the MP4 encoder and output validation with
  videos; the renderer accepted only PNG or MP4 replacements.
- GIF headers now select a dedicated GIF encoder for local uploads and media
  source downloads. The renderer accepts GIF MIME/extension and rejects MP4
  replacements for GIF uploads. Originals are restored with an explanation
  when the GIF cannot fit; files are never silently converted to video.
- When installed, Gifsicle tries lossless optimization, then modest lossy
  compression. FFmpeg is the fallback, using a two-pass palette without buffering
  the entire animation. Later attempts reduce colors, dimensions and frame rate;
  output retains transparency and the source loop setting. The existing serial
  encoder queue and cancellation apply. No new startup work or dependencies.
- Verification: 22 backend and 15 Chromium upload checks pass, including actual
  GIF decoding, animation duration/frame count, transparency, finite loops,
  output MIME/header validation, downloaded GIFs and original-file restoration.
  Two real Electron checks pass for PNG and animated GIF uploads across sandbox
  IPC. The decoder test waits for track metadata before reading frame count.
  Preload build and whitespace checks pass.
- Test diagnosis: the initial fixture already fit its requested cap. Replaced it
  with a larger animation; a 20 KB cap exceeded the encoder's quality floor
  (128px edge), so the success case uses 50 KB against a 92 KB source.
- Risks: Gifsicle is optional and absent on this development machine; the real
  codec checks exercise FFmpeg. GIF compression may visibly reduce quality and
  cannot guarantee that every animation will fit Discord's upload limit.

## Media support and extension search — 2026-10-23

- Root cause: the local attachment filter accepted only video MIME types and
  extensions, so GIFs and still images never reached compression.
- The toggle is now “Compress media”; its saved `compressVideos` key is retained
  so existing on/off choices survive the rename. Oversized images, videos and
  GIFs use the existing 20 MB DM/group-DM and 100 MB server/thread budgets.
- Still images become PNG with transparency preserved and dimensions reduced
  to fit. PNG uses FFmpeg's built-in encoder; the local FFmpeg installation
  does not provide WebP encoding. Videos and GIFs become MP4; GIF animation is
  retained. Smaller media keeps its original bytes. Existing native attachment
  selection, drafts, spoiler names, cancellation and Send behavior are retained.
- Output MIME and extension now travel with the bounded native response and
  are validated before creating the replacement File. Animated image headers
  are detected before still-image encoding to avoid flattening them.
- Media-source downloads also use the shared still-image compressor instead of
  rejecting oversized images. Encoding remains lazy and shares the serial queue.
- Extension settings now have a labeled search field filtering names and
  descriptions without changing preferences. Empty results are explained;
  clearing the query restores the list and related controls.
- Verification: backend checks cover PNG decoding/transparency and oversized
  source images; Chromium checks cover GIF/image interception, output MIME,
  extension search, cancellation and batch order. Four real Electron checks
  pass for video chooser/drop, still-image decoding and GIF-to-MP4 animation.
- Limits: FFmpeg remains required. Compression only runs at the requested size
  threshold; Discord still enforces the account's actual upload limits.

## Original video implementation — 2026-10-18

## Spec and decisions

Existing Electron/Discord product, attachment feature (not a Toolcraft canvas app).
Use capture events before the existing filename hook, rather than changing
Discord modules or upload requests: file-size checks happen before networking.
No attachment-grid styling or upload/delete changes.

- Default-enabled extension, one on/off control in Lowcord Extensions.
- Oversized local video files selected, dropped or pasted into the main composer
  become MP4 files below 20,000,000 bytes in DMs/group DMs and 100,000,000 bytes
  in guild channels/threads. Smaller files and nonvideos retain their bytes.
  These are requested targets; Discord still enforces its own upload limits.
- Preserve batch order, filenames (with .mp4 extension), spoiler prefixes, drafts,
  and native preview/send. No automatic message sending. Anonymization still runs
  after compression. No remembered file paths or media history.
- One batch per window, sequential files and bounded 1 MiB input chunks over the
  trusted main-frame bridge. Temporary local files only, never arbitrary renderer
  paths or FFmpeg arguments; source cap 2 GiB, duration cap six hours.
- Cancellable status outside attachment internals. On failure, replay originals
  with a clear error; Cancel discards the pending selection. Channel changes or
  disabling cancel without replay. Native services cancel on navigation/crash/quit.
- Lazy FFmpeg use, shared bounded serial encoder, two worker threads; no startup
  probes, polling, remote downloads, dependencies, or new renderer/window.
- Playback/preview uses native Discord/Chromium. Intrinsic video dimensions,
  preserved aspect ratio and audio; compression can lower resolution/frame rate.
  No canvas, timeline, layers, PNG export, or decorative animation applies here.

## Plan and acceptance

Verification tier: cross-process media processing (native + renderer + regression).

1. Generalize `electron/video-compress.cjs` for common local containers and queued
   encoding, preserving RedGIFs defaults. Test real MP4/WebM decoding, byte budget,
   queue cancellation and malformed inputs.
2. Add `electron/video-attachments.cjs`: owner-scoped job tokens, validated budgets,
   sequential bounded writes/reads, output-size checks and temp cleanup. Wire
   trusted IPC/start/stop lifecycle in `electron/main.cjs` and `scripts/build.mjs`.
3. Add `src-tauri/injection/video-compression.js` before existing file hooks,
   extension catalog entry and busy-state integration. A small status outside
   Discord's attachment DOM keeps Cancel visible even when other toasts appear.
4. Browser fixture tests: DM/group DM/server/thread targets, below-limit byte
   identity, mixed order, picker/drop/paste, errors/cancel/channel switch/disable,
   anonymization, draft/send safety. Native Electron test: real bridge chunks,
   decodable MP4 output and rejection of invalid requests/foreign frames.
5. Run focused Node, Chromium upload/extensions/compression and native Electron
   tests, build and diff checks; inspect neutral fixture status and live hook
   presence without sending real messages. Relaunch local app for user testing.

Performance load: mixed batch with >100 MB video, unchanged photos/documents,
one source chunk and one output chunk buffered in IPC at a time. Encoding is the
only heavy pass, invalidated by attaching an oversized video; typing and layout
do not invalidate it. Status updates occur at file/stage transitions only.

## Worklog

- Read AGENTS.md and brainstorming/writing-plans skills; user request authorizes
  this spec and implementation. No Toolcraft workflow exists in this repository.
- Confirmed native attachment input is multiple-file, and file anonymization
  already captures/replays chooser/drop/paste. Compression will run first.
- Implemented a separate fixed status with Cancel, and coordinated replay with
  filename anonymization. Pasted batches replay one File at a time because
  Discord accepts only the first file in a paste. Output Blob parts avoid
  retaining a second movie-sized typed-array buffer on the renderer JS heap.
- Verification: 28 Node checks pass, including five new attachment/codec checks
  and all 23 existing RedGIFs backend checks. All 37 existing upload/extension
  Chromium checks passed; nine new compression browser checks pass after
  narrowing two ambiguous status selectors in the test fixture. Real Electron
  compressed an over-20 MB local source through sandbox IPC and decoded the
  resulting MP4 in the attachment fixture. No real Discord messages were sent.
- Inspected normal and 360px-wide neutral status screenshots; Cancel stays
  visible, long text wraps, and no native attachment internals are resized.
- Requires an installed FFmpeg executable (available on this development Mac).
  Common self-contained video containers are accepted; playlists are excluded.
  Original source files are never changed. The requested caps do not override
  Discord's account/server upload permissions or limits.
- Final build and whitespace checks pass. Three focused real Electron checks
  pass (automatic attachment compression/MP4 decoding, existing media decoders,
  and settings sandbox IPC); the RedGIFs bridge regression also passed. Local
  app relaunched for testing. No commit or dependency changes.

## Drag overlay correction

- Root cause: the running Discord DOM places `.uploadArea_*` next to `<main>`,
  outside every drop target accepted by the compression hook. Its original
  large File therefore reached Discord's size validation before compression.
  A new local regression reproduced this: no compressed attachment was created.
- Read-only inspection of the actual native overlay handlers also showed that
  its active drag expires after one second. Simply widening the selector and
  replaying a drop after encoding could still silently lose the attachment.
- Fix: include the upload overlay in capture scope, let Discord's body-level
  cleanup receive an empty drop immediately, then deliver finished Files through
  its working native composer paste path, one at a time. Smaller drops and
  disabled compression retain native behavior; no warning dialog is suppressed.
- The regression checks an overlay outside main, original-file size validation,
  early cleanup, compressed delivery after the drag ends, smaller native drops,
  and disabled compression. All 47 Chromium compression/upload/extension checks
  pass. Build and whitespace checks pass.
- Both real Electron chooser and overlay-drop checks pass, including decoding
  the compressed MP4 and verifying the original large drop never reaches size
  validation. Relaunched the development app with this correction.
- Risks: native upload limits still apply. No messages or files were uploaded
  to live Discord during diagnosis; the actual overlay ancestry and cleanup
  handlers were inspected, with media processing verified in local fixtures.

## Selected bottom toast design

- Visual target: first displayed compression redesign,
  `/Users/yashsirmour/.codex/generated_images/01a148bb-c7da-7683-aa18-918a03b7a3b0/exec-9515b36d-4d68-46ff-a63a-fc1750df737e.png`.
- Scope: the existing status component only. Compact 360px-wide, approximately
  62px-high charcoal toast, 18px corners, lavender activity ring, 14px headline,
  12px metadata and a quiet Cancel button. No changes to chat or attachments.
- Position above and centered on the composer, with a bottom-96px fallback.
  Observe composer size only while compression runs; update on window resize,
  and disconnect on completion/cancellation. Clamp within narrow windows.
- Single-file copy: “Compressing 1 video” / “MP4 · under 20 MB”. Multi-file
  status retains its current index/count; filename remains available on hover.
  The activity ring is indeterminate, with a static reduced-motion variant.
- Plan: update status markup/positioning and isolated CSS, credit library icon
  sources, extend existing browser layout checks for bottom alignment, resizing,
  readable truncation, reduced motion and Cancel. Compare source and neutral
  fixture screenshots together, then build and relaunch for user testing.
- Implemented the selected design and a composer ResizeObserver scoped to the
  active status lifetime. Native CSS clamps keep it inside resized windows
  immediately; observer/listener disconnect on completion/cancellation. Standard
  Lucide ring geometry is credited, and reduced motion disables rotation.
- Eleven Chromium checks pass, including bottom alignment, compact height,
  off-center composer positioning, narrow viewport bounds, composer growth,
  reduced motion and no visual-flow page errors. Compared full/focused/narrow
  captures with the selected image; `design-qa.md` records final result: passed.
