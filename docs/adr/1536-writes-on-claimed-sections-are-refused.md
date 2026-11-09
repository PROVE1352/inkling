# 1536. Other agents' writes on a claimed section are refused, people's are not

- Status: Accepted
- Date: 2026-11-09

## Context
What should another agent's `patch_section` do on a section someone else claimed: refuse, wait, or
turn into a suggestion?

## Decision
- Refuse: `409 SECTION_CLAIMED`, nothing written, naming the client and the end time and the three
  ways on: another section, wait, or `suggest=true`. Suggestions are allowed on a claimed section.
- `update_page(replace)` is refused while any section of the page is claimed by another connection;
  `update_page(append)` is not (it leaves every section as it is).
- Only bearer connections are checked. People's edits (browser, collaboration socket) are never
  blocked; the claim is shown, not enforced, for them. A person accepting a suggestion is not blocked
  either.
- The check is one indexed lookup when the page has no live claim.

## Alternatives considered
- **Turn the write into a suggestion automatically**: the same call would answer differently
  depending on someone else's state, and the agent might not notice that nothing was written.
- **Wait for the claim**: an MCP call cannot sit for minutes.

## References
- apps/server/src/leases.ts (`assertNotClaimed`), apps/server/src/suggestions.ts (`suggestOrCheck`)
