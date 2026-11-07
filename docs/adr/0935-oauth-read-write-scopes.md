# 0935. Read-only MCP tokens: OAuth `read` / `write` scopes

- Status: Accepted
- Date: 2026-11-07

## Context
The remote MCP connector issued one scope, `notes`, which allowed every tool: read, search,
create, edit, comment, move and trash. Users who only want an assistant to *answer from* their
notes had to hand it write access too. `oauth_codes.scope` and `oauth_grants.scope` already
existed (text) but always held `notes` or null, and `ToolCtx.canWrite` was hard-coded to `true`.
Existing connections (Claude Code, claude.ai, Codex) send either no `scope` or `scope=notes` and
expect to write; they must keep working without reconnecting.

## Decision
- **Scope strings**: `read` and `write` (`write` implies `read`). New grants store exactly one of
  two normalized values: `read` (read-only) or `read write` (full). The metadata documents
  advertise `scopes_supported: ["read", "write"]`. `notes` is still accepted but no longer
  advertised.
- **One decision function**, `canWriteFromScopes(scope)` (apps/server/src/oauth.ts:46): null,
  empty or anything containing `notes` or `write` may write; a scope holding only `read`, or only
  unknown values, may not (fail closed). `undefined` means "not a bearer request" (cookie) → true.
  It is used by `requireUser`, the `/mcp` handler and the connected-apps list, and is what the
  tests exercise.
- **Request → consent → grant**: `requestedAccess(scope)` (oauth.ts:56) reads the authorization
  request: no scope, `notes`, `write` or only unknown values (e.g. `openid`) → `write`; only
  `read` → `read`. `/api/oauth/authorize/info` returns it as `requestedAccess`. The consent
  screen shows a two-option choice ("Read and write" / "Read only") and posts it as `access`.
  `grantedScope(requested, choice)` (oauth.ts:68) never widens the request: a client that asked
  for `read` gets `read` whatever the body says (the radio is also disabled in the UI). A body
  without `access` (an SPA build from before this change) gets what the client requested. The
  code stores the result, the token exchange copies it to the grant, and refresh never changes
  it (a `scope` parameter on refresh is ignored). Token responses return the stored string
  (`read write` for legacy null grants).
- **Default choice = read and write** unless the client explicitly asked only for `read`.
  Every client in use today asks for nothing or `notes`, and its users expect the edit tools that
  the tool list advertises; a read-only default would silently turn every reconnect (tokens are
  re-consented when refresh tokens expire after 60 days) into a connector whose writes fail. The
  choice is shown on the same screen, one click away, so least privilege is available without
  breaking existing flows.
- **Enforcement, three layers**:
  1. MCP tools: the `/mcp` handler sets `canWrite: canWriteFromScopes(user.scope)`
     (apps/server/src/mcp.ts:670); `wrapWrite` answers write tools with `READ_ONLY_MESSAGE`
     (apps/server/src/mcpTools/core.ts:107) before any REST call.
  2. REST (defense in depth): `requireUser` answers a read-only bearer token 403 on every method
     other than GET/HEAD (apps/server/src/auth.ts:178), so a future tool that forgets
     `wrapWrite` still cannot write. A non-GET route that never writes opts out with
     `config: { bearerReadOnlyOk: true }` (declared in auth.ts:49; used by
     `POST /workspaces/:id/query`, apps/server/src/routes/query.ts:77).
  3. Server instructions: a read-only session gets one extra sentence at the end
     (`READ_ONLY_INSTRUCTION`, mcp.ts:153) so the model tells the user to reconnect instead of
     retrying.
- **Write tools stay listed** for read-only sessions. Hiding them (`RegisteredTool.disable()`)
  would turn a call into a protocol error ("Tool update_page disabled") instead of the
  actionable `READ_ONLY_MESSAGE`; clients cache tool lists across reconnects, so a user who
  upgrades to read+write could keep a stale, shorter list; and hiding needs a reliable
  read/write classification of every tool another module registers (`readOnlyHint` is a hint,
  not a contract). Read tools already carry `readOnlyHint: true`, so clients that filter by it
  can still do so.
- **Connected apps** (`GET /api/oauth/grants`) returns an additive `access: 'read' | 'write'`;
  the connections page shows a "Read only" / "Read & write" badge.

## Alternatives considered
- `notes:read` / `notes:write`: more namespaced, but there is one resource and the existing
  `READ_ONLY_MESSAGE` already speaks of scope `read`; shorter strings read better on the consent
  screen and in client configs.
- Read-only by default: least privilege, but breaks the expectation of every existing client
  (see Decision).
- Enforce only in `wrapWrite`: one layer; a new tool written without it would write. The REST
  check costs one comparison per bearer request.
- Hide write tools from `tools/list`: see Decision.

## Trade-offs
- A read-only token cannot call a non-GET read route until that route opts in with
  `bearerReadOnlyOk`; the failure is a clear 403, never a silent write.
- Scope changes need a reconnect (new consent); there is no "upgrade this grant" button.
- Legacy `notes` grants stay full access forever (until revoked or the refresh token expires).

## How others solve it
- GitHub OAuth apps and Google APIs use separate read and write scopes (`repo` vs
  `public_repo`, `drive.readonly` vs `drive`) and let the authorization server grant fewer scopes
  than requested (RFC 6749 §3.3), reporting the granted set in the token response.
- Notion and Slack integrations pick capabilities at install time on a consent screen, as here.
- The MCP authorization spec leaves scope semantics to the server and expects 403
  `insufficient_scope` for missing scopes; our tools answer with an in-band tool error instead,
  which models handle better than a transport error.

## Consequences
- New connections can be read-only; existing ones keep working unchanged.
- Any new non-GET REST route that only reads and is used by an MCP read tool must set
  `bearerReadOnlyOk: true`.
- Any new MCP write tool must use `wrapWrite` (the REST layer is the backstop, not the UX).

## References
- apps/server/src/oauth.ts:25 (LEGACY_SCOPE), :27 (SUPPORTED_SCOPES), :46 (canWriteFromScopes),
  :56 (requestedAccess), :68 (grantedScope), :214 (getBearerUser returns scope)
- apps/server/src/auth.ts:49 (bearerReadOnlyOk), :54 (READ_ONLY_TOKEN_MESSAGE), :178 (403 check)
- apps/server/src/routes/oauth.ts:120, :137 (scopes_supported), :334 (access body field),
  :356 (requestedAccess in info), :401 (code scope), :429 (grant list access)
- apps/server/src/mcp.ts:153, :161 (read-only instruction), :670 (canWrite wiring)
- apps/server/src/mcpTools/core.ts:107, :114 (READ_ONLY_MESSAGE, wrapWrite)
- apps/server/src/routes/query.ts:77
- apps/web/src/pages/OAuthAuthorize.tsx:26 (access choice), apps/web/src/pages/Connections.tsx:77
- apps/server/src/oauthScopes.test.ts
