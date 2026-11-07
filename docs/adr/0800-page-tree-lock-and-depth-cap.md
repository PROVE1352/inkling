# 0800. Page tree: workspace tree lock, one ancestor walk, depth cap 64

- Status: Accepted
- Date: 2026-11-07
- Audit: A-H1, C-H2, A-M10, A-M11

## Context
Moves checked for cycles with a JS loop of single-row SELECTs outside any transaction (`depth < 100`, silently passing when the cap was hit). Two concurrent moves ("A under B", "B under A") both passed and committed a parent cycle; every `WITH RECURSIVE … UNION ALL` over `parent_id` (6 in pages.ts) then looped forever and the 10-connection pool drained — one member could stop the instance with a 102-level chain. Purge recursion followed live children of trashed pages; restore and purge raced.

## Decision
- Every tree change takes `pg_advisory_xact_lock(hashtext('page-tree:' || workspace_id))` first, in the same transaction as its checks and writes (`pageTree.ts`: `withTreeLock`, `lockTree`). Covered: create with parent, PATCH parent/scope, soft delete, restore, purge, duplicate, expand-canvas, from-template (structure templates, ADR 0921; the old instantiate route was removed in ADR 0920), vault-sync create/delete, imports, collection batch rows, sheet-sync inserts, housekeeping purge (per workspace).
- `assertPlacement` runs one capped recursive CTE up from the new parent: cycle → 400, parent trashed / foreign workspace → 400, resulting depth (`ancestors + 1 + subtree height`) > 64 → 400. A pre-existing cycle above the parent also ends in the depth error.
- Every recursive walk carries `depth < 64` (`descendantsCte`, `ancestorChain`, public.ts, compile.ts), so a cycle already in the database terminates.
- Purge walks only `deleted_at IS NOT NULL` rows; live children of purged pages are moved to the root first (parent_id is ON DELETE CASCADE). Restore is one transaction: `UPDATE … WHERE deleted_at IS NOT NULL`.
- Lock order: tree lock → row locks. No code path takes the tree lock after a row lock.

## Consequences
- Tree changes in one workspace are serialised (they are short). Under heavy contention `lock_timeout` (10 s, ADR 0807) surfaces as 500 — listed in KNOWN-ISSUES.
- Tests: `fixphase.test.ts` — 10 rounds of concurrent mutual moves (one 200, one 400, no cycle), three-way cycle attempt, 102-level chain root→leaf refused, legacy cycle cannot hang delete/restore/purge/list, purge keeps live children, restore‖purge consistent.
