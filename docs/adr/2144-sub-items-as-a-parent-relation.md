# 2144. Sub-items: a Parent item relation of the collection to itself

- Status: Accepted
- Date: 2026-11-10

## Context
Rows could not have sub-rows. `pages.parent_id` already means "row of this collection": it drives lock
chains, guest trees, the access version (`bumpAcl`) and the row cap, so nesting rows under rows there
would change all of those. Relation fields already store row ids in props, with visibility filtering,
pickers and agent writes.

## Decision
- **Field**: a relation with `relation.subItems: true` and `targetPageId` = the collection itself is the
  "Parent item". One per collection, one-way only (validated in `applyFieldsUpdate`); the children are
  found from the parents, no mirrored "Sub-items" field. Turning sub-items off removes the flag; the field
  stays an ordinary relation (no links lost).
- **Writes** (`PATCH /pages/:id/props`, the row create route, MCP `create_row parent` / `update_row`): at
  most one parent (the first submitted id is kept); never the row itself or one of its descendants —
  checked inside the write transaction by walking up from the new parent (recursive CTE with `CYCLE`)
  under a transaction-scoped advisory lock per collection, so two concurrent moves cannot close a loop.
  Refusal: 400 `SUBITEM_CYCLE`. A new row has no sub-items, so its parent needs no check.
- **Trash**: nothing is written. A trashed parent is not served (relation cells hold visible live links
  only, ADR 0300), so its sub-items show at the top level; restoring it brings the tree back. A purged
  parent leaves a dangling id that is never served. A parent the viewer cannot see behaves the same way.
- **Display**: `treeRows` (shared) orders rows depth-first under their parents, rows whose parent is not
  among the shown rows (filtered, trashed, hidden) at the top; collapse per view in the browser; depth
  shown up to 8. Table and list views nest by default (`viewConfig.subItems: 'flat'` turns it off); board,
  calendar, gallery and timeline stay flat.
- **query_rows**: `under` (row id, ID like TASK-3, or exact title) and `depth` (1–8, default 1) restrict
  to descendants (recursive CTE; the cursor is bound to them); the Parent item column is always shown and
  holds the parent's ID when the collection has one (else its title). `create_row` takes `parent`.
- Dependencies (blocked-by) are not part of this.

## Alternatives considered
- **`pages.parent_id`**: rows under rows would leave the collection's direct children, every collection
  read and the row cap would need a recursive query, and every re-parent would bump the access version.
- **Two-way relation (Parent / Sub-items)**: doubles storage and the cycle check, and the Sub-items cell
  of a parent with many children is large; the children are one query away.
- **Cascade trash to sub-items**: a restore of the parent would have to know which children went with it.

## References
- packages/shared/src/collectionFields.ts (`subItemsField`, `treeRows`), apps/server/src/collectionQuery/rowFields.ts,
  routes/collections.ts, routes/collectionQuery.ts, rowTemplates.ts, mcpTools/collectionTools.ts
- apps/server/src/collectionQuery/rows017.db.test.ts
- ADR 0300 (relations), 2145, 2147
