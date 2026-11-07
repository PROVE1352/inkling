# Performance log

This file records every algorithm or data-structure change made for performance, with the numbers
before and after and how they were measured. It also records changes that were measured and
rejected, changes that had no effect, and regressions, so the same idea is not tried twice and a
slowdown is never silent. The reasoning behind each change lives in its ADR (`docs/adr/`); this file
is the index of the numbers.

## Measurement principles

- **Same data, same conditions.** Before and after run on the same seed, machine and settings,
  ideally back to back or interleaved. A number measured on different data is not a comparison.
- **Distributions, not single runs.** Report p50 and p95 (or median and range) for latency, and
  the number of runs. Ranges in the tables are the spread over runs as given in the ADR.
- **State the load.** Concurrency (sequential, N parallel clients), data size (pages, rows, chunks,
  blocks, bytes) and whether caches were warm.
- **State the environment.** Node version, Postgres version, browser engine and build type
  (production or dev server), machine class and database size.
- **Link the source.** Every number links to the ADR (and, where possible, the commit) where it
  was recorded together with its script or test. A number without a source does not go in.
- **Improvement** is computed from the Before and After cells of the same row: percentages for
  token and size reductions, multiples (×) for time. Ranges in the inputs give a range here; no
  midpoint is picked.
- **Cost** lists what the change made worse or what it trades away. An honest cost is not a
  regression; a regression is a measured slowdown of something users already had.

The entries below were recorded before this log existed. Their "How measured" cell repeats only
what the ADR states; Node version, hardware and run counts are given where the ADR records them
and are otherwise not recorded. Commit hashes are not listed yet; the ADR is the source.

## Retrieval & MCP

Token counts are `estimateTokens` (ADR 0926) of the tool output an agent receives.

