# Review bugs

Found by reading the uncommitted social, chat, and DOM changes and reproducing them in the local fixture. The existing Playwright suites that cover this work passed: 144 tests. Nothing here was fixed.

Server channel bubbles are also gone, including the settings toggle. Saved `servers: true` is ignored. That matches the updated tests, so it is a behavior change to confirm, not one of the bugs below.

## 1. An X video with an unknown size is rejected as too large

`fitting` in `electron/social-posts.cjs` walks variants from highest bitrate to lowest. If `HEAD` has no `Content-Length`, or `HEAD` fails, it returns that URL immediately. The download then hits the size cap and throws `too-large`, which is not retried. A smaller variant that would have fit is never requested.

Reproduced with a 3 MB high variant whose `HEAD` succeeded without a length, an 8 byte low variant, and a 1 MB upload limit. `socialVideo` threw `{ code: "too-large" }`.

## 2. A second paste's progress toast is replaced by the first download

Each download builds its own toast, and `showToast` keeps only one. `progress.update` then calls `showToast` again if its own toast is no longer on the page, which removes whatever toast is showing now.

Reproduced by pasting two Reddit links and holding both lookups. The second paste's "Checking the Reddit post…" toast was up. Resolving only the first lookup changed the visible title to "Getting the Reddit video…", which only the first job can set.

## 3. A spoiler rename makes the next paste download the post again

Finished downloads are remembered by filename. `draftFiles` in `src-tauri/injection/extensions.js` compares those names to `UploadAttachmentStore`. Discord's spoiler control renames a file to `SPOILER_` plus the old name, so the names no longer match. The next paste of the same link treats the file as deleted.

Reproduced by renaming the stored upload. The first paste attached `hsspqao.mp4` and made 1 download. After the stored name became `SPOILER_hsspqao.mp4`, pasting the same link made a second download and left both files attached.

## 4. A video card with no width and height stays square

If the post has no dimensions, the card in `src-tauri/injection/social-embeds.js` listens for `load` or `loadedmetadata` and then sets `--lowcord-social-ratio`. A video that has a poster is created with `preload="none"`, so that event does not fire until someone plays it. OGInstagram slides do not carry width and height, so this is the fallback path for those videos.

Reproduced with `sample.mp4`, which is 160 by 90. After 400 ms the card's aspect ratio was still `1 / 1`, `preload` was `none`, and `readyState` was 0. A warm 400 by 100 image did update, to the clamped ratio `1.91 / 1`.

## 5. Detached composers stay in memory

Music drafts watch `characterData` on every composer they have seen. Nothing disconnects that observer, and a `MutationObserver` keeps its targets alive.

Reproduced with garbage collection forced. An ordinary detached node was collected. A composer that had shown a Spotify preview was removed from the page and was still alive after several collections, including after its text changed while detached. This grows if Discord throws away the composer node, such as a popout or a new thread editor.

## 6. Pasting a post that is already attached inserts the link again

While the files are still in the draft, `prepareVideo` returns true and does not call `preventDefault`. The download is correctly skipped. The link text still goes into the composer.

Reproduced by pasting the same Reddit URL twice. The composer text was the URL concatenated with itself, and the file count stayed at 1. On send, every copy of that post's link is stripped, so the message can still go out as files only.

## 7. Dismissing a toast can cut it off on the wrong animation

`dismissToast` removes the node on the first `animationend`, from any descendant. The entrance animation and the check-mark draw both qualify.

Reproduced by showing a success toast with an Undo button and clicking it at 321 ms. The toast was removed because `lowcord-toast-in` ended, not because the exit animation finished. `lowcord-toast-draw` also bubbled from the icon. A toast left up for the normal 4 seconds is past both of those animations, so this shows up on an early dismiss.
