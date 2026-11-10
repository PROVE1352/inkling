# 1803. /inkling: ephemeral find_context for linked members only

- Status: Accepted
- Date: 2026-11-10

## Context
`/inkling <words>` should answer from the notes, but a Slack user is not an Inkling session. Showing
results to the wrong person would leak private pages.

## Decision
- The answer is always `response_type: ephemeral` (only the person who typed it sees it) and is
  find_context (cached, ADR 1550) **as the linked Inkling user**, limited to this workspace: up to five
  sections with title, heading, a 200-character snippet and a link. Their own private pages may appear
  (only they see the answer); nobody else's do.
- **Linking**: (1) an explicit link: `/inkling link` answers a one-time URL `…/slack/link#code=…` (24
  random bytes, SHA-256 stored, 10 minutes, single use). The code is in the fragment, so it reaches no
  access log; the web page posts it to `/api/slack/link/preview` and `/confirm` while signed in, which
  binds that Slack user to the signed-in member. (2) An email match: Slack `users.info` says the address
  is confirmed and exactly one member of the workspace has it (case-insensitive); the match is stored
  (`method = 'email'`) so later commands need no Slack call. One Slack account per member per workspace.
- Membership is checked on every command (same list find_context uses: live workspace, 2FA rule, no
  guests). An unlinked or non-member user gets instructions only, never results.
- `/inkling unlink` removes the link; owners see and remove links in the settings.

## Consequences
- Email matching trusts the Slack workspace's admins not to change a member's address to someone
  else's. Teams that do not want that link explicitly (the Inkling side cannot tell).

## References
- docs/adr/0926-*, 1550-*, 1804-*
- `apps/server/src/slack/inbound.ts`, `apps/web/src/pages/SlackLink.tsx`
