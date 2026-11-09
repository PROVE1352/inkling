# 1625. Live typing is attributed per index window; server edits log pending typing first (CF-2)

- Status: Accepted
- Date: 2026-11-10

## Context
KNOWN-ISSUES CF-2: editor typing has no author in the change log. Worse for reverting (ADR 1620):
an agent's write indexes the whole live document, so typing not indexed yet lands in the agent's row
and a revert of that row would take the person's typing with it.

## Decision
- The collab `onChange` hook already notes who typed in a page. Those people are also collected per
  index window; an index pass takes the set when it starts. A change row logged without an in-flight
  actor is the typist's (`actor_id`, `via` null) when exactly one person typed in that window, else
  nobody's as before (no guessing between several people; no new column for the list).
- `withEditActor` (every REST/MCP document write) first indexes the live document of a page that
  has typing since its last pass, so the write's own rows hold only the write. The extra pass runs
  only when someone typed since the last one.

## Alternatives considered
- Last typist (like the mention producer's `indexActor`): misattributes when two people type.
- Per-change author lists in `page_changes`: needs a column (0.14 with ADR 1620's rows).

## Consequences
- Typing rows now carry a person, so the merge rule (same actor) keeps different people's typing
  apart. Notifications keep using the payload's actor (unchanged).
- Single process, in memory, like the rest of the collab state.

## References
- apps/server/src/context/attribution.ts, apps/server/src/docIndexer.ts, apps/server/src/collab.ts,
  apps/server/src/context/changeLog.ts
