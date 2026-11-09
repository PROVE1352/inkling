# 1537. catch_up markers move to their own table

- Status: Accepted (supersedes ADR 1522)
- Date: 2026-11-09

## Context
ADR 1522 kept the "last catch_up" marker in `plugin_storage` under a reserved plugin id, because the
wave that added `catch_up` had no schema change. This wave owns one.

## Decision
- `catch_up_markers (user_id, key) → cursor, seq, at, updated_at`; keys are unchanged
  (`grant:<id>`, `token:<id>`, `person`, each with `:<workspaceId>` when limited to a workspace).
- "Never backwards" is a column compare (`WHERE catch_up_markers.at < EXCLUDED.at`) instead of a
  JSON field cast.
- Migration 0041 copies the `inkling:catch_up` rows with a readable JSON object and a string cursor
  (the JSON cast is guarded with `pg_input_is_valid`), then deletes every row of that plugin id.
  Rows that cannot be read are dropped; they were unreadable for `readMarker` too.
- The upgrade test (scripts/upgrade-test/run.sh) allows `plugin_storage` to shrink by exactly the
  number of those rows.
- In the same step the header's date-dependent part moves to the end (ADR 1543): the second line
  says `N due (M overdue)` and the window end is the line `due window: up to <date>` right before
  `next since:`, so the header stays the same from day to day while nothing happens.

## Alternatives considered
- **Keep ADR 1522**: works, but the marker shares a quota table and a JSON format with plugins for
  no reason now.
- **A column on `oauth_grants`**: API tokens and the per-person and per-workspace markers would
  still need somewhere else.

## References
- apps/server/src/catchUp.ts (`readMarker`, `storeMarker`), apps/server/drizzle/0041_v012_suggestions_leases.sql
