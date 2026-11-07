# 1081. Notifications and webhooks through the outbox: retries, idempotency, leases

- Status: Accepted
- Date: 2026-11-07
- Amends: [1000](1000-notification-engine.md) (queue), [1004](1004-notification-mail-digests-and-webhooks.md) and [0504](0504-workspace-webhooks.md) (webhook delivery)

## Context
Notification events (ADR 1000) and webhook deliveries (ADR 0504, 1004) were in-memory queues. A
crash lost every event not processed yet (KNOWN-ISSUES NOTIFY-O1) and every queued or retrying
webhook delivery; a graceful shutdown flushed notifications for up to 3 s but dropped webhooks. The
change log now has a durable outbox (ADR 1080); the events it causes ("page you follow changed",
agent-written "@Name") are produced by its consumer and must not be lost or doubled either.

## Decision
Same table, two more topics (`outbox.topic`): `notify` (one event) and `webhook` (one event × hook).

**Producing.** `notify(input)` and `emitWebhookEvent(ev)` keep their fire-and-forget signatures and
insert one outbox row right after the producer's write (not awaited by the caller). Producers that
own a transaction queue inside it: `enqueueNotify(tx, …)` / `enqueueWebhookEvent(tx, …)` —
`syncDocMentions` (mention set + events + webhook in one transaction) and the change-log consumer
(follower events commit with the log rows). Payloads are bounded (200 recipients, 4,000-character
raw excerpt).

**Notifications: exactly once.** `runNotifyBatch` claims up to 50 due rows (`FOR UPDATE SKIP LOCKED`;
the fast path claims by `DELETE … RETURNING`) and runs the unchanged resolution in the same
transaction: never the actor → member → can see the page now → nearest subscription level → kind
rule → hourly cap (60 quiet / 300 drop) → one row per person → collapse into the unread row of the
same group key. The outbox delete and the notification rows commit together, so an event is
written once or not at all. Broadcast and instant-mail scheduling run after the commit (mail state
is persisted; housekeeping rebuilds timers as before). A failing event is retried (1 s × 2ⁿ, cap
5 min, 10 attempts, then `dead`); the batch redoes itself with savepoints to isolate it.

**Webhooks: at least once, deduplicated.**
- One row per (event, hook) with `dedupe_key = wh:<event key>:<hook id>`. Event keys: `comment:<id>`,
  `mention:<comment id>`, `page_created:<page id>`; other events get a random key (assignments, body
  mentions and digests have their own once-a-day claims). A second emit of the same event is
  `ON CONFLICT DO NOTHING`. Finished rows stay `done` for 7 days so the key keeps working after
  delivery; `dead` rows stay 30 days; the worker purges hourly.
- Delivery takes a 30 s lease (`locked_until`, `attempts + 1`, `SKIP LOCKED`), sends, then finishes
  the row only if the lease is still its own (`attempts` unchanged). A crash during the HTTP call
  leaves a leased row; after the lease any consumer sends it again. The request carries
  `X-Inkling-Delivery: <row id>`, stable across retries, so a receiver can drop the duplicate. Slack
  and Discord ignore it: there a crash in that window can post twice. This is stated, not hidden.
- Kept rules: privacy re-check at delivery (`buildMessage`), per-workspace token bucket (a row
  without a token goes back without spending an attempt), 4 deliveries in flight per process,
  `page_created` 20 s delay, Retry-After (≤ 60 s), retries after 2 s, 10 s, 50 s (2 s × 5ⁿ, cap
  60 s, 4 attempts), auto-disable after 5 failed events with the owner notification, at most 200
  pending deliveries per workspace (newer events dropped and logged, as before).

**Affinity.** Each row records the process that wrote it (`origin`, a per-boot id). `notify` and
`webhook` rows are taken by that process — it holds the sockets for the bell broadcast, the mail
timers and the same configuration — and by any other process only 10 s after they became due (a
crashed or stopped writer, or the previous boot after a restart). Follower events produced by the
change-log consumer inherit the origin of the change row. `change` rows have no affinity (DB-only
effects).

**Flush.** `flushNotifications()` (tests, digests, shutdown) waits for in-flight inserts, drains
the change log, then the notification rows.

## Alternatives considered
- **Keep the in-memory queues, add a shutdown flush for webhooks:** no extra writes, but a crash or
  OOM kill still loses the backlog, which is exactly when there is one.
- **A separate table per topic:** clearer columns, three copies of the same claim/retry/purge code;
  the common columns (state, attempts, available_at, lease) are the whole design.
- **Exactly-once webhooks (two-phase: mark "sending", then send):** impossible without receiver
  support; marking before sending trades duplicates for silent loss, which is worse for alerts.
- **A job library (pg-boss, graphile-worker):** new dependency (ADR 0882) for ~300 lines we need.

## Trade-offs
- Each event is an INSERT + a consumer transaction instead of a memory push: comment POST at 16
  concurrent p50 12.0 → 16.5 ms (+38%), p95 15.7 → 19.5 ms (+24%), throughput 1,298 → 956 req/s on a
  laptop where server, database and load generator share the CPU (docs/PERFORMANCE.md, Regressions).
  At 1 client +0.3 ms p50. Accepted for durability; batching the enqueue per tick is the next lever.
- Events produced by routes after their own commit (`notify`, `emitWebhookEvent`) are durable from
  the moment their insert commits; a crash in the milliseconds between the route's commit and that
  insert still loses them (routes are not changed to pass their transaction yet).
- A restart picks up the previous boot's notification and webhook rows 10 s after they were due.
- Webhooks are at least once.

## Consequences
- KNOWN-ISSUES NOTIFY-O1 and the in-memory webhook queue item are resolved apart from the window
  above.
- Tests (`apps/server/src/outbox.db.test.ts`, real child processes killed with SIGKILL): rows
  committed before the kill are processed exactly once after "restart" (change log, notification,
  webhook); a kill inside the notification or change-log consumer before its commit writes nothing
  and loses nothing; a kill after the HTTP call redelivers once with the same delivery id; three
  in-process consumers plus a second process write 40 events exactly once; a 503 is retried after
  the 2 s backoff; purge keeps `done` 7 days and `dead` 30 days.

## References
- apps/server/src/notify/engine.ts (`notify`, `enqueueNotify`, `runNotifyBatch`, `flushNotifications`, `processEvent`)
- apps/server/src/notify/producers.ts (`syncDocMentions`, `notifyPageEdited`), apps/server/src/webhooks.ts
  (`enqueueWebhookEvent`, `emitWebhookEvent`, `runWebhookPass`, `runJob`, `deliver`)
- apps/server/src/outbox.ts (`ownedOrOrphaned`, `failRow`, `backoffMs`, `purgeOutbox`), apps/server/src/db/schema-outbox.ts
- docs/adr/1080-change-log-through-a-transactional-outbox.md
