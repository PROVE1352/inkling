# 1802. Slack channel posts follow the notification engine, shared pages only

- Status: Accepted
- Date: 2026-11-10

## Context
The team wants mentions, assignments, open agent suggestions, comment replies and a change summary in
a channel. These already exist as notification kinds (ADR 1000, 1534). A channel is read by people
who may not be able to see a page, and posting must never slow down or fail a save.

## Decision
- **One tap.** After the notification consumer resolved a batch, `slackRowsForNotify` maps each event
  to at most one post: the first switched-on kind in the order mention (`doc_mention`,
  `comment_mention`) > assigned (`task_assigned`, `page_owner`) > suggestion (`approval_request`) >
  reply (`comment_reply`). The rows are inserted in the consumer's transaction inside a savepoint: they
  commit with the notification rows, and an error there is logged and never fails a notification.
  Writers are unchanged: they queue notification events as before and never wait for Slack.
- **Kinds are switched per workspace**: mention, assigned, suggestion, reply, digest. An agent's
  @mention does not ping the channel (the webhook rule of ADR 1000); its suggestion does.
- **Digest**: once a local day (hourly housekeeping, claimed by `digest_sent_on`), the shared pages
  changed in the last day, people and agents, up to 10 named with links.
- **Privacy at delivery**: the job is re-resolved when sent. Only pages with `scope = 'shared'`, not
  deleted, in the integration's workspace, in a live workspace are named; anything else is dropped
  silently. Names are of workspace members only. Text is summary + title + link; a 140-character
  excerpt only for comment replies and comment mentions (as the Slack webhook); suggestion text is
  never sent. Titles are escaped (`&`, `<`, `>`), so a title cannot form `<!channel>`.
- **Delivery**: outbox topic `slack`, leased like webhooks (at-least-once), retries 6 attempts with
  backoff 5 s ×3 capped at 15 min; Slack's 429 `Retry-After` is honoured. Codes that will not heal
  (`invalid_auth`, `token_revoked`, `not_in_channel`, `channel_not_found`, `missing_scope` …) mark the
  job dead and pause posts (`blocked_reason`) until a save or a passing test. At most 200 pending jobs
  per workspace; the same post (page, kind, people, thread) within 10 minutes is deduplicated.
- People linked to a Slack account (ADR 1803) are named with `<@U…>` so they get pinged.

## Consequences
- A crash after the HTTP call can post twice (at-least-once, like webhooks).
- Doc mentions produce one event per mentioned person, so one edit that mentions two people posts two
  lines. Channel posts use `DEFAULT_LOCALE`.

## References
- docs/adr/0504-*, 1000-*, 1081-*, 1150-*, 1534-*
- `apps/server/src/slack/notify.ts`, `apps/server/src/notify/engine.ts`
