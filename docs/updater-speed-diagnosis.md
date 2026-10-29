# macOS updater download speed diagnosis — 2026-10-29

## Findings

The installed `/Applications/OrbitCord.app` reports version 0.1.21, and its process is running from that bundle. The latest GitHub release is 0.1.24. Its universal DMG is 234,069,372 bytes. During inspection the app's partial DMG grew from 391,936 to 588,544 bytes, then stayed at 588,544 bytes for at least 69 seconds (file modification age). No app restart or live updater operation was triggered during diagnosis.

Bounded transfers on this Mac reproduce slow delivery outside the updater:

| Client / route | Bytes received | Elapsed | Average decimal KB/s |
| --- | ---: | ---: | ---: |
| curl, direct GitHub download | 1,660,910 | 25.01 s | 66.4 |
| curl, fresh official asset API redirect | 746,039 | 20.09 s | 37.1 |
| Electron net.fetch, direct download | 1,412,654 | 20.00 s | 70.6 |
| Electron net.fetch, fresh official asset API redirect | 1,169,408 | 20.00 s | 58.5 |

Requests used a bounded first-8-MiB Range and a 20–25-second measurement deadline; each returned HTTP 206. Electron tests used an isolated temporary profile and consumed response bytes without the updater's hash/file/progress pipeline. The two Electron routes were measured sequentially; some initial curl/probe activity overlapped, and the user's updater may also have been active. These are short local samples, not controlled ISP/CDN attribution or long-run throughput guarantees. The API route was not faster in these samples.

The similar direct curl and raw Electron rates establish that slow delivery is reproducible without OrbitCord's update UI or file-writing pipeline. This evidence cannot distinguish GitHub's asset CDN from ISP routing, local connectivity, or per-connection network effects. GitHub's status summary reported API requests operational and no release-download incident; an unrelated Copilot incident was present. Status pages cannot rule out regional delivery issues. Source: https://www.githubstatus.com/api/v2/summary.json .

## App behavior that makes this worse

- The 0.1.21 downloader has a 30-minute total request timeout, but no no-progress timeout, retries, or resume. Errors delete the partial file. A stalled connection can therefore leave the UI waiting, and retrying starts over.
- Versions 0.1.23 and 0.1.24 have a 30-second idle timeout, bounded retries, Range resume, and checksum verification. These improve recovery; they do not increase a continuously slow connection's transfer rate. The alternate route is selected on retry/resume, not simply because throughput is low.
- The 30-minute total deadline remains in current code. Downloading 234 MB at 66–71 KB/s would take roughly 55–59 minutes. A sustained average below about 130 KB/s cannot complete a fresh download within that deadline. Current versions retain eligible partial bytes after network timeout for a later retry; 0.1.21 does not.
- Progress is rounded down to whole percentages. Each step requires about 2.34 MB, or roughly 33–35 seconds at the measured direct rates. There is no bytes/speed/ETA or cancel control in settings, so slow or stalled transfers are difficult to distinguish.
- Old installers occupy about 2.8 GB in the updates directory. The volume has about 219 GiB free; storage exhaustion is not the observed cause. No cached files were removed.

## Verification and next steps

All 14 existing updater/release unit checks pass, including idle abort, retries, Range resume, persistence, and checksum rejection. No application behavior was changed for this diagnosis.

Installing 0.1.24 manually once provides recovery fixes to this 0.1.21 installation, but downloading the same asset in a browser is not proven faster. To identify the network owner, repeat the same bounded download on another connection, ideally without simultaneous downloads. For app improvements, expose downloaded bytes/speed/stall state and cancellation, and review the fixed overall deadline for slow transfers. Do not claim retries alone resolve low throughput.

Risks: the running packaged app had no accessible development debugging endpoint, so its internal state/error was not read over IPC. Partial-file observations establish lack of disk progress, not the precise socket state. Measurements do not establish a global GitHub outage or isolate the ISP.

## Shipped fix — 0.1.25

The new Mac downloader removes the fixed overall deadline while retaining the 30-second idle watchdog, bounded retries, Range resume, and final digest checks. It publishes transferred bytes, total bytes, a one-second interval transfer rate, and connecting/retrying/verifying/complete phases. Metrics continue updating without incoming chunks so a stall reports zero speed; timers stop on success and error. Windows forwards electron-updater's existing transfer statistics to the same settings display. Completed downloads retain their transferred/total status.

The release builds separate arm64 and x64 DMGs. Its validation requires both and rejects a universal DMG for that version, because 0.1.20's frozen asset selector prefers universal when present. A regression test executes that original selector against the new release layout for both processor types.

Validation: 17 updater/release checks, both Mac/Windows settings fixture checks, and three real Electron updater checks pass. A slow stream regression verifies nonzero speed before completion, zero speed when waiting, final byte totals and timer cleanup. The new controller test initially used an older release than its installed version, so downloading correctly did not start; corrected its release fixture to 0.1.25. No updater behavior was changed to accommodate the fixture.

Risks: new client recovery/UI improvements take effect after installation. Older clients benefit immediately from smaller matching installers but retain their old timeout and recovery limitations for that first transfer. Actual network throughput still depends on GitHub delivery and the user's connection. macOS continues to require opening the DMG and replacing the app. Speed is the last reporting interval's rate and may fluctuate.

The broader extensions/settings suite passed 33 of 34 cases on its first run. The unchanged media-gallery month pagination case stopped at 16 of 20 tiles under parallel load; it passed immediately in isolation. Both updater UI cases passed in both runs that included them. This release does not change media-gallery code or its test.
