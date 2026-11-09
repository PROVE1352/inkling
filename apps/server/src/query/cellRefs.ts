import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { CollectionField, QueryPageRef } from '@inkling/shared'
import { db } from '../db/index'
import { collections, pages, users } from '../db/schema'
import { isWorkspaceMember } from '../collectionRelations'
import { visibleTo } from '../pageDto'

/**
 * Person and relation cells of a query result (docs/adr/1320-*).
 *
 * The compiled statement returns collection field values as stored: a person field is a user id, a
 * relation field a list of row ids. This pass turns them into what the collection views show: the
 * member's name, and the linked rows as { ref: 'page', pageId, title }.
 *
 * Set-wise, after LIMIT: one query for the field definitions of the rows' collections, one for user
 * names, one for linked pages — at most three statements whatever the row count (no per-row lookup).
 *
 * Visibility follows the collection views (collectionRelations.ts resolveRelations, md/exporter.ts):
 *  - names of workspace members only (C-L11): any other id becomes null, never the id itself;
 *  - linked rows only when alive, in this workspace, visible to the viewer (visibleTo, which also
 *    narrows to a token's connection range) and a child of the field's target collection. Other
 *    links are dropped, so a viewer does not learn that a hidden row exists (not even its id).
 *
 * Only cells of a bare property column (CompiledQuery.columnProps) are touched, and only when the
 * row's collection has a field of that name and type with a value of the stored shape. A free page
 * property of the same name (the compiled lookup prefers those) that holds anything else is left as is.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IN_CHUNK = 5000

export interface RefRow {
  parentId: string | null
  cells: unknown[]
}

interface Ctx {
  workspaceId: string
  userId: string
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && UUID_RE.test(x))

/** Replace person / relation cells in place. Returns the number of SQL statements it ran (for tests). */
export async function resolveCellRefs(rows: RefRow[], columnProps: (string | null)[], ctx: Ctx): Promise<number> {
  const cols = columnProps.flatMap((name, i) => (name ? [{ i, key: name.toLowerCase() }] : []))
  if (cols.length === 0 || rows.length === 0) return 0
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((x): x is string => !!x))]
  if (parentIds.length === 0) return 0
  let statements = 0

  // 1) field definitions of the collections the rows belong to (rows whose parent is not a
  //    collection simply have no entry)
  const fieldsByParent = new Map<string, Map<string, CollectionField>>()
  for (const part of chunks(parentIds, IN_CHUNK)) {
    statements++
    const found = await db
      .select({ pageId: collections.pageId, fields: collections.fields })
      .from(collections)
      .where(inArray(collections.pageId, part))
    for (const c of found) {
      const byName = new Map<string, CollectionField>()
      // first field of a name wins, like the compiled lookup (jsonb_array_elements order, LIMIT 1)
      for (const f of (c.fields ?? []) as CollectionField[]) {
        const k = f.name.toLowerCase()
        if (!byName.has(k)) byName.set(k, f)
      }
      fieldsByParent.set(c.pageId, byName)
    }
  }

  // 2) which cells to resolve, and the ids they hold
  type Job = { row: RefRow; i: number; field: CollectionField }
  const jobs: Job[] = []
  const personIds = new Set<string>()
  const pageIds = new Set<string>()
  for (const row of rows) {
    const fields = row.parentId ? fieldsByParent.get(row.parentId) : undefined
    if (!fields) continue
    for (const { i, key } of cols) {
      const field = fields.get(key)
      const v = row.cells[i]
      if (!field || v === null || v === undefined) continue
      if (field.type === 'person' && typeof v === 'string' && UUID_RE.test(v)) {
        personIds.add(v.toLowerCase())
        jobs.push({ row, i, field })
      } else if (field.type === 'relation' && field.relation?.targetPageId && isIdList(v)) {
        for (const id of v) pageIds.add(id.toLowerCase())
        jobs.push({ row, i, field })
      }
    }
  }
  if (jobs.length === 0) return statements

  // 3) names and titles, one statement each (chunked only past IN_CHUNK ids)
  const names = new Map<string, string>()
  for (const part of chunks([...personIds], IN_CHUNK)) {
    statements++
    const us = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(inArray(users.id, part), isWorkspaceMember(ctx.workspaceId)))
    for (const u of us) names.set(u.id.toLowerCase(), u.name)
  }
  const linked = new Map<string, { title: string; parentId: string | null }>()
  for (const part of chunks([...pageIds], IN_CHUNK)) {
    statements++
    const ps = await db
      .select({ id: pages.id, title: pages.title, parentId: pages.parentId })
      .from(pages)
      .where(
        and(
          inArray(pages.id, part),
          eq(pages.workspaceId, ctx.workspaceId),
          isNull(pages.deletedAt),
          visibleTo(ctx.userId),
        ),
      )
    for (const p of ps) linked.set(p.id.toLowerCase(), { title: p.title, parentId: p.parentId })
  }

  // 4) substitute
  for (const { row, i, field } of jobs) {
    const v = row.cells[i]
    if (field.type === 'person') {
      row.cells[i] = names.get(String(v).toLowerCase()) ?? null
      continue
    }
    const target = field.relation!.targetPageId.toLowerCase()
    const refs: QueryPageRef[] = []
    const seen = new Set<string>()
    for (const raw of v as string[]) {
      const id = raw.toLowerCase()
      const t = linked.get(id)
      if (!t || t.parentId?.toLowerCase() !== target || seen.has(id)) continue
      seen.add(id)
      refs.push({ ref: 'page', pageId: id, title: t.title })
    }
    row.cells[i] = refs
  }
  return statements
}
