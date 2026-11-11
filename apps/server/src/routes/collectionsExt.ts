import { assertWorkspaceGrowth, assertWorkspaceRoom, jsonBytes } from '../quota/room'
import { assertPlacement, lockTree } from '../pageTree'
import { assertPageEditable, roleForPage } from '../editLock'
/**
 * Collection extension routes (registered from registerCollectionRoutes):
 *   GET   /pages/:id/collection/row-options   relation picker (visible rows, title search)
 *   GET   /pages/:id/collection/covers        gallery "first image" covers (one query)
 *   POST  /pages/:id/collection/rows/batch    batch insert (import / paste) — one transaction
 *   PATCH /pages/:id/collection/rows/batch    batch merge of props/title (paste) — one statement
 *   /pages/:id/collection/sheet-sync*         Google Sheets read sync — experimental `sheets-sync`
 *   GET   /pages/:id/collection/query, GET /pages/:id/row   agent reads (./collectionQuery.ts)
 *   /pages/:id/collection/row-templates, /pages/:id/collection/rows   row templates (./rowTemplates.ts)
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
import { enqueueAssignments, newAssignees, taskAssignments } from '../notify/producers'
import { outboxCommitted } from '../outbox'
import { changedPropKeys, propsEventText, recordPageEvents } from '../context/changeLog'
import type { PageEvent } from '../context/changeLog'
import { actorOf } from '../context/attribution'
import type { OutboxTopic } from '../outbox'
import { escapeLike } from '../util'
import { requireCollectionPage } from './collections'
import { nonMemberPersonIds } from '../collectionRelations'
import { registerSheetSyncRoutes } from './sheetSync'
import { autoSourceColumns, fillAutoInto } from '../collectionQuery/autoValues'
import { registerCollectionQueryRoutes } from './collectionQuery'
import { registerRowTemplateRoutes } from './rowTemplates'

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
    if (!f || f.type === 'rollup' || f.type === 'relation' || f.type === 'formula') continue
    if (value === null) {
      del.push(key)
      continue
    }
    switch (f.type) {
      case 'text':
      case 'url':
      case 'email':
      case 'phone':
        if (typeof value === 'string') set[key] = value.slice(0, 10_000)
        break
      // automatic values (createdTime … uniqueId, docs/adr/2140-*) have no case: never written
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
  // row templates + single-row create (docs/adr/1180-*)
  await registerRowTemplateRoutes(app)

  // ---- relation picker options ----
  const optionsQuery = z.object({
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  app.get('/pages/:id/collection/row-options', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    // guests pick among the rows they can see (docs/adr/2146-*): visibleTo is narrowed to their trees
    await requireCollectionPage(id, user.id, { guests: true })
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
    await requireCollectionPage(id, user.id, { guests: true })
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

      // Real role for the edit-lock check (the public-folder rule is off for new rows either way).
      const role = (await roleForPage(id, user.id)) ?? 'member'
      let queued: OutboxTopic[] = []
      const created = await db.transaction(async (tx) => {
        // The workspace tree lock serialises concurrent batch inserts into the same collection
        // (row cap + sortOrder) and keeps rows from landing under a collection that is being
        // trashed at the same moment (docs/adr/0800-*).
        await lockTree(tx, page.workspaceId)
        await assertPlacement(tx, {
          workspaceId: page.workspaceId,
          parentId: id,
          role,
          userId: user.id,
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
        await assertWorkspaceRoom(tx, page.workspaceId, { pages: body.rows.length }) // all rows or none (docs/adr/2505-*)
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
        const rows = await tx
          .insert(pages)
          .values(values)
          .returning({ ...pageColumns, props: pages.props, ...autoSourceColumns })
        // New rows created with people in person cells are assignments too (docs/adr/1000-*); the
        // events commit with the rows (docs/adr/1150-*).
        queued = await enqueueAssignments(
          tx,
          rows.flatMap((r) =>
            taskAssignments({ workspaceId: page.workspaceId, rowId: r.id, actorId: user.id, via: user.via ?? null, changes: newAssignees(fieldList, {}, (r.props ?? {}) as Record<string, unknown>) }),
          ),
        )
        // Change feed (docs/adr/1650-*): the new rows are logged as added with them.
        // a pasted or imported batch starts no database automation (docs/adr/2240-*)
        await recordPageEvents(rows.map((r) => ({ pageId: r.id, kind: 'page_added' as const, noAuto: true })), actorOf(user), tx)
        queued = [...queued, 'change']
        return rows
      })
      outboxCommitted(queued)
      const dtos = created.map((r) => toRowDTO(r, { ...((r.props ?? {}) as Record<string, unknown>) }))
      // automatic values of the new rows (docs/adr/2140-*), as GET /collection serves them
      fillAutoInto(fieldList, dtos, created)
      return { rows: dtos }
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
      // Rows are the collection's subtree; a row may carry a lock of its own.
      await assertPageEditable(id, user.id, { subtree: true })
      const body = batchUpdateRowsSchema.parse(req.body)
      await assertWorkspaceGrowth(db, page.workspaceId, jsonBytes(body.rows)) // full workspace: LIMIT_STORAGE, and the bytes count at once (docs/adr/2533-*)
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
      // Person cells before the write, for assignment notifications (docs/adr/1000-*). Only read
      // when the batch touches a person field.
      const personTouched = fieldList.some((f) => f.type === 'person' && payload.some((p) => f.id in p.set))
      const before = personTouched
        ? ((await db.execute(sql`
            SELECT id, props FROM pages
             WHERE id = ANY(${`{${payload.map((p) => p.id).join(',')}}`}::uuid[]) AND parent_id = ${id}
          `)) as unknown as { id: string; props: Record<string, unknown> | null }[])
        : []
      // The old title and props come along (the FROM side reads the rows as they were) for the
      // change feed's rename and property events (docs/adr/1650-*).
      const update = (exec: Pick<typeof db, 'execute'>) =>
        exec.execute(sql`
          UPDATE pages SET
            props = (pages.props || x.set) - x.del,
            title = COALESCE(x.title, pages.title),
            updated_at = now()
          FROM (SELECT r.id, r.set, r.del, r.title, p0.title AS old_title, p0.props AS old_props
                  FROM jsonb_to_recordset(${json}::jsonb) AS r(id uuid, set jsonb, del text[], title text)
                  JOIN pages p0 ON p0.id = r.id) AS x
          WHERE pages.id = x.id
            AND pages.parent_id = ${id}
            AND pages.deleted_at IS NULL
            AND ${visibleTo(user.id)}
          RETURNING pages.id, x.old_title AS "oldTitle", pages.title, x.old_props AS "oldProps", pages.props
        `) as unknown as Promise<{ id: string; oldTitle: string; title: string; oldProps: Record<string, unknown> | null; props: Record<string, unknown> | null }[]>
      const events = (rows: Awaited<ReturnType<typeof update>>): PageEvent[] =>
        rows.flatMap((r) => {
          const out: PageEvent[] = []
          if (r.oldTitle !== r.title) out.push({ pageId: r.id, kind: 'page_renamed', before: r.oldTitle, after: r.title })
          const keys = changedPropKeys(r.oldProps ?? {}, r.props ?? {})
          if (keys.length) out.push({ pageId: r.id, kind: 'page_props', after: propsEventText(fieldList, keys), keys })
          return out
        })
      if (!personTouched) {
        // The events commit with the update (docs/adr/1150-*).
        let logged = false
        const n = await db.transaction(async (tx) => {
          const rows = await update(tx)
          const ev = events(rows)
          if (ev.length) await recordPageEvents(ev, actorOf(user), tx)
          logged = ev.length > 0
          return rows.length
        })
        if (logged) outboxCommitted(['change'])
        return { updated: n }
      }
      // Assignments commit with the update (docs/adr/1150-*).
      let queued: OutboxTopic[] = []
      const updated = await db.transaction(async (tx) => {
        const rows = await update(tx)
        const ev = events(rows)
        if (ev.length) {
          await recordPageEvents(ev, actorOf(user), tx)
          queued = ['change']
        }
        const prevById = new Map(before.map((r) => [r.id, r.props ?? {}]))
        const done = new Set(rows.map((r) => r.id))
        queued = [
          ...queued,
          ...(await enqueueAssignments(
          tx,
          payload
            .filter((p) => done.has(p.id))
            .flatMap((p) =>
              taskAssignments({ workspaceId: page.workspaceId, rowId: p.id, actorId: user.id, via: user.via ?? null, changes: newAssignees(fieldList, prevById.get(p.id) ?? {}, p.set) }),
            ),
          )),
        ]
        return rows
      })
      outboxCommitted(queued)
      return { updated: updated.length }
    },
  )

  // ---- Google Sheets read sync (experimental) ----
  if (isExperimentalEnabled('sheets-sync')) {
    await registerSheetSyncRoutes(app)
  }
}
