# 1742. Background indexer: content-addressed chunk vectors, rate limit and backoff

- Status: Accepted
- Date: 2026-11-10

## Context
The unit of the section index is the chunk (`page_chunks`, ADR 0926): a section, split into parts of
at most 600 estimated tokens. Saves and the debounced reindex (ADR 0750) must never wait for an
embedding request, and an endpoint that is slow, rate limited or down must not affect anything else.

## Decision
- **Unit and key:** one vector per chunk. The embedded text is `page title \n heading path \n chunk text`
  (cut to `EMBEDDING_MAX_CHARS`, default 4,000); its md5 is `text_hash`. The same hash is computed in
  SQL (`md5(coalesce(p.title,'') || chr(10) || c.heading_path || chr(10) || c.text)`), so "pending" is
  one predicate: a live chunk with no vector of the same page, text hash, model and dims. An edited
  section gets new vectors for its changed parts only; a section inserted above others does not
  re-embed them (positions change, texts do not); a renamed page re-embeds its chunks (the title is
  part of the text).
- **A polling loop, not a hook.** Started from index.ts only when the feature is on. Each pass reads
  up to 8 requests' worth of pending chunks (newest pages first) and embeds them in batches of
  `EMBEDDING_BATCH_SIZE` (32), one request in flight, at most `EMBEDDING_REQUESTS_PER_MINUTE` (60).
  No transaction is held across a request; a vector whose page was purged meanwhile is not written.
- **Idle cost:** when a pass found nothing and no derived index changed since (`indexEpoch`), the loop
  sleeps without a query; a full check still runs every 5 minutes (restored pages, model change).
  A pending scan with nothing to do took 51 ms on 2,667 chunks.
- **Failures:** a network error, timeout, 401/403/404, 429 or 5xx backs the endpoint off for the
  indexer and the query path together: 5 s doubling to 10 minutes, `Retry-After` honoured. The last
  error is kept (no key, ADR 1744). A 400/413/422 refuses the input, not the endpoint: the batch's
  chunks are retried one by one, and a chunk refused alone is skipped until restart (counted).
- **Model change:** the key has no model, so re-embedding replaces each live chunk's row in place.
  Rows the indexer does not reach (pages in the trash) keep the old model until the clean-up deletes
  them; a restored page is embedded again.
- **Clean-up:** every 10 minutes, vectors whose hash matches no chunk of their page and vectors of
  another model are deleted, 2,000 per statement, until a statement finds none (at most 50 rounds).
  Chunks with identical text on one page share a vector; the current-chunk set is de-duplicated so a
  batch never counts that vector twice (a short batch is not taken as "done").
- **Shutdown:** the loop stops with the process (an in-flight request is abandoned).

## Cost
Requests = ceil(chunks / batch size). In the test database (all server suites, 6,157 sections) a section
is 1.24 chunks on average, so 1,000 sections ≈ 1,240 chunks = 39 requests, ~39 s at the default
60 requests/minute plus the model's own time. Measured with the fake endpoint: a synthetic 1,000 sections of long paragraphs = 2,667 chunks =
84 requests, 2.15 s of overhead at an unlimited rate (25.6 ms per request: scan, write, cache bump).
A local Ollama on CPU spends roughly 1–5 s per batch of 32 for a 768–1,024-dim model, so 1,000
sections take about 1–3 minutes there; a hosted API is rate-limit bound (~40 s).

## Alternatives considered
- **Key `(page_id, ord)` (the memo).** Every edit that adds a block high in a page would re-embed the
  rest of the page.
- **A hook in `reindexPageChunks` (queue rows on write).** Exact and cheap, but touches the save path
  and the change-feed transaction for an optional feature. The scan costs tens of milliseconds and only
  runs after an index change.
- **Embed whole sections.** Fewer requests, but sections have no length bound (models cut at 512–8k
  tokens) and long sections would be represented by their first part only.

## Consequences
- Turning the feature off leaves the table as it was (nothing reads it); `TRUNCATE page_chunk_vectors`
  frees the space. Turning it on again re-embeds only what changed meanwhile.
- With several server processes each would run its own loop; Inkling runs one process (ADR 1550).

## References
- docs/adr/0926-*, 0750-*, 1740-*, 1741-*, 1744-*
- `apps/server/src/context/semanticIndexer.ts`, `apps/server/src/context/embeddings.ts`
