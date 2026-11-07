# 0300. Relation values live in row props (no junction table); two-way links mirrored in SQL

- Status: Accepted
- Date: 2026-11-07

## Context
Collections ("databases") need a `relation` property: a row references rows of another (or the same)
collection, many-to-many, optionally two-way (the target collection shows the back-links). Collection
rows are `pages` rows and every property value already lives in the row's `props` jsonb; the
collection read path is one `SELECT … FROM pages WHERE parent_id = :collection`. Collections are
expected to reach tens of thousands of rows.

## Decision
- A relation value is a `string[]` of row (page) ids stored in `props[fieldId]`, like any other value.
  The field definition carries `relation: { targetPageId, twoWay?, pairFieldId? }`.
- **Read**: `resolveRelations` collects every id referenced by every relation cell of the response,
  loads them in chunked `IN` lists (5 000 ids per query) filtered by `visibleTo(user)` and
  `deleted_at IS NULL`, keeps only rows whose `parent_id` is the field's target collection in the same
  workspace, rewrites each cell to the visible subset and returns `refs` (`{id,title,icon,parentId}`)
  for display. Query count does not depend on the row count.
- **Write** (`PATCH /pages/:id/props`): `normalizeRelationWrite` keeps submitted ids that are live,
  visible children of the target, silently drops the rest, and *preserves* existing links the writer
  cannot see (hidden or trashed rows) so an edit never destroys links made by someone with more access.
- **Two-way**: saving a relation with `twoWay: true` creates the paired relation field on the target
  collection inside the same transaction (`applyFieldsUpdate`, target `collections` row locked
  `FOR UPDATE`). A cell edit mirrors only the diff onto the paired field with two set-based `UPDATE`s
  (`jsonb_set … || to_jsonb(id)` for added, `jsonb_agg … WHERE e <> id` for removed).
- Removing a paired field (or switching two-way off) turns the partner into a one-way relation and
  keeps its stored links (non-destructive).
- Batch row APIs (import/paste/sync) never write relation keys.

## Alternatives considered
- **Junction table `row_relations(source, field, target)`**: canonical for many-to-many, cheap reverse
  lookups and FK cleanup, but every collection read becomes a join + aggregate, field deletion and page
  duplication need extra copying, and the export/MCP/public paths would all need a second source of
  truth for "property values".
- **Store only one side and compute the reverse on read**: no write amplification, but the reverse
  side then needs a scan of the source collection on every read of the target.

## Trade-offs
- Links to permanently deleted rows remain as dangling ids until the cell is edited (they are never
  shown). Trashed rows reappear in relations when restored — intended.
- Two-way mirroring is application-maintained; a crash between the row update and the mirror update is
  impossible because both run in one transaction, but direct SQL edits can desynchronize the pair.
- A relation cell holds at most 500 links.

## How others solve it
Notion stores relations as property values on both pages and keeps the pair in sync server-side
(similar to this design). Airtable "linked records" are bidirectional by default and stored as arrays
of record ids per cell. Postgres-backed tools like NocoDB use junction tables.

## Consequences
- Duplicating a collection copies its field definitions verbatim, so the copy's relations still point
  at the original target collection (and two-way pairs point at the original's fields).
- Markdown export resolves relation cells to titles with the same visibility gate; public (anonymous)
  shares render relation cells empty because a linked row may be outside the shared subtree.

## References
- apps/server/src/collectionRelations.ts:100 (`resolveRelations`), :66 (chunked load), :269 (`normalizeRelationWrite`), :299 (`syncPairedLinks`), :368 (`applyFieldsUpdate`)
- apps/server/src/routes/collections.ts:124 (GET), :148 (fields PUT), :270 (props PATCH)
- apps/server/src/md/exporter.ts (`cellString` relation case, `collectionTableMdShared`)
- packages/shared/src/index.ts (`relationConfigSchema`)
