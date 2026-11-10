# 2185. find_context names the workspaces when an answer spans several

- Status: Accepted
- Date: 2026-11-10

## Context
find_context without workspaceId searches every workspace of the connection (ADR 0927). A person
with one workspace per contest reported that answers mixed in pages of other contests: two
`HARNESS.md` pages, two experiment logs, two "best submission … score" sections look the same in
the output, because a result line names the page and the section but not the workspace. MCP
requests are stateless, so there is no "current workspace" to fall back on; the agent has to see
where each result is from and narrow the next call itself.

## Decision
- **Only when an answer spans two or more workspaces** — counted over everything it prints with a
  page id: the fragments, the "Also relevant" pointers and the title-only matches. With one workspace
  (the common case, and always when workspaceId is passed) the output is byte for byte the 0.16 output;
  the existing find_context tests pass unchanged.
- **The name on the member-text lines**, inside the `<untrusted_content>` block (names are written by
  members): `[1] {Wind Power Forecast Cup} HARNESS.md › Validate`, and the same `{Name} ` before the
  title of a pointer to a page not shown and of a title-only match. A pointer to a page already shown
  (`page of [2]`) needs none. The name goes through `cleanText`, whitespace is collapsed, braces are
  dropped and it is cut at 40 characters. The `(page …; §… v=…)` line is untouched, so the evaluation
  parser (`evalRun.ts parseFragments`) and agents that read anchors from it see the same line.
- **One closing line with ids only** (no member text), after the hints and before the dated
  Verification line (ADR 1907):
  `Results come from 2 workspaces ({name} on each line): 5e6f7a8b [1], 1a2b3c4d [2]. To search one, pass workspaceId=<its id> (its name works too).`
  Workspaces in order of first appearance; ids are 8 characters, longer only on a shared prefix
  (`printedIds`); a workspace reached only by a pointer says `(Also relevant only)`.
- **Where the facts come from**: fragments already carry `workspaceId` (rank.ts `Fragment`). Pointers
  and title matches do not, and `multiQuery.ts` builds some pointers itself, so the tool looks the
  printed page ids up in one query (`pages` ⨝ `workspaces`, `printedWorkspaces` in contextTools.ts) —
  only when no workspaceId was passed and the answer could span workspaces: fragments from two, or any
  pointer or title match to a page not shown. The latter is most answers without workspaceId, also on a
  one-workspace connection, so in practice the lookup runs on most such calls (a primary-key lookup of at
  most ~20 ids; not timed). The ids come from the permission-checked REST answer, so the workspaces are
  the caller's. The REST response and `retrieve.ts` are unchanged.
- `renderFindContext` takes the map as an optional last argument; without it (the offline evaluation)
  the fragments' own workspace ids are used and the label is the short id.

## Alternatives considered
- **The name in the `(page …)` line** (`; ws "Name"`): that line is what agents and `parseFragments`
  read anchors and versions from (`§(\S+) v=`); a member-written name there could look like an anchor.
- **Always print the workspace** (also with one): changes every answer and its tokens for the person
  with one workspace, and breaks the byte-stable output of ADR 0937 for no information.
- **A legend line `A = 5e6f7a8b "Wind …"` and `ws A` per result**: one more indirection to read; the
  names are short and are what the person calls the contest.
- **Grouping results by workspace**: reorders by workspace instead of by score; the measured version of
  that idea is ADR 2188 (not adopted).

## Consequences
- An agent sees which contest each result belongs to and has the id (or name, ADR 2186) to narrow the
  next call; nothing changes for a one-workspace answer.
- Cost when it applies: about 4–8 tokens per labelled line plus ~40 for the closing line. The page →
  workspace lookup runs on most find_context calls without workspaceId (see above; not timed).
- Tests: `mcpTools/workspaceScope.test.ts` (one workspace = the same bytes; labels, closing line,
  pointer-only workspace, a name that tries to close the data block, `parseFragments` still reads every
  fragment), `mcpTools/workspaceScope.db.test.ts` and `context/context.db.test.ts` (end to end).

## References
- apps/server/src/mcpTools/contextTools.ts (`workspaceLabels`, `renderFindContext`, `printedWorkspaces`)
- docs/adr/0927-*, 0937-*, 0976-*, 1906-*, 1907-*, 2186-*, 2188-*
