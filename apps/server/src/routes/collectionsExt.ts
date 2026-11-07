import { assertPlacement, lockTree } from '../pageTree'
/**
 * Collection extension routes (registered from registerCollectionRoutes):
 *   GET   /pages/:id/collection/row-options   relation picker (visible rows, title search)
 *   GET   /pages/:id/collection/covers        gallery "first image" covers (one query)
 *   POST  /pages/:id/collection/rows/batch    batch insert (import / paste) — one transaction
 *   PATCH /pages/:id/collection/rows/batch    batch merge of props/title (paste) — one statement
 *   /pages/:id/collection/sheet-sync*         Google Sheets read sync — experimental `sheets-sync`
 *   GET   /pages/:id/collection/query, GET /pages/:id/row   agent reads (./collectionQuery.ts)
 */
import { and, asc, count, eq, ilike, isNull, max, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  batchCreateRowsSchema,
  batchUpdateRowsSchema,
  COLLECTION_MAX_ROWS,
} from '@inkling/shared'
import type { CollectionField, RowOptionsDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { collections, files, pages } from '../db/schema'
import { badRequest } from '../errors'
import { isExperimentalEnabled } from '../features'
import { idParam } from '../helpers'
import { pageColumns, toRowDTO, visibleTo } from '../pageDto'
import { escapeLike } from '../util'
import { requireCollectionPage } from './collections'
import { nonMemberPersonIds } from '../collectionRelations'
import { registerSheetSyncRoutes } from './sheetSync'
import { registerCollectionQueryRoutes } from './collectionQuery'

/** Batch bodies can be large (1000 rows × many columns). */
const BATCH_BODY_LIMIT = 16 * 1024 * 1024
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadFields(pageId: string): Promise<CollectionField[]> {
  const row = (
    await db
      .select({ fields: collections.fields })
      .from(collections)
      .where(eq(collections.pageId, pageId))
      .limit(1)
  )[0]
  return (row?.fields ?? []) as CollectionField[]
}

/**
 * Type-check batch prop values against the field definitions. Unknown keys, computed (rollup)
 * and relation keys are dropped (relations need per-row validation — use PATCH /pages/:id/props).
 * Returns the keys to set and the keys to delete (null values).
 */
export function sanitizeBatchProps(
  fields: Map<string, CollectionField>,
  props: Record<string, unknown> | undefined,
): { set: Record<string, unknown>; del: string[] } {
  const set: Record<string, unknown> = {}
  const del: string[] = []
  if (!props) return { set, del }
  for (const [key, value] of Object.entries(props)) {
    const f = fields.get(key)
    if (!f || f.type === 'rollup' || f.type === 'relation') continue
    if (value === null) {
      del.push(key)
      continue
    }
    switch (f.type) {
      case 'text':
      case 'url':
        if (typeof value === 'string') set[key] = value.slice(0, 10_000)
        break
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value)) set[key] = value
        break
      case 'checkbox':
        if (typeof value === 'boolean') set[key] = value
        break
      case 'date':
        if (typeof value === 'string' && DATE_RE.test(value)) set[key] = value
        break
      case 'select':
        if (typeof value === 'string' && f.options?.some((o) => o.id === value)) set[key] = value
        break
      case 'multiSelect':
        if (Array.isArray(value)) {
          const ok = value.filter(
            (v): v is string => typeof v === 'string' && !!f.options?.some((o) => o.id === v),
          )
          set[key] = [...new Set(ok)]
        }
        break
      case 'person':
        if (typeof value === 'string' && UUID_RE.test(value)) set[key] = value
        break
    }
  }
  return { set, del }
}

