# 1200. A connection can be limited to some workspaces or one page's subtree

- Status: Accepted
- Date: 2026-11-07

## Context
An OAuth grant (MCP connection) reaches every workspace and page its user can see (docs/adr/0935-*,
0947-*). People who connect an assistant for one project, or a script that should only touch one folder,
had to hand over everything. Workspace owners can block an agent per workspace (0947), but the person
who connects cannot narrow their own connection. Personal API tokens (docs/adr/1201-*) need the same choice.

## Decision
- **Model** (`packages/shared/src/accessTokens.ts`): `AccessRange = all | workspaces(ids, 1–20) |
  subtree(pageId)`. One range per connection, chosen by the person, never by the client. It only narrows:
  inside the range the owner's own permissions (membership, private pages, locks, 2FA) still apply.
- **Storage** (`db/schema-range.ts`): three nullable columns on `oauth_codes`, `oauth_grants` and
  `api_tokens`: `range_kind`, `range_workspace_ids uuid[]`, `range_page_id uuid`. `range_kind` null
  means `all`, so every grant made before this keeps working unchanged. The subtree stores only the root
  page id, without a foreign key: the root's workspace is read at request time from the root row (one
  subselect in the token lookup), so a root that moves follows, and a root that is purged leaves the
  connection seeing nothing. `columnsToRange` fails closed: an unknown kind or a kind without its value
  reads as an empty workspace list, never as `all`.
- **Choosing it**: the consent screen shows a range picker under the access choice (everything / tick
  workspaces / pick a page in a workspace's tree) and posts `range`; a body without it (an older SPA)
  means `all`. The code stores it, the token exchange copies it to the grant, refresh never changes it.
  Settings → Connections shows a badge per connection and **Change range** (`PATCH /api/oauth/grants/:id
  { range }`, browser sessions only); the next request uses the new range, no reconnect. Unlike the
  read/write scope (0935), a range is not something the client asked for, so changing it later does not
  go against what the client was told at the token endpoint.
- **Validation** (`validateRange`): workspaces must be live and the person a member; a subtree root must
  be a page `findVisiblePage` returns for them. 400 `INVALID_RANGE` otherwise.
- **Agents are told**: the MCP server instructions get one more sentence for a limited connection
  (`rangeInstruction`), and the 403 `OUT_OF_RANGE` maps to a next-step hint in `mcpTools/core.ts`.
- Enforcement is docs/adr/1202-*.

## Alternatives considered
- **Scopes per workspace in the OAuth `scope` string** (`ws:<id>`): clients would have to know ids before
  consent, and the request could widen what the person meant. Rejected; the range is a consent-screen choice.
- **Several subtree roots, or workspaces plus a subtree**: more general, but every check becomes a union
  of walks and the picker gets hard to read. One root covers "this project"; a parent folder covers more.
- **Store the root's workspace with the range**: saves a subselect, but goes stale when the root moves.
- **Foreign key with ON DELETE SET NULL / CASCADE**: SET NULL would turn a deleted root into "everything";
  CASCADE would delete the grant silently. No key, and fail closed.

## Consequences
- Existing connections and clients are unchanged; the grant list response gains an additive `range`.
- A range that names something the owner no longer sees shows "(no longer available)" and sees nothing there.

## References
- packages/shared/src/accessTokens.ts, apps/server/src/tokenRange.ts, apps/server/src/db/schema-range.ts
- apps/server/src/routes/oauth.ts (consent, token exchange, `PATCH /oauth/grants/:id`, grant list)
- apps/web/src/components/RangePicker.tsx, apps/web/src/pages/OAuthAuthorize.tsx, apps/web/src/pages/Connections.tsx
- Tests: apps/server/src/tokenRange.test.ts, apps/server/src/tokenRange.db.test.ts
