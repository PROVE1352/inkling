# 0952. Review reminders as a daily webhook digest, not inbox notifications

- Status: Accepted
- Date: 2026-11-07

## Context
Reminders for documents due for review could go to the in-app inbox, but teams already live in
chat, and a busy inbox is ignored (notification fatigue; Inkling's own inbox once flooded a team
during a hackathon). Existing workspace webhooks deliver to Slack and Discord with a privacy gate.

## Decision
- New webhook event `review_due` (packages/shared/src/embeds.ts). Once a day per workspace with
  reminders on and at least one hook subscribed, housekeeping claims the day with a conditional
  `UPDATE workspaces SET review_digest_sent_on = today WHERE … IS DISTINCT FROM today` and emits
  one event listing the stale shared documents by priority (up to 50).
- `buildReviewDigest` re-resolves pages at delivery like single-page events: only live, shared,
  non-template pages of the workspace are named, up to 8 titles with owners and "+k more", and a
  link to the Review tab (apps/server/src/webhooks.ts:217).
- Nothing is written to `notifications`.

## Alternatives considered
- Per-owner DMs: webhooks are channel URLs; mapping members to chat users is out of scope.
- One event per page: floods the channel on the first day after enabling reminders.

## Trade-offs
- Owners without a chat integration only see the Review tab.

## How others solve it
- Confluence and Notion wiki verification remind the page owner before a verification expires.
- GitHub stale-bot style digests post one comment/issue listing items.

## Consequences
- Delivery, rate limiting and auto-disable follow docs/adr/0504-*.

## References
- apps/server/src/review.ts:441
- apps/server/src/webhooks.ts:217, :496
