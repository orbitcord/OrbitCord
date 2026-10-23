# Media sources browser

XXXTik hover previews use the site's separate `preview.mp4` asset while sending
retains the original `master.m3u8`. The preview streams through the isolated
source session into the picker’s shared muted player and stops on pointer leave.
Chromium picker checks and a real Electron fixture verify preview decoding,
cleanup on pointer leave, and that hovering does not send a message.

Supported sources are GifReels and XXXTik. All retired source adapters have been removed.
Existing Electron feature, not a Toolcraft canvas application. Apply the existing
dark picker language without changing Discord's attachment grid or settings.

## Behavior and implementation plan

- Add a default-enabled “Media sources” composer action for GifReels and XXXTik.
- A resizable native browser uses the real source's navigation/search/login.
  One active remote WebContentsView, opened lazily; source sessions persist
  separately from Discord and from one another. No passwords enter Discord.
- App-owned toolbar: source selection, Back/Forward/Reload, source URL, refresh
  media, sign out and return to chat. Side panel lists media from the current
  page with an explicit Attach action and a fixed destination label.
- Scan only on page navigation or explicit refresh; context-clicking a media
  element offers Attach. Capture normal video/image source metadata, not site
  account data. Unsupported blob/DRM media gets an honest status.
- Site adapters identify source homes, permitted navigation and lazy/original
  media attributes; browsing itself stays on the source's real page. This avoids
  claiming undocumented feeds or guessed trending endpoints work.
- Prepare direct public HTTPS media through the same source session. Validate
  redirects/public hosts, byte limits, MIME/signatures and owner-scoped tokens.
  Unencrypted finite HLS can be downloaded to local segments then transcoded;
  live, encrypted and DRM streams are unsupported and reported explicitly.
- Preserve original images below the requested budget. Oversized videos and
  animated GIFs become MP4, below 20,000,000 bytes in DMs/group DMs or 100,000,000
  in servers. Discord still enforces its own limits. FFmpeg is local-file only.
- UI shows preparing/cancel/error states; completed media returns to the original
  channel's native attachment draft, never auto-sends. If the user changed chats,
  it waits for the original destination. Native upload/delete layout is untouched.
- Close remote views when finished/closed. Cancel work on owner navigation,
  crash, disable, logout and quit. Temporary files and capabilities expire.
  One job/window, bounded input/output streaming, shared serial encoder.

## File and verification plan

Cross-process feature tier: native sessions/windows + local media + renderer.

1. `electron/media-source-files.cjs`: validated streamed preparation, HLS,
   conversion, bounded read/release/cancel and temporary-file lifecycle.
2. `electron/media-sources.cjs`, `media-browser.html/js/css/preload.cjs`,
   `media-source-scan.cjs`: two configurations, isolated browser and host IPC,
   media scanning/context selection and explicit destination/status controls.
3. `electron/main.cjs`, `scripts/build.mjs`: trusted Discord bridge, event delivery
   and native lifecycle. Existing `video-compress.cjs`: animated-image demuxers.
4. `src-tauri/injection/media-sources.js`, extensions catalog and busy hook:
   open source browser, bounded delivery into the original native draft, settings
   toggle and cancellation. No third-party page gets Discord's bridge.
5. Node checks: source configuration, URL validation, byte budgets, MIME checks,
   redirects, HLS rejection/conversion, owner isolation, cancellation and cleanup.
   Chromium checks: source action, delivery/draft preservation, switched channels,
   errors/disable. Electron fixtures: source navigation, separate sessions,
   scanning/selecting real local media, decoding/preparation and bridge denial.
6. Build, whitespace/syntax checks and focused regressions; inspect neutral native
   browser fixture screenshots and launch for user testing. No live posting or
   account sign-in during automated verification.

No canvas, layers, timeline, decorative animation, export PNG or generated raster
assets apply. Native site playback is intrinsic media. Persistence covers site
cookies and extension preference, not downloaded media. Heavy workload is one
source video (max 2 GiB) plus one encoding job; typing/layout never triggers work.

## Limits to verify manually

Source challenges and login providers can reject embedded Chromium. Providing a
normal browser does not bypass them. Both integrations must show failures
clearly; authenticated accounts cannot be certified without user testing. Site
DOM changes can require adapter updates. No speculative API is represented as a
working integration and protected streams are not treated as downloadable files.

## Implementation and verification

- Implemented both site configurations through their real source pages,
  a sandboxed native browser and app-owned selection panel. This is a shared
  site-browser integration, not unverified copies of the RedGIFs API UI.
- Added per-account/per-source saved pages (up to 20), saved sessions and Sign out.
  Site pages get neither the Discord bridge nor the toolbar bridge; the local
  toolbar verifies its native sender separately. Third-party popups are limited
  to normal Google/Apple sign-in and are closed with the source view.
- Owner-scoped preparation validates every redirect, rejects local/private
  network destinations, identifies actual file signatures and streams bounded
  chunks. Finite unencrypted HLS and animated GIFs use local-file conversion.
  AVIF images retain image MIME rather than being mistaken for MP4 containers.
