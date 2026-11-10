# 1800. Slack app per workspace, owned by the operator

- Status: Accepted
- Date: 2026-11-10

## Context
Small teams (3–5 people) live in Slack and want Inkling news there and a quick lookup without opening
the app. Inkling is self-hosted: there is no central Inkling Slack app with a public OAuth install
flow, and an operator cannot be asked to trust one. The incoming-webhook kind of ADR 0504 only posts
one-way text to a URL; it cannot answer a slash command or unfurl a link.

## Decision
- Each operator creates **their own Slack app** (from a manifest Inkling fills in, ADR 1806) and pastes
  its Bot User OAuth Token and Signing Secret into **Workspace settings → Slack**. One Slack app per
  Inkling workspace: the request URLs carry the workspace id (`/api/slack/w/:workspaceId/commands|events`)
  because the signing secret is per app, so the URL alone picks the secret to verify with.
- Settings are for workspace **owners** only, like webhooks (C-L12): the token can post as the bot.
- `auth.test` runs on every save; its `team_id` is stored and every request from Slack must name it.
  A save with another team drops the account links of the old team.
- New tables (migration 0043): `slack_integrations` (one row per workspace), `slack_user_links`,
  `slack_link_codes`, `slack_request_nonces`; outbox topic `slack` (no SQL change: `topic` is text).
- No Slack SDK: the Web API is a form-encoded POST through `safeFetch` (host pinned to `slack.com`,
  no redirects, 8 s). Tests use a fake on 127.0.0.1 via `SLACK_TEST_API_URL`, honoured only with
  `WEBHOOK_TEST_ALLOW_LOOPBACK=1` outside production.

## Consequences
- Two Inkling workspaces in one Slack team need two Slack apps, and only one of them can own the
  `/inkling` command name there. Documented as a known limit.
- The incoming-webhook kind stays for one-way posts without an app.

## References
- docs/adr/0504-*, 1111-*, 1801-* .. 1806-*
- `apps/server/src/slack/*`, `apps/server/src/routes/slack.ts`, `apps/server/src/db/schema-slack.ts`
