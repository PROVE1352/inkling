# 1204. One table of routes that bearer tokens may not call

- Status: Accepted
- Date: 2026-11-07

## Context
Before API tokens, a bearer token reached REST only through `/mcp`'s inject, so the MCP tool list was the
effective allow-list. Some routes protected themselves with `req.authVia !== 'cookie'` (2FA, password,
OAuth consent, workspace administration, notification settings, edit locks, plugins, sidebar, admin API);
others relied on no tool calling them. An API token (docs/adr/1201-*) reaches all of them.

## Decision
- `tokenPolicy.ts` holds three tables matched on the route pattern Fastify resolved
  (`req.routeOptions.url`, never the raw URL), checked in `requireUser` after a bearer token is accepted,
  for API tokens and OAuth tokens alike:
  - **SESSION_ONLY**, every token: iCal feed token, workspace webhooks (all routes), creating or changing
    public links, sending to Notion, sheet-sync settings, permanent delete (purge), joining by invite,
    regenerating the invite code, adding/removing members and changing roles, ownership transfer,
    workspace rename, delete, restore and the deleted list. Reason: credentials, membership, data sent
    to outside URLs, or actions that cannot be undone.
  - **RANGED_DENY**, any limited range: creating a workspace, invite preview, member candidates (people
    from other workspaces).
  - **SUBTREE_DENY**, subtree range: workspace templates (they are copies of pages from anywhere) and
    creating from a template.
- Routes with their own cookie check are not repeated. `GET /workspaces` hides invite codes from tokens.
- Refusals are 403 with a fixed message (session-only) or `OUT_OF_RANGE`.

## Alternatives considered
- **An allow-list for tokens**: safest by default, but the REST surface is ~250 routes and most are
  page reads and writes a script legitimately needs; the list would lag every new feature.
- **A `sessionOnly` flag on each route**: spreads the decision over many files (some owned by other
  work) and is easy to forget; one table is reviewable in one place and tested as a whole.

## Consequences
- A new route that must stay in the browser goes into the table (or checks `authVia` itself). The unit
  test walks every entry; the [db] test calls a sample of them with a real token.
- Read-only tokens are refused on every non-GET route by method regardless of this table (0935).

## References
- apps/server/src/tokenPolicy.ts, apps/server/src/auth.ts, apps/server/src/routes/workspaces.ts (invite codes)
- Tests: apps/server/src/tokenRange.test.ts ("bearer route policy"), tokenRange.db.test.ts ("session-only routes")
