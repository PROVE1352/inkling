# 0301. Rollups are computed per request, set-wise, and may not aggregate rollups/relations

- Status: Accepted
- Date: 2026-11-07

## Context
A `rollup` property aggregates a property of the rows linked through a relation (count, sum, avg, min,
max, earliest, latest, percent checked, show unique). Results depend on what the *viewer* can see
(hidden linked rows must not leak through a count or a sum). Rollups of rollups can form cycles
(A.rollup → B.rollup → A.rollup).

## Decision
- Rollups are never stored. The collection GET computes them in memory from the linked rows already
  loaded by `resolveRelations` (one extra query for the target collections' field definitions, one for
  user names only when "show unique" aggregates a person field). Values are injected into `props` so
  client-side filter/sort/export treat them like any other property; writes to rollup keys are ignored.
- **Depth-1 rule**: a rollup's target property may not be a rollup or a relation (only `count` is
  allowed over those). Validated in the fields PUT and re-checked at compute time (returns `null`), so
  cycles are impossible by construction — no cycle detection needed.
- No cache. Measured on the smoke DB (Postgres 16 in Docker, MacBook Air): `GET /pages/:id/collection`
  with 10 000 rows, 3 rollups and 20 000 links to 2 targets = 92–115 ms; with an added self-relation
  (≈20 000 more links to 10 000 distinct rows) and a 4th rollup = 189–213 ms (4.4 MB JSON).

## Alternatives considered
- **Materialized rollup columns updated on write**: fast reads, but every write to a target row must
  find and update all referencing rows, and per-viewer visibility cannot be materialized.
- **Per-user in-memory cache** keyed by (collection, user, max(updated_at)): adds invalidation
  complexity for a read that is already ~100–200 ms at 10k rows.
- **Arbitrary nesting with cycle detection** (Notion allows rollup of rollup): requires a dependency
  graph and evaluation order across collections; deferred.

## Trade-offs
Large collections pay the aggregation on every read (the collection query polls every 15 s). If this
becomes a hotspot, the cache above is the next step.

## How others solve it
Notion computes rollups server-side and caches them; Airtable recomputes rollups on change and stores
them. Both allow nesting with cycle prevention.

## Consequences
Filtering/sorting by a rollup works client-side; the iCal feed and markdown export do not include
rollup values.

## References
- apps/server/src/collectionRelations.ts:211 (`computeRollup`), :218 (depth-1 guard)
- apps/server/src/collectionRelations.ts:368 (`applyFieldsUpdate` validation)
- apps/web/src/components/collection/FieldConfigEditors.tsx (`fnsFor`)
