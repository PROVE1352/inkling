# 0306. Google Sheets read sync (experimental): published-CSV pull, key upsert, claim-based locking

- Status: Accepted (experimental, flag `sheets-sync`)
- Date: 2026-11-07

## Context
Teams keep data in Google Sheets and want it mirrored into a collection. OAuth to the Sheets API
would add a Google app registration to every self-hosted install.

## Decision
- The collection stores a "Publish to the web → CSV" URL that must start with
  `https://docs.google.com/spreadsheets/` (zod refine + re-check before every fetch). Fetches go through
  `safeFetch` with `allowedHosts: docs.google.com, *.googleusercontent.com` (Google redirects published
  CSVs to googleusercontent), ≤ 3 redirects each re-validated, 20 MB, 20 s, CSV/text content types.
- Rows are upserted by a key column (or the title column). Missing columns become fields with inferred
  types; select options are added on the fly. Rows missing from the sheet are **kept**. Only changed
  rows are updated (one `UPDATE … FROM jsonb_to_recordset` per 1 000 rows), all in one transaction.
- **Re-entry**: a run starts with an atomic claim
  `UPDATE … SET running_since = now() WHERE page_id = ? AND (running_since IS NULL OR stale > 10 min)`.
  Scheduler, "Sync now" and other server processes therefore never run one sync concurrently
  (a manual run during a run gets 409). The scheduler ticks every minute, runs due syncs sequentially,
  and never overlaps ticks.
- Interval default 15 min, minimum 5. The sync acts as the user who configured it; their visibility
  and membership are re-checked on every run (lost access → error status, nothing written).
- Routes are registered only when `EXPERIMENTAL_FEATURES` contains `sheets-sync`; the UI entry appears
  only when `/auth/mode` lists it.

## Alternatives considered
- **Sheets API with OAuth**: private sheets, exact types, but per-install Google Cloud setup.
- **Postgres advisory session locks**: tied to pooled connections and held during a 20 s network fetch.
- **Delete rows missing from the sheet**: true mirroring, but a truncated/edited sheet could wipe data.

## Trade-offs
Only published (public-by-link) sheets work; the published CSV is cached by Google for a few minutes.

## How others solve it
Notion/Airtable use OAuth Sheets integrations; many lightweight tools (Glide, Softr) support the
published CSV URL the same way.

## Consequences
Status, last error and stats are shown in the sync dialog. Smoke: non-Google URL → 400, interval < 5 →
400, a real (non-existent) published URL reached Google through safeFetch and returned "HTTP 404".

## References
- apps/server/src/routes/sheetSync.ts (`planSync`, `runSheetSync` claim, `startSheetSyncScheduler`)
- apps/server/src/db/schema-collections.ts (`collection_sheet_syncs`)
- apps/server/src/safeFetch.ts, docs/adr/0500-safe-fetch-ssrf-guard.md, docs/adr/0405-experimental-feature-flags.md
