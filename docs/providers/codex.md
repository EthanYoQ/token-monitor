---
summary: "Codex provider notes: rollout metadata/context, OAuth and RPC quota sources, managed workspaces and system-account switching."
ids: [codex]
read_when:
  - Changing Codex session metadata, T3 title lookup, context occupancy or turn state
  - Changing Codex OAuth/RPC limits, managed accounts or workspace identity
  - Changing Codex account activity or its All Time presentation
  - Changing Codex login, system-account switching or reset forecasts
---

# Codex

Codex combines a tokscale-backed usage client, local rollout enrichment and a multi-account limits provider. Keep those data planes separate even though they share the `codex` id.

## Optional account activity

When enabled in Settings, the app can read `tokscale codex activity --json`, backed by Codex app-server `account/usage/read`, every 15 minutes. The validated lifetime total is saved under the hashed live account identity and replaces local Codex in the **All Time display projection** once the daily buckets add to that lifetime total and the selected start date covers them. It is never uploaded as per-device usage, assigned to a model/project/session, or added on top of local Codex. Device, model, project and cost details remain local and need not add up to the account total. Other periods and daily history remain local because the account API does not document bucket timezone semantics. A fresh, fully covered single-account reading also raises the Trends consecutive-day count when its positive daily buckets exceed the local streak; the last active bucket may be today or yesterday, accounting for the source's day boundary. A stale or unverified reading leaves the local streak in place. If another synced device contributes Codex or multiple logins have been observed locally, the account overlap is unknown and the projection retains the original aggregate. A lower lifetime reading requires a matching second live read; an older timestamp is ignored. A reading older than one hour is marked stale and is only the last known total.

The account total is disabled by default. The user can enable it in Settings after verifying that local Codex history belongs to the current login.

## Session metadata and context

`sessionMetadata.js` joins rollout sessions to Codex's thread databases and, for T3 Code sessions, T3's own thread catalog. T3 drives the same harness but stores generated titles separately; a Codex-only lookup can otherwise fall back to the first user message. Attachment markup and agent boilerplate are stripped before display. Background reviews keep their `sessionKind` rather than masquerading as ordinary chats.

`sessionContext.js` reads the newest rollout `token_count` event. `info.last_token_usage` is current occupancy and `info.model_context_window` is the actual per-session capacity; cumulative `total_token_usage` is never occupancy. The reader uses bounded tail windows and returns no gauge when the newest event is beyond them. Turn-end detection grows through bounded tail windows up to its cap. Both caches invalidate on size and mtime.

Do not replace the transcript-reported window with a model table. User configuration can change the window for the exact sessions being measured.

## Limits sources

The live account normally reads the ChatGPT/Codex backend with the current `auth.json`. The configured `chatgpt_base_url` selects the matching backend path family. The app-server RPC path is a fallback, not an interchangeable authority.

For a managed account, RPC output is usable only when the isolated auth snapshot is scoped to that account's selected workspace. Otherwise the explicitly scoped OAuth request must succeed. A transient OAuth failure may use a correctly scoped RPC reading; an unscoped live RPC must never be published under a managed workspace.

The live system account stays visible alongside enabled managed accounts. Composite identity keeps same-email workspaces distinct while collapsing the live and managed observation of the exact same login. Managed-account hydration must preserve local collisions rather than silently coalescing them.

Reset-credit data supplements quota when available. Empty quota can receive one bounded retry for plans expected to expose windows; do not turn absence into zero.

## Login and account switching

Only allowlisted `auth.openai.com` authorization/device URLs may be opened from CLI output. Command discovery and Windows quoting are part of the provider contract because Store/npm installations resolve differently.

Switching the system account rewrites the live auth material for the selected workspace. The write is atomic and identity-checked; UI controls serialize the operation and refresh only after it settles. Managed credentials remain in the main-process store.

## Reset forecast

The optional reset forecast is display enrichment from `codex-resets.com`, not quota authority. It has independent success/error cache durations and bounded fetch time. A forecast failure must not alter the provider's real windows.

## Verification

Run the Codex session, limits, login and account-switching tests when changing this note's scope:

```bash
node --test tests/shared/codex*.test.js tests/shared/limitCollector.codex*.test.js tests/shared/sessionContext.test.js tests/electron/codex*.test.js
```
