# 1001. Subtree subscriptions: all, mentions, nothing, mute

- Status: Accepted
- Date: 2026-11-07

## Context
Only a page's creator heard about comments. Teams need to follow a folder ("everything under
Projects"), quiet a noisy page, and keep the default low so notifications do not become noise.

## Decision
- `notification_prefs(user, workspace, root_page_id NULL|page, level, subtree, agent_digest)`,
  unique `NULLS NOT DISTINCT` per (user, workspace, root). A null root is the person's default for the
  workspace; with no row the default is `mentions`.
- The nearest row wins: the page's own row, then the closest ancestor whose row covers its subtree
  (`subtree = true`), then the workspace row, then the default. One recursive CTE per event.
- Levels: `all` = direct items + activity (comments, edits) on the subtree; `mentions` = direct items
  (mentions, replies in your threads, assignments); `nothing` = direct items kept in the list quietly
  (no badge, no mail, no webhook ping); `mute` = nothing recorded, except kinds flagged `bypassMute`
  (only `approval_request`, reserved for approvals addressed to you).
- "Follow" is a row with level `all`; "follow this page only" is `subtree = false`. The page's
  creator and document owner get new comments without a row (`implicit`), still subject to
  nothing/mute.
- Settings are browser-only routes: an agent acting for a person cannot silence that person.

## Alternatives considered
- A separate follows table (Discord threads): two sources of truth for one decision.
- `@all` / `@here`: not added; when it is, it obeys mute (Discord's channel mute does not stop
  @everyone, a common complaint).

## Trade-offs
- `nothing` vs `mute` is a subtle difference; the settings screen explains each in one line.

## How others solve it
- Discord: All / Only @mentions / Nothing per server and channel, mute separate.
- Slack: per-channel "All new messages / Mentions / Nothing", plus mute.

## Consequences
- Moving a page moves it under the new ancestors' subscriptions automatically (rows are by root).

## References
- apps/server/src/db/schema-notifications.ts, routes/notificationSettings.ts, notify/kinds.ts (`decide`)
