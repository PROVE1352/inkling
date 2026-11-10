# 1722. Extra ranked lists join the RRF merge (the join point for semantic candidates)

- Status: Accepted
- Date: 2026-11-10

## Context
0.14 adds optional embeddings (`context/semantic.ts`, `semanticCandidates({ workspaceIds, query, limit, userId })`
→ `{ pageId, anchor, score }[]`, or `null` when the feature is off). Semantic candidates have no text and their
scores are on another scale than the lexical ones. The multi-query merge (ADR 1720) already combines ranked lists
by rank, so it is the natural place where a semantic list joins; the wiring is done separately.

## Decision
`fuseContextResults(perQuery, { queries, budget, k?, extra?: ExtraList[] })`, and
`cachedFindContextMulti(…, { extraLists?: ({ userId, workspaceIds, queries }) => Promise<ExtraList[]> })`:
- `ExtraList = { label, items: { pageId, anchor | null, score?, title?, tokens?, fragment? }[] }`, best first.
  The `semanticCandidates` items fit as they are.
- Extra lists add to the same RRF sum (`1/(k + rank)`); scores are not used, only order.
- `label` is printed in `matched:`. A list built for query n should use label `"n"`, so `matched` keeps meaning
  "which phrasings found it"; another label (e.g. `s`) is printed after the query numbers.
- An item whose section a query found boosts that section. An item no query found becomes a pointer under "Also
  relevant" (`§anchor`, or `whole page` for `anchor: null`); `anchor: null` on a page a query found credits that
  page's best lexical section. An item with a resolved `fragment` is a text piece like a lexical fragment.
- `extraLists` is called once per bundle after the markers are read (version before data) with the workspaces
  this person may search; its output is digested into the bundle key, so the cache stays exact.
- No lists, or empty lists: the merge is exactly the lexical one.

## Alternatives considered
- **Mix the semantic candidates into `retrieve.ts`:** that is ranking work inside the lexical retrieval and would
  change single-query answers; the join point here leaves them untouched.
- **Fetch text for semantic-only items inside the merge:** needs a database read and permission check in a pure
  function; left to the caller through `fragment`.

## Consequences
- Not wired in 0.14's first cut: `find_context` passes no extra lists until the integration change sets
  `extraLists` in `routes/context.ts`. A single query with semantic candidates would go through the multi path
  (its output then gains `matched:`), which is a decision for that change.
- Tests: `apps/server/src/context/multiQuery.test.ts` ("extra ranked lists", fake lists in the
  `semanticCandidates` shape).

## References
- apps/server/src/context/multiQuery.ts (`ExtraList`, `ExtraItem`, `fuseContextResults`),
  apps/server/src/context/contextCache.ts (`MultiContextOptions.extraLists`)
- ADR 1720, 1721
