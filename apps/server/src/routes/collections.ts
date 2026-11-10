import { createHash } from 'node:crypto'
import { actorFor, assertAllEditable, assertPageEditable } from '../editLock'
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
  WorkspaceAccessRole,
} from '@inkling/shared'
import { isAutoFieldType, subItemsField, VIA_PROP_PREFIX } from '@inkling/shared'
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
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { rowVersionSql } from '../collectionQuery/compile'
import { actorOf, withEditActor } from '../context/attribution'
import { z } from 'zod'
import { idParam, requireMembership, requireMembershipAcl } from '../helpers'
import { gateWrite } from '../aclVersion'
import { assertAgentAllowed } from '../agentAccess'
import { findVisiblePage, pageColumns, toRowDTO, visibleTo } from '../pageDto'
import { memberOrGuestSql } from '../pageGrants'
import { enqueueAssignments, newAssignees, taskAssignments } from '../notify/producers'
import { outboxCommitted } from '../outbox'
import type { OutboxTopic } from '../outbox'
import { changedPropKeys, propsEventText, recordPageEvents } from '../context/changeLog'
import type { PageRow } from '../pageDto'
import { registerCollectionExtRoutes } from './collectionsExt'
import { registerFormRoutes } from './forms'
import { registerAutomationRoutes } from './automations'
import { nonMemberPersonIds } from '../collectionRelations'
import { connectionKey } from '../leases'
import { normalizeAgentProps } from '../teamAgents'
import { autoSourceColumns, fillAutoInto } from '../collectionQuery/autoValues'
import { assertNoSubItemCycle } from '../collectionQuery/rowFields'
import { guestPeopleNames, redactHiddenTargets, stripAgentKeys } from '../collectionQuery/guestView'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Optional optimistic-concurrency check for PATCH /pages/:id/props (docs/adr/0934-*): the row
 * version from GET /pages/:id/collection/query or GET /pages/:id/row. Parsed separately so the
 * shared updatePropsSchema (and the web app, which never sends it) stays unchanged.
 */
const baseVersionSchema = z.object({ baseVersion: z.string().min(1).max(64).optional() })

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

/**
 * Page lookup → membership → collection kind check (shared guard). `guests: true` lets a page guest
 * in (docs/adr/2146-*): findVisiblePage is already narrowed to the trees shared with them, so a
 * collection outside those trees is a 404 as for anyone else.
 */
