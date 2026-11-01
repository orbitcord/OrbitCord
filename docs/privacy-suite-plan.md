# Privacy suite

Current scope (Privacy & Security page): media metadata removal, Cover image
details, message expiry, attachment inspection, Walk-away protection, Leave no trace
and the Privacy report. Redacted screenshots live in the Chat screenshots
extension: its review dialog and its options on the Extensions page. Undo Send, live privacy masking and
the settings guardian were built, then removed at the user's request (2026-10-29);
none of their code remains. A later privacy checkup was also dropped.
Selected visual: third displayed generation, `exec-c8561211-79ec-4282-93b6-7b77d5becf12.png`.
Flat Sharing / Messages / Protection rows inside Discord's existing settings column.

## Implementation and acceptance

- `electron/privacy-files.cjs`: bounded, local image metadata removal and attachment
  identification / ZIP directory inspection. Preserve image payloads, orientation
  and animation. Report unsupported / malformed input explicitly. No extraction,
  execution, remote scanners or new dependencies. Native download inspection reads
  only headers and bounded ZIP directories, never a whole large download.
- `src-tauri/injection/privacy-core.js`: testable per-account expiry queue/rules,
  privacy-setting snapshots and comparisons. Retain IDs/deadlines,
  never message bodies. Explicit expiry rules apply to newly observed own sends;
  no retroactive history sweep. Preserved IDs are excluded. Back off on rate limits.
- `src-tauri/injection/privacy.js` and `privacy.css`: selected settings page, upload
  preparation, effective settings review, scoped live
  masking. Default metadata/inspection/guardian protections on; masking off until
  invoked, expiry unconfigured. Respect native uploads and never modify the
  attachment grid.
- `chat-capture.js`: configurable identity/message redaction, opaque flattening,
  preview before copy/save. No automatic clipboard write before review.
- `electron/main.cjs`, `scripts/build.mjs`, settings registration: authenticated
  native IPC, lazy file inspection, production and fixture integration.

Guardian reads actual enumerable privacy-related account setting values exposed by
Discord stores. It saves the user's chosen baseline, reports changed/new values,
and says unavailable when a setting cannot be read. It never invents protobuf
fields or silently rewrites server preferences.

## Verification

High blast radius: file parsers, native IPC, message sending, persistent deletion.
Run `node --test tests/privacy-files.test.cjs tests/privacy-core.test.cjs`, targeted
Playwright privacy/upload/capture/settings suites, then `pnpm test`, preload build
and `pnpm test:electron` for bridge/download integration. Rust is unchanged; skip
its tests unless the implementation changes native Rust sources.

Browser acceptance: inline settings and native X; saved preferences after reload;
undo cancels before API request and preserves draft; staged files are not lost;
expiry deletes only own tracked IDs and persists retry/preserve state; guardian
detects changed baseline; masks cover newly mounted messages and restore cleanly;
capture pixels stay redacted in exports; dangerous and uninspectable downloads
have accurate results. Inspect selected mock and captured UI side by side.

Performance: no broad DOM scans per mutation, no per-element universal selectors,
no polling network requests, bounded file buffers, serial local processing, one
expiry timer and store subscriptions. Load heavier inspectors only on use.

## Worklog

- Existing workspace clean. Read AGENTS.md and relevant existing native/upload,
  settings, capture and deletion integrations. Generated three visual alternatives;
  user selected the third displayed image. No Toolcraft runtime in this repository.
- Review pass (2026-10-29): expiry verified ownership with `GET /messages/:id`,
  which Discord refuses for user accounts, so every message would have been
  preserved and never deleted; it now reads `?around=<id>&limit=1`. Attachment
  rules now edit attachments out (text kept) and delete attachment-only messages.
  Expiry also runs while minimized to the tray. Undo Send targets the pressed
  editor, skips inline edits, shows destination, text and attachments, and says
  when a pending send is dropped. Metadata notices name unsupported media (HEIC,
  video) instead of implying it was cleaned. Inspector recognizes text, warns on
  HTML/Python downloads, treats disk images as uninspectable, and shows a dialog
  only for concrete warnings. Masking keeps sidebars clickable under covers, hides
  tooltips and typing names, aliases mentions. Guardian reads enums and activity
  sharing, labels known settings, ignores frecency-only store changes; the
  unverifiable support link was removed. Screenshot review uses a reduced preview
  and restores only covered pixels after export, so the 200M px cap is back.
- Undo Send removed entirely (send buffer, composer interception, pending bar,
  extension re-send hooks and their tests). Settings page rebuilt as the chosen
  split inspector: protection list, one detail pane per protection, shared
  section/card/fact patterns on a 4/8/12/16/24/32 scale, theme tokens only.
- Live masking removed entirely (DOM masking, aliases, shortcut, window-title and
  notification hiding). Guardian replaced by a privacy checkup that opens Discord's
  own settings pages: Discord's settings store omits defaults and uses undocumented
  codes, so raw value diffs were not trustworthy. Expiry now picks servers (whole
  or one channel) and DMs from searchable lists, with a live before/after preview.
  Screenshot redaction has saved defaults for names, avatars and channel mentions.
- Fixed: pasted or dropped images never reached the composer when anonymous file
  names was on. Its replay of our cleaned file was treated as a new upload while
  we were busy and dropped. Hooks now pass through while cleaned files are handed
  over; a regression test covers paste with both features on.
- Screenshot review moved into Chat screenshots (options: review on/off and the
  default covers; earlier Privacy-page choices carry over once). Review dialog
  rebuilt: Cover chips, click to hide with hover outline, hidden count and Show
  all, Copy/Save aligned; the message dropdown is gone. It scrolls rather than
  clipping in small windows. Fixed a 1px seam between stitched screenfuls at
  fractional zoom (edges were rounded per segment). Privacy page trimmed to
  metadata, expiry and inspector; the metadata success toast lasts 1.8s.
- Added 2026-11-02. Video and HEIF metadata (`privacy-media.js`): boxes are overwritten
  in place and the result is built from slices of the original, so files never load
  whole. Sensor tracks are removed and their samples zeroed. Handler names and encoder
  strings in sample descriptions stay. A file that is not ISO media uploads silently
  like any other unsupported format; a recognised one that cannot be cleaned stops the
  upload. Walk-away: `lock-screen` and `suspend` only, never idle time. Its toast comes
  from re-reading Discord's stores, so a failure is reported as one. Cover image details
  never touches Discord's attachment list: it runs before attaching (message bar action,
  or the optional ask-first switch) and re-enters through the paste path. Report: totals
  only, per account, flushed every 30s. Leave no trace (`traces.cjs`): choices live in
  the main process; sign-out keeps `lowcord*` keys in open windows, fully clears
  closed accounts, and requires a native confirmation. Update restarts keep the sign-in.

## Release verification — 0.1.27, 2026-11-02

The native/preload build, 354 Chromium fixture tests, 32 real Electron tests,
and 48 privacy/cache-cleanup/updater unit checks all pass. GitHub release jobs
now verify the media metadata parser, leave-no-trace logic, and native screen-lock
integration on each platform before publication. Generated design screenshots
remain local. Rust sources are unchanged.
