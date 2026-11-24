# 2389. "What an agent reads": a read-only dialog over the existing context routes

- Status: Accepted
- Date: 2026-11-24

## Context
The token saving that section reads give an agent (ADR 0926-0930) was only visible from inside an agent:
nobody looking at a page in the browser could tell that a 30,000-token page costs an agent 100 tokens when it
asks one question. People who try Inkling without an agent connected, or who wonder what their agent sees,
had no way to check. The server already answers everything needed, for the session cookie as for a token:
`GET /pages/:id/outline` (sections, `estimateTokens` per section, versions), `GET /pages/:id/section`
(one section as the Markdown the agent gets, `notation: 'agent'`) and `GET /context` (what `find_context`
returns, the same cached path, the default 3,500-token budget).

## Decision
- **One page-menu item, a dialog**: "What an agent reads" / "에이전트가 보는 화면" in the page header's ⋯ menu,
  for document pages and not for guests (the three routes refuse guests anyway). It opens a `Modal size="lg"`;
  the editor, its collaboration connection and the Yjs document stay mounted and untouched. The menu name is
  fixed: the sample page (ADR 2388) names it.
- **What it shows**, numbers first:
  - "This page: ~N tokens" from the outline's `tokens`.
  - A question box. Its answer: "find_context would return n sections, ~used of budget tokens", where `used`
    is the route's `usedTokens` as given (on the sample it is larger than the fragment's own `tokens`, 100
    against 59; it is not summed again here), then one line per fragment: page title, first `§anchor` (+ how many merged
    neighbours), tokens, and "this page" in the text colour and weight for this page's fragments. The same
    sections are set in bold in the section list. `more` (matches that did not fit the budget) is counted.
    The question is sent 400 ms after typing stops, or on Enter, with `workspaceId` = the current workspace.
  - The sections: `§anchor`, `~tokens`, share of the page in whole percent (largest remainder, so the rows add
    up to 100; a section with tokens that rounds to 0 shows "<1%"), `v=version`, indented by heading level.
    Anchors are shown by the label find_context prints (ADR 1212): the shortest unique run of trailing
    segments, which read_page accepts too (the result lines use the route's `short`, the list computes the
    same rule); the full anchor is in the title. Cutting a nested anchor (`parent/child`) to width would leave
    only the parent's part on every row under it. The part before the first heading is `_intro`,
    labelled "(before the first heading)". A row opens to the section's Markdown in a read-only `<pre>`,
    fetched only then, at most 20,000 characters (the rest is counted).
  - "Tokens are estimates. Searched in this workspace as you, with no agent connected."
- **The sample page** starts with a question filled in: "How do I connect an
  agent to an MCP client?" / "에이전트를 MCP 클라이언트에 연결하려면?", chosen from the language of the sample's
  title (an automatically made sample can be in another language than the UI). Both find the sample's
  "5. AI agents" section in either language's sample, through "MCP". The page counts as the sample when
  `onboarding.samples[workspaceId]` is its id.
- **No server change, no shared type**: response types are local to `agentViewApi.ts`. A browser session has
  no token id, so `recordTokenRead` returns at once and no agent read count moves (ADR 2040).
- **Large pages**: rows start closed, the first 150 are drawn with "Show all N", the list scrolls in its own
  box, rows are memoised and the question box is its own component, so typing does not redraw the list.
  Measured locally (production build, headless Chrome on an M-series Mac, a 602-section page of 30,784
  tokens): the dialog opens with rows in 70-500 ms including the outline request, "Show all" draws the other
  452 rows in about 30 ms.

## Alternatives considered
- **Replacing the editor with the agent's view**: unmounting the editor would close and reopen its collaboration
  connection; a dialog needs about ten lines in the page view.
- **A right-panel tab**: too narrow to show the section list and the question result together.
- **Printing the MCP tool's text** (a new route that runs the `find_context` tool): it adds review marks, agent
  context and read counting around the same sections, and would count browser reads as agent reads. The dialog
  promises the same sections and the same `usedTokens`, not the same characters.
- **A second phrasing box** (`q` may repeat, ADR 1720) for questions in another language than the notes: left
  for later; the footnote and the empty answer say that the search matches words.
- **Virtualising the list**: no dependency for it (ADR 0882); closed rows and a first slice keep pages with
  hundreds of headings fast.

## Consequences
- The dialog shows the index's view: right after typing, the outline lags the editor by the indexing delay, and
  reopening the dialog reads it again.
- A question that shares no word with the notes finds nothing, as an agent's would; the dialog says so.
- Strings: `i18n/{en,ko}/agent-view.ts`, one import and one spread line in each dictionary.
