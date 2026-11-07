# 1150. Events in the writer's transaction, NOTIFY after the commit, batched notification consumer

- Status: Accepted
- Date: 2026-11-07
- Amends: [1080](1080-change-log-through-a-transactional-outbox.md) (waking the consumer),
  [1081](1081-notifications-and-webhooks-through-the-outbox.md) (producing, trade-offs)

## Context
ADR 1081 left a window it stated: "events produced by routes after their own commit (`notify`,
`emitWebhookEvent`) are durable from the moment their insert commits; a crash in the milliseconds
between the route's commit and that insert still loses them". The page routes did the same with
`logPageEvents` (best effort, after the transaction, errors swallowed). So a comment, a rename or an
assignment could be written without its event (crash, or a failed insert), and nothing tied the
event to the write the other way round either.

The same ADR accepted a regression: comment POST at 16 concurrent clients p50 12.0 → 16.5 ms (+38%)
and named "batching the enqueue" as the next lever. Before choosing one, the cost was measured
(`apps/server/scripts/comment-post-bench.ts`, docs/PERFORMANCE.md):

- per comment: 1 outbox insert and 1 `pg_notify` (one NOTIFY per request), ~6–7 commits per request
  counting reads, a consumer that runs one pass at a time and could not keep up at 16 clients (the
  outbox emptied 220–250 ms after the last response);
- wait events of the app's connections at 16 clients (pg_stat_activity, sampled every 2 ms):
  `Lock:object` ≈ 0.9–1.0 backends on average — the database-wide lock a transaction that called
  `pg_notify` takes at commit — next to `LWLock:WALWrite` 0.5–0.9 and `IO:WALSync` 0.4–0.6;
- removing only the NOTIFY (a build with `pg_notify` stubbed out) made `Lock:object` disappear and
  left p50 within the noise (19.6–22.4 vs 21.8–23.0 ms): the lock queue was real but other waits
  (WAL flush of the second commit, CPU) took its place.

## Decision
**One transaction for a write and its events.** Every route that queues outbox rows does it in the
transaction of its write, and runs the local kick after the commit (`outboxCommitted(topics)`):

| Write | Events | Before | Now |
|---|---|---|---|
| comment POST | notify (`comment`, replies, mentions, followers) + webhook `comment`/`mention` | 2–3 autocommits after the insert | the same statement as the insert (below) |
| page POST | webhook `page_created` | after the tree-lock transaction | in it |
| page PATCH / DELETE / restore / duplicate | change `page_renamed/moved/visibility/trashed/restored/added` | `logPageEvents` after the transaction, errors swallowed | `recordPageEvents(…, tx)` |
| row PATCH, rows POST, rows batch PATCH | notify `task_assigned` + webhook `assigned` | after the transaction (batch: after an autocommit UPDATE) | in the transaction (batch: a transaction when a person cell is touched) |
| page owner PUT | notify `page_owner` + webhook `assigned` | after the transaction | in it |
| `markCreatedVia` (import, templates) | change `relabel` | 3 autocommits | 1 transaction |

