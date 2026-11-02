# Bulk delete reaction cleanup — 2026-11-02

Existing Electron/Discord extension; no Toolcraft canvas, media, timeline, layers
or export changes. The requested behavior is an optional reaction cleanup in the
existing message-deletion confirmation. A standard checkbox fits the existing
DOM controls. It is off each time the dialog opens and is not persisted, so a
previous cleanup cannot silently widen a later deletion.

Implementation plan (writing-plans skill; tier 2 behavioral change):

1. In `mass-delete.js`, add a third start argument with `reactions: false` by
   default and the confirmation checkbox. Keep the existing message-only path.
2. When selected, scan full history rather than stopping at the search boundary.
   Remove only reaction entries marked `me`, using the URL-encoded own-reaction
   endpoint. Reuse deletion request cooldowns/retries, account identity checks,
   bounded channel workers and Stop. Do not delete other people's messages or
   reactions. Count unsupported super reactions as skipped rather than claiming
   they were removed; the documented own-reaction route covers standard reactions.
3. Update progress, completion and extension descriptions. No new startup work,
   dependency, background scan or history persistence. Keep one history page per
   worker, at most four workers. Only this opt-in incurs the full-history cost.
4. Add Chromium fixture checks in `tests/mass-delete.spec.mjs` for checkbox
   default/selection, Unicode/custom emoji, other authors, pagination beyond
   indexed own messages, server channels/active threads, rate limits, stopping,
   skipped/inaccessible history and account changes. Existing message deletion
   suites must pass unchanged. Build the preload and run whitespace checks.

Acceptance: the checkbox reaches start options; deselected jobs make no reaction
requests; selected jobs remove only the current user's standard reactions in the
chosen scope; Stop prevents further work; summaries report both counts and any
incomplete histories. Use browser fixtures only, never live deletion.

Reference: https://docs.discord.com/developers/resources/message#delete-own-reaction

Limits: archived threads not found in search or the active-thread listing remain
outside discovery. Super reactions are reported as skipped. Reactions added to
old messages during a scan may also be removed; Discord supplies no reaction time
for a per-job cutoff. Messages newer than job start remain excluded.

Verification results: 22 Bulk delete Chromium checks pass, including eight new
reaction cases, and the 38 extension checks passed in the initial combined run.
Preload build and diff whitespace checks pass. No live requests were made.
The existing global Retry-After test also failed against the unchanged code:
its clock advanced between browser calls before the 119 ms assertion. Other near-boundary cooldown assertions showed the same issue under parallel
load. Pausing clocks before starting these jobs makes the cooldown assertions
deterministic; all 22 deletion checks pass with four workers.
The Stop fixture now anchors its composer at the bottom, as existing deletion
UI fixtures do, so its status capsule is inside the viewport.