export async function registerCollectionExtRoutes(app: FastifyInstance): Promise<void> {
  // agent-oriented reads: SQL filter/sort/keyset over rows, single row + version (docs/adr/0934-*)
  await registerCollectionQueryRoutes(app)

  // ---- relation picker options ----
  const optionsQuery = z.object({
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  app.get('/pages/:id/collection/row-options', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireCollectionPage(id, user.id)
    const { q, limit = 50 } = optionsQuery.parse(req.query)
    const conds = [eq(pages.parentId, id), isNull(pages.deletedAt), visibleTo(user.id)]
    if (q && q.trim()) conds.push(ilike(pages.title, `%${escapeLike(q.trim())}%`))
    const rows = await db
      .select({ id: pages.id, title: pages.title, icon: pages.icon, parentId: pages.parentId })
      .from(pages)
      .where(and(...conds))
      .orderBy(asc(pages.sortOrder), asc(pages.createdAt))
      .limit(limit + 1)
    const out: RowOptionsDTO = { rows: rows.slice(0, limit), more: rows.length > limit }
    return out
  })

  // ---- gallery covers: first uploaded image of each visible row (DISTINCT ON, one query) ----
  app.get('/pages/:id/collection/covers', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireCollectionPage(id, user.id)
    const rows = await db
      .selectDistinctOn([files.pageId], { pageId: files.pageId, fileId: files.id })
      .from(files)
      .innerJoin(pages, eq(pages.id, files.pageId))
      .where(
        and(
          eq(pages.parentId, id),
          isNull(pages.deletedAt),
          visibleTo(user.id),
          sql`${files.mime} LIKE 'image/%'`,
        ),
      )
      .orderBy(files.pageId, asc(files.createdAt))
    const covers: Record<string, string> = {}
    for (const r of rows) if (r.pageId) covers[r.pageId] = `/files/${r.fileId}`
    return { covers }
  })

  // ---- batch insert ----
  app.post(
    '/pages/:id/collection/rows/batch',
    { preHandler: requireUser, bodyLimit: BATCH_BODY_LIMIT },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const page = await requireCollectionPage(id, user.id)
      const body = batchCreateRowsSchema.parse(req.body)
      const fieldList = await loadFields(id)
      const fields = new Map(fieldList.map((f) => [f.id, f]))
      const sanitized = body.rows.map((r) => sanitizeBatchProps(fields, r.props).set)
      if ((await nonMemberPersonIds(page.workspaceId, fieldList, sanitized)).length) {
        throw badRequest('Person cells may only reference members of this workspace')
      }

      const created = await db.transaction(async (tx) => {
        // The workspace tree lock serialises concurrent batch inserts into the same collection
        // (row cap + sortOrder) and keeps rows from landing under a collection that is being
        // trashed at the same moment (docs/adr/0800-*).
        await lockTree(tx, page.workspaceId)
        await assertPlacement(tx, {
          workspaceId: page.workspaceId,
          parentId: id,
          role: 'member',
          publicRule: false,
        })
        const [{ n }] = await tx
          .select({ n: count() })
          .from(pages)
          .where(and(eq(pages.parentId, id), isNull(pages.deletedAt)))
        if (n + body.rows.length > COLLECTION_MAX_ROWS) {
          throw badRequest(`A collection can hold at most ${COLLECTION_MAX_ROWS} rows`)
        }
        const [{ maxSort }] = await tx
          .select({ maxSort: max(pages.sortOrder) })
          .from(pages)
          .where(and(eq(pages.workspaceId, page.workspaceId), eq(pages.parentId, id)))
        const base = maxSort ?? 0
        const values = body.rows.map((r, i) => ({
          workspaceId: page.workspaceId,
          parentId: id,
          kind: 'doc' as const,
          scope: page.scope,
          title: (r.title ?? '').trim(),
          props: sanitized[i],
          sortOrder: base + 1000 * (i + 1),
          createdBy: user.id,
        }))
        return tx
          .insert(pages)
          .values(values)
          .returning({ ...pageColumns, props: pages.props })
      })
      return {
        rows: created.map((r) => toRowDTO(r, (r.props ?? {}) as Record<string, unknown>)),
      }
    },
  )

  // ---- batch merge update (single UPDATE … FROM jsonb_to_recordset) ----
  app.patch(
    '/pages/:id/collection/rows/batch',
    { preHandler: requireUser, bodyLimit: BATCH_BODY_LIMIT },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const page = await requireCollectionPage(id, user.id)
      const body = batchUpdateRowsSchema.parse(req.body)
      const fieldList = await loadFields(id)
      const fields = new Map(fieldList.map((f) => [f.id, f]))
      const payload = body.rows.map((r) => {
        const { set, del } = sanitizeBatchProps(fields, r.props)
        return { id: r.id, set, del, title: r.title === undefined ? null : r.title.trim() }
      })
      if ((await nonMemberPersonIds(page.workspaceId, fieldList, payload.map((p) => p.set))).length) {
        throw badRequest('Person cells may only reference members of this workspace')
      }
      const json = JSON.stringify(payload)
      // Only children of this collection that the user can see are touched; the merge is done
      // in SQL so concurrent single-cell edits to other keys are not lost.
      const updated = (await db.execute(sql`
        UPDATE pages SET
          props = (pages.props || x.set) - x.del,
          title = COALESCE(x.title, pages.title),
          updated_at = now()
        FROM jsonb_to_recordset(${json}::jsonb) AS x(id uuid, set jsonb, del text[], title text)
        WHERE pages.id = x.id
          AND pages.parent_id = ${id}
          AND pages.deleted_at IS NULL
          AND ${visibleTo(user.id)}
        RETURNING pages.id
      `)) as unknown as { id: string }[]
      return { updated: updated.length }
    },
  )

  // ---- Google Sheets read sync (experimental) ----
  if (isExperimentalEnabled('sheets-sync')) {
    await registerSheetSyncRoutes(app)
  }
}
