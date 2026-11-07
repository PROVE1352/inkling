import { createHash } from 'node:crypto'
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  createViewSchema,
  updateFieldsSchema,
  updatePropsSchema,
  updateViewSchema,
} from '@inkling/shared'
import type {
  CollectionDTO,
  CollectionField,
  CollectionViewDTO,
  ViewConfig,
  ViewType,
} from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import {
  applyFieldsUpdate,
  FieldConfigError,
  idList,
  normalizeRelationWrite,
  resolveRelations,
  syncPairedLinks,
} from '../collectionRelations'
import { db, retryOnDeadlock } from '../db/index'
import { ifNoneMatch } from '../httpCache'
import { workspaceVersion } from '../versions'
import { collectionViews, collections, pages } from '../db/schema'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage, pageColumns, toRowDTO, visibleTo } from '../pageDto'
import type { PageRow } from '../pageDto'
import { registerCollectionExtRoutes } from './collectionsExt'
import { nonMemberPersonIds } from '../collectionRelations'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ViewRow {
  id: string
  name: string
  type: ViewType
  config: unknown
  sortOrder: number
}

function toViewDTO(row: ViewRow): CollectionViewDTO {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: (row.config ?? {}) as ViewConfig,
    sortOrder: row.sortOrder,
  }
}

const viewColumns = {
  id: collectionViews.id,
  name: collectionViews.name,
  type: collectionViews.type,
  config: collectionViews.config,
  sortOrder: collectionViews.sortOrder,
} as const

/** Assembles a collection definition (fields + views) into a DTO. */
async function loadCollectionDTO(pageId: string): Promise<CollectionDTO> {
  const col = (
    await db
      .select({ fields: collections.fields })
      .from(collections)
      .where(eq(collections.pageId, pageId))
      .limit(1)
  )[0]
  const views = await db
    .select(viewColumns)
    .from(collectionViews)
    .where(eq(collectionViews.pageId, pageId))
    .orderBy(asc(collectionViews.sortOrder), asc(collectionViews.createdAt))
  return {
    pageId,
    fields: (col?.fields ?? []) as CollectionField[],
    views: views.map(toViewDTO),
  }
}

/** Page lookup → membership → collection kind check (shared guard) */
export async function requireCollectionPage(pageId: string, userId: string): Promise<PageRow> {
  const page = await findVisiblePage(pageId, userId)
  if (!page) throw notFound()
  await requireMembership(page.workspaceId, userId)
  if (page.kind !== 'collection') throw badRequest('Not a collection page')
  return page
}

/** View id → the view and its page, or null (→ 404) */
async function findView(id: string): Promise<{ id: string; pageId: string } | null> {
  const rows = await db
    .select({ id: collectionViews.id, pageId: collectionViews.pageId })
    .from(collectionViews)
    .where(eq(collectionViews.id, id))
    .limit(1)
  return rows[0] ?? null
}

async function collectionEtag(
  workspaceId: string,
  pageId: string,
  userId: string,
  rowsParam: string,
): Promise<string> {
  const [ws, views] = await Promise.all([
    workspaceVersion(workspaceId),
    db.execute(sql`
      SELECT coalesce(md5(string_agg(
        id::text || '|' || name || '|' || type || '|' || sort_order::text || '|' || config::text,
        ',' ORDER BY id)), '') AS v
      FROM collection_views WHERE page_id = ${pageId}
    `) as unknown as Promise<{ v: string }[]>,
  ])
  const h = createHash('sha1')
    .update(`${userId}|${pageId}|${rowsParam}|${ws}|${views[0]?.v ?? ''}`)
    .digest('base64url')
  return `W/"col-${h}"`
}

