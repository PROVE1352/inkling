# 2184. search output: grouped by workspace, 10 by default with an "N more" line, and when to use it instead of find_context

- Status: Accepted
- Date: 2026-11-10

## Context
With one workspace per contest, an unfiltered search answer mixed pages of several workspaces without
saying which page came from where (the compact line has the page id only), printed up to 20 results per
workspace, and never said whether more existed. Agents also used search to answer questions (the field
report: "find_context is what you use for the exact place"), because the description put the two tools
side by side without a rule. ADR 2183 makes one ranked request with per-workspace counts; this record is
about what the tool prints.

## Decision
- **Groups**: when the shown results come from two or more workspaces, the compact and lines formats print
  them under `## <name> (<id>)` heads, groups in the order of their best-ranked result, results in rank
  order inside each group. One workspace (given, or the only one with shown results) prints no head, so
  the common case costs nothing. Names are member-written: `cleanText`, collapsed to one line, cut at 40
  characters, inside the `<untrusted_content source="search">` block with the page lines. Ids: 8
  characters in compact (`shortIdsFor` over the workspace ids, ADR 1541), full in lines.
- **Lines**: `id | title [kind] 🔒`, then for a heading match ` | §<anchor> <heading path>`, for a body
  match ` | §<anchor> <snippet>` (anchor: find_context's short form in compact, the full anchor in lines);
  title matches print nothing more, as before.
- **Default 10, `limit` up to 50**; after the block, our own line (ids and counts only, so it stays
  outside the data block):
  `12 more matches (7 in 1a2b3c4d, 5 in 5e6f7a8b); narrow with workspaceId=<id or name> or more specific words.`
  when matches spread over several workspaces and none was given (at most five workspaces listed, the rest
  summed as `N in K other workspaces`); otherwise
  `12 more matches; narrow with more specific words or a higher limit (max 50).` Nothing when all were shown.
  "id or name" relies on ADR 2186 (workspace arguments take a name); the counts are the remaining matches
  per workspace, count desc then id.
- **json** keeps `results[]` with `id, workspaceId, title, kind, section` (evalRun and clients parse them)
  and adds `workspace` (name), `match` (`title|heading|body`), `exact`, `anchor` + `heading` for heading
  and body matches with a section, `snippet`; then `total`, `more`, `moreByWorkspace[{workspaceId,
  workspace, more}]`, and the `untrusted` note last (ADR 1525). json stays in global rank order (grouping is
  a text layout). With no match: the same `No pages match "q". Try find_context or fewer words.` in
  compact/lines and `{"results":[], …}` in json, as before.
- **Description** (one sentence for the split): "Find pages by a name or exact words: title matches first,
  then headings, then bodies; whole words before parts of words. To find what answers a question, use
  find_context. Omit workspaceId to search all workspaces. limit: default 10, max 50. format …".
  `scripts/mcp-tools-list-cost.ts --by-tool`: search 722 → 740 characters, ~181 → ~185 tokens
  (description 88 → 79, schema 68 → 81 for the `limit` argument).

## Alternatives considered
- **Workspace name on every line** (find_context's `{name}` per result, ADR 2185): repeats the name per
  result; search answers are lists of up to 50 short lines where a head per group is cheaper.
- **Interleaved groups** (keep the global rank order and print a head whenever the workspace changes):
  the same workspace could appear several times; grouping by best hit keeps one head per workspace and the
  best result of the answer first.
- **Names in the "more" line**: it would have to move inside the untrusted block (names are member
  text) or be cleaned outside it; ids are enough to narrow (and every shown workspace's name is in its
  head).
- **Default 20 or no cap**: the field report's 20 mixed results are the problem; 10 ranked results plus a
  count says more in fewer tokens. The evaluation set's "before" flow (evalRun reads search json and then
  the top 3 pages; 78 questions, context.db.test.ts) moved from mean tokens 3,131 → 2,841, success
  0.756 → 0.795, page@1 0.615 → 0.667, mean calls 3.77 → 3.67; that is ranking (ADR 2183) and the cap
  together on a one-workspace set, not the cap alone (an A/B run with the 0.16 search emulated on the same
  code and data reproduces both sides exactly).
- **A longer description with examples**: a fixed cost in every session's tool list (ADR 1945); the one
  sentence "to find what answers a question, use find_context" carries the rule.

## Consequences
- An unfiltered search across contests says which contest each page is in and how many matches each
  other contest still has, and how to narrow; the agent's next call is one argument away.
- Output is deterministic for the same documents (ADR 0937): grades, ties and group order depend on the
  documents only.
- Before/after on the same data (two workspaces "Lab notes", "Seoul AI Hackathon"; query `harness`):
  before, two body matches of the hackathon workspace came first and the `Harness test plan` and
  `HARNESS.md` titles third and fourth; after, the titles first under `## Lab notes (6d1fcc89)`, the
  experiment log's `## Harness` heading as `§harness Harness`, the hackathon's body matches with their
  sections under their own head.
- Tests: `mcpTools/search017.db.test.ts` (groups, heads, more line, limit, determinism, empty answer),
  `routes/agentSearchText.test.ts` (renderers), `jsonOutput.db.test.ts` (workspace names cleaned in json,
  one data block in lines).

## References
- apps/server/src/mcpTools/compactList.ts (`renderCompactSearch`, `searchMoreLine`, `searchJson`),
  mcp.ts (`search`)
- docs/adr/0937-*, 1525-*, 1541-*, 1944-*, 1945-*, 2183-*, 2185-*, 2186-*
