# 1253. Guests and tokens, guests and the workspace 2FA requirement

- Status: Accepted
- Date: 2026-11-08

## Context
An account can be a member of its own workspace and a guest elsewhere. Its MCP connections and API
tokens (docs/adr/0935-*, 1201-*) act as the account. A workspace may require two-step verification
(docs/adr/1112-*), whose stated reason is a team inviting outsiders.

## Decision
- **Tokens do not reach guest workspaces.** For bearer requests (OAuth MCP and API tokens) the guest
  scope is entered with `token: true`: `visibleTo` hides the guest workspaces entirely, the guest
  membership path is never taken (`isGuestIn` is false), `GET /workspaces` leaves them out. The
  account's own workspaces work as before. Reasons: the workspace's owners cannot see or block a
  guest's agents (agent blocks and the Connected agents list are per member, docs/adr/0947-*); agent
  instructions and lock rules for agents were written for members' agents; a guest's automation
  copying a shared tree elsewhere is a new exfiltration path the inviter did not decide on. Notion
  makes the same call (guests cannot connect MCP). Allowing it later is a policy switch: the scope
  composes with ranges already.
- **The 2FA requirement applies to guests.** The guest membership path and the socket check
  `twoFactorBlockedSql` like the member path; a guest who has not turned 2FA on gets 403
  `TWO_FACTOR_REQUIRED` once the workspace's grace period is over (added guests get no fresh grace,
  as for late members). Delegated and OIDC accounts satisfy it as in 1112/1162.

## Alternatives considered
- **Guests may use tokens within their pages**: technically free with the scope, but the owner has no
  control over it (above). Kept as an option, off.
- **Exempt guests from 2FA**: the weakest accounts in the workspace would be the outsiders.

## Consequences
- A guest who wants an agent on a shared page asks to be made a member, or the owner exports it.
- Tests: `guests.db.test.ts` ("tokens of a guest", "the workspace 2FA requirement applies to guests").
