---
summary: "Read Pagekin model usage from trusted generation attempts, with optional project folders."
ids: [pagekin]
read_when:
  - Changing Pagekin source discovery, counters, or archive backfill
---

# Pagekin

Enable Pagekin under tracked tools. The adapter follows the completed Pagekin data migration receipt to its active recent-projects list. It also accepts individual Pagekin project folders in the custom scan paths. Each folder must contain `.ai-novel/project.db`. The adapter opens these databases read-only.

The same settled attempt can appear in the recent-project list, a custom path, an exported test report, and the project's AI call log. The adapter reads one trusted provider receipt per generation attempt ID across all databases. It reads only the model, recorded timestamp, and numeric usage. A portable project transfer's frozen attempts are excluded. Model reasoning tokens are included when the provider total includes them, without adding them again when they are already part of completion tokens.

The adapter does not infer usage from text or import `llm_calls` and external request logs. Model requests without trusted receipts and projects outside the recent list and configured folders are outside coverage. The adapter does not read provider credentials or invoice data. The only reported cost is the shared default for a source with no cost evidence.

Day, month, all-time and graph views use the same attempt timestamps. The collector reacts to SQLite database and WAL updates. If older receipts change, it rebuilds the period anchor. A read failure retains the last successful runtime snapshot when available and reports failed collection. As with other clients, enable the usage archives to retain observations after projects disappear.
