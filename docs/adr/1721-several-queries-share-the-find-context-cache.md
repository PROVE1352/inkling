# 1721. Several queries share the find_context cache: per-query entries plus a bundle entry

- Status: Accepted
- Date: 2026-11-10

## Context
The find_context result cache (ADR 1550) keys one query's answer by the person, every permission input and the
index markers of the searched workspaces. A bundle (ADR 1720) is N queries; agents mix bundles and single calls,
and two bundles often share phrasings ("cache invalidation" with "캐시 무효화" now, with "purge stale cache" later).

## Decision
`cachedFindContextMulti` (context/contextCache.ts):
- **One marker statement per bundle:** the workspace list and markers (`searchScope`) are read once and used for
  every key of the call, then the in-process epochs, as before (version before data).
- **Per-query entries:** each query is looked up under exactly the key a single call with the same budget uses
  (`queryKey`: scope part, budget, normalised query, markers), so a phrasing asked alone, or in another bundle, is
  not computed again; misses run the ordinary retrieval and are stored under that key. Misses run in parallel.
- **Bundle entry:** the merged result is stored under `userId|m|sha256(scope part, budget, "multi k=60", ordered
  normalised queries, digest of extra lists (ADR 1722), markers)`. Order is part of the key because `matched`
  numbers are positions. Same inputs → same entry → same bytes.
- Same `BoundedLru` (1,000 entries, 32 MB, 5 minutes); the size estimate adds the query strings and labels.
- Counters: `hits`/`misses` count per-query lookups (single calls and bundle members), `batchHits`/`batchMisses`
  bundle lookups. The connection's usage marks the call a cache hit when the bundle entry answered or when every
  query came from its entry (no retrieval statement ran).

## Alternatives considered
- **Only a bundle entry:** a bundle that shares four of five phrasings with the last one recomputes all five.
- **Only per-query entries:** a repeated bundle still pays the merge and N lookups; the merge is cheap, but the
  bundle entry is one lookup and keeps the answer byte-identical even if the merge code changes mid-process.
- **Order-free bundle key (sorted queries):** would need renumbering `matched` on a hit; not worth it.

## Consequences
- Bundle call, mean of 5 bundles: cold 12–18 ms, with the per-query entries warm 6–8 ms (laptop, Postgres 16 in
  Docker, `scripts/multi-query-bench.ts`).
- Correctness is the single-query cache's: every per-query entry is keyed by the same permission inputs and
  markers, and the bundle key contains all of them plus everything the merge reads.
- Tests: `apps/server/src/mcpTools/multiQuery.db.test.ts` ("cache: …").

## References
- apps/server/src/context/contextCache.ts (`markersFor`, `queryKey`, `cachedFindContextMulti`)
- ADR 1550, 1720, 1722
