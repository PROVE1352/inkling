# 1191. Webhook delivery records, resend, and what of a response is kept

- Status: Accepted
- Date: 2026-11-07
- Amends: [1081](1081-notifications-and-webhooks-through-the-outbox.md) (consumer statements)

## Context
An owner could see only `lastError` per hook. To debug a receiver (n8n, own server, ADR 1190) one needs
the recent deliveries: what was sent, the HTTP status, how long it took, how many attempts, when the next
one is, and a way to send a delivery again or a test event. The outbox rows (ADR 1081) hold part of this
but are purged (done after 7 days, dead after 30), shared by all topics and hold no status code.

## Decision
**One record per delivery, rewritten per attempt.** Table `webhook_deliveries` (hook, `outbox_id` =
X-Inkling-Delivery, event, status `ok | retrying | failed`, attempts, status code, error, duration,
response excerpt, next attempt, created/updated). The record is written **in the same statement that
finishes or reschedules the outbox row** (`WITH s AS (UPDATE outbox … AND attempts = <lease>) INSERT …
SELECT … FROM s ON CONFLICT (outbox_id) DO UPDATE`), so:
- a consumer that lost its lease records nothing (its UPDATE matched no row) — the lease guard of
  ADR 1081 is untouched;
- no extra round trip: on success the hook's streak reset (`failure_count = 0`, `last_success_at`)
  joined the same statement, so a successful delivery costs one statement less than before (measured
  below);
- a crash between the HTTP call and the statement leaves no record; the redelivery then writes it
  with `attempts = 2` (tested).
One record per attempt was rejected: the list the owner reads is per delivery, and a row per attempt
would need a group-by on every read and more rows for the same information.

**Not recorded:** deliveries skipped at delivery time (page private or deleted, hook disabled, rate
limit requeue). A record "comment event skipped" would tell an owner that someone commented on a
private page at that time.

**Test events** are recorded with `outbox_id` NULL (they bypass the outbox) and cannot be resent.

**Response body: only for non-2xx, ≤ 200 printable characters.** A failing receiver usually says why
in its body ("invalid signature", "no_service"), which is what an owner needs; a successful body is
never needed and may echo data (n8n returns workflow output). Control characters are removed and the
excerpt is capped, so the record cannot carry markup or large data. Storing nothing was rejected (the
status code alone rarely explains a 400); storing more was rejected (it is the receiver's data, kept in
our database, visible to every owner).

**Retention.** Every 20 new records of a hook, all but the newest 100 are deleted (one indexed
DELETE, counted in memory per process; worst case ~120 rows per hook between prunes). Records go with
their hook (`ON DELETE CASCADE`).

**Resend = the same outbox row.** `POST /webhooks/:id/deliveries/:deliveryId/resend` (owners, 10/min)
sets the row back to `pending`, due now, `origin` = this process (no 10 s takeover wait), and records
`attemptBase = attempts` in its payload: the retry budget counts from there, while `attempts` keeps
growing, so a consumer whose lease expired can never finish the new attempt (no ABA on the lease
guard). Same row → same `X-Inkling-Delivery` and body `id` (Stripe/GitHub semantics: a resend is the
same event), re-resolved (privacy) and re-signed at send time. 410 when the row was purged or belongs
to another hook, 409 while an attempt is in flight or the hook is disabled. A resend is not counted
against the 200-row flood guard (owner action, rate-limited).

**List.** `GET /webhooks/:id/deliveries?limit=` (owners; default 30, max 100), newest first, with the
outbox state joined for "can resend" and the exact next attempt time.

## Consequences
- Migration: table `webhook_deliveries` with an index on `(hook_id, id)` and a unique index on
  `outbox_id`.
- Consumer cost (docs/PERFORMANCE.md, "Webhook consumer"): statements per delivery 6.7 → 5.6 (Slack)
  / 5.7 (generic, the workspace name is cached 60 s); throughput within the noise of a shared laptop.
- The web panel shows the list per hook (collapsed until opened, refreshed every 5 s while a delivery
  waits for a retry) with Resend and Send test event.

## References
- apps/server/src/webhooks.ts (`recordAttemptSql`, `settle`, `retryLater`, `notePrune`, `listDeliveries`,
  `resendDelivery`, `sendTestMessage`), apps/server/src/routes/webhooks.ts,
  apps/server/src/db/schema-webhooks.ts, apps/web/src/components/WebhooksPanel.tsx
- apps/server/src/webhooksGeneric.db.test.ts, apps/server/scripts/webhook-consumer-bench.ts
