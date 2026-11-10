# 1943. workspaceId inferred from a page or the only workspace; fewer calls before the first answer

- Status: Accepted
- Date: 2026-11-10

## Context
The instructions told agents to call `get_instructions(workspaceId)` once before working in a
workspace, and every workspace-scoped tool required a workspaceId. A question became
list_workspaces → get_instructions → find_context: three round trips before any content, and
create_page needed a workspaceId even with a parentId that already names the workspace.

## Decision
- `inferWorkspace(ctx, workspaceId?, pageId?)` (`mcpTools/idArgs.ts`): the argument if given; else the
  workspace of the page argument (looked up as this connection, `findVisiblePage` in `runAsConnection`);
  else the only workspace of this connection (`GET /api/workspaces`). With several and no hint:
  `workspaceId is required: this connection has 2 workspaces: a65ac6ab "Team notes", df89bf9c "Side
  project". Pass one (8 characters are enough).` — the list_workspaces call is inside the error.
- Optional workspaceId: list_pages (parentId), create_page (parentId), import_folder (parentId),
  create_from_template (parentId), create_collection (parentId), get_instructions (forPageId),
  list_templates, list_trash. find_context, search, catch_up, changes_since, later and inbox already
  took it as optional ("all workspaces").
- **Instructions round trip**: with one workspace (or a page id at hand) get_instructions needs no
  list_workspaces first, so a question is get_instructions → find_context (two calls instead of three).
  SERVER_INSTRUCTIONS keeps "call it once before working in a workspace" and drops `(workspaceId)`.
  Telling agents they may skip it when a read shows no `applies:` line was considered and not done:
  list_comments, catch_up and changes_since return member text without an `applies:` line.
- **Trust boundary unchanged**: only which workspace is asked is inferred. get_instructions still reads
  the bundle route, which returns only designated, locked instruction pages (ADR 0975); page text stays
  data.

## Alternatives considered
- **Instructions inside the find_context answer**: the always-instructions in full would repeat in
  every answer (and the find_context output belongs to another work stream). find_context results
  already carry the `applies:` line for their pages; a one-line "this workspace has instructions" hint
  in its answer (so an agent can skip get_instructions when there are none) is left to its owners.
- **A default workspace per connection**: state per connection (settings UI) for what the page argument
  or the single workspace already says.

## Consequences
- Fewer round trips: list_workspaces is not needed with one workspace or a page id.
- An agent with several workspaces and no page argument gets an error that lists them instead of a
  validation error; the retry is one call either way.
- Tests: `toolSurface.db.test.ts` (one workspace: list_pages, get_instructions, list_templates,
  list_trash, create_page without it; two: inferred from parentId, otherwise the listing error, a
  workspace the user is not in never listed).

## References
- apps/server/src/mcpTools/idArgs.ts (`inferWorkspace`), mcp.ts (SERVER_INSTRUCTIONS), instructionTools.ts,
  structureTools.ts, historyInkFileTools.ts
- docs/adr/0975-*, 1940-*
