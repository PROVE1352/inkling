# 1533. Accepting applies the suggestion to the section as it is now, after a warning

- Status: Accepted
- Date: 2026-11-09

## Context
Between the agent's suggestion and a person's decision, people keep typing. The suggestion was made
against one version of the section; the person decides on another.

## Decision
- Only people decide: a browser session or a personal API token (which acts as its person, ADR
  1201). A request inside an agent (OAuth/MCP) scope gets `403 PEOPLE_DECIDE`; there is no MCP tool
  for it. The decider needs edit access as a person (membership, edit lock, people rows).
- The preview and the diff are always against the current text. When the base version differs from
  the section's version now, the web view shows "changed after the agent read it", and accept
  answers `409 SUGGESTION_CHANGED` with the fresh preview unless the call says `confirmChanged`.
- Accepting runs the same code as a direct patch (`patchSectionAs`, extracted from the route; for
  `page_*` modes `writePageContentAs`), as the person who accepts, without a base version, under the
  write gate (ADR 1150). The section is found by its heading block id first, then by anchor, then
  by the rename trail (ADR 1501).
- The row is claimed (`open` → `accepted`) before the document edit so two people cannot apply it
  twice; if the edit fails, it goes back to `open`.
- Rejecting only changes the row.

## Alternatives considered
- **Refuse to accept when the section changed** (like the agent's conflict): pushes the merge to the
  agent again, which is what people wanted to avoid.
- **Three-way merge of base, current and suggestion**: needs the base text, which is not stored, and
  a merge the person has not seen.

## Consequences
- The edit is attributed to the person who accepted (history, change feed); the suggestion row keeps
  who suggested it.
- Per-hunk acceptance is the next step (ADR 1530).

## References
- apps/server/src/suggestions.ts (`acceptSuggestion`), apps/server/src/context/sectionWrite.ts,
  apps/server/src/pageContentWrite.ts, apps/web/src/components/SuggestionsPanel.tsx
