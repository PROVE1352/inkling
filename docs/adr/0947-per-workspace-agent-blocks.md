# 0947. Per-workspace agent blocks, enforced per request

- Status: Accepted
- Date: 2026-11-07

## Context
An OAuth connection (grant) belongs to a user and reaches every workspace that user is in
(docs/adr/0935-*). A workspace owner may want a member's agent out of *their* workspace without
cutting that member's agent everywhere, and needs to see which agents touched the workspace.
`oauth_grants.last_used_at` is global, not per workspace.

## Decision
- **Blocks**: `workspace_agent_blocks (workspace_id, user_id, client_id NULL = every client,
  client_name, created_by)`, unique NULLS NOT DISTINCT (schema-workspaceAdmin.ts:58). Keyed by
  user + client, not by grant: reconnecting creates a new grant, the same client id stays. Owners
  and admins manage blocks; admins cannot block an owner's agents. Grants themselves are only
  revoked by their user (Settings → Connections) or by removing the account (server admin).
- **Enforcement** (no-op for browser sessions):
  - `requireUser`, used as a preHandler, continues a bearer request inside an AsyncLocalStorage
    scope `{ userId, grantId, clientId }` entered around Fastify's `done` callback
    (apps/server/src/auth.ts:169). A store entered with `run()` around `app.inject` does not
    survive into the injected request (verified), so the scope is entered on the request side.
  - `requireMembership` calls `assertAgentAllowed(workspaceId)` (helpers.ts:53) → 403
    `AGENT_BLOCKED`, and records access; `findVisiblePage` adds `agentAllowedSql`
    (pageDto.ts:125) so single-page routes answer 404.
  - Cross-workspace lists add `agentAllowedSql`: `GET /workspaces` (list_workspaces, search
    across workspaces), `memberWorkspaceIds` (find_context without a workspace, read_pages),
    the change feed subquery.
  Because every MCP tool calls REST through `app.inject` with the bearer token, the same rule
  applies to MCP tools and to REST.
- **Access records**: `workspace_agent_access (workspace_id, grant_id, user_id, client_id,
  first_used_at, last_used_at)`, upserted at most once a minute per (workspace, grant) in the
  same choke point (agentAccess.ts:79). `GET /workspaces/:id/agents` lists connections of current
  members with access (read/write), last use and whether a block matches, plus the blocks.

## Alternatives considered
- Bind tokens to a workspace at consent time: breaks every existing connection and the
  "one connector, all my notes" model.
- Delete the grant from the workspace screen: cuts the member's other workspaces; a workspace
  owner has no say there.
- Check blocks in each MCP tool: misses direct REST paths and future tools.

## Trade-offs
- A client can re-register under a new `client_id` and slip past a per-client block; "block all
  agents of this member" (client NULL) is the robust option (KNOWN-ISSUES).
- One extra indexed query per membership check for bearer requests.
- Searches across all workspaces do not create access rows for workspaces they did not reach
  through `requireMembership`.

## How others solve it
- GitHub OAuth app access restrictions: organization owners approve or deny an app for the
  organization; the user's token keeps working elsewhere.
  https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions
- Slack app approval: workspace admins allow or restrict apps per workspace.
- Notion MCP: Enterprise can allow-list MCP clients; no per-app revoke ("Disconnect All Users").
  https://www.notion.com/help/notion-mcp

## Consequences
- `AuthUser` gained `grantId` / `clientId` for bearer requests (oauth.ts `getBearerUser`).
- The workspace screen shows agents without exposing tokens or other workspaces.

## References
- apps/server/src/agentAccess.ts:65, :79
- apps/server/src/auth.ts:169, apps/server/src/helpers.ts:53, apps/server/src/pageDto.ts:125
- apps/server/src/context/retrieve.ts:57, apps/server/src/context/changeFeed.ts:494
- apps/server/src/routes/workspaces.ts:163, apps/server/src/routes/workspaceAdmin.ts:181, :254
