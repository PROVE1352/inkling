# 2222. Push deliveries go through the outbox, one per notification row and device

- Status: Accepted
- Date: 2026-11-10

## Context
Notifications are made by the outbox consumer of topic `notify` (ADR 1080, 1081, 1150): it resolves an
event to rows per person (membership, page visibility, subscription level, hourly cap) and writes them
in one transaction. Push must follow exactly those rows, never slow the write path, survive restarts,
retry when a push service is down, and forget devices that are gone.

## Decision
- Source: after a consumer pass wrote its rows, `enqueuePushInTx` queues outbox rows of topic `push`
  in ONE statement inside a savepoint of the same transaction (like the Slack posts, ADR 1802): rows
  with `delivery = 'now'` (quiet rows do not push), hand-offs to an agent connection only when the
  person keeps a copy (ADR 1863), kinds that have a push group, joined with the person's subscriptions
  and push settings. A failure there never fails the notification rows. Nothing runs when no
  subscription exists (an `EXISTS` cached for 10 s) or with `WEB_PUSH=off`. Due-date reminders, written
  outside the engine (`md/reminders.ts`), queue the same way right after their insert. System notices
  (`workspace_added`, `workspace_deleted`, `webhook_disabled`, `backup_failed`, `large_page`) do not push:
  they have no instant mail either.
- One outbox row per (notification, subscription), payload ids only (`{t, n, s, u}`), the dedupe key
  holds a 30 s bucket: a burst on one thread or page is one push per device, whose text is built at send
  time from the collapsed row (latest actor, count).
- Send time (`push/deliver.ts`): the row must exist, be unread and still pass the mailer's visibility
  rule (member of the workspace, live page and workspace, private pages only for their author, not held
  back by a 2FA requirement — `notify/mailer.ts pending`); the person's switch and kinds are read again.
  Otherwise the delivery is settled as skipped.
- Delivery: leased like webhook and Slack rows (`locked_until` 30 s, at-least-once), 4 at a time per
  process — not the heavy-job pool (ADR 1240), whose 2 slots belong to imports and exports. Headers
  `TTL: 86400`, `Content-Encoding: aes128gcm`, `Urgency: high` for mentions, assignments, approvals and
  reminders (else normal), `Topic` = hash of the tag (the push service replaces an undelivered older
  message for the same page). 2xx: done, the device's failure count resets. 404/410: the subscription
  is removed (RFC 8030 §7.3). 429/5xx/network: retried with capped backoff (`PUSH_RETRY` 10 s × 3ⁿ up
  to 30 min, 5 attempts, Retry-After honoured), then dead. Other 4xx: dead. Every failure counts on the
  device; 10 in a row remove it. A flood guard drops new deliveries for a person with 100 pending.
- Admin status: item `app.push` (devices, failing devices, deliveries given up in 24 h; warn on a key
  problem or ≥ 20 given up), counts only.

## Alternatives considered
- Push from the producers (comment route, indexer): would duplicate the engine's recipient rules and
  run before the rows exist.
- One outbox row per notification fanning out to all devices: one dead device would hold back or
  repeat the others' retries.
- The heavy-job slots: push calls are small and frequent; sharing two slots with zip exports would
  delay both.

## Trade-offs
- A notification read within the 30 s window on another device is not pushed (by design); one made
  quiet by the hourly cap never pushes.
- At-least-once: a crash between the push service's 201 and the settle can repeat one push (same tag,
  so it replaces itself on the device).

## Consequences
- `OutboxTopic` gains 'push'; `notify/engine.ts` returns the written rows' ids and fields.

## Files
- apps/server/src/push/deliver.ts, notify/engine.ts, md/reminders.ts, outbox.ts, status/*.ts