export async function requireCollectionPage(pageId: string, userId: string, opts?: { guests: true }): Promise<PageRow & { role: WorkspaceAccessRole }> {
  const page = await findVisiblePage(pageId, userId)
  if (!page) throw notFound()
  const role = opts?.guests ? await requireMembership(page.workspaceId, userId, { guests: true }) : await requireMembership(page.workspaceId, userId)
  if (page.kind !== 'collection') throw badRequest('Not a collection page')
  return { ...page, role }
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
  // form views: public links and public answers (docs/adr/1820-*)
  await registerFormRoutes(app)
  // database automations and the server side of button blocks (docs/adr/2240-*, 2244-*)
  await registerAutomationRoutes(app)

  // Collection definition + rows
  app.get('/pages/:id/collection', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await requireCollectionPage(id, user.id, { guests: true })

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
      .select({ ...pageColumns, props: pages.props, ...autoSourceColumns })
      .from(pages)
      .where(and(eq(pages.parentId, id), isNull(pages.deletedAt), visibleTo(user.id)))
      .orderBy(asc(pages.sortOrder), asc(pages.createdAt))

    // relation cells → visible links only; rollups computed set-wise (no per-row queries).
    // Automatic values first (docs/adr/2140-*): formulas may read them.
    const dtos = rows.map((r) => toRowDTO(r, { ...((r.props ?? {}) as Record<string, unknown>) }))
    fillAutoInto(collection.fields, dtos, rows)
    const { refs } = await resolveRelations(page.workspaceId, collection.fields, dtos, user.id)

    // A guest cannot read the member list (docs/adr/2146-*): the names of the people in the person
    // cells of these rows come with them, members only, names only.
    if (page.role === 'guest') {
      // a member's agent connection next to a person cell names that connection: not for guests
      for (const d of dtos) stripAgentKeys(d.props)
      const people = await guestPeopleNames(page.workspaceId, collection.fields, dtos)
      return { collection: { ...collection, fields: await redactHiddenTargets(collection.fields, user.id) }, rows: dtos, refs, people }
    }
    return { collection, rows: dtos, refs }
  })

  // Replace all fields
  app.put('/pages/:id/collection/fields', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await requireCollectionPage(id, user.id)
    const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id)
    await assertPageEditable(id, user.id, { role, acl })

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
          // Write gate (docs/adr/1071-*, 1523-*): a lock, block or role change that committed since the
          // check above is re-checked here, before any row lock; one that starts now waits for this write.
          const gate = await gateWrite(tx, page.workspaceId, user.id)
          if (gate.acl.version !== acl.version || gate.role !== role) {
            if (!gate.role) throw forbidden()
            await assertAgentAllowed(page.workspaceId, gate.acl.version, tx)
            await assertPageEditable(id, user.id, { role: gate.role, acl: gate.acl, exec: tx })
          }
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
          // A new ID property: the collections trigger of migration 0051 numbers the rows that have none
          // in this same statement (docs/adr/2140-*); later rows get theirs from the pages insert trigger.
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
    await assertPageEditable(id, user.id)

    const body = createViewSchema.parse(req.body)
    const [{ maxSort }] = await db
      .select({ maxSort: max(collectionViews.sortOrder) })
      .from(collectionViews)
      .where(eq(collectionViews.pageId, id))
    const sortOrder = (maxSort ?? 0) + 1000

    const [row] = await db
      .insert(collectionViews)
      .values({ pageId: id, name: body.name, type: body.type, config: body.config ?? {}, sortOrder })
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
    await assertPageEditable(view.pageId, user.id)

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
    await assertPageEditable(view.pageId, user.id)

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
        // memberOrGuestSql: someone outside the workspace gets the same 404 as for an id that does not
        // exist, not a 403 that says the page is there (docs/adr/1301-*)
        .where(
          and(
            eq(pages.id, id),
            isNull(pages.deletedAt),
            visibleTo(user.id),
            memberOrGuestSql(pages.workspaceId, user.id),
          ),
        )
        .limit(1)
    )[0]
    if (!target) throw notFound()
    // Page guests with edit on the row edit its cells (docs/adr/2146-*); the grant level is checked
    // by assertPageEditable like for any page.
    const { role, acl } = await requireMembershipAcl(target.workspaceId, user.id, { guests: true })
    await assertPageEditable(id, user.id, { role, acl })

    const body = updatePropsSchema.parse(req.body)
    const { baseVersion } = baseVersionSchema.parse(req.body)

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
    // A guest cannot see the member list, so it cannot assign people either (no member oracle).
    if (role === 'guest' && parentFields.some((f) => f.type === 'person' && (f.id in body.props || `agent:${f.id}` in body.props))) {
      throw new AppError(403, 'GUEST_PERSON', 'Guests cannot assign people')
    }
    const parentField = target.parentId ? subItemsField(parentFields, target.parentId) : null

    const bad = await nonMemberPersonIds(target.workspaceId, parentFields, [body.props])
    if (bad.length) throw badRequest('Only members of this workspace can be assigned')

    // withEditActor: the edit is attributed to the user / MCP client (docs/adr/0934-*)
    const { row, merged, version, queued } = await withEditActor([id], actorOf(user), () =>
      retryOnDeadlock(() =>
      db.transaction(async (tx) => {
        // Write gate (docs/adr/1071-*): an access change that committed since the check above is
        // re-checked here; one that starts now waits for this write.
        const gate = role === 'guest' ? await gateWrite(tx, target.workspaceId, user.id, { guests: true }) : await gateWrite(tx, target.workspaceId, user.id)
        if (gate.acl.version !== acl.version || gate.role !== role) {
          if (!gate.role) throw forbidden()
          await assertAgentAllowed(target.workspaceId, gate.acl.version, tx)
          await assertPageEditable(id, user.id, { role: gate.role, acl: gate.acl, exec: tx })
        }
        const [cur] = (await tx.execute(
          sql`SELECT props, ${rowVersionSql()} AS version FROM pages WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
        )) as unknown as { props: Record<string, unknown> | null; version: string }[]
        if (!cur) throw notFound()
        if (baseVersion !== undefined && cur.version !== baseVersion) {
          throw new AppError(409, 'ROW_VERSION_CONFLICT', 'The row changed since you read it', undefined, {
            currentVersion: cur.version,
          })
        }
        const oldProps = (cur.props ?? {}) as Record<string, unknown>
        // A person's agent connection next to a person cell (docs/adr/1861-*, 1864-*): checked here,
        // stored as `agent:<fieldId>`; a refused one writes nothing.
        const agentAssigned = await normalizeAgentProps(target.workspaceId, parentFields, oldProps, body.props, id)
        const set: Record<string, unknown> = {}
        const del: string[] = []
        const pairSyncs: { field: CollectionField; oldIds: string[]; newIds: string[] }[] = []
        for (const [key, value] of Object.entries(body.props)) {
          const field = fieldById.get(key)
          // computed and automatic values are never stored (docs/adr/2140-*), nor the via labels served next to them
          if (field?.type === 'rollup' || field?.type === 'formula' || isAutoFieldType(field?.type) || key.startsWith(VIA_PROP_PREFIX)) continue
          if (field && field === parentField) {
            // sub-items (docs/adr/2144-*): one parent, never the row itself or one of its sub-items
            let next = await normalizeRelationWrite(tx, field, oldProps[key], value, user.id)
            const submitted = idList(value)
            if (next.length > 1) next = submitted.length ? next.filter((x) => submitted.includes(x)).slice(0, 1) : next.slice(0, 1)
            await assertNoSubItemCycle(tx, target.parentId!, field, id, next[0] ?? null)
            if (next.length === 0) del.push(key)
            else set[key] = next
            continue
          }
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
        // Two-way links are mirrored onto the target rows: those rows must be editable as well.
        const mirrored = pairSyncs.flatMap((p) =>
          p.field.relation?.twoWay ? [...p.oldIds, ...p.newIds].filter((r) => !(p.oldIds.includes(r) && p.newIds.includes(r))) : [],
        )
        if (mirrored.length) await assertAllEditable(tx, mirrored, actorFor(user.id, gate.role))
        for (const p of pairSyncs) await syncPairedLinks(tx, p.field, id, p.oldIds, p.newIds)
        // version read after the pair sync (a self-referencing two-way relation may touch this row)
        const [r] = await tx
          .select({ ...pageColumns, version: rowVersionSql(), ...autoSourceColumns })
          .from(pages)
          .where(eq(pages.id, id))
          .limit(1)
        // Task assignment (docs/adr/1000-*): people newly put in a person cell hear about it; the
        // events commit with the write (docs/adr/1150-*).
        // A person assigned together with their agent hears nothing as a person: the agent's inbox
        // gets the assignment (and the person a copy with their setting, docs/adr/1863-*).
        const assigned = newAssignees(parentFields, oldProps, set)
          .map((a) => ({ ...a, userIds: a.userIds.filter((u) => !agentAssigned.some((x) => x.field === a.field && x.conn.userId === u)) }))
          .filter((a) => a.userIds.length)
        const toAgents = agentAssigned
          .filter((x) => x.conn.key !== connectionKey(user))
          .map((x) => ({ workspaceId: target.workspaceId, pageId: id, actorId: user.id, via: user.via ?? null, kind: 'task_assigned' as const, userIds: [x.conn.userId], field: x.field, connection: x.conn.key }))
        const queued: OutboxTopic[] = assigned.length || toAgents.length
          ? await enqueueAssignments(tx, [...taskAssignments({ workspaceId: target.workspaceId, rowId: id, actorId: user.id, via: user.via ?? null, changes: assigned }), ...toAgents])
          : []
        // Change feed (docs/adr/1650-*): which properties changed, committed with the write.
        // an agent next to a person cell is a change of that cell (docs/adr/1861-*)
        const changedKeys = [...new Set(changedPropKeys(oldProps, (updated?.props ?? {}) as Record<string, unknown>).map((k) => (k.startsWith('agent:') ? k.slice(6) : k)))]
        if (changedKeys.length) {
          await recordPageEvents([{ pageId: id, kind: 'page_props', after: propsEventText(parentFields, changedKeys), keys: changedKeys }], actorOf(user), tx)
          queued.push('change')
        }
        return {
          row: r,
          merged: (updated?.props ?? {}) as Record<string, unknown>,
          version: r?.version,
          queued,
        }
      }),
      ),
    )
    outboxCommitted(queued)
    // Relation cells return only visible links (hidden links stay stored but are never exposed in the response).
    const dto = toRowDTO(row, { ...merged })
    // automatic values as of this write; the last editor is set by the change log in the same transaction
    fillAutoInto(parentFields, [dto], [row])
    if (target.parentId && parentFields.length) {
      await resolveRelations(target.workspaceId, parentFields, [dto], user.id)
    }
    if (role === 'guest') stripAgentKeys(dto.props)
    // `version` only for callers that use the version check (response unchanged for the web app)
    return baseVersion !== undefined ? { row: dto, version } : { row: dto }
  })
}
