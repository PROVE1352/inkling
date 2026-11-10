# 1806. Setup by manifest, and tests against a fake Slack

- Status: Accepted
- Date: 2026-11-10

## Context
Creating a Slack app by hand means many fields; mistakes show up as silent failures. Tests must never
call Slack.

## Decision
- `GET /api/workspaces/:id/slack` returns the command URL, events URL, unfurl domain, bot scopes
  (`chat:write`, `chat:write.public`, `commands`, `links:read`, `links:write`, `users:read`,
  `users:read.email`) and a JSON app manifest with them filled in. The page also shows the raw values,
  so setup works even if Slack changes a manifest field.
- The Test button posts a message to the channel and shows Slack's error code (e.g. `not_in_channel`:
  invite the bot to a private channel); a passing test clears a pause.
- `slack.db.test.ts` runs a fake Web API on 127.0.0.1 (auth.test, conversations.info, users.info,
  chat.postMessage, chat.unfurl) with per-call answers: 503, 429 + Retry-After, error codes, hang.

## Consequences
- The manifest shape was not validated against Slack's live schema in CI; the raw values are the
  fallback.

## References
- docs/adr/1745-* (same fake-endpoint approach)
- `apps/server/src/slack/slack.db.test.ts`, `apps/web/src/components/SlackPanel.tsx`
