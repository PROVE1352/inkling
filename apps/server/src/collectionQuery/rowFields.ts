/**
 * Server side of the 0.17 sub-items (docs/adr/2144-*). Unique ID numbers are handed out by the
 * triggers of migration 0051 (docs/adr/2140-*), not here.
 *  - sub-items: one parent per row, never a cycle, and the descendants of a row for query_rows.
 */
import { sql } from 'drizzle-orm'
import type { CollectionField } from '@inkling/shared'
import { SUB_ITEMS_MAX_DEPTH } from '@inkling/shared'
import { AppError } from '../errors'
import type { db } from '../db/index'

type Exec = Pick<typeof db, 'execute'>

/** Advisory lock key space for parent changes of one collection (any constant unique in the app). */
const SUBITEMS_LOCK = 2144

/**
 * A row's new parent must not be the row itself or one of its descendants. Parent changes in one
 * collection are serialized by a transaction-scoped advisory lock, so two concurrent moves cannot
 * close a loop that neither saw.
 */
export async function assertNoSubItemCycle(tx: Exec, collectionId: string, field: CollectionField, rowId: string, parentId: string | null): Promise<void> {
  if (!parentId) return
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUBITEMS_LOCK}, hashtext(${collectionId}::text))`)
  if (parentId === rowId) throw subItemCycle()
  // walk up from the new parent; finding the row means the row would become its own ancestor
  const [hit] = (await tx.execute(sql`
    WITH RECURSIVE up(id, depth) AS (
      SELECT ${parentId}::uuid, 0
      UNION ALL
      SELECT (p.props -> ${field.id}::text ->> 0)::uuid, up.depth + 1
        FROM up JOIN pages p ON p.id = up.id
       WHERE p.parent_id = ${collectionId}::uuid
         AND jsonb_typeof(p.props -> ${field.id}::text) = 'array'
         AND (p.props -> ${field.id}::text ->> 0) ~ '^[0-9a-f-]{36}$'
         AND up.depth < 1000
    ) CYCLE id SET looped USING path
    SELECT 1 AS hit FROM up WHERE id = ${rowId}::uuid LIMIT 1
  `)) as unknown as { hit: number }[]
  if (hit) throw subItemCycle()
}

export function subItemCycle(): AppError {
  return new AppError(400, 'SUBITEM_CYCLE', 'A row cannot be placed under itself or under one of its own sub-items; choose another parent')
}

/**
 * Ids of the rows under `rootId` down to `depth` levels (1 = children), live rows only, following
 * the stored parent links. Visibility is applied by the caller's query (this only narrows).
 */
export function descendantsSql(collectionId: string, field: CollectionField, rootId: string, depth: number) {
  const d = Math.max(1, Math.min(depth, SUB_ITEMS_MAX_DEPTH))
  return sql`(
    WITH RECURSIVE down(id, depth) AS (
      SELECT p.id, 1 FROM pages p
       WHERE p.parent_id = ${collectionId}::uuid AND p.deleted_at IS NULL
         AND (p.props -> ${field.id}::text ->> 0) = ${rootId}::text
      UNION ALL
      SELECT p.id, down.depth + 1 FROM down JOIN pages p
        ON (p.props -> ${field.id}::text ->> 0) = down.id::text
       WHERE p.parent_id = ${collectionId}::uuid AND p.deleted_at IS NULL AND down.depth < ${d}
    ) CYCLE id SET looped USING path
    SELECT id FROM down
  )`
}
