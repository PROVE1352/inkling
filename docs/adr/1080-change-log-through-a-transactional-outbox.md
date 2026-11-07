# 1080. Change log through a transactional outbox: one writer per database, no request-wide queue

- Status: Accepted
- Date: 2026-11-07
- Amends: [0932](0932-change-feed-cursor.md) (Ordering, high-water mark, Trade-offs)

## Context
`changes_since` (ADR 0932) uses `page_changes.seq` as a high-water cursor: a reader that saw seq N
must never later find a committed row ≤ N. Postgres hands out `bigserial` values at insert time and
commits in a different order (T1 takes seq 10 and is still open, T2 takes 11 and commits; a reader
stores 11 and skips 10 forever). ADR 0932 made seq order equal commit order with one process-wide
promise chain (`serialized`, old changeLog.ts:63): every change-log write and every cursor
reservation queued behind every other one, each statement in its own autocommit.

That cost showed up in the v0.1.0 → v0.2.0 regression report (item 5): the title PATCH route awaits
`logPageEvents`, so at 16 concurrent writes p50 rose +75–183%, and a write in one workspace waited for
the change-log writes of every other workspace. The chain is also in-memory: a second process
writing `page_changes` would break the cursor (KNOWN-ISSUES CF-1), and a crash between a page's
chunk rewrite and the change-log write lost that change for good (the next reindex sees no diff).

## Decision
**Writers queue, one consumer materialises.**
- The section index writes ONE row into `outbox` (topic `change`, `db/schema-outbox.ts`) in the
  same transaction that rewrites `page_chunks` (`chunkIndex.ts` → `recordSectionChanges(delta, tx)`
  in a savepoint, so a failed log write still never fails the index). The payload is the section
  diff computed by the request (`computeSectionChanges`, CPU only), already capped like the stored
  row (16 KB per side, `large` flags), plus what only the request knows: the edit actor and the
  people typing in the page (for "page you follow changed").
- Page routes keep calling `logPageEvents(events, actor)` after their own transaction (signature
  unchanged): one `INSERT … SELECT` that reads each page's workspace, owner and visibility now (log
  time, as before) and writes one outbox row per workspace. `markCreatedVia` queues a `relabel` row
  behind the `page_added` rows of the same request (it used to patch rows that now may still be in
  the outbox).
- The consumer (`runChangeBatch`, `context/changeLog.ts`) takes `pg_advisory_xact_lock(CHANGE_LOG_LOCK)`,
  reads up to 200 pending rows in outbox-id order (`FOR UPDATE SKIP LOCKED`), applies them — merge
  rule, `page_added` once per page, events, relabels — assigns seqs, deletes the outbox rows and
  queues the notification events the section changes cause, all in one transaction. Whichever
  process holds the lock is the only writer of `page_changes.seq` in the database; the lock is
  released after the commit is visible, so the next holder's seqs are larger and seq order equals
  commit order across processes.
- `changed_at` is the log time: `clock_timestamp()` taken after the lock, so it grows with seq
  (the cursor's `at` invariant of ADR 0932 stays exact). It is later than the write by the consumer
  lag (milliseconds, see below).
- Rows of one page are applied in order. A row that fails is retried with backoff (0.5 s × 2ⁿ, cap
  60 s, 10 attempts, then `dead`); later rows of the same page wait behind it, other pages go on.
  The batch runs without savepoints; on an error it is rolled back and redone with one savepoint per
  row so only the failing rows are rescheduled.

**High-water mark in the database.** `change_feed_state.high_water` replaces the in-memory mark.
`reserveCursor` and the consumer serialise on the same advisory lock: under it the reader raises the
mark to `max(seq)` and returns it with the clock, so no merge can be deciding between "read max" and
"raise the mark". The row is created at first use with `max(seq)` (every existing row may be behind
a cursor, like the old boot rule) and survives restarts. The returned end is `greatest(mark, max)`,
so a log whose newest rows were all purged no longer reports a valid cursor as "past the end".

**Waking the consumer.** In-process kick right after a local commit; `LISTEN inkling_outbox` on a
dedicated connection for commits of other processes (`pg_notify` is part of the insert statement,
`'<topic>:<origin>'`, a process ignores its own); a 1 s poll (`OUTBOX_POLL_MS`) as the backstop.
`startOutboxWorker` runs from `index.ts`; shutdown stops it before closing the pool, pending rows stay
for the next boot.

**Lag, stated.**
- `changes_since` (and `GET /api/changes`): **0** for writes that committed before the call. The
  reader first checks for due change rows (one indexed `EXISTS`) and, if there are any, runs the
  consumer itself (up to 20 passes × 200 rows) before reserving its end.
  Test: `outbox.db.test.ts` "changes_since sees a committed change at once, even with no background
  consumer" (consumer disabled; the call materialises and returns the change; same cursor → same
  bytes).
- Other readers of `page_changes` (activity screen, provenance badge / `last_edit`, review scores,
  AI digest): after the background consumer. Upper bound while the process runs: the poll interval
  (1 s) plus one batch; typical: one consumer pass after the commit. Measured: write response →
  row visible p50 1.6–3.7 ms, p95 2.3–8.4 ms, max 4.5–139 ms over 4 runs; another process's commit
  → row 9–10 ms (LISTEN). Test: "the background consumer materialises a write within the poll
  bound" (cross-process, asserts ≤ poll + 500 ms).

