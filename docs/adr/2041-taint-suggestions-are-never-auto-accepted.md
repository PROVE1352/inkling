# 2041. Suggestions of a suggest-only connection are never auto-accepted

- Status: Accepted
- Date: 2026-11-10

## Context
Under the "auto" edit policy (ADR 1544, 1545) agent suggestions that pass the rules land without a
person. A suggest-only connection (ADR 2040) is exactly the case where nobody should be skipped:
an append that matches every rule may still carry what the injection asked for.

## Decision
- `suggestionMode` checks the connection first. When it is suggest-only in the page's workspace the
  write becomes a suggestion with origin `taint` and **no policy**, whatever else applies: an asked
  suggestion, an "auto" or "suggestions only" lock node, a workspace "auto" or "review" policy.
  `createSuggestions` gives every `taint` suggestion the fate "review" with the reason
  "this connection recently read content flagged as a possible prompt injection; its edits wait for a
  person until <time>Z" (shown in the tool answer and in the web suggestion panel).
- The grace sweeper (`runAutoAccepts`) checks the suggestion's connection again before applying a
  waiting row: a connection that became suggest-only during the grace period leaves the row open for
  a person with that reason.
- A person accepting a `taint` suggestion applies it as always (outside the agent scope; the
  connection scope is left too, `outsideAgent`).

## Alternatives considered
- **Let the rules decide but drop "replace"/"delete"**: an append can be the harmful edit (a link that
  exfiltrates on render, an instruction for the next agent).
- **Keep the original origin and only add a reason**: reviewers would not see why at a glance, and the
  web panel and agents' answers switch on origin.

## Consequences
- Tested for workspace "auto", an "auto" lock node and the grace sweeper (agentTaint.db.test.ts).

## References
- apps/server/src/suggestions.ts, apps/server/src/autoAccept.ts, apps/server/src/mcpTools/collabTools.ts,
  apps/web/src/components/SuggestionsPanel.tsx
