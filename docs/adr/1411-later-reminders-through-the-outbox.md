# 1411. Later reminders: a sweep that queues notification events through the outbox

- Status: Accepted
- Date: 2026-11-09

## Context
A saved item can carry a reminder: in 20 minutes, this evening, tomorrow 9:00, next Monday 9:00, or
a picked date and time. At that time the person gets a bell item and, with their mail settings, a
mail. "This evening" and "Monday" depend on the person's time zone; the server's zone (`TZ`) is
not theirs. Reminders must survive restarts and must not be delivered twice when two processes or
two sweeps run at once. The notification engine (1000) and its outbox consumer (1081) already
deliver exactly once, re-check visibility, respect mail settings and drop mail for 2FA-blocked
workspaces (1300).

## Decision
- **Time:** the browser computes the presets in its own time zone (`apps/web/src/lib/laterPresets.ts`)
  and sends one absolute instant (`remindAt`, ISO with offset). The server stores `timestamptz`,
  plus the IANA zone it was picked in (`remind_tz`); it never computes "tomorrow" itself. The zone
  is stored for wording only and nothing reads it yet: the reminder mail names the page, not the
  time (it arrives at that time). Lists show the instant in the viewer's local time. Accepted range: from one minute ago
  (clock skew) to 732 days ahead.
- **Sweep** (`runLaterSweep`, `apps/server/src/later.ts`): one transaction claims up to 500 due rows
  (`remind_at <= now() AND reminded_at IS NULL AND done_at IS NULL`, partial index, `FOR UPDATE SKIP
  LOCKED`), sets `reminded_at = now()`, and inserts one `notify` outbox row per row (kind
  `later_reminder`, no actor, the person as the only recipient). Claim and events commit together:
  a crash before the commit leaves the rows due; after it, the events are in the outbox and the
  consumer writes each exactly once. A dedupe key `later:<item>:<remind_at ms>` guards the queue
  while the event is pending.
- **Timer:** at boot one sweep runs at once (reminders that came due while the server was down fire
  now, once), then a timer is set to the next due reminder, at most 60 s away. Saving or moving a
  reminder in this process pulls the timer forward; another process's reminders are found within
  60 s. A backlog drains 500 at a time.
- **Kind `later_reminder`:** priority 95, instant mail, passes mute and the hourly caps (the person
  asked for it), not an agent inbox item, no group key (each reminder is its own item). Done or
  deleted items never fire; setting a new reminder clears `reminded_at`.
- **Visibility** is the engine's (member, live page, can see it now) at delivery and the mailer's
  (plus 2FA) at send time. A reminder on a page the person can no longer see is claimed and
  dropped: nothing is written.

## Alternatives considered
- **Future-dated outbox rows** (`available_at = remind_at`): no table, but every notification pass
  scans pending rows of its topic in id order: with 10,000 future rows one pass with one due event
  went from p50 2.55–2.58 to 3.90–4.03 ms (docs/PERFORMANCE.md, Rejected). Moving or cancelling would need an
  outbox lookup by key, and the payload would be frozen at save time.
- **pg_cron / a job library:** new dependency or extension (ADR 0882) for one query.
- **Server-side presets with a stored user time zone:** the device knows the zone it is in now;
  a stored zone goes stale when people travel.

## Trade-offs
- Up to 60 s late when another process set the reminder (single-instance deployments: on time).
- A large backlog (10,000 due at once) holds the notification consumer for about 3 s.
- Reminders are exact to the minute presets, not to the second.

## Consequences
- Tests (`apps/server/src/later.db.test.ts`): one notification however many sweeps run, four
  concurrent sweeps over 30 due rows write 30, a failure before the commit loses nothing, done items
  and muted pages, invisible targets write nothing, instant mail is queued.
- docs/PERFORMANCE.md (`apps/server/scripts/later-bench.ts`): idle tick 0.81–0.91 ms p50 with the
  partial index (3.41–3.62 ms without), 10,000 due at once in 3.6–3.7 s.

## References
- apps/server/src/later.ts (`runLaterSweep`, `startLaterReminders`, `wakeLaterReminders`)
- apps/server/src/notify/kinds.ts, notify/mailer.ts (`later_reminder`)
