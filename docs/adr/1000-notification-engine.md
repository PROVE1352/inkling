# 1000. Notification engine: one queue, one table, rules in one place

- Status: Accepted
- Date: 2026-11-07

## Context
Notifications were written inline by the comment route only (`comment`, `comment_mention`). The
`doc_mention` type existed with no producer, there was no assignment notice, no way to follow a page,
no mail, and the bell could be flooded by repeated events (a past hackathon saw a notification storm
from delete-and-recreate loops). New producers (body mentions from the indexer, assignments, followed
page edits) run on hot write paths.

## Decision
- Producers call `notify()` (`apps/server/src/notify/engine.ts`) after their write committed. It only
  queues; one background drain processes events in order with a handful of set-based statements per
  event (recipients' levels, visibility, settings, hourly counts, one `INSERT … SELECT FROM
  jsonb_to_recordset`). No per-recipient queries, nothing awaited inside the caller's transaction.
- Per recipient: never the actor → member of the workspace → can see the page now (live page, shared
  or own private, live workspace) → nearest subscription level (ADR 1001) → kind rule
  (`notify/kinds.ts`) → hourly cap → highest-priority kind wins when one event qualifies a person
  several times (mention > reply > comment).
- Kinds and their rules live in one table (`KINDS`): priority, instant-mail eligibility, `bypassMute`,
  inbox label, `quietWhenAgent`. New kinds: `comment_reply`, `page_owner`, `task_assigned`,
  `page_update`, `agent_digest`; reserved `approval_request` (passes mute) and `approval_result`.
  The `type` enum stays TypeScript-only (no DB check), like `workspace_members.role`.
- Collapse: a partial unique index on `(user_id, group_key) WHERE read = '0'` turns repeats into
  `count + 1` on the unread row (`ON CONFLICT … DO UPDATE`), bumping `created_at` and `seq`. Keys:
  doc mention per page, comment/reply/mention per thread, assignment per row, page update per page.
- Two deliveries: `now` (badge, may mail right away) and `quiet` (listed, no badge, digest only).
- Caps: at most 200 recipients per event; per person and hour, beyond 60 rows arrive quietly and
  beyond 300 they are dropped (bypass kinds excepted).
- Webhooks stay producer-side (`emitWebhookEvent`), re-checked at delivery as before.

## Alternatives considered
- A job table (persistent queue): survives restarts, but every write would add a row and the
  in-memory queue already matches the single-instance model (webhooks, indexer). Lost events on a
  crash are an accepted gap (KNOWN-ISSUES).
- Notifications computed at read time from the change log: no fan-out cost, but per-user levels,
  grouping and mail state need stored rows.

## Trade-offs
- Up to a few hundred ms between the write and the bell.
- Collapsing hides individual events inside a count; the activity screen (ADR 1005) has them all.

## How others solve it
- Slack/Discord: per-channel notification levels evaluated server-side, badges vs. silent unreads.
- Notion: "updates" grouped per page, inbox separate from the activity view.

## Consequences
- Comment notifications now also reach the document owner and followers; behaviour for the page
  creator is unchanged.

## References
- apps/server/src/notify/engine.ts, notify/kinds.ts, notify/producers.ts
- apps/server/drizzle/0031_notifications.sql
