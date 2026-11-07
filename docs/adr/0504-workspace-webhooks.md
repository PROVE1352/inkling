# 0504. Workspace Slack/Discord webhooks: strict URL allowlist, delivery-time privacy gate, in-memory queue

- Status: Accepted
- Date: 2026-11-07

## Context
Teams want mentions, comments, due-date reminders and new shared pages posted to a Slack or Discord channel. Incoming-webhook URLs are bearer secrets. Delivery must not slow down the request that caused the event, must survive flaky endpoints, and must never leak content from private (🔒) pages.

## Decision
- Storage: `workspace_webhooks` (workspace_id FK cascade + index, kind, url, events jsonb, enabled '0'/'1', failure_count, last_error, last_success_at, auto_disabled_at, created_by). Up to 10 per workspace. Managed by workspace owners (and site admins who are members). API responses only contain a masked URL (`https://hooks.slack.com/services/T…/••••`).
- URL policy, checked at save time AND at every delivery: https, no credentials/port/query/fragment, host exactly `hooks.slack.com` with `/services/<id>/<id>/<secret>`, or `discord.com`/`discordapp.com` with `/api/webhooks/<id>/<token>`. Delivery goes through `safeFetch` with `allowedHosts` + `allowedPathPrefixes`, no redirects, 16 KiB response cap.
- Events: `comment`, `mention` (comment @mentions; document mentions are not generated server-side today), `reminder` (row and in-document task reminders, once per page per day), `page_created` (POST /pages in the shared section, delivered after 20 s so the title has been typed).
- Privacy gate at delivery time, not at the call sites: the page is reloaded and the event is dropped unless it exists, is not deleted, is `scope='shared'`, is not a template, and belongs to the hook's workspace; comment events are dropped if the comment is gone. Messages are one line ("Bob commented on "Roadmap"") + up to 140 characters of the comment + a link, never page bodies. Discord: markdown and `@` neutralised, `allowed_mentions: { parse: [] }`.
- Queue: in-memory, max 200 pending per workspace / 5000 total, per-workspace token bucket (burst 20, 20/min), 4 concurrent sends, retries at 2 s / 10 s / 60 s for 5xx, timeouts and 429 (Retry-After honoured, capped at 60 s). Other 4xx fail immediately. One failed event (after retries) increments `failure_count`; success resets it. At 5 consecutive failed events the hook is disabled (`auto_disabled_at`) and each owner gets an in-app `webhook_disabled` notification.
- "Send test" posts a fixed message right away (still rate limited) and reports the HTTP result.
- Test mode: `WEBHOOK_TEST_ALLOW_LOOPBACK=1` additionally accepts `http://127.0.0.1:<port>/…` so smoke tests can use a local receiver. It is ignored when `NODE_ENV=production`, and `safeFetch` independently ignores its loopback flag in production.

## Alternatives considered
- Persistent job table (or pg-boss): survives restarts and works with several instances, but needs a migration, polling and cleanup; the payloads are best-effort notifications.
- Encrypting webhook URLs at rest with an app key: protects against DB-dump leaks, but needs key management that the project does not have yet. Masking in API responses plus DB access control is the current boundary.
- Filtering private pages at the call sites: easy to miss in a new call site; one gate at delivery covers all of them.
- Generic webhooks to any URL: much larger SSRF and abuse surface; Slack/Discord cover the request.

## Trade-offs
- Pending events are lost on restart, and with several app instances each instance has its own queue and rate limiter.
- Webhook URLs are stored in plaintext in Postgres.
- Page creation through templates, duplication and imports does not emit `page_created` (avoids bursts of hundreds of messages on import).
- `notifications.type` gains `webhook_disabled` (a TS enum member only; the column is plain text, so no migration is needed for it).

## How others solve it
GitLab and Gitea validate webhook URLs against a local-network denylist, retry with backoff and auto-disable hooks after repeated failures. Linear and Notion's Slack integrations post a summary + link rather than content. Discord's documentation recommends `allowed_mentions` to prevent mass pings.

## Consequences
- Smoke-tested with a local fake receiver: Slack and Discord payloads, private-page suppression, mention text, 429/5xx retry, auto-disable after 5 failures plus owner notification, and owner-only access.

## References
- apps/server/src/db/schema-webhooks.ts
- apps/server/src/webhooks.ts:30 (URL policy), :41 (auto-disable), :44 (bucket), :50 (test mode), :156 (privacy gate), :310 (scheduler), :377 (failure handling), :432 (emit)
- apps/server/src/routes/webhooks.ts
- call sites: apps/server/src/routes/comments.ts (generateCommentNotifications), apps/server/src/md/reminders.ts, apps/server/src/routes/pages.ts (POST /pages)
