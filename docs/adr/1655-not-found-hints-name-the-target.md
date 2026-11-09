# 1655. Not-found hints name what was not found

- Status: Accepted
- Date: 2026-11-10

## Context
Every 404 a tool got from its REST route ended in "page/workspace not found or not visible to you; use
find_context or list_pages". `claim_section` on a missing section already had a message listing the
anchors, and the hint after it said the page was missing; `read_file` with an unknown id talked about
pages. ADR 0929: an error says what to do next, which needs it to say what is wrong.

## Decision
- Error codes keep the first word: `SECTION_NOT_FOUND` ("the page exists but has no such section; use
  one of the anchors listed, or read_page(pageId, outline=true)"), `SECTION_AMBIGUOUS`,
  `TEMPLATE_NOT_FOUND`, `PAGE_NOT_FOUND`.
- A plain 404 is read by target: `call()` takes an optional `target`, else derives it from the route
  (`/files/…` file, `/api/comments/…` comment thread, `/api/pages/:id/row|props` row,
  `/api/pages/:id/collection…` collection, `/api/pages/:id/snapshots/:sid…` version, `/api/workspaces/:id…`
  workspace, other `/api/pages/…` page). Each target has its own hint and next tool (list_comments,
  query_rows, list_versions, list_workspaces, …). Unknown routes (suggestions, Later) get a neutral
  hint; suggestion wording stays with its own codes.
- `claim_section` (and `release_section`) resolve an anchor from before a heading rename like
  `read_page(section=…)` and `patch_section` do (ADR 1501), instead of answering "not found".

## Alternatives considered
- A hint per tool: every tool would repeat the mapping, and a tool calling two routes would need two.
- Route-specific error codes for every 404 (`FILE_NOT_FOUND`, …): changes the REST contract (docs/API.md)
  for many routes; the derivation in the MCP layer gives the same text without it.
