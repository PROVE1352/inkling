# 1805. Link unfurls: title and first paragraph of shared pages

- Status: Accepted
- Date: 2026-11-10

## Context
A pasted Inkling page link should show what it is, but Slack would otherwise fetch nothing (pages need
sign-in), and a preview must not reveal a page the channel cannot see.

## Decision
- The manifest lists the PUBLIC_URL host under `unfurl_domains` and subscribes to `link_shared`.
- A verified `link_shared` event queues an unfurl job (outbox, same retries); the HTTP answer is 200 at
  once. Only links of the configured host with the path `/w/<this workspace>/p/<id>` are considered, at
  most 5.
- At delivery the shared-page rule of ADR 1802 applies to each page; `chat.unfurl` gets the escaped
  title as a link and the first prose line of the page's indexed text (≤ 300 characters). Pages that
  fail the rule are left out; if none is left, nothing is called.
- `app_uninstalled` / `tokens_revoked` events pause the integration.

## Consequences
- Without PUBLIC_URL (or with an IP address) there is no unfurl domain; the settings page says so.

## References
- docs/adr/1802-*, 1804-*
- `apps/server/src/slack/inbound.ts`, `apps/server/src/slack/notify.ts`
