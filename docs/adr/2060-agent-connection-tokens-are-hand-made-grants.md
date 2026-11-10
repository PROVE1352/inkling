# 2060. Agent connection tokens: hand-made agent connections, stored as OAuth grants

- Status: Accepted
- Date: 2026-11-10
- Supplements: [1201](1201-personal-api-tokens-for-rest.md) (personal API tokens stay 401 at `/mcp`)

## Context
`/mcp` took only OAuth 2.1 access tokens made by the authorization code flow with dynamic client registration
(0935, 0936). Clients that cannot register themselves, servers on plain `http://` at an address other than
localhost, and self-signed setups had no way in. The connection settings generator (2020) already had a token
mode, switched off because the only static token, the personal API token of 1201, is 401 at `/mcp` and is
deliberately "not an agent": no agent blocks, no agent lock rules, no `via` label, no "Connected agents" entry.
Opening `/mcp` to API tokens would have made an agent connection that none of those rules see.

Since 0.12 to 0.16 an agent connection carries much more than a scope: per-workspace blocks (0947), agent lock
rules and instruction pages (0970, 0971, 0975), edit policies and suggestions (1530 ff.), section claims (1535),
usage numbers (1552), the change feed's agent marker and revert (1620 ff.), the team agents board, hand-offs and
assignments (1860 ff.), suggest-only after flagged content (2040 ff.), tool profiles, resources and prompts
(2000 ff.). Every one of these keys on the grant id and the OAuth client id: `workspace_agent_access` and
`workspace_agent_blocks` reference `oauth_grants` / `oauth_clients`, the connection key is `grant:<id>`, the
team agents SQL, the notification label, the admin usage status and the release routes resolve `grant:` keys
through those two tables, and `loadAgentContext` needs a `grantId` and a `clientId`.

## Decision
- **An agent connection token is an OAuth grant of kind `token`**, made by a person on Settings › Connections
  instead of by the authorization code flow. New columns on `oauth_grants` (migration 0049): `kind`
  (`'oauth'` default, `'token'`) and `token_prefix`. Each token gets **its own `oauth_clients` row** (id
  `ink_tc_…`, `redirect_uris = []`) whose name is the name the person gave: that name is the `via` label,
  the name in Connected agents, on the team agents board, in the audit log and in blocks.
- **One merge point.** `getBearerUser` already finds a grant by `sha256(token)` and returns the `AuthUser`
  with `grantId`, `clientId`, `via`, scope and range; `requireUser` enters the agent and connection scopes
  from it. Nothing after that point knows how the grant was made, so no rule has a "token" branch. The
  differences live where a grant is made, refreshed, listed and revoked:
  - made: `POST /api/agent-tokens` (browser session only, 2063); one access token, valid until the chosen
    expiry (2061); `refresh_hash` is the hash of random bytes nobody holds and `refresh_expires_at` equals the
    expiry, so `purgeExpiredOAuth` and the team agents liveness check (`refresh_expires_at > now()`) treat it
    like any grant;
  - refreshed: never — `/oauth/token` refuses a grant whose kind is not `oauth` (defence in depth);
  - authorized: never — a client with no redirect URIs fails `validateClientRedirect`;
  - listed: `GET /api/agent-tokens`; `GET /api/oauth/grants` lists only `kind = 'oauth'`;
  - range changed: `PATCH /api/oauth/grants/:id`, the same route as OAuth connections;
  - revoked: `DELETE /api/agent-tokens/:id` or `DELETE /api/oauth/grants/:id`, both through
    `revokeConnection`: the grant and its client row go in one transaction, the revocation is audited (2063),
    hand-offs fall back to the person (1863). The hourly purge also deletes `ink_tc_` client rows left
    without a grant (a password reset deletes grants, as for every bearer credential).
- **Rules, all inherited, none re-implemented:**

  | Rule | Where it is enforced | Holds for the token because |
  |---|---|---|
  | Agent edit lock, instructions | `assertCan` / `editLock.ts` read the agent scope | `runAsAgent` from `grantId` + `clientId` |
  | Edit policy direct/auto/review, suggestions | `suggestionMode`, `autoAccept.ts` | same agent scope and `grant:` key |
  | Section claims | `section_leases.connection` | `connectionKey(user)` = `grant:<id>` |
  | Usage | `connectionUsage.ts`, meter frame | keyed on `grantId` |
  | Agent blocks, two-step requirement | `assertAgentAllowed`, `requireMembership` | block on its client id; the person's 2FA state |
  | Member-name clash per workspace | `clientNameClashesInWorkspace` | the client name is the token's name |
  | `via` label, change feed, revert by via | `page_changes.via_client` | `via` = client name |
  | Connected agents list, workspace access record | `workspace_agent_access` | FK to the grant and client |
  | Team agents: board, inbox, hand-offs, assignment | `teamAgents.ts` SQL on `oauth_grants` | listed as kind `grant` with the client name |
  | Suggest-only after flagged content | `connection_taints.connection` | key `grant:<id>`; released by its owner |
  | Read-only scope, range | `canWriteFromScopes`, `runInRange` | `scope` and range columns as chosen at issue |
  | Tool profiles, resources, prompts | `/mcp?profile=`, `buildMcpServer` | the same `/mcp` handler |
  | Only at `/mcp` | `requireUser` (MCP internal header) | it is not `ink_pat_`-shaped, so the grant path applies |

- **ADR 1201 is unchanged**: a personal API token is still the person, for the REST API, and still 401 at
  `/mcp`. An agent connection token is still an agent, for `/mcp` only, and 401 on the REST API outside
  `/mcp`. Each credential has one meaning.

## Alternatives considered
- **Accept personal API tokens at `/mcp`** (the request in 2020): either the token becomes an agent only at
  `/mcp` (one credential, two identities, and the agent scope would need a `token:` branch in every rule above)
  or it stays "the person" there (agent rules silently skipped for a connection that runs an agent). Rejected.
- **A new `agent_tokens` table**: a third connection kind (`grant:`, `token:`, and a new prefix) in about fifteen
  files — the FKs of `workspace_agent_access` and `workspace_agent_blocks`, the team agents and notification SQL,
  the admin usage status, the release routes, `loadAgentContext` — each a place to forget. Rejected: the point is
  that a missing branch cannot exist.
- **A long-lived OAuth refresh token handed to the person**: still needs a client that speaks OAuth to use it.
- **Static client credentials (`client_credentials` grant)**: a second secret and a token exchange the clients in
  question do not implement either.

## Consequences
- Any future rule written for agent connections applies to agent connection tokens without extra work, and a
  rule that needs to tell them apart can read `oauth_grants.kind`.
- `oauth_clients` gains one row per token; nothing lists clients on their own.
- The 2020 generator's token mode is on and fills in only `ink_agt_` tokens (2063).
