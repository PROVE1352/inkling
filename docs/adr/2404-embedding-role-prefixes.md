# 2404. Optional role prefixes for embedding models (EMBEDDING_QUERY_PREFIX, EMBEDDING_PASSAGE_PREFIX)

- Status: Accepted (amends 1740)
- Date: 2026-11-11

## Context
Semantic search (ADR 1740, 1723) sends the query and each chunk (title, heading path, text) to an
OpenAI-compatible `/embeddings` endpoint exactly as they are. Models of the e5 family
(`multilingual-e5-small`, `-base`, `-large`) are trained with a role prefix: `query: ` before a search
query and `passage: ` before a document. Without them their retrieval quality drops, and nothing in
0.19 could add them. The next measurement of find_context (the recall set of ADR 2400 with
`multilingual-e5-small`) needs them.

Vectors are stored per chunk with the model name (`page_chunk_vectors.model`); a different
`EMBEDDING_MODEL` makes every chunk pending again and the clean-up deletes the old rows. A prefix
changes the vectors as much as a model change does, so it must be handled the same way.

## Decision
- Two optional settings, empty by default: `EMBEDDING_QUERY_PREFIX` (put before the query of every
  search, after its normalisation) and `EMBEDDING_PASSAGE_PREFIX` (put before every chunk text the
  indexer sends, before the `EMBEDDING_MAX_CHARS` cut). They are taken as written, not trimmed: e5
  wants the space after the colon (`EMBEDDING_QUERY_PREFIX="query: "` in `.env`).
- `SemanticConfig.vectorModel` is the name vectors are stored and looked up under: the model alone when
  both prefixes are empty, else `<model>#p<8 hex>` (sha1 of both prefixes). Every lookup, the pending
  scan, the clean-up and the workspace vector caches use it; the request still sends the plain
  `model`, and the admin status still shows it.
- So: no prefix → nothing changes for an existing install (same name, same vectors, byte-identical
  requests). Setting, changing or removing a prefix → every chunk is embedded again and the old rows
  are deleted by the existing clean-up, exactly as after a model change. The query cache key carries
  the name too.
- `compose.yaml` passes both variables; `.env.example` documents them.

## Alternatives considered
- **A per-model built-in table** ("e5 → query:/passage:"): model names differ by host (Ollama, TEI,
  OpenAI-compatible proxies); two settings are explicit and cover bge/gte/nomic styles as well.
- **A separate `prefix` column on `page_chunk_vectors`**: a migration for what the stored name already
  expresses; the clean-up and lookups would need a second condition everywhere.
- **Hash the prefix into `text_hash`**: also re-embeds, but the old rows would linger until each chunk's
  text changes (the clean-up compares the model name only), and old and new vectors would be mixed.

## Consequences
- Turning prefixes on for an existing semantic index costs one full re-embed (the indexer's normal
  rate, `EMBEDDING_REQUESTS_PER_MINUTE`), as a model change does; until it finishes, sections without a
  new vector are found lexically only (ADR 1740).
- The stored name with a prefix is not a model the endpoint knows; it is never sent.

## References
- apps/server/src/context/semanticConfig.ts (`vectorModelName`), semantic.ts, semanticIndexer.ts
- apps/server/src/context/semantic.test.ts, semantic.db.test.ts ("e5 prefixes")
- docs/adr/1740-*, 1723-*, 2400-*
