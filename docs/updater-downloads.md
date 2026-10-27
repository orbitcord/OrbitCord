# Interrupted installer downloads (0.1.23)

## Diagnosis and decision trail

- Report: the in-app updater stopped downloading with a network reset error.
- Local evidence: an incomplete 0.1.22 Mac installer contained about 0.8 MB of its expected 235 MB. The published release includes the expected installers and update manifests; the manifest was independently downloaded successfully.
- `downloadMacInstaller` previously made one request, with no idle timeout, retries, or Range resume. Its error handler deleted the partial installer. Tests reproduced immediate failure on `net::ERR_CONNECTION_RESET` and failure to request the remaining bytes of a saved partial file.
- A real Electron HTTP test drops the socket after 32 KiB reaches disk. Chromium reports `net::ERR_CONTENT_LENGTH_MISMATCH`; this is another recoverable interrupted-body error.
- On Windows, `electron-updater.checkForUpdates()` returns a separate `downloadPromise`. The controller ignored that promise, so a reset could leave an unhandled rejection and no automatic retry. A regression test reproduced both behaviors.

## Fix

Mac downloads retry transient network and server errors up to three times. Each attempt has a 30-second no-progress timeout, within the existing 30-minute overall limit. Saved bytes are rehashed and resumed with Range; the response's range and total size must match the release. If the server ignores Range, the file is truncated and downloaded from the start. Retries and resumed downloads can use GitHub's official asset API with fresh redirect metadata.

Partial files with a GitHub SHA-256 digest can survive an exhausted retry budget and be resumed on the next manual attempt or launch. Size, range, and checksum failures remove the invalid file. Only a complete verified installer is renamed into the installable path.

Windows now observes the automatic download promise and retries transient download failures without another version check. Integrity failures remain errors and are never suppressed or automatically retried.

## Verification

Unit coverage includes reset recovery, API fallback, persisted partial bytes, range validation, servers ignoring Range, stalled bodies, checksum rejection, and Windows download-promise rejection and retry. The real Electron test confirms a second request starting at byte 32768 and exact output bytes. The release workflow runs that test on both platforms alongside its existing media and updater checks.

A live Electron probe against the published 0.1.22 installer resumed its saved 4,766,595 bytes through GitHub's asset API. The response was HTTP 206 with `Content-Range: bytes 4766595-235300992/235300993`, confirming the official endpoint supports the actual resume request. The full 235 MB transfer was not completed on the slow local connection.

## Risks

The cause of an upstream network reset cannot be established from the reported message alone. Repeated resets, outages, or extremely slow connections can still exhaust the bounded retries; the Mac downloader keeps verified-by-final-digest partial progress for the next attempt. A live download probe reached the published GitHub asset but was slow on the local connection, so deterministic interruption tests provide the recovery proof.

Older installations still contain their previous updater. If an older updater cannot fetch 0.1.23, installing its GitHub installer manually once is required to obtain the recovery changes.
