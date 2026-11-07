# 1004. Delivery: instant mail, daily/weekly digest, AI summaries, webhooks

- Status: Accepted
- Date: 2026-11-07

## Context
Without mail, nobody knows a comment arrived until they open the app. Research on team tools keeps
pointing at notification fatigue; teams also want notices in their chat rather than in one more app.

## Decision
- Per-user settings (`user_notification_settings`, defaults: instant on, digest daily). Browser-only.
- Instant mail: direct items (mentions, replies, assignments, approvals) delivered `now` are queued
  per person and mailed after `NOTIFY_MAIL_DELAY_MS` (default 2 min) in one message; at send time the
  item must still be unread and visible, so reading it in the app cancels the mail. Housekeeping
  sends anything whose timer was lost.
- Digest: everything else that should reach mail (quiet items such as agent mentions, followed-page
  activity, AI summaries, direct items when instant mail is off) waits with `mail_state = 'digest'`
  and goes out once a day (or week) from 08:00 server time, one message per person.
- Content: who, what, page title and at most 200 characters of the comment or the mentioning line;
  never page bodies. Links from APP_URL/PUBLIC_URL only (ADR 0806). Unverified addresses of accounts
  that must verify are skipped.
- No SMTP: nothing is marked for mail; everything stays in the app.
- AI summaries: a subscription row with `agent_digest` produces one in-app `agent_digest` item a day
  listing pages agent connections changed under its root (rows the person could see when logged and
  pages they can see now). Workspaces can also send a daily `agent_digest` webhook (shared pages only).
- Webhooks: new events `assigned` (owner / person cell) and `agent_digest`; body mentions now emit
  `mention` (people's only). Payloads keep the 0504 rules (summary + link, privacy gate at delivery).

## Alternatives considered
- Mail per notification: the fatigue problem; batching with a short delay keeps "right away" useful.
- Web push: later; it would reuse the same `now` rows.

## Trade-offs
- The digest hour is server-local, not per-user time zone.
- Mail failures move the items to the digest instead of retrying forever.

## How others solve it
- GitHub/Linear: instant mail per event with "you were mentioned" priority, plus digests.
- Notion: mail only for items unread after a delay.

## References
- apps/server/src/notify/mailer.ts, notify/digest.ts, housekeeping.ts, webhooks.ts
