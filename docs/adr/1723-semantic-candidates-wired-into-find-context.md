# 1723. Semantic candidates wired into find_context: one extra list per query, off path untouched

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 1722 gave the multi-query merge a join point for extra ranked lists, and ADR 1740–1743 added
`semanticCandidates({ workspaceIds, query, limit, userId })` (null while the feature is off or the endpoint is
down). Neither was connected to `find_context`. Three constraints: with semantic search off (the default) a single
query must answer exactly as before, byte for byte; the candidates must pass the same permission boundary as the
lexical retrieval (connection range, guest scope, agent blocks, 2FA); and the find_context cache (ADR 1550, 1721)
must not hide vectors written after an answer was cached.

## Decision
- **Gate:** `routes/context.ts` asks `semanticOn()` (`semanticConfig() !== null`) once per request.
  - Off, one distinct query: the unchanged `cachedFindContext` call (the 0.13 path). Off, several: the ADR 1720
    merge without extra lists.
  - On: every call, one query included, goes through `cachedFindContextMulti` with
    `extraLists: semanticExtraLists` (`context/semanticFind.ts`). MCP `find_context` reads the same REST route,
    so both surfaces are wired by this one place.
- **One list per query,** labelled with the query's number (`"1"`..`"5"`). `matched:` keeps meaning "which
  phrasings found it": a section found by query 2 lexically and by query 1 semantically shows `matched: 1,2`.
  A query whose candidates are `null` (endpoint down or backing off) adds no list and is answered lexically.
- **8 candidates per query, relative floor 0.6:** a candidate is kept when its cosine is at least 0.6 × the
  query's best cosine (and above 0). Nearest neighbours always exist, also for a question none of the notes is
  about; without the floor every small workspace would see its whole content merged in. 0.6 is the lexical
  floor's relative share (rank.ts `FLOOR.relative`); it is a constant, not tuned on an evaluation set.
- **Text for semantic-only sections:** each item carries a `fragment` built from the section's first chunk
  (`page_chunks` row with the lowest `ord`; title, short anchor and heading tail as ADR 1212, version =
  `section_hash`). A section only meaning finds is shown with its text like a lexical result, not as a bare
  pointer (with no fragments, a query with no lexical hit would print "No sections match" and drop the pointers).
  The fragment statement applies the visibility rule and `pageInRangeSql` again in the request scope.
- **Rendering of a merged single query:** `renderFindContext` keeps the single-query header
  (`N result(s) for "q", ~used/budget tokens`) and prints no `matched:` when the merged result has one query;
  only its pointer lines use the merged form (no `~N tok` for an item without size).
- **Cache key:** the bundle key gains `sem <workspace>:<semanticEpoch>` per searched workspace, read after the
  database markers and before the extra lists (version before data). Off, `semanticEpoch` is `''` and nothing is
  added: off keys are byte-identical. The per-query (lexical) entries do not carry it, so an indexer write does
  not evict lexical answers. The extra lists stay digested into the bundle key (ADR 1722), so a bundle hit
  still costs one `semanticCandidates` call per query (its query vector is cached in `semantic.ts`).
- **Scope:** `extraLists` is called inside the request; `semanticCandidates` keeps only live member workspaces
  the connection may reach and pages visible under the range/guest scope. A guest is never a member of the
  workspace they are a guest in, so it is never searched for them (lexically or semantically).

## Alternatives considered
- **Semantic candidates as pointers only (no text):** cheaper (no fragment statement), but a query with no
  lexical hit would show nothing, and the found section would cost the agent another `read_page` call.
- **Compute extra lists only on a bundle miss** (the epoch alone guarding the key): saves the per-call query
  embedding on hits, but an endpoint that was down when the entry was stored would keep a lexical-only answer
  for up to the TTL. Kept the ADR 1722 rule; revisit with numbers.
- **Single query stays on the single path even when on, with semantic only for `queries=[…]`:** the feature
  would do nothing for the common call.
- **A threshold on absolute cosine:** scales differ between models; a relative floor works with any.

## Consequences
- Off (default): `GET /api/context` with one `q` and `find_context(query)` answer byte for byte as without this
  change (and as 0.13 apart from ADR 1700/1701 ranking). Checked by comparing the outputs of the unwired and
  wired trees on one seeded database (100 answers) and by the "off again" test in `semantic.db.test.ts`.
- On: one query is merged (RRF of the lexical list and the semantic list). Packing follows the merge rules
  (ADR 1720), not `pack`'s value-per-token order, and the header estimate reserves room for a `matched:` column
  that is not printed for one query, so `~used` can differ by a few tokens from the lexical answer of the same
  sections. The REST answer of one `q` gains `queries: [q]` and `fragments[].matched` while semantic search is on.
- Determinism (ADR 0937) holds for the same documents, vectors and endpoint state (KNOWN-ISSUES, ADR 1740).
- Tests: `apps/server/src/context/semantic.db.test.ts` — a section only meaning finds (single header, no
  `matched:`; `queries=[…]` labels by number; REST), the bundle key and the semantic epoch, a subtree and a
  workspaces range, a guest with a page grant (cookie and token).

## References
- apps/server/src/context/semanticFind.ts, apps/server/src/routes/context.ts,
  apps/server/src/context/contextCache.ts, apps/server/src/mcpTools/contextTools.ts
- ADR 1550, 1720, 1721, 1722, 1740, 1743
