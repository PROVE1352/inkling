# 1192. Generic webhooks are disabled after 24 hours of failures, not after five events

- Status: Accepted
- Date: 2026-11-07
- Amends: [0504](0504-workspace-webhooks.md) (auto-disable)

## Context
A hook is disabled after 5 consecutive failed events (each event already retried 4 times over about a
minute), and workspace owners get a `webhook_disabled` notification. For Slack and Discord a failure is
almost always permanent (the URL was revoked: 404/410). A self-hosted receiver fails for ordinary
reasons: a deploy, a restart, a certificate renewal. In a busy workspace five events arrive in a minute,
so a five-minute outage would turn the hook off and every later event would be lost until someone
noticed.

## Decision
**Rule, in one sentence:** a generic hook is disabled when its last five or more events all failed
**and** the first of those failures is at least 24 hours old. Column
`workspace_webhooks.failing_since` is set on the first failed event of a streak (`coalesce`) and
cleared by any success (delivery or test) and by re-enabling.
- Busy workspace, receiver down 1 hour: many failed events, streak 1 h → stays enabled; the events of
  that hour can be resent from the delivery list (ADR 1191).
- Receiver gone for good: disabled about 24 hours after the first failure (at the first failed event
  after that point).
- Quiet workspace (one event a week): disabled at the fifth failed event, four weeks after the first.
  A count-only rule would do the same; a time-only rule would fire on the second failure a week later,
  which is too eager for an endpoint that was down once. Requiring both keeps the old "five events"
  floor.
- Slack and Discord keep five failed events: their failures are permanent and a dead channel should
  stop quickly.

**Notification, reviewed.** Kept as is: one `webhook_disabled` notification row for every workspace
owner (owners are the only people who can manage hooks), shown in the bell. It is written directly, not
through the notification engine, so it is not mailed on its own; that is unchanged. Added
in the panel: "Failing since …" while a streak is running, so an owner sees the problem before the hook
is turned off. An earlier warning notification (e.g. after 1 hour) was considered and not added: it
would fire on every short outage, and the delivery list already shows the failures; it can be added
later as a second notification type without a schema change.

## Consequences
- Migration: `workspace_webhooks.failing_since timestamptz`.
- `WebhookDTO.failingSince` (null when the last event went through).
- Tests: five failures within minutes keep a generic hook enabled; with the streak backdated by 25 h the
  next failure disables it and notifies the owner only; re-enabling clears the streak; a Slack hook with
  four failures is disabled by the fifth (`webhooksGeneric.db.test.ts`).

## References
- apps/server/src/webhooks.ts (`recordFailure`, `GENERIC_DISABLE_AFTER_MS`), apps/server/src/routes/webhooks.ts (PATCH)
