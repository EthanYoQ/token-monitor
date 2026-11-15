---
summary: "Read Pagekin model usage from trusted generation attempts, with optional project folders."
ids: [pagekin]
read_when:
  - Changing Pagekin source discovery, counters, or archive backfill
---

# Pagekin

## Identity and ids

Enable the `pagekin` usage source under tracked tools.

## Data sources

The adapter follows the completed Pagekin data migration receipt to its active recent-projects list. You can also add Pagekin project folders under custom scan paths. The adapter opens each project's `.ai-novel/project.db` read-only and reads the model, timestamp, and numeric usage from trusted generation receipts.

## Invariants and known gaps

The adapter counts each attempt ID once across all databases. Conflicting receipts for the same ID mark the scan as failed. The adapter skips frozen attempts from portable project transfers. It uses the provider's total to determine whether reasoning tokens are already included in completion tokens.

Coverage requires a retained, trusted generation receipt in a discovered project. Pagekin billing data and derivative call logs such as `llm_calls` are outside this scope. Enable the usage archives to retain observations after projects disappear.

Day, month, all-time, and history views use the same attempt timestamps. The collector watches SQLite database and WAL updates. Changes to older receipts trigger a full period scan. On a read failure, the collector marks Pagekin as failed and reuses the most recent valid snapshot available. After midnight, the collector assigns saved attempts to the current periods using their original timestamps.

## Verification

Run `node --test tests/shared/pagekinUsage.test.js`.
