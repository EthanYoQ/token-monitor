# Personal Windows memory validation, 2026-10-31

The installed personal application was updated from 0.63.1-personal.16 to 0.63.1-personal.17. This is a local application update and source backup, not a published installer or upstream release.

## Change and cause

The largest resident process was the Electron browser process, which also contains the usage and filesystem-watcher worker threads. An initial production sample attributed about 420 MiB private memory to that process, 159 MiB to the renderer, 114 MiB to GPU, and 12 MiB to utility. Those samples locate the largest process; they are not the before/after benchmark.

Within collection, the OpenCode Review adapter retained 116,573 numeric row objects as its last-successful fallback and materialized new objects during each validated scan. The new fallback uses exact Float64 timestamp/token columns and a session/model dictionary. Period/history projection iterates those columns without rebuilding row objects. The reader, checksum validation, UUID history revision, deduplication, failure fallback and date boundaries retain their contracts. No extra per-file cache, forced GC, working-set trimming or production refresh delay was added.

A separate Electron representation diagnostic measured approximately 22.01 MiB of net retained heap plus external memory for raw rows and 5.03 MiB for the compact snapshot. It explicitly used forced GC to inspect representation cost. These figures are not whole-application RAM savings; the whole-app trials below used natural GC only.

## Normal-mode whole-app trials

Five alternating runs per version used Electron 43.4.0 / Node 24.18.1, the same cloned warm numeric caches and SQLite snapshot, the same windows and selected clients, and eight successful OCR rescans per run. Each run observed another 60 seconds after the last rescan. Values below are across-run medians, with run ranges in parentheses. Post-rescan values use each run's last 20 one-second samples.

All values are MiB. Private memory sums the four resident Electron processes; worker threads are already included in the browser process and are not counted twice. Short-lived native scanner child-process peaks are outside this metric. Working-set sums can include shared pages and are not unique physical RAM.

| Metric | Before, median (range) | After, median (range) | After minus before |
| --- | ---: | ---: | ---: |
| Rescan sampled peak | 1086.6 (1039.6–1112.8) | 998.3 (967.2–1036.3) | -88.3 |
| Rescan time-weighted mean | 967.8 (958.5–1004.4) | 907.0 (900.1–934.0) | -60.8 |
| Post-rescan private memory | 627.5 (590.5–824.7) | 687.7 (589.0–748.8) | 60.2 |
| Post-rescan working set | 679.7 (649.9–880.2) | 738.0 (668.4–808.0) | 58.3 |

Rescan peaks and means decreased in these observed runs. The post-rescan normal-mode result does **not** establish lower idle RAM: live Codex input changed and non-OCR targeted background collections continued at different times and counts. The unfavorable raw result is retained above rather than discarded. The shared profile template did not freeze every external source.

## Controlled post-rescan diagnostic

Three additional alternating pairs used the same packages, caches, windows, watchers and eight OCR rescans. Only the measurement harness set watchTriggersCollection=false and interval/history cadence to ten minutes. Watcher threads remained active. Diagnostics required no in-flight or newly completed collection throughout the post-rescan window. Production options were unchanged. This measures post-rescan retention with background collection triggers isolated; it does not represent every production activity pattern.

| Metric | Before, median (range) | After, median (range) | After minus before |
| --- | ---: | ---: | ---: |
| Rescan sampled peak | 1003.2 (981.1–1043.3) | 1010.5 (996.8–1011.9) | 7.3 |
| Rescan time-weighted mean | 910.0 (910.0–942.8) | 905.4 (905.3–909.7) | -4.6 |
| Post-rescan private memory | 587.4 (576.8–594.2) | 567.3 (563.8–575.2) | -20.1 |
| Post-rescan working set | 648.1 (642.5–654.5) | 641.0 (629.1–643.2) | -7.1 |

## Correctness, package and backup

- Full npm run verify: lint passed; 5,347 tests passed, 8 skipped, zero failures. It ran in an isolated source copy to avoid linting nested worktrees. npm run update:hub-build also completed without generated drift.
- Independent review found no blocking issues. An additional 4,800 old/new period and history comparisons passed across three timezones; cancellation and late completion were checked.
- Every whole-app run completed all eight rescans without an application error. Each OCR read returned the same row count and four token-component totals. Fresh full collection completed. This is OCR equivalence, not a new independent audit of every provider's live totals.
- Installed package SHA-256: b7ff88ff9466587567a67fb80d1cef8f69042e3e4dcf97e6c55c903b5ab472ec. All 355 source/package files were read back and matched the exact personal-source manifest. The 78 unpacked native files were unchanged. The previous local package is retained for rollback.
- personal-build/source-0.63.1-personal.17.zip contains exact personal src/ and package.json. It preserves personal window/presentation additions that differ from the normal source tree. It excludes user profiles, credentials, usage records, logs, dependencies and native binaries.
- The backup also includes the previous cloud-observation and small snapshot/detail-retention fixes. Cloud observations remain per-thread official values with observed deltas and separately undated gaps; they are not asserted to be complete account-wide cloud history.

The adjacent JSON file contains sanitized numeric measurements only. Local raw measurement files, account data and screenshots are excluded from the GitHub backup. This report establishes local verification; it does not claim GitHub CI or release qualification.
