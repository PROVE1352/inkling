# 0928. Partial reads (outline/section), batch reads, compact list/search output

- Status: Accepted
- Date: 2026-11-07

## Context
`read_page` always returned the whole page; `list_pages` returned up to 500 JSON objects with seven
fields each (≈ 970 estimated tokens for 25 pages); `search` returned JSON. Agents paid for structure
they did not need and could not ask for less.

## Decision
- **`read_page`** gains three optional parameters; without them the output is byte-for-byte the old
  one (same header, same body):
  - `outline=true` → `GET /api/pages/:id/outline`: one line per section,
    `- §anchor  Heading › Path  ~N tok  v=<version>`.
  - `section=<ref>` → `GET /api/pages/:id/section?ref=`: that section's blocks rendered with the same
    Markdown exporter as a full read, plus `§anchor v=…`. An unknown reference answers 404 with the
    list of valid anchors.
  - `maxChars` caps the body and says how to read the rest.
  Both routes read the live in-memory document when it is open (`liveDocState`), else `page_docs`.
- **`read_pages(pageIds ≤ 20, budget)`** → `GET /api/pages/read?ids=…`: one permission query
  (`inArray` + `visibleTo` + live page + live workspace + membership) and one `page_docs` query for
  all ids; pages are rendered in the requested order until the budget (default 8,000, max 30,000
  estimated tokens) is spent, the last one cut, the rest listed by title/id. Invisible ids are
  reported as "not found or not visible" without distinguishing why.
- **Defaults stay backward compatible.** `list_pages` and `search` keep returning the legacy JSON
  (same fields) unless `format: "lines"` is passed. `list_pages` also gets `depth` (with `parentId`
  a JSON caller still gets only direct children when `depth` is omitted, as before).
  `lines` output: `- Title [kind] 🔒 <id> (+N)` indented per level (`+N` = children hidden by the depth
  limit) and `<id> | Title | snippet` for search. On the evaluation wiki: list_pages 967 → 392
  tokens, search 75 → 43 (context.db.test.ts log lines).
- All new read routes are `GET`, so read-only tokens (ADR 0935) can use them.

## Alternatives considered
- **Compact by default.** Saves tokens for agents that never read descriptions, and no in-repo code
  parses the MCP JSON. Rejected because tool results are a de-facto contract for scripts built on the
  connector and the request explicitly asked not to break clients that rely on existing fields; the
  server instructions and tool descriptions steer agents to `find_context` and `format: "lines"`,
  which captures most of the saving.
- **Serving outline/section from `page_chunks`.** Cheaper, but up to 30 s stale while someone types
  and would not reproduce the exporter's Markdown; a block conversion of one page costs a few ms.
- **POST for read_pages.** Would need a read-only exemption (ADR 0935); a 20-id query string is
  < 800 characters.

## Trade-offs
- `read_page(outline)` + `read_page(section)` is two calls; `find_context` usually makes both
  unnecessary.
- Full `read_page` output does not carry section versions (that would cost tokens on every read);
  agents that want to patch read the outline first.

## How others solve it
Notion's API pages blocks with cursors; Confluence exposes body by section macro; most MCP doc
servers offer `get_outline`/`get_section` style tools for long documents.

## Consequences
- `docs/API.md` lists the new routes; `docs/MCP.md` documents the parameters and formats.

## References
- apps/server/src/routes/context.ts:214 (routes), :52 (read limits)
- apps/server/src/mcp.ts:63 (`renderPageList`), :180 (list_pages), :207 (search), :256 (read_page)
- apps/server/src/mcpTools/contextTools.ts:50 (`renderReadPages`)
- apps/server/src/context/context.db.test.ts ("read_page: outline, section…", "list_pages / search…")