- Fixed cancellation before address validation completes and disabling during
  the final IPC read. A ready file waits for its original chat, retains the draft,
  and never sends automatically. Explicitly reopening from another chat changes
  the destination only when no preparation is active.
- Ten source backend checks pass, alongside all 28 existing RedGIFs/attachment
  backend checks. 52 Chromium extension/upload/compression/source checks passed;
  five final source checks pass including the late-disable regression.
- Five focused real Electron checks passed (source isolation/delivery, chooser,
  drop, codec decoding and settings IPC). The final source check also verifies
  saved pages, sign-out, separate cookies for both provider configurations,
  and downloading a cookie-protected neutral fixture video into the native draft.
- UI evidence: `/tmp/lowcord-media-sources.png` is the app-owned toolbar and media
  panel; `/tmp/lowcord-media-source-page.png` is its separate native source view.
  Chromium screenshots of a host renderer do not composite other WebContentsViews;
  these are explicitly separate captures, not a claim of a combined screenshot.
  Inspected both at native scale with neutral media. No live media was posted.
- Build, JavaScript syntax and whitespace checks pass. No dependencies added,
  no commit made, and unrelated local work remains untouched.

Remaining manual verification: real source login, regional access and anti-bot
checks, browser-only player differences and source-specific original-vs-thumbnail
selection. A configured site is not a claim that every item on it is downloadable.

## 2026-10-18 picker correction

User reports generic preparation/attachment errors and requests the RedGIFs/Reddit
one-click sending workflow. Live inspection confirmed the native source browser
was displaying the catch-all preparation error (before Discord delivery). Its
scanner also treats linked preview images as originals, and successful delivery
only synthesizes a paste rather than invoking the uploader. Prior fixtures tested
that draft behavior and could not establish working real-site resolution.

Approved behavior: a movable, resizable Discord picker with source selection,
search, thumbnail cards, one-click Send, progress/cancel/retry and fixed destination.
The isolated native website window is secondary (login/browse), opened explicitly.
Resolve thumbnail links on the source page before preparing original media; scan
loaded videos, structured media metadata and observed media requests, without
reading account secrets. Retain isolated site sessions and 20 MB DM / 100 MB guild
budgets. Use CloudUpload + RestAPI as existing pickers do, capture reply references,
preserve draft text and use a stable nonce on retries. Keep the picker open after
sending. No canvas, export, timeline or generated assets apply. DOM/CSS grid and
one reusable preview video; thumbnail fetching is bounded and generation-scoped.

Implementation order: add original/page media scanner fixtures; add native state,
thumbnail and browse commands; replace paste delivery with direct uploader and
picker; test failures, retries, destination/reply/draft, original resolution and
native isolation; build and relaunch. Risks: source challenges, DRM and unsupported
players remain real limitations; never substitute a thumbnail or claim success
without Discord confirming the message. Tests must exercise the uploader, not a
fixture paste listener. No live message sends during automated verification.

### Correction outcome and evidence

- Reproduced a cross-origin media failure: Chromium rejected CDN requests
  with `net::ERR_BLOCKED_BY_CLIENT` and logged “invalid referrer”. The full source
  page Referer conflicted with strict-origin-when-cross-origin. Requests now keep
  the page URL only for same-origin requests, strip fragments and use the origin
  for cross-origin CDNs. The native regression uses distinct localhost/127.0.0.1
  origins, so a same-origin fixture cannot hide this bug again.
- Replaced synthetic paste with direct CloudUpload + RestAPI sending, matching
  RedGIFs/Reddit. A click captures destination and reply, uploads the original,
  posts with enforce_nonce, leaves draft text intact and marks Sent only after
  confirmation. Failed sends retain a nonce for a safe retry. Closing the picker
  during a send does not redirect the destination; Cancel/disable abort work.
- Replaced the browser sidebar with a movable/resizable Discord thumbnail grid.
  Site search, saved pages and login/browse are available; the source window is
  secondary and full width. Sending keeps the picker open, with bottom progress.
  Thumbnails are bounded, fetched with the source session and delivered as small
  data images. Progress updates do not resend all thumbnail bytes.
- Fixed linked thumbnails, navigation graphics, sibling-poster association,
  delayed SPA feeds and JavaScript-only card clicks. Single-player MSE resolves
  its real MP4/HLS network request, including worker requests with optional
  WebContents metadata. Let playback start before treating its early blob URL as
  a file. File-backed blobs stream in bounded chunks in an isolated world; MSE
  blobs themselves and protected content are not treated as downloadable files.
- Real public-source dry runs (no Discord sends, no account sign-in) prepared
  GifReels MP4 (~3.5 MB) and XXXTik MP4 (~7.2 MB).
- Verification: 24 Node backend checks and 23 Chromium picker/Reddit/compression
  checks pass. Native checks exercise two isolated source configurations,
  cookie-protected linked originals, worker/MSE detection, chunk delivery into
  the uploader, draft preservation, file-backed blob reads and cross-origin
  referrer behavior. A separate neutral thumbnail fixture checks rendered cards.
- Risks: source access challenges and changing site markup remain source-specific.
  This integrates source pages rather than claiming documented API clones.
  Protected/live streams, separate-audio HLS, and unsupported players give clear
  failures; no thumbnail substitution and no live message was used for testing.
