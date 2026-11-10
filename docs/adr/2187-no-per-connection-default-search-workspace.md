# 2187. No per-connection default search workspace (for now)

- Status: Accepted
- Date: 2026-11-10

## Context
The report behind ADR 2185/2186 (one workspace per contest, other contests' pages in find_context
answers) suggested a setting: a "search default workspace" per connection — writes still reach every
workspace, but find_context and search without workspaceId look only in that one, other workspaces
by passing workspaceId, with a header such as `searching OIBC (default for this connection)`.

What exists already: a connection's **range** (ADR 1200/1202; OAuth grants, personal API
tokens, agent connection tokens of ADR 2060–2063) limits the connection to some workspaces or one
page's subtree, for reads and writes alike, enforced in `requireMembership`, `visibleTo`,
`agentAllowedSql` and `pageInRangeSql` (`tokenRange.ts`), and announced in the server instructions
(`rangeInstruction`). A person who wants an agent to see one contest only can already make that
connection for that workspace.

## Decision
Not built. What the report needs is covered without new state:
- an answer that mixes workspaces says so, per result and in one closing line with the ids (ADR 2185);
- narrowing is one argument the agent already knows how to fill: `workspaceId: "OIBC"` (ADR 2186), and
  the server instructions say so in one sentence;
- a hard limit is the existing connection range.
Ranking the best workspace first without a setting was measured and rejected (ADR 2188).

## Alternatives considered
- **The setting as proposed**: a column on the grant (`oauth_grants`, which also stores agent tokens) and
  a migration, a picker on the consent screen and on Connections, the setting in the MCP context, a
  header line on every find_context/search answer, and rules for what happens when that workspace is
  deleted, the person leaves it, it blocks agents, or it falls outside the range. Costs that were judged
  too high for what it adds over 2185/2186:
  - **Hidden state** (ADR 0937's concern): the same call answers differently on two connections of one
    person, and a result missing from an answer is explained only by a header the agent may skim.
  - **Two scopes on one screen**: "range" (what the agent may touch) and "default search" (where it looks
    first) are easy to confuse at consent time; a person who sets the default believing it is a limit
    gets an agent that still writes everywhere.
  - **Per task, not per connection**: the right workspace follows the question (which contest it is
    about), and a connection outlives many tasks; the agent can say it per call.
- **A default from the last workspaceId used** (session memory): MCP requests are stateless here (each
  request builds its server); a remembered value is hidden state that changes answers between identical calls.
- **Infer the workspace from a page argument** (as ADR 1943 does for writes): find_context has no page
  argument; that is what the 2188 rule tried with the best-matching result instead, and it lost recall.

## Consequences
- No migration, no UI, no per-connection state; every answer is a function of its arguments and the notes.
- To revisit when field reports show agents ignoring the closing line of 2185 and still not passing
  workspaceId; then the cheapest step is a default stored with the connection's range columns and printed
  in `rangeInstruction`, not a new screen.

## References
- apps/server/src/tokenRange.ts, agentTokens.ts, mcp.ts (`rangeInstruction`)
- docs/adr/0937-*, 1200-*, 1202-*, 1943-*, 2060-*–2063-*, 2185-*, 2186-*, 2188-*
