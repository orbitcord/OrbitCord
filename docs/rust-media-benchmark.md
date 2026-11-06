# Rust media migration — 6 November 2026

Branch: `codex/rust-media-processing`. Baseline: `d2af058348d0ffd8dcdc2909292016ea5c649632`.

All five proposed areas now have Rust-backed production paths. The complete migration is an experiment: the measurements favor selective adoption over shipping every part.

## What moved

- Image sanitization: lossless JPEG, PNG/APNG, WebP and GIF filtering, CRC checks, orientation preservation, and metadata removal. A short-lived Rust job replaces the JS worker.
- GIF encoding: histogram construction, median-cut palette, nearest-color lookup, changed-frame regions, and LZW. Chromium still decodes frames and renders captions. Frames cross binary IPC individually; conversions queue without retaining every frame.
- MP4 assembly: fragmented MP4 header parsing, track/duration rewriting and streaming copies. Dedicated Rust jobs support cancellation without blocking window state or notifications.
- Attachment/ZIP inspection: native file inspection, archive directory parsing, ZIP64 preview entries, CP437 decoding, and bounded deflate preview decoding. The browser retains range fetching and the preview interface.
- Temporary media storage: Rust creates, opens, reads, writes, stats and removes temporary files/directories for media caches, source files and attachment jobs. It removes owned directories on graceful pipe EOF. JS retains network requests, ownership checks, cache eviction/read leases, cancellation coordination and Electron protocol adapters. Network writes batch within approximately 1 MiB to bound IPC overhead.

The original JS algorithms remain available for isolated browser fixtures and comparison. The app configures the native implementation automatically. Electron windows/settings/Discord hooks and the existing FFmpeg compression orchestration remain JavaScript.

## Operation measurements

Apple M4 Max, macOS arm64, release Rust with the existing size-optimized release profile. Eleven measured repetitions after two warmups, alternating implementation order. Includes process startup where used and binary IPC. Background applications, including a CPU-heavy game during parts of the run, were present; treat absolute timings and small differences as approximate. The harness was not run concurrently with our builds/tests during the final measurements.

| Operation / input | JavaScript median | Rust median | Result |
| --- | ---: | ---: | --- |
| Image metadata, valid random-pixel PNG ~8 MiB | 305.5 ms | 76.1 ms | 4.01× faster |
| GIF, 30 synthetic RGBA frames at 240×135 | 288.2 ms | 124.4 ms | 2.32× faster |
| MP4 remux, padded 64 MiB video plus audio | 61.1 ms | 51.6 ms | 1.18× faster |
| Attachment inspection, ZIP with 5,000 entries | 5.9 ms | 7.9 ms | 33% slower |
| ZIP preview directory, 5,000 entries | 3.7 ms | 9.4 ms | 2.56× slower |
| Temporary storage, 32 MiB write/read/delete in 1 MiB chunks | 27.2 ms | 95.1 ms | 3.50× slower |

A combined workload runs one of each operation sequentially. Seven alternating repetitions measured **716.1 ms → 363.0 ms: 1.97× faster, or 49% less elapsed time**. This is a defined fixture workload, not a measurement of the entire Discord app running twice as fast. Browser frame decoding is excluded from this synthetic GIF benchmark; real Electron decoding/caption parity is covered separately.

Raw samples: `output/rust-media-benchmark.json`.

## Complete playback and app resource measurements

A separate five-repetition workflow streams three 64 MiB fixture videos through the actual social-post download, remux, cache and first-byte path. Median elapsed time is **649.7 ms → 849.8 ms: 31% slower**. Small file-I/O pipe round trips and extra copies outweigh the MP4 parser improvement. Batching network writes improved the first experimental version, which had taken 1.27 s versus 0.70 s in its own comparison.

`output/rust-playback-preparation-benchmark.json` includes CPU and RSS deltas for the **Node parent only**. Those fields omit Rust-child CPU/memory and cannot support a claim of total CPU or RAM savings.

A separate real Electron fixture benchmark launches each variant three times, plays twelve short clips, then samples idle resource use. Both variants use the same compiled native executable for the unchanged notification/window-state command mode; only the current app invokes the new media modes.

