---
summary: "Opt-in OCR usage from local response events, with bounded metadata reads and a persistent numeric cache."
ids: [open-code-review]
read_when:
  - Changing OCR usage parsing, cache checkpoints, or local source discovery
---

# Open Code Review

## Identity and ids

`open-code-review` is a local usage client, disabled on fresh installs. Enable it in Settings → tools or append `open-code-review` to `TOKEN_MONITOR_CLIENTS`. `ocr` and `opencodereview` normalize to the same client. OCR's configured model provider does not make its usage Codex account usage.

## Data sources

The adapter reads `~/.opencodereview/sessions/*/*.jsonl` on the host. Only `llm_response` events with recorded `usage` contribute tokens. Response `uuid` deduplicates repeated events and copied session files. Event timestamps determine local calendar days and months. The adapter uses the selected all-time start date and supplies daily history through the collector's existing history path.

OCR v1.12.12's native Anthropic and OpenAI response resolvers produce `prompt_tokens` that includes `cache_read_tokens` and `cache_write_tokens`. The total is `prompt_tokens + completion_tokens`. Exclusive input is prompt minus both cache components. OCR's generic provider compatibility fallback does not establish the same cache convention; providers with different semantics are unsupported. Cache components greater than prompt fail the scan. The adapter supplies no estimated cost, project, or work duration.

## Invariants and known gaps

The reader streams bounded chunks and projects only top-level usage metadata. It skips response bodies, reasoning, tool arguments and native payloads. The numeric cache lives under `sharedDataDir()/open-code-review-usage`, outside the watched source tree. Each source file has an atomic cache with identity, complete-line offset, a SHA-256 hash of the entire committed prefix, and numeric events. A partial final record remains uncommitted. Truncated or replaced files rebuild their own ledger.

If file identity, size and modification time are unchanged, the adapter reuses cached rows without reading source bytes. A changed or growing file streams its entire committed prefix to validate the hash before parsing the append. A hash mismatch rebuilds the ledger, including middle edits followed by appends. This costs reads proportional to the changed file's existing size; those bytes are hashed without parsing or retaining response bodies. The check assumes ordinary filesystem metadata updates and does not detect deliberate timestamp restoration on an unchanged-size file.

Usage lines over 32 MiB, metadata fields over 64 KiB, numeric caches over 64 MiB, or files with more than 200,000 usage events fail explicitly. A scan also limits source files to 10,000 and unique events to 500,000. Oversized non-usage payloads are skipped without retaining their bodies. Failed or cancelled scans do not publish partial totals. The collector retains its last complete snapshot.

Today's append uses the targeted today delta. A changed historical usage revision forces the existing serial full scan so historical imports or removals also correct month and all-time totals. Only files still in the source tree contribute to live usage. The shared history archive retains daily history according to its existing policy.

The WSL tokscale path does not run this native adapter. To collect OCR inside WSL, run the Node collector there. No remote account or provider API is queried.

## Verification

`node --test tests/shared/openCodeReviewUsage.test.js tests/shared/clientCatalog.test.js tests/shared/clientTracking.test.js tests/shared/clientRegistrationConsistency.test.js tests/shared/clientPartitionInvariants.test.js tests/shared/clientHealth.test.js tests/docs/providerGuidance.test.js tests/docs/readmeConsistency.test.js`

Fixtures cover copied-event deduplication, cached prompt inclusion, partial appends, restart cache reuse, truncation and replacement, middle rewrites followed by appends, bounded payload handling, local date windows, source detection, and collector full/delta totals. Real session totals require a separate comparison with the recorded numeric usage fields.
