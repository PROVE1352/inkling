# 1906. find_context output: 8-character page ids, `can:` once when every result has the same

- Status: Accepted (amends the output of 0927, 1212 and 1720)
- Date: 2026-11-10

## Context
Every fragment header printed the 36-character page id and `; can: read,comment,edit`; "Also relevant"
and title-only lines printed the full id again. In a workspace where the agent may edit everything the
`can:` part is the same on every line. 0.15.1 makes every tool that takes a page id accept its first 8
or more hex characters (the resolver of ADR 1541, extended to all tools by the tool-surface change of
this release); find_context can therefore print the short form.

## Decision
- `renderFindContext` prints `page <8 hex>` in fragment headers, pointer lines and title-only lines
  (`printedIds`). Two ids printed in the same answer that share the 8 characters are both extended at
  the UUID's dashes (13, 18, 23, 36 characters) until they differ. A clash with a page that is not in
  the answer is left to the resolver, which answers "ambiguous" with the candidates (1 in 4·10⁹ per
  pair).
- When there are two or more fragments and `can:` is the same for all of them, it is printed once at the
  end of the header line (`3 result(s) for "q", ~640/3500 tokens; can: read,comment,edit (all results)`)
  and not per fragment; otherwise (one fragment, or different rights) each fragment keeps its own — with
  one result the header form would cost 3 tokens more. `edited by`, `suspicious`, `large page`, review and ink notes
  stay per fragment.
- The packing estimate (`headerTokens`, `multiHeaderTokens`) counts the 8-character id. The `can:`
  share of `HEADER_FACTS_TOKENS` (15) is kept, so the estimate errs high when `can:` is shared.
- REST (`GET /api/context`) keeps full ids; only the MCP text changes.

## Measured
Per fragment: the id 36 → 8 characters (9 → 2 tokens, `estimateTokens`), `; can: read,comment,edit`
(6 tokens) once instead of per fragment. The 74 single-query evaluation questions through MCP on the
bench workspace (padded + 5,000 distractors), 0.15 tree vs this tree with the ranking switched back to
0.15 (format only): the two header lines per result 87.5 → 65.0 tokens per question (−25.7%), whole
output 376.3 → 360.4 (−4.2%) at the default budget; at 1,500: 74.2 → 56.5 (−23.9%), 270.1 → 257.9
(−4.5%). Part of the saving is spent on text: the header estimate is smaller, so more text fits. The
0.12 measurement of 8-character ids alone was −5.6% (docs/PERFORMANCE.md).

## Alternatives considered
- **Keep full ids**: the reason given in docs/PERFORMANCE.md for rejecting 8-character ids was that the
  edit tools did not accept them; that is gone in 0.15.1.
- **Shorter than 8**: collisions become plausible in large workspaces; 8 is what list_pages/search print.
- **`can:` in a separate line**: one more line for the same information.

## Consequences
- Agents must pass the printed prefix, not reconstruct a UUID; every page-id argument accepts it.
- Tests that matched `[0-9a-f-]{36}` in find_context output match the prefix (ADR 1908).

## References
- apps/server/src/mcpTools/contextTools.ts (`printedIds`, `renderFindContext`)
- apps/server/src/context/rank.ts (`headerTokens`), multiQuery.ts (`multiHeaderTokens`)
- apps/server/src/context/evalRun.ts (`samePage`)
- docs/adr/1541-*, 1908-*
