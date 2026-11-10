# 2320. Row numbers in bulk inserts: the counter bump goes to this transaction's newest collection row

- Status: Accepted
- Date: 2026-11-10

## Context
Unique IDs (ADR 2140) are assigned by the `pages_row_number_ins` / `_move` triggers of migration 0051:
`UPDATE collections SET row_seq = row_seq + 1 WHERE page_id = NEW.parent_id AND fields @> '[{"type":"uniqueId"}]'`
for every new row. Inside one transaction each bump leaves a dead version of the same `collections` row
behind (not yet prunable: the transaction is still open). The next bump enters through `collections_pkey`,
which points at the first version, and follows the update chain to the newest one, so the n-th row of a
transaction walks n − 1 versions. A bulk insert of N rows under one ID collection in one transaction is
quadratic: sheet sync's shape (all new rows in one transaction, 1,000 rows per INSERT) took 41.1 s for
50,000 rows, its 50th statement 1,460 ms against 95 ms for the first. Imports of large Notion or CSV
databases and template instantiation have the same shape at smaller sizes. Parents without an ID field
pay one failed index probe per row and are not affected.

## Decision
Migration 0058 (`0058_row_number_tid.sql`, hand-written, `drizzle-kit generate --custom`) replaces only the
body of `inkling_row_number()`; no table, index or trigger definition changes.
- After a successful bump the function stores `'<parent id>@<ctid>'` in a transaction-local setting
  (`set_config('inkling.row_seq_at', …, true)`): the parent it bumped last and where that newest version is.
- The next row under the same parent first runs the same UPDATE by `ctid` with the same WHERE (`page_id`
  and the ID test kept), so it reaches the newest version directly. The setting is reset at commit and
  rollback and restored on a savepoint rollback.
- A note that no longer points at a live version of that row (this transaction updated the row again,
  e.g. the backfill trigger, a fields change, or a bump under another parent replaced the note) matches
  zero rows, and the function falls back to the 0051 lookup. Same UPDATE, same row lock, so the
  serialization of parallel creates and the "counter only grows" guarantees of ADR 2140 are unchanged.
- Result (same machine, Postgres 16 in Docker): 50,000 rows in 50 statements 41.1 s → 3.7 s (trigger
  disabled: 1.9 s); statement 50 1,460 → 92 ms. Single-row creates: insert p50 5–6 ms either way; the trigger's own
  time under an ID collection is ~10 µs higher (76–162 → 85–170 µs per row across three runs: reading and
  writing the setting), unchanged under plain parents. The concurrency checks of 0051 (parallel creates on five connections, deletes, moves,
  savepoint rollback, same-transaction add/remove of the ID field, alternating parents) give the same
  results as before. `collectionQuery/rowNumberBulk.db.test.ts` fails when the last statements of a
  20,000-row transaction cost more than three times the first ones (0051: 4.5x, 0058: 1.15x).

## Alternatives considered
- **Also remember "this parent has no ID field"** (`'<parent>@-'`), skipping the lookup for later rows
  under a plain parent. Saves the one index probe per row for folders, but a fields change in another
  transaction that adds the ID between two of those rows is then never seen; making it safe needs a
  `FOR SHARE` lock on the collection row (measured 6.2 s for the 50,000 rows instead of 3.7 s) and a
  reset in the backfill trigger. Not worth it for a probe that costs microseconds.
- **Check with a SELECT first** (EXISTS, then UPDATE only for ID collections): same chain walk for the
  UPDATE; it only helps parents without an ID.
- **Number rows in application code after the insert** (one UPDATE … FROM generate_series per batch):
  thirteen insert paths again (ADR 2140); the trigger stays the single assignment point.
- **A sequence per collection**: DDL per collection, and rolled-back numbers would show as gaps.

## Not changed (known)
A row inserted by a transaction that runs concurrently with a fields change adding the ID field to its
collection may stay without a number: if the insert's UPDATE runs before the fields change commits, it
sees no ID field and matches nothing; the backfill of the fields change does not see the uncommitted rows.
Measured: three rows inserted while the "add ID" transaction was open got no number; five rows of an
open insert transaction around a committed fields change got two numbers. This is how 0051 behaves too
(ADR 2140 is corrected), see KNOWN-ISSUES. Fixing it needs the share lock above on every row under a
plain parent.

## References
- apps/server/drizzle/0058_row_number_tid.sql, 0051_v017_collection_rows.sql
- apps/server/src/collectionQuery/rowNumberBulk.db.test.ts, rows017.db.test.ts
- ADR 2140 (unique IDs from a trigger)
