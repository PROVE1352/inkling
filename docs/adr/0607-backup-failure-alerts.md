# 0607. Backup failures become admin notifications (+ mail); webhook hook left as an extension point

- Status: Accepted
- Date: 2026-11-07

## Context
Backups fail silently unless someone looks. Inkling has in-app notifications, optional SMTP mail, and workspace-scoped Slack/Discord webhooks (ADR 0504).

## Decision
- The app polls `status.json` every 2 minutes (first check 30 s after boot, timers unref'd). `currentAlert()` picks one problem: a failed run newer than the last success, a failed restore test (cleared by a later passing test), a failed remote copy (cleared by a later successful copy), or a sidecar heartbeat older than 10 minutes.
- For a new alert: insert a `backup_failed` notification for every admin (no page/workspace; clicking opens Admin), mail admins when SMTP is configured (skipping delegated mirror addresses), then call `notifyBackupFailureExternal()`.
- Dedupe is restart-safe without new tables: an alert is already sent when a `backup_failed` notification exists with `created_at >= alert.at`. Alerts older than 3 days are ignored (e.g. right after enabling the feature).
- `notifications.type` gains `backup_failed` (text column with a TS-only enum — no migration).
- Workspace webhooks are not used: they are workspace-scoped and page-event oriented, and backups are instance-level. `notifyBackupFailureExternal()` is the TODO hook for a future instance-level channel.

## Alternatives considered
- Notify from the sidecar directly (SMTP from bash): duplicates mail config and code, no in-app notification.
- Marker file for dedupe: the app may not be able to write next to `status.json` (read-only mount).
- Posting to every workspace webhook: leaks instance operations to every team channel.

## Trade-offs
- Up to 2 minutes delay; two distinct failures within one poll interval produce one notification.
- With several app instances each one polls, but the DB check makes duplicates unlikely (a race can still double-insert).

## How others solve it
- Discourse: emails admins on backup failure ("backup failed" system message).
- GitLab: no built-in alerting; relies on cron mail / monitoring.

## Consequences
- Smoke test: a failed run produced one `backup_failed` notification for the admin within one poll; later polls did not repeat it.

## References
- apps/server/src/backup/monitor.ts:32 (`notifyBackupFailureExternal`), :39 (dedupe), :105 (poller)
- apps/server/src/backup/store.ts:120 (`currentAlert`)
- apps/server/src/db/schema.ts:312 (enum), packages/shared/src/index.ts (`NotificationType`)
- apps/web/src/components/NotificationBell.tsx (`backup_failed` text + navigation)
