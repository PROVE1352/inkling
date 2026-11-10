# 1907. find_context: verification marks in one line at the end

- Status: Accepted (amends the find_context part of 1842)
- Date: 2026-11-10

## Context
ADR 1842 added `; verified`, `; verified, changed since` or `; stale: verification lapsed` to the
header of each fragment from a verified page. The state depends on the date (a verification lapses at
a fixed day) and on later edits, not on the fragment's text. ADR 0937/1543 put clock-dependent facts
last so the rest of an answer stays byte-identical; read_page moves its verification line after the
body in the same release.

## Decision
The marks leave the fragment headers. When any shown page has a verification, the answer ends with one
line, after the `Next:` line, the large-page hint and the other-language hint (ADR 1904):
`Verification: [1] verified; [3] stale: verification lapsed` — the result number of the page's first
fragment and the same words as before. Pages without a verification print nothing, as before.

## Why it matters, and how much
- When a verification lapses or a section changes under it, every byte above the last line stays the
  same; before, the header of that fragment changed in the middle of the answer.
- Prompt caches cache prefixes. A tool result already in a conversation never changes, so the gain is
  for an identical call made again (another agent, a new session, a retry): the answer up to the last
  line is the same bytes as yesterday's. The effect is real but small; the main reason is the
  convention of 0937 (facts that change with the clock come last).
- Tokens: one line of ~4 + 4 per page instead of 3–7 per fragment; equal for one verified page.

## Alternatives considered
- **Keep them in the header** (status quo): the agent sees the mark next to the text; but a page's mark
  is a property of the page, and the result number keeps the link.
- **Move the review note (owner, reviewed, `stale p=…`) too**: `stale p` also comes from a daily batch.
  Left for a later change: the review note is older, its parts are mostly stable (owner, reviewed date),
  and other tests depend on its place. Listed in docs/KNOWN-ISSUES.md.

## References
- apps/server/src/mcpTools/contextTools.ts (`renderFindContext`, the `Verification:` line)
- apps/server/src/mcpTools/verifyStatus.db.test.ts; apps/server/src/context/rank0151.test.ts
- docs/adr/0937-*, 1543-*, 1842-*, 1904-*
