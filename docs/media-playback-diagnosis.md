# Video playback and fullscreen investigation

Investigated 7 October 2026 against OrbitCord 0.1.5-1 (installer build 0.1.5.1), Electron 44.5.1. The report did not identify an affected clip, player, Windows version, or GPU. Execution here was on arm64 macOS; a Windows machine was unavailable.

## Confirmed failure and cause

The current app rejected fullscreen requests from cross-origin embedded players. A local video fixture served under `https://www.youtube.com/embed/fullscreen-fixture` played inline, but clicking its fullscreen button left `document.fullscreenElement` unset and the native window out of fullscreen.

Temporary diagnostics captured Electron's request:

```js
{ isMainFrame: false, requestingUrl: 'https://www.youtube.com/embed/fullscreen-fixture' }
```

Both permission handlers in `electron/main.cjs` required the requesting origin to be Discord. That evaluated to false for the player. This is shared application code, so the defect is not specific to Windows. The reproduction used the real Electron runtime, a user click, and an iframe with explicit fullscreen delegation; no live YouTube service or Discord account was needed.

The fix allows ordinary `fullscreen` requests within the main window while its top-level page is trusted. Chromium continues to enforce iframe delegation and user activation. Other permissions continue to require a trusted requesting origin; automatic fullscreen is not granted. Both the permission request and check handlers use the same decision.

## Verification

- Existing MP4/H.264, AAC, WebM, GIF-loop and file-backed Reddit playback tests passed before the fix. No general decoding failure was reproduced locally.
- New attachment and embedded-player tests verify actual native fullscreen entry/exit, continued decoded frames in fullscreen, and return to inline playback.
- The embedded-player regression additionally verifies that camera/microphone permissions remain denied even when the iframe delegates them, and that fullscreen fails without iframe delegation.
- The complete Electron suite passed all 10 tests on the final pre-commit run. Policy-denial assertions use the rejection's `TypeError` name rather than Chromium-specific error wording.
- JavaScript syntax checks and `git diff --check` passed for the task changes.
- Release builds now run the decoding, fullscreen and Reddit playback tests on both their Windows and macOS runners before packaging.

macOS native fullscreen transitions are asynchronous. The tests wait for `enter-full-screen`/`leave-full-screen`, rather than relying only on `isFullScreen()`, before testing the next transition. A minimal Electron window confirmed normal exit after the entry transition finishes.

Reproduce with:

```sh
pnpm test:electron --grep 'decodes|fullscreen|file-backed'
```

## Remaining uncertainty

Risks: Windows execution, GPU/driver-specific behavior, and the original videos that reportedly fail to play at all remain unverified. The fullscreen fix does not establish that every reported playback failure had the same cause. An affected file/link and the user's app/Windows version are needed to diagnose that separate symptom. No codec, GPU, attachment-grid, or video-player replacement was introduced.

References: [Electron frame permission handlers](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler), [native fullscreen transition timing](https://www.electronjs.org/docs/latest/api/browser-window#winsetfullscreenflag).
