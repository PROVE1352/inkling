# 1948. Backlinks on read_page; create_page makes canvases and folders

- Status: Accepted
- Date: 2026-11-10

## Context
Evaluation 2026-11-10, "half-built": MCP had no backlinks (REST `GET /pages/:id/backlinks` exists) and
create_page could not make a canvas or a folder (no kind argument). File upload through MCP is out of
scope (backlog).

## Decision
- `read_page(backlinks=true)` adds `linked from (n): <id8> "Title", …` after the page (after the
  trailer of ADR 1946; in an outline or section read, after its last line). Sources come from the REST
  route (visible, live pages only; another member's private page that links here is never listed),
  ordered by title then id in code-unit order (the route orders by edit time, which would change the
  bytes on every edit of a source; `localeCompare` would depend on the host's locale data), at most 50 then `… n more`. Titles go through `cleanText`. Cost in the tool list: +23
  tokens; a read without it is unchanged.
- `create_page(kind='canvas'|'folder')` creates an empty page of that kind through `POST /api/pages`
  (the web app's route: placement, locks, range and section rules apply). Markdown is refused for them
  (`a folder has no Markdown body; …`). `markdown` became optional (an empty document is created, tested).
  The JSON answer gains `kind` only for non-documents, so document answers are byte-identical. +27
  tokens.

## Alternatives considered
- **A `backlinks` tool**: ~180 tokens in every list (a tool's fixed cost) for what one boolean does.
- **Backlinks on every read**: one more query per read and lines most reads do not need.
- **kind=collection through create_page**: create_collection already exists with fields.

## References
- apps/server/src/mcp.ts (`backlinksLine`, read_page, create_page)
- apps/server/src/routes/pages.ts (`/pages/:id/backlinks`, `POST /pages`)
- Tests: toolSurface.db.test.ts
