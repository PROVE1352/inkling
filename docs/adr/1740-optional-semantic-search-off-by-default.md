# 1740. Optional semantic search: an operator's embedding endpoint, off by default

- Status: Accepted
- Date: 2026-11-10

## Context
ADR 1214 (design memo, not built) sketched hybrid retrieval for find_context: pgvector with an HNSW
index, an OpenAI-compatible embedding endpoint chosen by the operator, a background re-embed of
changed chunks, the query inside the lexical permission filter, and Reciprocal Rank Fusion with the
lexical list. It was deferred because it needed a new extension in the database image, a model to run
or a third party to send notes to, and a backfill for every page.

Release 0.14 is a light search release. The lexical work (ADR 1210–1213, and the 0.14 work on Korean
partial matching) still leaves the two misses the memo named: a question whose words are not in the
section ("팀 구성" for "우리 팀 체크리스트") and a Korean question for an English page. Some
operators already run a local model server (Ollama) or have an API key; most do not.

## Decision
Semantic search is an **opt-in feature with no default**: it is on only when the operator sets
`EMBEDDING_URL` (base URL of an OpenAI-compatible API, e.g. `http://host:11434/v1` for Ollama, or the
full `…/embeddings` URL) and `EMBEDDING_MODEL`; `EMBEDDING_API_KEY` is optional. A half-filled set
stays off with one boot warning. Tuning variables have defaults (`context/semanticConfig.ts`).

When it is off, nothing of it runs: `semanticCandidates()` returns `null` before any query or request,
index.ts does not load the indexer module, no timer is started, and `/api/admin/status` has no
`semantic` field. Existing behaviour, performance and output are byte-identical (ADR 1745 says how
this is tested).

The feature has one retrieval entry point, `semanticCandidates({ workspaceIds, query, limit, userId })`
in `context/semantic.ts`, returning `{ pageId, anchor, score }[]` (one row per section, best score
first) or `null` when off or when the endpoint fails. Fusion with the lexical list (RRF) belongs to
find_context's multi-query merge and is wired in by ADR 1723; with `null` that path is the
lexical one unchanged.

### Where this differs from the 1214 memo
| 1214 memo | This decision | Why |
|---|---|---|
| pgvector `vector(n)` + HNSW index, Postgres image `pgvector/pgvector:pg16` | plain `real[]` and brute-force cosine (ADR 1741) | no image change for any self-hoster; a workspace of a few thousand chunks scores in ~10 ms from memory |
| side table keyed `(page_id, ord, model)` | keyed `(page_id, text_hash)`, model and dims as columns (ADR 1742) | an inserted section shifts every `ord`; content addressing re-embeds only new text |
| chunk writer marks changed rows | no change to the chunk writer; the indexer compares hashes (ADR 1742) | the save path stays exactly as it was, on or off |
| query inside the lexical SQL's permission filter | its own query with the same rules, plus a workspace membership filter (ADR 1743) | the caller's workspace list is checked again, so a wrong list cannot leak |
| fusion decided here | fusion left to the multi-query merge (RRF) | one merge for every candidate list |
| evaluation gates adoption | off by default; the dev/test numbers are an integration step | the feature changes nothing until an operator turns it on |
| no status | counts and the last error in the admin status (ADR 1744) | operators need to see a backfill and a broken endpoint |

## Alternatives considered
- **Build the memo as written (pgvector).** Scales to any size with an index, but every self-hoster
  would need another Postgres image or extension for an optional feature. Rejected for 0.14; the
  table can move to `vector(n)` later without changing the entry point.
- **Ship a model inside the server (ONNX/transformers.js).** A new dependency of hundreds of MB and
  CPU inside the request process. Rejected (ADR 0882).
- **On by default with a hosted provider.** Note text would leave the server without an explicit
  choice. Rejected.

## Consequences
- Operators who set the variables send chunk text (page title, heading path, chunk text) to the
  endpoint; with a hosted provider that is a third party. The docs say so next to the variables.
- The first enablement embeds every live chunk in the background (cost in ADR 1742); search answers
  from what is already embedded meanwhile.
- A model change re-embeds everything (vectors carry model and dims).

## References
- docs/adr/1214-*, 1210-*–1213-*, 0927-*, 0937-*, 1741-*–1745-*
- `apps/server/src/context/semanticConfig.ts`, `semantic.ts`, `semanticIndexer.ts`, `embeddings.ts`
