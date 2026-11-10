# 1941. Short ids in every tool, and what a prefix may reveal

- Status: Accepted
- Date: 2026-11-10
- Amends: 1541 (short ids accepted by four tools)

## Context
ADR 1541 printed 8-character page ids in compact lists and resolved them in four tools only
(read_page, read_pages, patch_sections, list_pages parentId). docs/PERFORMANCE.md rejected 8-character
ids in find_context because "ids feed patch_section/read_page, which would all need short-id support",
and 1541 kept `json` as the default partly because "short ids work only in the four tools above".
An agent going from a list to an edit needed a read_page in between to learn the full id.

## Decision
- Every id argument of every tool takes the full id or a prefix of at least 8 hex characters
  (ADR 1940 does it in one place). Kinds:
  - **page**: among the pages this connection can see — member workspaces (`memberWorkspaceIds`, agent
    blocks applied), the connection range and agent scope entered (`runAsConnection`), `visibleTo`
    (another member's private page is not a candidate), live page, live workspace. A primary-key range
    scan (`id BETWEEN prefix000… AND prefixfff…`), as in 1541.
  - **trashedPage** (restore_page): the same, among trashed pages.
  - **workspace**: among the workspaces `GET /api/workspaces` returns to this connection (what
    list_workspaces shows).
  - **thread** (reply_comment, resolve_comment): thread ids of comments on pages the connection can see
    (the page rule above, joined on `comments.page_id`).
  - **full**: version ids and suggestion ids (no tool prints them short).
- One match → its full id. None → `no page you can see has an id starting with "<hex>"; use list_pages
  or find_context to get a valid id` (workspace and thread have their own wording). Several → up to five
  candidates with full id and title, `Pass a longer prefix or the full id.`
- **Nothing outside the connection's view takes part**: a prefix shared with a hidden page resolves to
  the visible one without saying anything; a prefix only hidden pages have gets the same bytes as a prefix
  nobody has; candidates in an ambiguity error are visible pages only. Guests: token requests never reach
  guest workspaces (ADR 1253), so a guest's short ids resolve only in workspaces they are a member of —
  the same set their tokens can use at all.

## The 0.12 objection
The reason recorded for rejecting short ids outside compact lists (PERFORMANCE.md "find_context with
8-character page ids", ADR 1541 Compatibility) was that the write tools did not accept them. That is no
longer true, so find_context prints them (ADR 1906), read_page headers, outlines, comments and
get_instructions print them (ADR 1942), and compact becomes the list default (ADR 1944). The other half of
1541's objection — clients that parse 36-character ids in `lines` output — is unchanged: `lines` and
`json` keep full ids.

## Alternatives considered
- **Shortest unique prefix**: rejected in 1541 (output changes when an unrelated page appears).
- **Resolve within the tool's workspace only**: most tools do not know the workspace before the id
  is resolved; the connection's view is the boundary every route already enforces.
- **Short version / suggestion ids**: not printed short anywhere; the resolver would need the page first
  (versions) and gains nothing today.

## Consequences
- One indexed lookup per prefix argument; full ids cost nothing extra.
- The error for an id of a page the agent cannot see is now the resolver's ("no page you can see …")
  when the argument was a prefix, the route's 404 hint when it was a full id; both say what to do.
- Tests (`toolSurface.db.test.ts`): visible/hidden/foreign pages sharing a prefix through read_page,
  rename_page, list_comments, trash_page, update_page and patch_section (contextTools.ts unchanged);
  hidden-only prefix byte-identical to an unknown one, also for a thread on another member's private page
  (reply_comment, resolve_comment) and another member's trashed private page (restore_page); ambiguity
  lists visible pages only; short page,
  workspace and thread ids across create_page, patch_section, list_pages, add/list/reply/resolve
  comments, get_instructions, trash/restore; a foreign workspace prefix is "not found".

## References
- apps/server/src/mcpTools/idArgs.ts, shortIds.ts (`resolvePageRef`)
- docs/adr/1253-*, 1541-*, 1906-*, 1940-*, 1942-*, 1944-*
