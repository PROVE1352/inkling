# 0926. Section index (`page_chunks`) with heading-path anchors

- Status: Accepted
- Date: 2026-11-07

## Context
MCP agents found content with `search` (substring, unranked, 20 per workspace), then read whole pages
with `read_page`, often several, because nothing smaller than a page was addressable. Retrieval,
partial reads, section edits (ADR 0930) and the change feed (ADR 0932) all need one shared notion of
"a section of a page" with an id that survives ordinary editing.

## Decision
- **Sections** (`context/chunker.ts:191` `splitSections`): a top-level heading block plus every
  top-level block up to the next top-level heading of any level. Nested headings stay content.
  Content before the first heading is `_intro` (dropped when empty). Long sections are split into
  parts of at most 600 estimated tokens at line boundaries (`MAX_CHUNK_TOKENS`, `chunkSections`);
  parts share the anchor. Text is a light Markdown rendering (lists, checkboxes, code fences, table
  rows, `[[internal links]]`) built in one pass without the BlockNote editor.
- **Anchors**: the heading path slugged and joined with `/` (`setup/backups`); Unicode letters and
  digits are kept (`결정-사항`); a repeated path gets `~2`, `~3`. `findSection` also accepts the
  heading text, a `A › B` / `A > B` path or the heading block id.
- **Section version**: first 12 hex characters of sha1(heading path + body) — the `v=` an agent
  sees and passes as `baseVersion` to patch_section.
- **Table** `page_chunks` (migration `0028_agent_context`): `(page_id, ord)` primary key,
  `workspace_id`, `anchor`, `block_id`, `heading_path`, `level`, `part`, `text`, `grams`,
  `token_estimate`, `hash`, `section_hash`, and a **stored generated** `tsv` =
  `to_tsvector('simple', heading_path || ' ' || text || ' ' || grams)`. Indexes: GIN on `tsv`, GIN
  `gin_trgm_ops` on `text`, btree on `workspace_id`. Marker table `page_chunk_index(page_id, version)`.
- **Korean**: `'simple'` splits on spaces only, so a 2-syllable term inside a compound ("회의" in
  "주간회의") would never match. `grams` holds the CJK bigrams of runs longer than two characters
  (`cjkBigrams`), indexed in the same vector; 3+ character CJK terms additionally use the trigram
  index (ADR 0927). Query terms also try the term without a trailing particle ("백업을" → "백업").
- **Maintenance** (`context/chunkIndex.ts:72` `reindexPageChunks`): diffs new chunks against the
  stored rows by position and upserts only rows whose hash changed, deletes rows past the new end,
  stamps the marker; never throws. Called from the debounced store indexer (`docIndexer.ts:105`,
  own signature so unchanged chunk lists skip even the diff), import (`md/importer.ts`), vault sync,
  structure templates; subtree duplicate copies rows inside Postgres (`routes/pages.ts:209`).
- **Backfill** (`backfillPageChunks`, `index.ts:416`): pages with a document and no marker of the
  current `CHUNKER_VERSION`, 50 per batch with `setImmediate` yields, at most 50,000 per boot,
  failed pages stamped so they are not reselected. Bumping `CHUNKER_VERSION` re-indexes everything.
- **Token estimate** (`context/tokens.ts:9`): ASCII characters / 4 + one per Hangul/CJK character +
  other non-ASCII / 2. No tokenizer dependency; deliberately high for Korean so budgets are not
  overrun. Every number in ADR 0927 uses this estimator on both sides.

## Alternatives considered
- **Block-id anchors.** Survive heading renames, but `update_page replace`, Markdown import and vault
  upload regenerate every block id (KNOWN-ISSUES "A vault upload regenerates all block ids"), and
  agents cannot guess them. Heading paths survive all of those and are readable; a renamed heading
  changes its anchor, which the change feed reports as `renamed` (ADR 0932). Block ids remain an
  accepted fallback reference.
- **Expression GIN index on `to_tsvector(...)` instead of a stored column.** First version. The
  index matched, but `ts_rank` and per-term coverage had to re-parse every candidate's text: p50
  182 ms / p95 404 ms on 15k chunks; with the stored vector p50 ≈ 48 ms / p95 ≈ 68 ms (same data).
  The extra ~1× text size on disk is the price.
- **Embedding vectors (pgvector).** New extension and dependency, a model to run, and the eval set
  is already answered at section@1 = 0.93–1.0 lexically. Revisit with a cross-lingual need.
- **One row per page** (`page_texts` reuse): no partial reads, no section versions.

## Trade-offs
- Index lag equals the store indexer's debounce (≤ 30 s while typing); server edits index immediately.
- Text is stored twice (`page_texts` and `page_chunks`), bounded by the same 200 KB per page.
- Heading renames change anchors; the old anchor stops resolving.

## How others solve it
Docs sites and RAG pipelines chunk by headings with slugged anchors (GitHub's heading ids, Docusaurus
TOCs); LlamaIndex/LangChain "markdown header splitters" do the same with size-capped sub-chunks.
Postgres full-text with `simple` + n-grams is the usual answer for CJK without a morphological
analyzer.

## Consequences
- `page_chunks` is a derived index like `page_texts`; `drizzle-kit push` must still never be used.
- New writers of `page_docs` must call `reindexPageChunks` (or `forgetDocIndex` + the store hook).

## References
- apps/server/src/context/chunker.ts:20 (`CHUNKER_VERSION`), :191 (`splitSections`), :248, :302, :340
- apps/server/src/context/chunkIndex.ts:72, :218
- apps/server/src/db/schema.ts (`pageChunks`, `pageChunkIndex`), apps/server/drizzle/0028_agent_context.sql
- apps/server/src/docIndexer.ts:105, apps/server/src/routes/pages.ts:209, apps/server/src/index.ts:416
- apps/server/src/context/tokens.ts:9
