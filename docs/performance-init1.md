# CPU and memory audit: init1

Implemented on branch `init1`, measured on 6 October 2026. The baseline is the working source captured immediately before these changes, including the user's pre-existing local edits. No commit or installed-profile migration was performed.

## Implemented plan

1. **Chat updates:** cache timestamps by surface and timestamp value; precompute foreground colors; compare cheap message inputs on MessageStore events; refresh changed rows and adjacent group boundaries; read row widths before style writes. Removed and recycled rows release their cached entries. Resize, settings, channel, user, locale, avatar, and rich-content changes still reconcile. New rows retain synchronous styling before paint.
2. **Playback memory:** download Reddit DASH playback streams directly to private temporary files with backpressure; parse and rewrite MP4 headers without loading media payloads into memory; serve byte ranges through bounded streams. Keep three completed clips, deduplicate requests, limit production to two simultaneous clips, lease files during reads, and clean up on eviction/shutdown. A writable-volume failure uses the existing buffered fallback. Native upload and attachment handling stays intact.
3. **Startup and DOM work:** traverse webpack exports once per polling batch, share pending named-store lookups, and cache discovered stores. DOM listeners receive bounded batches of mutation records and can unsubscribe; composer, iframe, and settings consumers skip unrelated records. Load electron-updater when Windows updates or updater tests need it.
4. **Verification:** add repeatable chat, media, startup, idle, first-frame, and visual benchmarks via `pnpm bench:performance`, plus cancellation, range, eviction, module-cache, DOM lifecycle, row-reuse, and real Electron playback coverage.

## Measured results

Apple M4 Max, arm64 macOS, 64 GiB RAM; Node 22.23.2, Electron 44.5.1, Chromium 153.0.8010.12. These are local fixture measurements. They quantify the changed paths, rather than total CPU/memory savings for a logged-in Discord session. Baseline/current order alternates between repetitions. Tables show medians of the per-run measurements.

### Chat: one edited text message per update

Three paired runs per row count, 30 edits per run; timestamps enabled, alternating authors, 1000 × 800 viewport. “Script time” is the renderer's CDP ScriptDuration delta across the workload; refresh durations include synchronous layout caused by refreshes. Runtime timing instrumentation is applied equally to both sources.

| Loaded rows | Median refresh, before → after | Reduction | Per-run p95, before → after | Script time for workload, before → after |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 5.6 → 1.5 ms | 73.2% | 7.5 → 2.1 ms | 145.6 → 26.1 ms |
| 200 | 8.6 → 2.6 ms | 69.8% | 9.4 → 3.2 ms | 245.6 → 43.4 ms |
| 500 | 14.3 → 4.7 ms | 67.1% | 14.6 → 6.1 ms | 414.9 → 77.5 ms |

The idle extension refresh count was zero in every run, before and after. DOM hashes matched for every paired workload. Heap snapshots were not forced-GC retained-memory measurements, so no chat heap reduction is claimed. Row caches add state in exchange for less work and are pruned when rows disappear.

### Playback: three 64 MiB synthetic clips

Five paired runs in fresh Node processes. The fixture streams 64 KiB chunks and pads a real H.264 DASH sample's mdat payload; audio is a small real AAC DASH sample. Both implementations use the same resolver, download limits, mux logic, and range request. This is a controlled stress workload without network latency. Peak RSS is the process high-water increase over its initial high-water mark; ArrayBuffers are a GC-collected process delta, not total app RAM.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Peak RSS increase | 456.8 MiB | 173.0 MiB | 62.1% lower |
| Retained ArrayBuffers | 192.08 MiB | 0.065 MiB | 99.97% lower |
| Total preparation wall time | 84.0 ms | 140.7 ms | +56.8 ms |
| Total process CPU time | 146.9 ms | 255.5 ms | +108.6 ms |

The media change trades extra disk I/O and one-time preparation CPU for much smaller retained memory. It is a memory optimization; the measured CPU improvement comes from chat updates. Temporary source files are removed after successful muxing; cached playback files are removed on eviction or shutdown. The mux copy buffer is 1 MiB; downloads and range responses use 64 KiB watermarks with byte-counted web-stream queues. Allocators may retain released pages, so RSS does not fall to the buffer watermark.

### Real Electron startup, idle, and playback

