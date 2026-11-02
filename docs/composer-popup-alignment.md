# Composer popup alignment — 2026-11-02

Approved direction: option C, content-sized cards sharing the message composer's right edge.

Root cause: status toasts used a viewport-centered fixed position; bulk-delete and compression bars independently centered on the composer; the extensions menu centered on its trigger. Their separate positioning rules produced inconsistent alignment and could overlap.

Change: `extensions.mountComposerPopup` mounts transient surfaces in one right-aligned flex stack, 12px above the composer with 8px between surfaces. Metadata and other status notices, compression, bulk deletion, screenshot selection controls use this stack. The extensions menu is an exception: it centers on its chevron, keeps the same 12px gap from the composer (the chevron sits inside the composer, so a gap measured from the chevron touched its top edge), with viewport clamping and a below-composer fallback when needed. Existing card contents and actions remain. Screenshot capture temporarily moves its controls above the captured region to keep them out of the image.

The anchor follows composer/parent resizing, scrolling, focus and composer replacement. Observers and listeners are removed when the stack becomes empty. No idle polling. A composer near the top of the viewport uses available space below; without a composer, the stack uses a viewport right-edge fallback.

Verification: Chromium fixture suites cover geometry, differing widths, stacking, viewport resizing, replacement composers, narrow layouts, fallback and cleanup, plus metadata, compression, deletion, keyboard menus and screenshots. Inspected the rendered desktop compression fixture visually. `git diff --check` passes.

Risks: live Discord DOM changes may require updating the existing `channelTextArea_` selector. Live Discord account testing was not performed for this change.

Release verification — 0.1.28, 2026-11-02: the preload/native build, all 378
Chromium fixtures, 32 real Electron tests and 48 unit checks pass against the
combined pending changes. This includes deletion/reaction/history coverage,
composer stack geometry, quick-reply emoji selection and real screenshot export.
Generated screenshots remain local; no live deletion was used for verification.