**Unchanged behaviour.** Merge window (10 minutes, same visibility, actor and client, only above the
mark; edit-back deletes the unseen row), `via` provenance, the 16 KB/large rule, one `page_added`
per page, the visibility union of `page_visibility` rows, retention, the cursor format and the
reader's fold/budget/determinism. `recordSectionChanges(delta)` and `logPageEvents(events, actor)`
keep their signatures (an optional transaction argument was added).

## Alternatives considered
- **Snapshot-xmin cursor (no consumer):** each request inserts `page_changes` in its own transaction
  together with `pg_current_xact_id()`; the reader only returns rows whose transaction is older than
  `pg_snapshot_xmin(pg_current_snapshot())` and stores (xmin, seq) in the cursor. It removes the
  queue without a background worker and gives exact commit visibility. Rejected because:
  - the feed stalls behind the oldest open write transaction in the whole database (an import,
    a long collab store, a stuck `idle in transaction` session for up to the 60 s pool timeout):
    one slow transaction delays every agent's feed, and the delay is unbounded by our code;
  - the merge rule rewrites the latest row of a section (`UPDATE … SET seq = nextval`). With
    concurrent request transactions two edits of one section race on that row (lost update or a
    serialization failure in the request path), and "only above the high-water mark" needs the
    mark to be an xid position, which a merge cannot move;
  - the request keeps all the change-log work (DISTINCT ON + UPDATE/INSERT, notification fan-out),
    which is what the report measured on the write path;
  - read-your-writes needs the reader to wait for xmin to pass the writer's xid anyway.
  The outbox costs a second write per change and a consumer, but bounds the lag by our own poll
  interval, keeps the merge single-threaded, and empties the request path.
- **Advisory lock around every request's change-log write** (ADR 0932 trade-off): multi-process
  safe, but keeps the global serialisation on the request path — the thing being removed.
- **Per-workspace chains:** removes cross-workspace waiting only, still in-memory and single
  process, and a cursor spans workspaces (a global cursor would again see out-of-order seqs).
- **Logical decoding / CDC (wal2json, Debezium):** commit order for free, but needs replication
  slots, superuser-level setup and an external process; out of proportion for a self-hosted app.

## Trade-offs
- More statements per write (measured: title PATCH 9 → 14 per request, append 31.4–32.0 →
  41.5–41.8), now off the request path: request = one INSERT instead of awaiting SELECT + INSERT.
  At 1 concurrent client nothing is gained; the gain is under concurrency (below).
- `changes_since` does a little more: p50 1.3–2.4 → 3.4–5.0 ms right after a write (existence probe,
  then the lock-serialised reservation).
- The consumer is a single writer per database: a burst of imports is still materialised one batch
  at a time, but nobody waits for it except a `changes_since` call that needs those rows.
- Reads of `page_changes` other than `changes_since` can be a few milliseconds behind a write.
- The outbox row holds the capped before/after texts until materialised (seconds at most).

## Consequences
- REST writes no longer wait for each other's change-log writes. Measured on the v0.1.0 seed
  (production builds, same DB, interleaved runs; docs/PERFORMANCE.md): title PATCH at 16 concurrent
  p50 27.8 → 23.8 ms (−14%), p95 40.6 → 32.4 ms (−20%); a sequential title PATCH in workspace B while
  16 clients write to workspace A p50 71.2 → 44.6 ms (−37%), p95 95.8 → 85.0 ms (−11%). Body append,
  row edit unchanged within noise. Comments got slower (see ADR 1081).
- KNOWN-ISSUES CF-1 (single instance only) is resolved for the change log: ordering is enforced in
  the database.
- Crash safety: a section change commits with its chunk rows; a SIGKILL after the commit and before
  the consumer, or inside the consumer before its commit, is materialised exactly once later
  (`outbox.db.test.ts`, real child processes). Two in-process consumers plus a second process
  racing over 6 pages × 5 rounds produce every row once, and rows at or below every reserved end
  never change afterwards.
- Pending rows are read in numeric outbox-id order (`ORDER BY outbox.id`; ordering by the `id::text`
  output alias sorted "100" before "99" and would have applied two edits of one page out of order
  across a digit boundary — covered by a test that fails on the text order).
- Migration: tables `outbox`, `change_feed_state` (no data migration; existing `page_changes` rows
  stay, the mark is initialised from them at first use).

## References
- apps/server/src/context/changeLog.ts: `recordSectionChanges`, `recordPageEvents`, `recordCreatedVia`,
  `runChangeBatch` / `changePass`, `highWaterAndClock`, `reserveCursor`, `CHANGE_LOG_LOCK`
- apps/server/src/outbox.ts (enqueue, kick/LISTEN/poll, retry policy, purge), apps/server/src/db/schema-outbox.ts
- apps/server/src/context/chunkIndex.ts (outbox row in the chunk transaction), apps/server/src/notify/provenance.ts
- apps/server/src/outbox.db.test.ts, apps/server/src/context/changeFeed.test.ts
- PostgreSQL 16 docs: Advisory Locks; `SELECT … FOR UPDATE SKIP LOCKED`; `LISTEN`/`NOTIFY` (delivered on commit)
