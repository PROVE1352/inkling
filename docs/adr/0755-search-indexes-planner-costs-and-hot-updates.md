# 0755. Search plans, indexes declared in the schema, HOT-friendly fillfactor

- Status: Accepted
- Date: 2026-11-07

## Context
Seed: 5,000 pages (≈2 KB body text each), 10k-row collection, 15k links, 20k notifications. EXPLAIN (ANALYZE, BUFFERS) of the representative endpoints showed:
- search: `title ILIKE OR text ILIKE` across a LEFT JOIN cannot use the trigram indexes → detoast + ILIKE of every body: 75–79 ms.
- unlinked mentions: the planner picks a seq scan over `page_texts` even for a selective pattern (detoasting is not costed, default `random_page_cost = 4`): 94 ms.
- notifications: bitmap scan of all 10k rows of the user + top-N sort: 8.1 ms.
- The trigram and "perf" indexes came from hand-written migrations 0007/0009; a `drizzle-kit push` against production dropped them because the schema did not declare them.
- `pages.updated_at` is bumped by every document store; on packed heap pages only 0.1% of those updates were HOT, so each rewrote all eight indexes including the GIN trigram index.

## Decision
- Search: for terms ≥ 3 characters, candidate ids come from two index-friendly probes (`pages.title ILIKE` ∪ `page_texts.text ILIKE`); shorter terms keep the OR form (no trigrams; a title hit short-circuits the body test there). 78 ms → 3 ms; identical result sets (verified ignoring tie order). A term matching nearly every page is ~10% slower (73 vs 66 ms).
- Unlinked mentions: `pages.id IN (SELECT page_id FROM page_texts WHERE …)`.
- Both run in `withSsdPlanCosts` (transaction-local `random_page_cost = 1.1`), which alone flips the plan: 94 ms → 0.4 ms. `enable_seqscan = off` was tried first and rejected: it made 1–2 character searches 9x slower (GIN full-index scan).
- Migration 0024: index `notifications(user_id, created_at)` (8.1 ms → 0.33 ms, ordered index scan stops at 50 rows); all 0007/0009 indexes declared in `schema.ts` and recreated with `IF NOT EXISTS` (no-op where they survived, repair where push dropped them); `pages` fillfactor 85, `page_docs` fillfactor 90.
- HOT effect measured on the seed: 2,267 updates of `pages.updated_at` → 2 HOT (0.1%); after `fillfactor = 85` + table rewrite → 4,090 / 4,484 HOT (91%). The setting applies to newly written heap pages; `docs/OPERATIONS.md` describes the optional one-time rewrite.

## Trade-offs
- `random_page_cost = 1.1` is also the new compose default; the local SET keeps these two plans right on databases running stock settings.
- fillfactor leaves 15% of each `pages` heap page empty (the table is small).