A failing event insert now fails the write (500) instead of being logged and dropped; it is a plain
INSERT, so this happens only when the database fails the write anyway. Already transactional and
unchanged: the section index (`recordSectionChanges` in the chunk transaction), body mentions
(`syncDocMentions`), follower events of the change-log consumer. Not changed (background jobs that
claim a day first and emit after; a crash between the two loses that day's item, as before): review
digest, AI-edit digests and summaries, reminders.

**Comment POST: one statement.** The comment, its notification row and its webhook rows are one
`INSERT … ; INSERT INTO outbox …` statement (data-modifying CTEs), which also takes the write gate
(ADR 1151). What the events need besides the request (page creator and owner, thread root and
participants, which mentioned ids are members) is one read run in parallel with the membership
read. Request path: 3 statements (page, membership ‖ context, write) instead of 4 awaited + 1–2
fire-and-forget inserts, one commit instead of two or three.

**NOTIFY after the commit, only when another process can act.** `pg_notify` left the producer
statements. `outboxCommitted` kicks the local consumer (as before) and, for `change` rows (any
process may apply them) or rows that belong to another process (follower events whose change row
came from elsewhere), sends one `SELECT pg_notify(…)` from the pool, coalesced per topic (while one
is in flight, at most one more follows). `notify` and `webhook` rows of this process are not
announced: other processes may take them only after the 10 s takeover delay (ADR 1081 affinity), so
the NOTIFY only queued writers behind the commit-time lock. A lost announcement (crash right after
the commit) costs one poll interval (1 s), the bound ADR 1080 already states.

**Batched notification consumer.** A fast-path pass (up to 50 events) resolves all its events with
one statement for the subscription levels (recursive walk per event, `DISTINCT ON (event, user)`)
and one for visibility, mail settings and hourly counts of every recipient, then one INSERT per
event (the `ON CONFLICT … DO UPDATE` collapse cannot take two rows for the same `(user, group_key)`
in one statement). Per event: 5 statements → 1, plus 2 per pass. The hourly cap keeps counting the
rows this pass inserted (`RETURNING (xmax = 0)`); a collapse into an unread row older than an hour
is counted from the next pass on (the old per-event query counted it at once). The isolating path
(one savepoint per event after a failure) uses the same functions with a batch of one. Exactly once
is unchanged: the claim (`DELETE … RETURNING`) and the rows commit together.

## Alternatives considered
- **One outbox row per transaction holding all its events** (`{events: […]}`): fewer rows, but a
  webhook delivery needs its own row (lease, `X-Inkling-Delivery: <row id>` stable across retries,
  dedupe key per event and hook), and comment POST has one notification event anyway. Rows stay one
  per event; the batching is in the statement (one INSERT for all rows of a write) and in the
  consumer.
- **Keep NOTIFY in the producer statement, batch per tick in memory** (ADR 1081's suggestion):
  delays every event by the tick and still pays the commit-time lock once per tick per writer;
  measured, the lock alone was not the latency.
- **No NOTIFY at all, poll only:** another process's change rows would wait up to 1 s (now 9–10 ms).
- **Savepoint around the event insert** (as the section index does): would keep "the write succeeds
  without its event", the case this ADR removes.
- **Recipients computed in SQL inside the comment statement:** saves the parallel read, but moves the
  recipient rules out of the code the engine and its tests read; the read costs no latency in
  parallel with the membership statement.

## Consequences
- A write and its events commit or roll back together for every route above. Tests
  (`apps/server/src/outboxTx.db.test.ts`): a trigger that fails outbox inserts makes comment POST,
  page PATCH, DELETE and POST return 500 with nothing written; a failing comment insert leaves no
  event; the notification is written once after the consumer runs.
- `logPageEvents` remains for writers without a transaction; no route uses it now.
- Measured on comment POST (docs/PERFORMANCE.md, "Comment POST, events in the write statement";
  `apps/server/scripts/comment-post-bench.ts`, own seed, 3 interleaved rounds per build): 16 clients
  p50 20.6–24.2 → 17.0–17.8 ms (1.16–1.42×), 605–741 → 839–885 req/s, outbox empty 296–358 → 43–47 ms
  after the last response, 1 → 0 NOTIFY per request, 7.13 → 6.17 commits per request; 1 client not
  faster (within the spread). This is not a comparison with v0.4.x (other seed and machine state): the
  +38% of ADR 1081 is reduced on this path, not shown to be gone.
- Measured and kept for another reason: removing only the NOTIFY changed nothing beyond the spread
  (PERFORMANCE.md, Rejected / no effect).
- A route that adds events must queue them with its transaction (`enqueue(tx, …)`,
  `outboxInsertSql`, `recordPageEvents(…, tx)`, `enqueueAssignments(tx, …)`) and call
  `outboxCommitted` after the commit; without the call the rows wait for the poll (≤ 1 s).
- The split-page route (`routes/splitPage.ts`, in progress elsewhere) still emits `page_created`
  after its transaction.

## References
- apps/server/src/outbox.ts (`outboxInsertSql`, `outboxCommitted`, `announce`), apps/server/src/notify/engine.ts
  (`notifyOutboxRow`, `planEvents`, `lookupRecipients`, `writePlanned`), apps/server/src/notify/producers.ts
  (`assignmentRows`, `enqueueAssignments`), apps/server/src/webhooks.ts (`webhookOutboxRows`),
  apps/server/src/routes/comments.ts, routes/pages.ts, routes/collections.ts, routes/collectionsExt.ts,
  routes/workspaceAdmin.ts, apps/server/src/notify/provenance.ts
- apps/server/src/outboxTx.db.test.ts, apps/server/src/outbox.db.test.ts (crash tests unchanged)
- apps/server/scripts/comment-post-bench.ts
- PostgreSQL 16: `NOTIFY` (notifications are queued at commit under a database-wide lock,
  `PreCommit_Notify` in src/backend/commands/async.c), WITH queries (data-modifying statements in WITH)