| Area | Change (what algorithm or structure) | Before | After | Improvement | Cost | How measured | Source |
|---|---|---|---|---|---|---|---|
| find_context, large corpus | Section-level retrieval: stored section index, lexical ranking, greedy packing into a token budget, instead of search + whole-page reads | 2,254 mean tokens (median 1,910), 3.68 calls, success 0.75 (page@1 0.68) | 624 mean tokens (median 123), 1.00 call, success 0.93 (section@1 0.93, section@3 0.93) | −72% tokens (3.6×), 3.68× fewer calls, success +0.18 | Lexical only: no synonyms or cross-language matching | 28 questions (English and Korean, `context/evalSet.ts`), fictional 25-page wiki padded to 1–2k tokens/page + 5,000 distractor pages (15,310 chunks). Before = old tools with an oracle stop (≤ 3 reads). `apps/server/scripts/context-bench.ts`, Postgres 16 in Docker on a laptop | [ADR 0927](adr/0927-find-context-ranking-and-budget-packing.md) |
| find_context, small corpus | Same as above | 377 mean tokens (median 308), 3.36 calls, success 1.00 | 135 mean tokens (median 121), 1.00 call, success 1.00 | −64% tokens (2.8×), 3.36× fewer calls | Same as above | Same 28 questions on the unpadded 25-page wiki, same script and setup | [ADR 0927](adr/0927-find-context-ranking-and-budget-packing.md) |
| find_context latency | Coverage-ordered coarse SQL + trigram probe only for CJK terms, 300-candidate cut | Old one-term search route p50 3 ms (does far less work, not comparable) | p50 49 ms, p95 67 ms | None claimed (absolute latency of the new tool) | New per-question latency compared with a plain search | 15k-chunk workspace above, direct call, 3 × 28 queries | [ADR 0927](adr/0927-find-context-ranking-and-budget-packing.md) |
| Section index full-text search | Stored `tsvector` column on `page_chunks` instead of an expression GIN index | p50 182 ms, p95 404 ms (expression index; `ts_rank` and coverage re-parse every candidate) | p50 ≈ 48 ms, p95 ≈ 68 ms | 3.8× (p50), 5.9× (p95) | About 1× extra text size on disk | 15k chunks, same data for both | [ADR 0926](adr/0926-section-index-and-stable-anchors.md) |
| list_pages / search output | Compact `format: "lines"` output instead of JSON | list_pages 967 tokens, search 75 tokens | list_pages 392 tokens, search 43 tokens | −59% (list_pages), −43% (search) | Opt-in; JSON stays the default | Evaluation wiki, `context.db.test.ts` log lines; conditions not recorded beyond that | [ADR 0928](adr/0928-partial-and-batch-reads-compact-output.md) |
| patch_section | Edit one section as a Yjs edit with a base version, instead of read_page + update_page replace | ≈ 2,415 tokens (read + update_page replace) | ≈ 222 tokens (outline + call + result) | −91% (10.9×) | None for tokens; see Sync & collaboration for the echo cost | Changing one sentence on the padded evaluation page, `context.db.test.ts` | [ADR 0930](adr/0930-patch-section-yjs-splice-with-base-version.md) |
| changes_since | Cursor-based section change feed with merged log rows and line diffs, instead of re-reading pages | 5,724 tokens (re-read the 4 pages with read_page) | 388 tokens, recall 12/12 | −93% (14.8×) | Before/after text up to 2 × 16 KB per log row | 40 edits on 12 sections of 4 pages → 12 log rows, `apps/server/src/context/changeFeed.test.ts` ([db] suite) | [ADR 0932](adr/0932-change-feed-cursor.md) |
| query_rows, first page | Row-level collection query (filters, fields, paging) instead of read_page of the whole table | 7,083 tokens (read_page) | 838 tokens (25 rows, default columns) | −88% | 200 rows with all columns cost 9,679 tokens (+37% over read_page) | 200-row, 7-field collection, `collectionQuery/collectionQuery.db.test.ts` | [ADR 0934](adr/0934-collection-query-tools-for-agents.md) |
| query_rows, filtered | Same, 3-condition filter, 2 columns | 7,083 tokens (read_page) | 519 tokens, 17 of 17 expected rows | −93% | Each row line carries its id and version (about 13 tokens) | Same collection and test | [ADR 0934](adr/0934-collection-query-tools-for-agents.md) |
| Untrusted-data wrappers | Data/instruction boundary markers and `can:` attributes around user-written content in tool output | find_context + section mean 631 (padded) / 135 (unpadded) tokens; old flow 2,264 | 665 / 158 tokens; old flow 2,320 | None (security mitigation) | +5.4% (+34) padded, +17% (+23) unpadded, +2.5% (+56) old flow; fixed ≈ 15–25 tokens per call | `apps/server/scripts/context-bench.ts --pages 1000`, fresh DB each run | [ADR 0976](adr/0976-data-instruction-boundary-in-mcp-output.md) |
| Injection scan, URL rules | URL and image-exfil rules as one left-to-right pass (non-overlapping URL tokens, each `=` after `?` checked once) instead of regexes whose classes both accepted `?` and `=` (backtracking over every split point, cubic) | 20 KB adversarial text: `http://?` 19,522 ms, `http://a?b` 12,465 ms, `![x](http://a?` 7,799 ms, `https://x/p?a=&` 2,606 ms; 180 KB did not finish in 10 min | 20 KB: 0.2–0.4 ms; 180 KB: 1.7–3.0 ms; ordinary prose unchanged (0.5 ms / 20 KB, 4.1 ms / 180 KB) | ≈ 10⁴–10⁵× on adversarial input (one document could stall the server's event loop for seconds to hours) | None found; same 50 detection cases pass, plus placeholders in a later query parameter or after a space | `scanInjection` called directly, Node 22.23.4, Apple-silicon MacBook Air; before = 1 run per input (20 KB), after = median of 3 (20 KB) and 5 (180 KB). Guard test in `mcpTools/trust.test.ts` (180 KB < 1 s) | [ADR 0977](adr/0977-injection-signals-and-taint-record.md) |

## Editor & web

| Area | Change (what algorithm or structure) | Before | After | Improvement | Cost | How measured | Source |
|---|---|---|---|---|---|---|---|
| Presence list | Push the online-users list to React only when it changes (`sameUsers` comparison) | 303 React commits | 2–3 commits | ≈ 100–150× fewer commits | O(users) comparison per awareness event | Headless Chromium and WebKit, production build, a second client changing an awareness field 150 times at 100 ms intervals, commits counted through the DevTools hook | [ADR 0700](adr/0700-awareness-users-equality.md) |
| Table view, 10,000 rows | Own fixed-height list windowing (`useWindowedRows`) | First paint ~14 s, scroll frame p50 482 ms / p95 783 ms | First paint 2.4 s, 26 rows in the DOM, scroll p50 50 ms / p95 100 ms | ≈ 5.8× (first paint), 9.6× (p50), 7.8× (p95) | Windowed rows are one line high (cells clipped) | Headless Chromium against the Vite dev server (dev-mode React; first paint includes the 4.4 MB API response), synthetic 2,500 px-per-frame scroll | [ADR 0302](adr/0302-own-list-virtualization.md) |
| Bundle size | Route- and feature-level code splitting (`React.lazy` routes, lazy canvas/collection/graph, lazy Shiki) | 680 KB gzip on every route | Entry 163 KB, doc page 517 KB, canvas 578 KB, database 540 KB, graph 179 KB, admin 174 KB | −76% entry, −15% to −24% on editor routes | One extra round trip on a cold first visit to a non-shell route | `vite build`, gzip of the static import closure from `index.html`; CSS unchanged (49 KB gzip) | [ADR 0704](adr/0704-route-and-feature-code-splitting.md) |
| Right-panel outline | Outline read from the ProseMirror doc with a per-block `WeakMap` cache, instead of `editor.document` walked three times | 1.4–4.9 ms per tick | 0.2 ms per tick after an edit | 7–25× | Depends on BlockNote's ProseMirror layout | Chromium, 3,701-block document, per 300 ms tick | [ADR 0705](adr/0705-right-panel-incremental-outline.md) |
| Sidebar tree navigation | Memoized rows with per-row store subscriptions (`useSyncExternalStore`), node reuse in `buildTreeShared` | 7,009 row renders, ~430 ms long tasks per navigation | 4 row renders, ~115 ms long tasks (remainder is layout of the 40k-node sidebar) | 1,750× fewer renders, ≈ 3.7× less long-task time | Rows read flags from a store written during render | Headless Chromium, production build, 2,335 rows expanded, 6 navigations | [ADR 0708](adr/0708-page-tree-row-subscriptions.md) |
| Board view, 10,000 rows | Columns render the first 50 cards plus "Show N more" | 50,929 DOM nodes, 5,682 ms long tasks on open, 645 ms while scrolling | 1,682 DOM nodes, 0 ms, 0 ms | 30× fewer nodes; long tasks eliminated | Cards past the first 50 are not drop targets until shown | Production build, headless Chromium, long tasks via PerformanceObserver | [ADR 0709](adr/0709-board-incremental-columns.md) |
| Math pages, 1,000 formulas | Shipped math rendering (memory LRU, 8 ms render slices, ≤ 16 insertions per frame, cap of 100 rendered display formulas, deferral from 300 formulas) vs the first version (synchronous render in React render) | First display 1,427 ms; long tasks 3, max 516 ms; typing p50 29.9 / p95 64.4 ms; 123,656 DOM nodes | 670–685 ms; 1, max 169–171 ms; 21.9–22.3 / 30.1–38.2 ms; 62,080 nodes (final build, 1 run: 683 ms, 169 ms, 18.9 / 30.2 ms) | 2.1× first display, 3.0× longest task, 1.3–1.4× p50, 1.7–2.1× p95 | Formulas past two screens render later (all done after ≈ 7 s); CLS on load stays ≈ 0.07 | Headless Chromium, Apple-silicon MacBook Air, production build, 1280×900, fresh profile per run, 1–2 runs (ranges); N formulas half display (≈110 chars) / half inline; typing = 43 keys at 60 ms, keydown → next frame; plain-text control: 411 ms, no long task, 5.0 / 15.3 ms | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math pages, 500 formulas | Same | 912 ms; 3, max 268 ms; 19.6 / 26.6 ms; 62,020 nodes | 556–598 ms; 1, max 71–77 ms; 17.2–20.0 / 23.4–26.5 ms; 44,365 nodes | 1.5–1.6× first display, 3.5–3.8× longest task | Same | Same | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math pages, 100 formulas | Same (below the deferral threshold: render all, paced) | 570 ms; 1, max 81 ms; 12.0 / 18.6 ms | 585–587 ms; no long task; 9.2–9.4 / 13.5–14.2 ms | Long task removed; first display unchanged | — | Same | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math insertion pacing | Hand rendered formulas to React ≤ 16 per animation frame instead of all results of a batch at once | 1,000 formulas: long tasks 4–9, max 423–683 ms; 500: 5–6, max 184–240 ms | 1, max 170–173 ms; 1, max 71–73 ms | 2.5–4× longest task | All formulas on screen a few frames later | Same setup, worker variant before/after, 2 runs | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math resident cap | At most 100 rendered display formulas in the DOM, evict farthest from the viewport (placeholder keeps source text and exact box) | 1,000 formulas: typing p50 29.9–30.5 ms, 123,656 nodes | 22.9 ms, 62,114 nodes; ping-pong scroll re-insertions 126 (OPT 71), scan 237; scroll CLS 0 | 1.3× p50, −50 % DOM | Re-insertions while scrolling (from the cache, paced) | Same; scroll scan 160 × 400 px, ping-pong 3 × 40 steps; OPT = Belady on the recorded trace | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math deferral threshold | Defer off-screen formulas from 300 formulas on (not below) | Not deferred: first display 760–836 ms (300), 1,224–1,272 ms (500), 2,584–2,616 ms (1,000) | Deferred: 507, 564, 698 ms | 1.5×, 2.2×, 3.7× | All formulas rendered only after ≈ 5.6–7.7 s; at 100 formulas the gain is 1.16× (510 vs 589–592 ms), so not enabled there | Same, worker variant, deferral forced on/off | [ADR 0998](adr/0998-math-render-scheduling.md) |

## Server & database

| Area | Change (what algorithm or structure) | Before | After | Improvement | Cost | How measured | Source |
|---|---|---|---|---|---|---|---|
| Collab store path | Auto snapshot inside Postgres, one-round-trip persistence, debounced and diffed derived-index rewrites | 40,006 SQL statements; DB time 4.9–5.9 s; wall 29.6–35.5 s; Node CPU 10.7–11.6 s | 1,042 statements; DB 0.8–1.3 s; wall 4.7–6.3 s; Node CPU 4.2–6.0 s | 38× fewer statements; DB 3.8–7.4×; wall 4.7–7.6×; CPU 1.8–2.8× | Search, backlinks, tags and tasks of a page being typed in lag by up to 30 s | 1,000 store calls on a ~300-block page (93 KB state), same machine, back-to-back runs, `pg_stat_statements`; Node CPU includes a 1.5 s harness | [ADR 0750](adr/0750-collab-store-path-db-side-snapshot-debounced-diffed-indexing.md) |
| Conditional GET | Version ETags checked before doing the work (`precheckEtag`), content-hash ETags otherwise | Full 200: tree 101 ms, graph 91 ms, due 84 ms, collection 80 ms | 304: tree 7.1 ms (0 B), graph 6.4 ms, due 7.1 ms, collection 7.3 ms | 11–14× | Version ETag only as precise as `workspaceVersion` (user renames do not bump it) | 5k pages + 10k-row collection, interleaved full vs conditional requests, p50 | [ADR 0752](adr/0752-http-caching-policy-and-conditional-gets.md) |
| Public share pages | Bounded LRU with TTL and byte budget for rendered HTML and allowed file ids | p50 17.0 ms | p50 0.9–2.1 ms | 8–19× | Up to ~40 MB of cache in the worst case | 30 sequential views of a 93 KB-state page | [ADR 0753](adr/0753-public-share-render-cache.md) |
| Search | Two index-friendly probes (title ∪ body ILIKE) for terms ≥ 3 characters, instead of OR across a LEFT JOIN | 78 ms | 3 ms, identical result sets | 26× | A term matching nearly every page is ~10% slower (66 → 73 ms) | Seed: 5,000 pages (≈ 2 KB body each), 10k-row collection, 15k links, 20k notifications; EXPLAIN (ANALYZE, BUFFERS) | [ADR 0755](adr/0755-search-indexes-planner-costs-and-hot-updates.md) |
| Unlinked mentions | Transaction-local `random_page_cost = 1.1` (`withSsdPlanCosts`) flips the plan from a seq scan | 94 ms | 0.4 ms | 235× | None recorded | Same seed and method | [ADR 0755](adr/0755-search-indexes-planner-costs-and-hot-updates.md) |
| Notifications | Index on `notifications(user_id, created_at)`, ordered index scan stops at 50 rows | 8.1 ms | 0.33 ms | 25× | One more index to maintain | Same seed and method | [ADR 0755](adr/0755-search-indexes-planner-costs-and-hot-updates.md) |
| `pages` HOT updates | `fillfactor = 85` on `pages` (90 on `page_docs`) so `updated_at` bumps stay on the heap page | 2 of 2,267 updates HOT (0.1%) | 4,090 of 4,484 HOT (91%) | 0.1% → 91% HOT | 15% of each `pages` heap page left empty; applies to newly written pages only | Same seed, after a table rewrite | [ADR 0755](adr/0755-search-indexes-planner-costs-and-hot-updates.md) |
| Query blocks | Lateral fence + `SET LOCAL jit = off` in the query compiler | 3.4–90.5 ms across 8 representative queries (e.g. no-filter LIMIT 500: 90.5 ms) | 1.7–29.2 ms (same query: 29.2 ms) | 1.6–4.1× per query | None recorded | 5,000 docs + 50 folders + a 500-row collection, Postgres 16 on a laptop, median SQL time of 7 runs | [ADR 0203](adr/0203-query-language-parser-and-sql-compilation.md) |

## Sync & collaboration

| Area | Change (what algorithm or structure) | Before | After | Improvement | Cost | How measured | Source |
|---|---|---|---|---|---|---|---|
| Collab WebSockets | One tab-wide multiplexed Hocuspocus socket instead of one per provider | 7 sockets open on the page, 13 created over the run | 1 open, 3 created (2 short-lived fallbacks) | 7× fewer open sockets | Fallback rules for duplicate, just-closed and denied documents | Production build, headless Chromium and WebKit, page with 5 page embeds, then 6 SPA navigations | [ADR 0702](adr/0702-shared-collab-websocket.md) |
| patch_section concurrency | Minimal Yjs edit (block alignment + character diff) instead of deleting and re-inserting the section | Concurrent typing kept in 1/6 scenarios; fuzz markers kept 0/240; block ids kept 0/4; callouts and mentions lost | 6/6; 240/240; 4/4; all kept | Correctness: no lost concurrent input in the tested cases | Echo before the patch ≈ 43 ms (100 blocks) / 94 ms (300 blocks); synchronous part in the transaction ≈ 9 / 15 ms | `apps/server/src/context/sectionPatch.test.ts`, old splice kept as `legacyPatch`; fuzz = 60 random sections and agent edits with a marker typed into every block | [ADR 0940](adr/0940-patch-section-minimal-yjs-edit.md) |

## Memory

Peak RSS delta is measured on the server process; heap is the JS heap after a forced GC.

| Area | Change (what algorithm or structure) | Before | After | Improvement | Cost | How measured | Source |
|---|---|---|---|---|---|---|---|
| Undo history | Cap the Yjs undo stack at 500 captures (trim at 550), un-keeping deleted structs | +3.88 MB heap, 4,997 stack items | +1.52 MB heap, ≤ 550 items | −61% heap growth | Edits older than 500 undo bursts cannot be undone | Headless Chromium, 5,000 programmatic captures with `stopCapturing()` between edits | [ADR 0701](adr/0701-yjs-undo-stack-cap.md) |
| Upload | Stream to disk through a byte-counting transform instead of `toBuffer` | +31 MB | +1–7 MB | 4.4–31× less | Needs free disk in `DATA_DIR` | 24 MB upload, fresh process per operation, same seed, original vs new code | [ADR 0751](adr/0751-stream-large-bodies-to-disk-and-copy-in-postgres.md) |
| Folder import | Stream each part to a temp dir and feed entries lazily, instead of buffering and re-zipping | +114 MB, 782 ms | +32–37 MB, 351–695 ms | 3.1–3.6× less memory, 1.1–2.2× faster | Temp files remain until `finally` or the next boot if interrupted | 2 × 20 MB assets + 8 Markdown files, same method | [ADR 0751](adr/0751-stream-large-bodies-to-disk-and-copy-in-postgres.md) |
| Duplicate / instantiate | `INSERT … SELECT … FROM unnest(old_ids, new_ids)` in Postgres instead of loading every state into a Map | +286 MB, 296 ms | +5–6 MB, 87–135 ms | 48–57× less memory, 2.2–3.4× faster | Only template pages containing `{{` are still decoded in Node | 99 docs (9.2 MB of Yjs state), same method | [ADR 0751](adr/0751-stream-large-bodies-to-disk-and-copy-in-postgres.md) |
| Public share pages | Render cache (see Server & database) | Peak RSS +88 MB | +5 MB | 17.6× less | Up to ~40 MB of cache in the worst case | 30 sequential views of a 93 KB-state page | [ADR 0753](adr/0753-public-share-render-cache.md) |

## Rejected / no effect

Measured and not adopted, or adopted for reasons other than speed. "Before" is the kept or baseline
variant, "After" the variant that was tried.

| Area | Change (what algorithm or structure) | Before | After | Improvement | Cost | How measured | Source |
|---|---|---|---|---|---|---|---|
| find_context ranking | Link-graph proximity boost (+0.05 for pages linked to/from the top 3) | section@1 0.93 | section@1 0.93 | None; removed from the code | One extra `page_links` query | Large corpus of ADR 0927 with four cross links added | [ADR 0927](adr/0927-find-context-ranking-and-budget-packing.md) |
| find_context packing | Relative relevance floor 0.45 instead of 0.6 | 624 mean tokens at 0.6, success 0.93 | 1,416 mean tokens at 0.45, success 0.93 | Worse: 2.3× the tokens for the same success; 0.6 kept | — | Same benchmark | [ADR 0927](adr/0927-find-context-ranking-and-budget-packing.md) |
| find_context candidates | Trigram probe for every term ≥ 3 characters + ts_rank-only coarse order | Coverage order + trigram only for CJK: recall 0.93, p50 49 ms / p95 67 ms | Recall 0.75, p50 182 ms / p95 404 ms | Worse; rejected | — | Same 15k-chunk corpus | [ADR 0927](adr/0927-find-context-ranking-and-budget-packing.md) |
| Section full-text index | Expression GIN index on `to_tsvector(...)` (first version) | Stored vector: p50 ≈ 48 ms / p95 ≈ 68 ms | p50 182 ms / p95 404 ms | Worse; replaced by the stored column | — | 15k chunks, same data | [ADR 0926](adr/0926-section-index-and-stable-anchors.md) |
| Search plans | `enable_seqscan = off` instead of local `random_page_cost` | Local `random_page_cost = 1.1` | 1–2 character searches 9× slower (GIN full-index scan) | Worse; rejected | — | Seed of ADR 0755 | [ADR 0755](adr/0755-search-indexes-planner-costs-and-hot-updates.md) |
| Query blocks | Expression index `page_tags (lower(tag))` | 12.0 ms | 12.1 ms | None; not added | — | 5,000 docs seed of ADR 0203, median of 7 runs | [ADR 0203](adr/0203-query-language-parser-and-sql-compilation.md) |
| Zip export | Spill rendered entries to temp files, lazy asset streams | +49 MB peak RSS | +43–58 MB | No measurable change; kept on design grounds (bounded by one page) | Needs free disk in `DATA_DIR` | 99 docs (2.9 MB zip), fresh process per operation; at 990 pages one run each, too noisy to claim | [ADR 0751](adr/0751-stream-large-bodies-to-disk-and-copy-in-postgres.md) |
| JSON serialisation | Schema-based serializer for large responses | `JSON.stringify` 2.6 ms of a 26 ms DB query (4.6 MB collection) | Not built | Not worth it; 304s avoid the work instead (ADR 0752) | — | 10k-row collection GET | [ADR 0758](adr/0758-postgres-and-node-runtime-settings.md), [ADR 0759](adr/0759-hardware-cache-hot-loops-measured-and-rust-notes.md) |
| Collection GET hot loops | Monomorphic shapes / typed arrays for per-row loops | Row DTO spread 0.4 ms, `JSON.stringify` 2.6 ms, DB 26 ms | Not built | Cannot move the total; the driver materialising rows dominates | — | 10k-row collection GET | [ADR 0759](adr/0759-hardware-cache-hot-loops-measured-and-rust-notes.md) |
| Graph view | Structure-of-arrays (TypedArray) layout instead of d3-force node objects | Frame p50 16.7 ms, p95 16.8 ms (vsync-bound), one 57 ms task at start | Not built | No measurable gain at this size | Would mean re-implementing the force engine | Workspace with 2,335 pages, production build, headless Chromium, M-series Mac, first 6 s of simulation | [ADR 0710](adr/0710-graph-engine-soa-rejected.md) |
| WebKit editor blocks | `content-visibility: auto` variants in WebKit | Off: open 1,065 ms, relayout 40 ms, keystroke 33 ms | On (current CSS): 3,600 / 300 ms / —; plain `auto 60px`: 1,440 / 130–360 / 590 ms; `contain: layout style`: 1,435 / 195 / 200 ms | Worse in every variant; rejected (also 1/6 new blocks painted) | — | Playwright WebKit, production build, 3,701-block document, median of 3–5 runs | [ADR 0703](adr/0703-webkit-content-visibility-stays-off.md) |
| Math rendering in a Web Worker | KaTeX in one worker (queue, cancel, main-thread fallback) instead of main-thread 8 ms slices, both with paced insertion | Main thread: 1,000 formulas 2,776 ms first display, long task max 176 ms, typing p50 31.1 ms; 500: 1,249 ms, 70 ms | Worker: 2,584–2,616 ms, 169–176 ms, 29.9–30.5 ms; 1,224–1,272 ms, 71 ms | None measurable; removed | +77 KB gzip second download | Headless Chromium, Apple-silicon MacBook Air, production build, 1280×900, fresh profile per run, 1–2 runs (ranges); N formulas half display (≈110 chars) / half inline; typing = 43 keys at 60 ms, keydown → next frame. KaTeX alone: 0.6 ms per benchmark formula, ≤ 5.2 ms for 4,000-character worst cases (Node) | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math persistent cache | IndexedDB cache of rendered HTML (key: KaTeX version, options, latex, display mode) | Cold: 100 / 500 / 1,000 formulas first display 585–587 / 556–598 / 670–685 ms | Warm (second visit): 532 / 540 / 733 ms; long task 218 vs 169–171 ms at 1,000 | Within spread or worse; removed (memory LRU kept) | — | Same, 1 warm run after a first visit in the same profile | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math output format | KaTeX `output: 'mathml'` instead of `htmlAndMathml` | 500 formulas: 62,020 nodes, typing p50 21.5–21.8 ms; 1,000: 29.9–30.5 ms | 16,459 nodes, 12.5 ms; 14.4 ms | 1.7–2.1× p50, but Chromium draws ∑, limits and stretchy delimiters wrong; rejected | — | Same; appearance compared on screenshots | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math resident cap variants | Cap 50 / 200 display formulas; LRU instead of distance | Cap 100, distance: ping-pong re-insertions 126, scan 237 (1,000 formulas), typing p50 22.9 ms | Cap 50: 426 (OPT 321), typing 19.9 ms; cap 200: 0, typing 23.6 ms; LRU: 129, scan 301 | 50 thrashes, 200 gains nothing over 100, LRU re-inserts more on a scan | — | Same | [ADR 0998](adr/0998-math-render-scheduling.md) |
| Math placeholders (first cap) | `min-height` / `min-width` reservation for evicted formulas, inline formulas evicted too | — | Scroll CLS 1.2–4.0 (scan), 6.7–11.4 (ping-pong) | Replaced by exact display boxes, no inline eviction: 0 / 0 | — | Same, caps 100–200 | [ADR 0998](adr/0998-math-render-scheduling.md) |

## Regressions

Measured slowdowns that were accepted on purpose.

| Area | Change (what algorithm or structure) | Before | After | Improvement | Cost | How measured | Source |
|---|---|---|---|---|---|---|---|
| Large-document open (Chromium) | Removed `content-visibility: auto` from editor blocks in every engine (typed text was lost after Enter) | Open 320 ms; typed text lost in 17/20 runs | Open 455 ms; 0/20 lost | Correctness fix | +135 ms to open a 3,701-block document; relayout after a width change loses the skip | Open times from ADR 0703 (Playwright Chromium, production build, 3,701 blocks); loss from a strict Playwright repro, 20 runs per scenario | [ADR 0850](adr/0850-editor-blocks-without-content-visibility.md), [ADR 0703](adr/0703-webkit-content-visibility-stays-off.md) |
| Math pages, layout shift on open | Formulas replace placeholders that hold their source text | Plain-text control CLS 0.004 | CLS 0.06–0.09 (every variant, first version included) | Accepted | Placeholders size from estimates until a formula was seen once | Headless Chromium, Apple-silicon MacBook Air, production build, 1280×900, fresh profile per run, 1–2 runs (ranges); N formulas half display (≈110 chars) / half inline; typing = 43 keys at 60 ms, keydown → next frame | [ADR 0998](adr/0998-math-render-scheduling.md) |

Under investigation: v0.2.0 vs v0.1.0 comparison.

## How to add an entry

- A pull request that changes an algorithm or data structure for performance must add a row to
  the matching table above, with before and after numbers and how they were measured. A change
  that was measured and not kept goes under "Rejected / no effect"; a measured slowdown goes under
  "Regressions".
- Measure before and after on the same data and machine, following the principles at the top.
  Record data size, concurrency, p50/p95 (or median and range), run count, Node and Postgres
  versions, browser engine and build type.
- Put the reasoning in an ADR and link it in Source; add the commit hash once the change is merged.
- Re-use the existing harnesses where they fit:
  - `apps/server/scripts/context-bench.ts` (find_context vs the old search + read flow, tokens,
    calls, success, latency)
  - `apps/server/src/context/context.db.test.ts` (retrieval assertions and token log lines,
    patch_section tokens)
  - `apps/server/src/context/sectionPatch.test.ts` (patch_section concurrency and fuzz)
  - `apps/server/src/context/changeFeed.test.ts` (changes_since recall and tokens)
  - `apps/server/src/collectionQuery/collectionQuery.db.test.ts` (query_rows tokens)
  - `apps/server/src/perf.test.ts` and `apps/web/src/lib/perf.test.ts`
- Browser measurements in the existing entries (React commits, long tasks, editor repros) were made
  with out-of-tree Playwright scripts. Describe the script in the ADR precisely enough to repeat it.
- Do not round or restate a number differently here than in its source. If the source does not
  record the conditions, write "conditions not recorded".
