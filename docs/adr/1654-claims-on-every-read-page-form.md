# 1654. Section claims on every read_page form

- Status: Accepted
- Date: 2026-11-10

## Context
CHANGELOG 0.12 says `read_page` prints `claimed by <client> until <time>Z`. Only the section read did:
the full read never asked for claims (the export route has none), and a `known=` read that came back
`unchanged` (ADR 1540) returned before any claim line, so an agent re-reading a page it already had
could not see that another agent was working in it.

## Decision
- **Full read**: the header ends with `- claims: §a claimed by X until …Z; §b …` when the page has live
  claims, as the **last** header line: it changes with the clock, the lines above it with the page, so a
  cached prefix (ADR 0937, 1543) survives a claim coming and going. Not part of the page version.
- **Outline**: each claimed section's line ends with its claim (as before; now covered by a test).
- **Unchanged answers** (page or section `known=`): the `unchanged` line, then the claims line(s). A
  claim is not content, so "unchanged" stays true and the claim is still said.
- Claims are read once per call from `section_leases` (`pageClaims`); "this connection" for the
  caller's own claims.

## Alternatives considered
- Fold claims into the page version so `unchanged` never hides them: every claim and expiry would make a
  whole-page re-read look necessary.
- Only a hint "claims exist, read the outline": one more call for the one fact the agent needs.

## Consequences
- `read_pages` (several pages) does not print claims yet.
