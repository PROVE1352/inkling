# 1040. The section index covers the whole page; page_texts keeps head + tail

- Status: Accepted
- Date: 2026-11-07

## Context
Both text indexes stopped at 200 KB per page: `page_texts` (`md/textIndex.ts`, `MAX_TEXT_BYTES`) and
`page_chunks` (`context/chunker.ts`, `MAX_PAGE_TEXT_BYTES`). A production "experiment log" page holds
469k characters of live text (4.5 MB of Yjs state, 170 sections, 192 tables). Only its first 56 of
170 sections were in `page_chunks` and only the first 200 KB in `page_texts`, so the newest entries
(appended at the end) were invisible to `find_context`, `search` and the change feed.

Why 200 KB existed, checked against the code and Postgres:
- `page_texts` has no `tsvector`; it is plain text with a `gin_trgm_ops` index. Postgres' 1 MB
  `tsvector` limit does not apply to it. The only `tsvector` is `page_chunks.tsv`, one per chunk of
  ≤ 600 estimated tokens, far below 1 MB whatever the page size.
- `pg_trgm` has no size limit either. The cap bounds cost, not correctness: the search route
  (`routes/workspaces.ts`) returns `page_texts.text` of up to 20 result rows to Node for snippets,
  unlinked mentions re-check `ILIKE` on the whole detoasted text, the share page reads it for its
  description, and every store rewrites the row and its trigram GIN entries.
- For `page_chunks` the cap was copied from `page_texts` ("same cap", ADR 0926). Chunks are already
  bounded by size, rows are diffed per position (a store rewrites only changed chunks), and nothing
  reads all of a page's chunk text at once.

## Decision
- **page_chunks: no text cap.** `chunkSections` indexes every section; the only bound is
  `MAX_CHUNKS_PER_PAGE = 5,000` rows (≈ 3M estimated tokens). A page at that bound is treated as
  partially indexed by the outline/section reads (ADR 1041). `CHUNKER_VERSION` 2 → 3.
- **Upgrade cost:** a version-2 index whose rows total ≤ 200 KB and < 2,000 rows was never cut, so it
  equals what version 3 writes. The boot backfill first stamps those as version 3 in one `UPDATE`
  (`promoteUncutIndexes`, `chunkIndex.ts`) and re-indexes only pages that may have been cut. Those
  pages also get their `page_texts` rewritten when the body is over the cap.
- **page_texts: keep the 200 KB budget, spend it on head + tail.** `capPlainText` keeps the first
  and the last ≈ 100 KB, cut on UTF-8 character boundaries and joined by `\n…\n`. The head tells what
  the page is, the tail holds the newest entries of a growing log. The middle of a very long page is
  found by `find_context` (the section index has it all), not by `search`.
- `Section.tokens` is now the sum of the estimates of the section's index parts (`sectionTokens`),
  so an outline built from the index and one built by a decode print the same numbers (ADR 1041).
  It differs from the old whole-body estimate only for sections over 600 tokens (by at most one
  token per part).

## Alternatives considered
- **No cap on page_texts.** Search snippets would move up to the whole body (megabytes) to Node for
  every hit on such a page and the trigram index would be rewritten in full on every store of it.
  Rejected without measurement because head + tail already finds new entries.
- **Search also probes `page_chunks`.** Finds the middle too, but changes the documented search
  route (`docs/API.md`), adds a trigram probe over a table several times larger to every search,
  and snippets would have to come from a different source. Possible later; `find_context` is the
  agent path and already covers it.
- **Head only, larger cap.** Moves the problem; a log that grows past any cap hides its newest part.

## Consequences
- Index rows of a 4.5 MB page: 130 → 490 (`current.bin`), 122 → 361 (synthetic 4.1 MB page);
  index text 205 KB → about 0.8 MB for that page. Measurements in docs/PERFORMANCE.md.
- `search` still misses text in the middle of a page over 200 KB of plain text.
- `KNOWN-ISSUES` AGENT-P2 ("each capped at 200 KB") should now read: section text is stored twice,
  page_texts capped at 200 KB (head + tail), page_chunks at 5,000 rows.

## References
- apps/server/src/context/chunker.ts (`CHUNKER_VERSION`, `MAX_CHUNKS_PER_PAGE`, `chunkSections`, `sectionTokens`)
- apps/server/src/context/chunkIndex.ts (`promoteUncutIndexes`, `backfillPageChunks`)
- apps/server/src/md/textIndex.ts (`capPlainText`, `MAX_TEXT_BYTES`, `TEXT_CUT_MARK`)
- apps/server/src/context/largePage.test.ts, apps/server/src/context/largePage.db.test.ts
- ADR 0926 (section index), ADR 0755 (search probes)
