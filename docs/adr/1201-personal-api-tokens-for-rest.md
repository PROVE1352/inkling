# 1201. Personal API tokens for the REST API

- Status: Accepted
- Date: 2026-11-07

## Context
The REST API could only be used with the browser session cookie. inklingctl stored that cookie (from a
password login or `deploy/cli-token.sh`), which is full access for 30 days, cannot be limited, does not
show where it is used, and is the same credential the browser uses. OAuth access tokens are valid only
inside `/mcp` (`MCP_INTERNAL_HEADER`, 0935) and expire after an hour.

## Decision
- **Format**: `ink_pat_` + 32 random bytes in base64url (43 characters). The prefix tells a person, a
  log scrubber or a secret scanner what leaked, and lets `requireUser` route the token without a lookup.
  Registering the pattern with GitHub secret scanning (partner program) is left to whoever runs a public
  instance; the regex is `ink_pat_[A-Za-z0-9_-]{43}`.
- **Storage** (`api_tokens`): SHA-256 of the whole token, like sessions (docs/adr/1060-*), plus the first
  12 characters for the list, name, `scope` (`read` or `read write`, the strings of 0935), the range of
  docs/adr/1200-*, `expires_at` (30 / 90 / 365 days or null), `last_used_at`, `last_used_ip`. Shown once
  in the `POST /api/tokens` answer (`Cache-Control: no-store`). At most 50 per account. Revoke = delete.
- **Use**: `Authorization: Bearer ink_pat_…` on any `/api` route. `requireUser` checks the shape, refuses
  a banned IP (guard), looks the hash up (expired = 401), counts a miss as an auth failure for the IP ban,
  sets `authVia = 'bearer'` and `user.tokenId`, refuses non-GET routes for read-only tokens unless the
  route is `bearerReadOnlyOk` (same backstop as 0935), applies the bearer route policy
  (docs/adr/1204-*) and runs the request in the token's range. Last use is written at most once a minute
  per token, or when the IP changes.
- **Not an agent**: an API token acts as the person. It does not enter the agent scope of 0947, so agent
  blocks, agent lock rules (0971), `via` labels and the "Connected agents" list are for OAuth clients
  only. An API token at `/mcp` is 401 (the MCP lookup reads grants only), and an OAuth token on REST
  outside `/mcp` stays 401.
- **Origin check** (docs/adr/1062-*): requests with an `Authorization` header are already exempt; a
  token is not an ambient credential, so a cross-site page cannot use it.
- **Session-only management**: list, create, rename, change range, revoke under `/api/tokens` are
  browser sessions only, so a leaked token cannot mint a longer-lived one or hide itself.
- **Two-step verification** (docs/adr/1112-*): a token runs as its owner through the same membership and
  page checks, so a workspace that blocks the owner refuses the token with 403 `TWO_FACTOR_REQUIRED`;
  accounts created by OIDC or delegated sign-in satisfy it as they do in the browser (1162). Creating a
  token needs no fresh 2FA prompt (out of scope; see Consequences).
- **Revocation**: `setPassword` (self change, reset by code, admin temporary password) deletes all of the
  account's tokens in the same transaction that deletes sessions and OAuth grants: the rule for every
  bearer credential minted under the old password. Instance admins list a user's tokens and revoke one
  or all (`/api/admin/users/:id/api-tokens`, `/api/admin/api-tokens/:id`, browser sessions only).
  Housekeeping deletes expired tokens hourly.
- **Rate limit**: the global limiter keys requests with an API token by a hash prefix of the token
  (`rateLimitKey`), others by IP, so a script and its owner's browser behind one NAT do not share a budget.

## Alternatives considered
- **Let OAuth access tokens work on REST**: they expire hourly and need a refresh flow; scripts want a
  static secret.
- **Store tokens encrypted**: the server never needs the raw token again; a hash is enough and safer.
- **Treat tokens as agents**: workspace owners could block them, but every script would write as
  "via API token" and lock rules for agents would apply to the person's own sync. Kept separate; owners
  can still remove a member, and the token owner sees each token's last use.
- **Keep password reset from touching tokens**: CI keeps running, but a token minted with a stolen session
  would survive the reset that is meant to end the theft. Same rule as grants and iCal tokens.

## Consequences
- A token is a bearer secret with up to "never" expiry; the list shows last use and IP to spot misuse.
- Creating a token needs only a signed-in session (no password re-entry); recorded as a remaining risk.
- Changing the password stops every script; the guide says so.

## References
- apps/server/src/apiTokens.ts, apps/server/src/routes/apiTokens.ts, apps/server/src/auth.ts (authenticate)
- apps/server/src/rateLimitKey.ts, apps/server/src/accounts.ts (setPassword), apps/server/src/housekeeping.ts
- apps/server/src/db/schema-apiTokens.ts; apps/web/src/pages/Connections.tsx, apps/web/src/components/AdminUserTokens.tsx
- Tests: apps/server/src/tokenRange.db.test.ts ("API tokens"), apps/server/src/tokenRange.test.ts