| App measurement | Baseline | Rust branch |
| --- | ---: | ---: |
| Median launch-to-fixture-load | 419.6 ms | 431.0 ms |
| Median inline playback first-frame latency per run | 8.2 ms | 8.4 ms |
| Median sampled Electron idle CPU | 0.32% | 0.45% |
| Median process-memory sum after playback | 428.9 MiB | 439.2 MiB |

The memory sum is Electron's sampled process working sets plus separately sampled native-child RSS, per run, then median across runs. It is a process-memory estimate, not unique physical memory: shared pages can be counted more than once. The Rust branch retains an additional media service after first use. No startup, idle-CPU or overall RAM improvement is established; the extra memory is approximately **10.4 MiB** in this fixture. Cold-launch variation was substantial, so the small startup difference should not be interpreted as significant.

Raw samples: `output/rust-app-after-media-benchmark.json`.

## Validation and diagnosis trail

- 78 Node tests with `LOWCORD_NATIVE_MEDIA` set to the release executable: passed. Covers native/JS parity, all existing attachment-inspection cases, malformed image mutations, archive limits, MP4 output, cancellation, leases, media sources and uploads.
- 37 Chromium privacy, GIF caption and concurrency tests: passed.
- Five real Electron tests: passed, including native image orientation, GIF byte parity and decode, caption overlays, concurrent conversions, size-limit cleanup, attachment inspection and MP4/AAC playback.
- Four existing Rust backend tests: passed; release build and `git diff --check` passed.
- Fixed build failure: tempfile's prefix needs `&str`, rather than `&Cow<str>`.
- Fixed sandbox integration failure: canvas pixels are `Uint8ClampedArray`; the IPC validation originally accepted only `Uint8Array`.
- Fixed large-directory response failure: 5,000-entry JSON listings exceeded the original 64 KiB response-header bound. Results are bounded separately from requests, and preview entries serialize directly instead of allocating JSON trees per entry.
- Fixed ZIP inspection allocation overhead: extension checks originally allocated lowercase strings repeatedly inside the extension loop. They now compare borrowed suffixes without allocation; CP437 decoding no longer builds a lookup vector for each name.
- Addressed playback regression source: per-64 KiB pipe writes dominated disk I/O. Bounded write batching reduced that overhead; the remaining regression is reported above.

Risks: only macOS arm64 was executed here. Windows/Linux implementations use portable Rust/std and Node APIs but still need destination-platform verification. Heavy ZIP/GIF work and temporary-file commands share one lazily started media service; notifications/window state use a separate process. The full experimental branch increases IPC and post-use memory. Keep image/GIF processing and evaluate MP4 on representative real files; prefer the existing Node storage and browser ZIP preview for a performance-focused release.

## Reproduce

Create a source snapshot of baseline commit `d2af058348d0ffd8dcdc2909292016ea5c649632` at `/tmp/lowcord-rust-baseline` (the performance harness supplies its build dependencies), then run from the branch:

```sh
node scripts/build.mjs --release
node scripts/bench-rust-media.cjs /tmp/lowcord-rust-baseline
node scripts/performance.mjs --scenario=media --baseline=/tmp/lowcord-rust-baseline --iterations=5 --clip-mib=64 --output=output/rust-playback-preparation-benchmark.json
node scripts/performance.mjs --scenario=idle --exercise-media --baseline=/tmp/lowcord-rust-baseline --iterations=3 --idle-seconds=3 --output=output/rust-app-after-media-benchmark.json
LOWCORD_NATIVE_MEDIA="$PWD/src-tauri/target/release/lowcord-native" node --test tests/native-media.test.cjs tests/native-image.test.cjs tests/reddit.test.cjs tests/redgifs.test.cjs tests/video-attachments.test.cjs tests/media-sources.test.cjs tests/privacy-files.test.cjs tests/zip-preview.test.cjs
pnpm test:native
pnpm exec playwright test tests/gif-captioner.spec.mjs tests/efficiency.spec.mjs tests/privacy.spec.mjs
pnpm exec playwright test --config playwright.electron.config.mjs -g 'privacy image processing|Rust GIF encoder|native attachment download inspection|RedGIFs opaque|real Electron decodes'
```

The standalone `scripts/bench-native-image.cjs` can also compare image sizes and cold-job RSS on macOS. It labels the JS host+worker and Rust-child measurements separately; those are not whole-app memory totals.