export async function registerCollectionRoutes(app: FastifyInstance): Promise<void> {
  // relations/rollups helpers, batch rows, covers, sheets sync (experimental) — collectionsExt.ts
  await registerCollectionExtRoutes(app)

  // Collection definition + rows
  app.get('/pages/:id/collection', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await requireCollectionPage(id, user.id)

    // Conditional GET (docs/adr/0752-*): the response is a pure function of the viewer, the
    // workspace's pages/collections (rows, relation targets and rollup sources live in the same
    // workspace) and this collection's views. The web app polls this every 15 s; when nothing
    // changed we answer 304 before loading/serialising up to 10k rows (~4.4 MB).
    const rowsParam = (req.query as { rows?: string } | undefined)?.rows === '0' ? '0' : '1'
    const etag = await collectionEtag(page.workspaceId, id, user.id, rowsParam)
    reply.header('Cache-Control', 'private, no-cache')
    reply.header('ETag', etag)
    if (ifNoneMatch(req.headers['if-none-match'], etag)) {
      return reply.code(304).send()
    }

    const collection = await loadCollectionDTO(id)
    // ?rows=0 → definition only (field pickers for relation/rollup targets)
    if ((req.query as { rows?: string } | undefined)?.rows === '0') {
      return { collection, rows: [], refs: {} }
    }
    // Collection access is already guarded. Rows (children) inherit the parent's scope, but apply
    // visibleTo once more defensively so nobody else's private rows leak.
    const rows = await db
      .select({ ...pageColumns, props: pages.props })
      .from(pages)
      .where(and(eq(pages.parentId, id), isNull(pages.deletedAt), visibleTo(user.id)))
      .orderBy(asc(pages.sortOrder), asc(pages.createdAt))

    // relation cells → visible links only; rollups computed set-wise (no per-row queries)
    const dtos = rows.map((r) => toRowDTO(r, { ...((r.props ?? {}) as Record<string, unknown>) }))
    const { refs } = await resolveRelations(page.workspaceId, collection.fields, dtos, user.id)

    return { collection, rows: dtos, refs }
  })

  // Replace all fields
  app.put('/pages/:id/collection/fields', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await requireCollectionPage(id, user.id)

    const body = updateFieldsSchema.parse(req.body)
    const ids = body.fields.map((f) => f.id)
    if (new Set(ids).size !== ids.length) {
      throw badRequest('Duplicate field IDs')
    }

    // relation/rollup validation + two-way pairing run in one transaction with the write.
    // Every collection the update may touch (this one + old/new relation targets) is locked up
    // front in id order, so two schema edits on paired collections cannot deadlock (A-M12).
    const relTargets = (fs: CollectionField[]) =>
      fs
        .filter((f) => f.type === 'relation')
        .map((f) => f.relation?.targetPageId)
        .filter((t): t is string => typeof t === 'string' && UUID_RE.test(t))
    try {
      await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
          const [pre] = (await tx.execute(
            sql`SELECT fields FROM collections WHERE page_id = ${id}`,
          )) as unknown as { fields: unknown }[]
          const lockIds = [
            ...new Set([id, ...relTargets((pre?.fields ?? []) as CollectionField[]), ...relTargets(body.fields as CollectionField[])]),
          ].sort()
          const locked = (await tx.execute(
            sql`SELECT page_id AS "pageId", fields FROM collections
                 WHERE page_id = ANY(${`{${lockIds.join(',')}}`}::uuid[])
                 ORDER BY page_id FOR UPDATE`,
          )) as unknown as { pageId: string; fields: unknown }[]
          const oldFields = (locked.find((r) => r.pageId === id)?.fields ?? []) as CollectionField[]
          const fields = await applyFieldsUpdate(tx, page, oldFields, body.fields, user.id)
          await tx
            .update(collections)
            .set({ fields, updatedAt: new Date() })
            .where(eq(collections.pageId, id))
        }),
      )
    } catch (err) {
      if (err instanceof FieldConfigError) throw badRequest(err.message)
      throw err
    }

    return { collection: await loadCollectionDTO(id) }
  })

  // Add a view
  app.post('/pages/:id/collection/views', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireCollectionPage(id, user.id)

    const body = createViewSchema.parse(req.body)
    const [{ maxSort }] = await db
      .select({ maxSort: max(collectionViews.sortOrder) })
      .from(collectionViews)
      .where(eq(collectionViews.pageId, id))
    const sortOrder = (maxSort ?? 0) + 1000

    const [row] = await db
      .insert(collectionViews)
      .values({ pageId: id, name: body.name, type: body.type, config: {}, sortOrder })
      .returning(viewColumns)

    return { view: toViewDTO(row) }
  })

  // Update a view (config is replaced as a whole)
  app.patch('/collection-views/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const viewId = idParam(req.params)

    const view = await findView(viewId)
    if (!view) throw notFound()
    const page = await findVisiblePage(view.pageId, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const body = updateViewSchema.parse(req.body)
    const updates: Partial<typeof collectionViews.$inferInsert> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.config !== undefined) updates.config = body.config
    if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder

    const [row] = await db
      .update(collectionViews)
      .set(updates)
      .where(eq(collectionViews.id, viewId))
      .returning(viewColumns)

    return { view: toViewDTO(row) }
  })

  // Delete a view (400 if it is the last one)
  app.delete('/collection-views/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const viewId = idParam(req.params)

    const view = await findView(viewId)
    if (!view) throw notFound()
    const page = await findVisiblePage(view.pageId, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const siblings = await db
      .select({ id: collectionViews.id })
      .from(collectionViews)
      .where(eq(collectionViews.pageId, view.pageId))
    if (siblings.length <= 1) {
      throw badRequest("The last view can't be deleted")
    }

    await db.delete(collectionViews).where(eq(collectionViews.id, viewId))
    return reply.code(204).send()
  })

  // Merge row properties (a null value deletes the key). Allowed even when the parent is not a collection.
  //  The merge happens in SQL — `(props || $set) - $del` — on a row locked FOR UPDATE inside the
  //  transaction, so two clients editing different cells of the same row both win (A-M4) and the
  //  relation diff for two-way pairing is computed from the value actually being replaced.
  app.patch('/pages/:id/props', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const target = (
      await db
        .select({ ...pageColumns })
        .from(pages)
        .where(and(eq(pages.id, id), isNull(pages.deletedAt), visibleTo(user.id)))
        .limit(1)
    )[0]
    if (!target) throw notFound()
    await requireMembership(target.workspaceId, user.id)

    const body = updatePropsSchema.parse(req.body)

    // Parent collection fields: rollups are computed (never stored), relations are validated
    // and two-way relations mirror their diff onto the paired field.
    const parentFields: CollectionField[] = target.parentId
      ? (((
          await db
            .select({ fields: collections.fields })
            .from(collections)
            .where(eq(collections.pageId, target.parentId))
            .limit(1)
        )[0]?.fields ?? []) as CollectionField[])
      : []
    const fieldById = new Map(parentFields.map((f) => [f.id, f]))

    const bad = await nonMemberPersonIds(target.workspaceId, parentFields, [body.props])
    if (bad.length) throw badRequest('Only members of this workspace can be assigned')

    const { row, merged } = await retryOnDeadlock(() =>
      db.transaction(async (tx) => {
        const [cur] = (await tx.execute(
          sql`SELECT props FROM pages WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
        )) as unknown as { props: Record<string, unknown> | null }[]
        if (!cur) throw notFound()
        const oldProps = (cur.props ?? {}) as Record<string, unknown>
        const set: Record<string, unknown> = {}
        const del: string[] = []
        const pairSyncs: { field: CollectionField; oldIds: string[]; newIds: string[] }[] = []
        for (const [key, value] of Object.entries(body.props)) {
          const field = fieldById.get(key)
          if (field?.type === 'rollup') continue
          if (field?.type === 'relation' && field.relation?.targetPageId) {
            const next = await normalizeRelationWrite(tx, field, oldProps[key], value, user.id)
            if (next.length === 0) del.push(key)
            else set[key] = next
            pairSyncs.push({ field, oldIds: idList(oldProps[key]), newIds: next })
            continue
          }
          if (value === null) del.push(key)
          else set[key] = value
        }
        const [updated] = (await tx.execute(sql`
          UPDATE pages SET props = (props || ${JSON.stringify(set)}::jsonb)
                   - ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(del)}::jsonb)),
                 updated_at = now()
           WHERE id = ${id}
          RETURNING props
        `)) as unknown as { props: Record<string, unknown> }[]
        for (const p of pairSyncs) await syncPairedLinks(tx, p.field, id, p.oldIds, p.newIds)
        const [r] = await tx.select(pageColumns).from(pages).where(eq(pages.id, id)).limit(1)
        return { row: r, merged: (updated?.props ?? {}) as Record<string, unknown> }
      }),
    )

    // Relation cells return only visible links (hidden links stay stored but are never exposed in the response).
    const dto = toRowDTO(row, { ...merged })
    if (target.parentId && parentFields.length) {
      await resolveRelations(target.workspaceId, parentFields, [dto], user.id)
    }
    return { row: dto }
  })
}
