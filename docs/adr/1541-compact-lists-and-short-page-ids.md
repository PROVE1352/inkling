# 1541. Compact lists: folded numbered siblings and 8-character page ids

- Status: Accepted
- Date: 2026-11-09

## Context
`list_pages` (format `lines`) prints one line per page with its 36-character id. Real workspaces have
long runs of siblings that differ only by a number or a date — weekly meeting notes, daily logs,
"실험 일지 3-1 … 3-8", sprint pages — and the id is the largest part of every line. A 2,000-page
workspace does not fit the 500-line cap in one call (4 calls more for the rest), and a 100-note
meeting folder costs ~1,600 tokens to list.

## Decision
- New `format: 'compact'` for `list_pages` and `search` (`mcpTools/compactList.ts`). `lines` and
  `json` are unchanged, byte for byte.
- **Short ids**: the first 8 hex characters of the page id. Fixed length, not "shortest unique
  prefix": with shortest-unique, adding one page can lengthen another page's id and change the
  listing of an untouched subtree (against ADR 0937). Where two pages of the workspace share the
  8-character prefix, both print their full id (a 2,000-page workspace has such a pair with a chance of
  about 0.05%).
- **Folding**: consecutive leaf siblings with the same kind/section marks whose titles are identical
  except for one number fold into one line when there are at least three:
  `Weekly sync 2026-11-{03,10,17} ids: a1b2c3d4,e5f6a7b8,c9d0e1f2`. Consecutive numbers of the same
  width print as a range (`{01..05}`, `{1..8}`, descending too); the `ids:` follow the values in
  order, so every page stays addressable. A date run splits where the month changes. Titles with
  braces never fold; pages with children never fold (their subtree follows them).
- One space of indentation per level (was two). A legend line after the data explains short ids and
  braces (a constant string, last, ADR 0937).
- **Short ids as arguments** (`mcpTools/shortIds.ts`): `read_page`, `read_pages`, `patch_sections` and
  `list_pages(parentId)` accept a full id or any prefix of at least 8 hex characters. The server
  resolves it among the pages this connection can see (member workspaces with agent blocks and the
  connection range applied, live, visible) with a primary-key range scan
  (`id BETWEEN prefix000… AND prefixfff…`). No match → not found; several → an error listing up to
  five candidates (full id and title) and asking for a longer prefix. Another member's private page
  is never a candidate.

## Compatibility (why an option, not the new default)
- Clients and prompts parse `lines` today (`- title id`, 36-character ids) and docs/MCP.md, the
  README examples and the CLI show that shape. Changing the default would silently break them.
- Short ids work only in the four tools above. Every other tool still validates its id arguments as
  UUIDs (`core.ts uuid()` is shared by every tool module, and the other modules were being changed in
  the same step); compact output says so in its legend and read_page prints the full id. Making short
  ids universal (and then maybe the default) is a follow-up: one schema helper for every id argument
  plus a resolution step in each tool.
- `json` stays the default of list_pages and search (legacy shape, ADR 0928).

## Alternatives considered
- **Shortest unique prefix**: fewer characters (4–5 for 2,000 pages) but unstable output, see above.
- **Per-response numbering** (`[1] title`, ids in a table at the end): references die with the
  response; an agent mixing two listings confuses numbers.
- **Short ids in find_context**: measured on the bench (8 questions): 1,863 → 1,758 tokens (−5.6%);
  its bodies dominate, and every id it prints feeds patch_section, which does not take short ids.
  Not adopted.
- **Fold by longest common prefix** (any differing text): produced unreadable groups
  (`2026-1{0-27,1-03}`) and folded unrelated titles; one differing number is predictable.

## Consequences
- Bench (`scripts/mcp-token-bench.ts`, 2,000 pages): one list_pages call — lines 6,986 tokens for 500
  pages, compact 4,430 tokens for 1,043 pages (json 22,971 for 500); the complete tree (root + one call
  per top folder) lines 25,256 → compact 10,821 tokens (−57.2%). Meeting folder (100 weekly notes)
  1,564 → 543 (−65.3%), daily log (365) 4,577 → 970 (−78.8%), 실험 일지 (96) 1,484 → 395 (−73.4%);
  search "sync" 324 → 247 (−23.8%).
- Real tokenizers split hex ids into more tokens than the estimator's 4 characters per token, so the
  id savings are larger with real models than reported here (the estimator is used on both sides).
- Tests: `mcpTools/compactList.test.ts` (folding, braces, short ids, tree), `tokenSaving.db.test.ts`
  (compact list and search, resolution, ambiguity, hidden pages, byte-identical repeats).

## References
- apps/server/src/mcpTools/compactList.ts, apps/server/src/mcpTools/shortIds.ts
- apps/server/src/mcp.ts (`renderPageList`, list_pages, search, read_page),
  apps/server/src/mcpTools/agentContext.ts (`runAsConnection`)
- ADR 0928, 0937, 1200