| Metric | Before | After |
| --- | ---: | ---: |
| Local startup to renderer load | 343.7 ms | 323.9 ms |
| Idle Electron CPU, summed reported percentage | 0.522% | 0.518% |
| Idle Electron working set, summed | 362.8 MiB | 353.9 MiB |
| Small-video first-frame median | 8.6 ms | 8.7 ms |
| Small-video per-run p95 first frame | 172.1 ms | 190.4 ms |

Startup/idle use three paired clean-profile launches and a minimal local renderer with the production preload. Idle means ten one-second samples after warmup; no idle CPU improvement is claimed at this noise level. Working sets can count shared pages more than once and exclude the Rust child; the child stayed around 10 MiB in both versions. The updater remained unloaded in all current macOS benchmark launches and loaded in all baseline launches. Startup was 5.7% faster in this workload. These results do not establish the same percentage on Windows, where the packaged updater still loads when required.

First-frame timings use three paired Electron launches, twelve distinct small H.264/AAC fixture clips per launch, and requestVideoFrameCallback. The per-run p95 includes cold decoder startup. The median per-run p95 increased by 18.3 ms, within the planned 50 ms local fixture allowance. The 64 MiB stress workload's preparation overhead is reported separately above; network and large-video first-frame latency are not established by the small fixture.

## Aesthetics and functionality

- Eight before/after combinations: bubbles/avatars × dark/light × 520/1000 px. All PNG bytes and timeline DOM hashes were identical, including timestamp edits and appended rows. New rows were styled before their first animation frame.
- `pnpm test`: **129 passed**. The strengthened avatar-source assertion also passed separately after the final test edit.
- `pnpm test:electron`: **8 passed**, including actual file-backed H.264/AAC decode, duration, seek, native IPC, media formats, and the updater interaction flow.
- `pnpm test:native`: **3 passed**; profile/icon Node tests: **4 passed**. Final cache/mux/concurrency tests: **6 passed**.
- File mux output matches the original mux byte-for-byte. Range, suffix, invalid-range, temporary-volume fallback, duplicate requests, leased eviction, response cancellation, queued production shutdown, and empty-cache cleanup are covered.
- Existing Icon/photo-upload feature assertions were brought up to date. The clipboard test now handles clipboard items with no exposed MIME types. Existing local appearance CSS and unrelated edits were preserved.

Windows and Linux execution, real network failure behavior, and logged-in Discord voice/streaming workloads still need platform measurements. No GPU switches, codec changes, visual simplifications, or feature-disable defaults were introduced.

## Reproduce

Build once with `pnpm prepare`. To compare two source versions, save an independent copy or checkout of the earlier version containing `electron/` and `src-tauri/injection/`, including its local edits. The harness builds each preload, shares the current dependencies/native binary, uses temporary clean profiles and a local server on a free port, and leaves the installed Discord profile alone.

```sh
pnpm bench:performance --scenario=chat --iterations=3 --baseline=/tmp/lowcord-init1-baseline --output=/tmp/lowcord-chat.json
pnpm bench:performance --scenario=media --iterations=5 --baseline=/tmp/lowcord-init1-baseline --output=/tmp/lowcord-media.json
pnpm bench:performance --scenario=idle --iterations=3 --baseline=/tmp/lowcord-init1-baseline --output=/tmp/lowcord-idle.json
pnpm bench:performance --scenario=playback --iterations=3 --baseline=/tmp/lowcord-init1-baseline --output=/tmp/lowcord-playback.json
pnpm bench:performance --scenario=visual --baseline=/tmp/lowcord-init1-baseline --output=/tmp/lowcord-visual.json
```

Use `--scenario=all` for the complete run, or omit `--baseline` to record the current app. Run benchmarks without concurrent tests. Optional controls: `--rows=50,200,500`, `--clip-mib=64`, and `--idle-seconds=10`. Keep the same machine/runtime/fixtures between versions; raw measurements are recorded even if a benchmark fails.

Raw results, source hashes, and all sixteen comparison PNGs are saved in `benchmarks/init1/`: `chat.json`, `media.json`, `idle.json`, `playback.json`, `visual.json`, and `manifest.json`. The original working-source snapshot remains at `/tmp/lowcord-init1-baseline`; preserve it elsewhere before temporary-directory cleanup if an exact rerun is needed. Source paths and hashes in each JSON describe the version used by that scenario.
