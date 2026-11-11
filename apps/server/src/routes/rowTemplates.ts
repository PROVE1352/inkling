/**
 * Row template routes (docs/adr/1180-1184), registered from registerCollectionExtRoutes:
 *   GET    /pages/:id/collection/row-templates          list (anyone who can see the collection)
 *   POST   /pages/:id/collection/row-templates          create (collection editable)
 *   GET    /collection-row-templates/:tid               one template with its body
 *   PATCH  /collection-row-templates/:tid               name/icon/title/props/body/default/order
 *   DELETE /collection-row-templates/:tid
 *   POST   /pages/:id/collection/rows                   one new row, from a template or empty
 *
 * Reading follows the collection's visibility (requireCollectionPage); every write checks the
 * collection's edit lock (assertPageEditable), the same rule as fields and views.
 */
import { and, eq, max, ne, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  createRowSchema,
  createRowTemplateSchema,
  ROW_TEMPLATES_MAX,
  updateRowTemplateSchema,
} from '@inkling/shared'
import type { CollectionField, RowTemplateBodyDTO, RowTemplateListDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { collectionRowTemplates, collections, pageDocs, pages } from '../db/schema'
import { AppError, badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { assertPageEditable } from '../editLock'
import { requestLocale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { toV1 } from '../yState'
import { DOC_SCHEMA_VERSION, parseSchemaVersion } from '@inkling/shared'
import { schemaOfStoredState } from '../docSchema'
import {
  createRow,
  listRowTemplates,
  mergeBody,
  sanitizeTemplateProps,
  toRowTemplateDTO,
} from '../rowTemplates'
import type { RowTemplateRow } from '../rowTemplates'
import { requireCollectionPage } from './collections'
import { stripAgentKeys } from '../collectionQuery/guestView'
import { assertWorkspaceGrowth, jsonBytes } from '../quota/room'

async function loadFields(pageId: string): Promise<CollectionField[]> {
  const [row] = await db.select({ fields: collections.fields }).from(collections).where(eq(collections.pageId, pageId)).limit(1)
  return (row?.fields ?? []) as CollectionField[]
}

/** Template id → the template, after the collection visibility check (404 otherwise). */
async function requireTemplate(tid: string, userId: string): Promise<RowTemplateRow> {
  const [row] = await db.select().from(collectionRowTemplates).where(eq(collectionRowTemplates.id, tid)).limit(1)
  if (!row) throw notFound('TEMPLATE_NOT_FOUND', 'Row template not found')
  try {
    await requireCollectionPage(row.collectionId, userId)
  } catch (err) {
    if (err instanceof AppError && err.status === 404) throw notFound('TEMPLATE_NOT_FOUND', 'Row template not found')
    throw err
  }
  return row
}

const bodyOf = (row: RowTemplateRow): string => (row.state && row.state.length ? Buffer.from(toV1(row.state)).toString('base64') : '')

export async function registerRowTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/collection/row-templates', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    // a guest who can see the collection may use its templates (docs/adr/2146-*)
    await requireCollectionPage(id, user.id, { guests: true })
    const rows = await listRowTemplates(id)
    const out: RowTemplateListDTO = {
      templates: rows.map(toRowTemplateDTO),
      defaultId: rows.find((r) => r.isDefault)?.id ?? null,
    }
    return out
  })

  app.post(
    '/pages/:id/collection/row-templates',
    { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const coll = await requireCollectionPage(id, user.id)
      await assertPageEditable(id, user.id)
      const body = createRowTemplateSchema.parse(req.body)
      await assertWorkspaceGrowth(db, coll.workspaceId, jsonBytes(body)) // full workspace: LIMIT_STORAGE, and the bytes count at once (docs/adr/2533-*)
      const fields = await loadFields(id)

      let title = body.title ?? ''
      let props = sanitizeTemplateProps(fields, body.props)
      let state: Buffer | null = null
      if (body.fromRowId) {
        // A row of this collection the creator can see: its title, values and body.
        const src = await findVisiblePage(body.fromRowId, user.id)
        if (!src || src.parentId !== id) throw badRequest('That page is not a row of this collection')
        const [p] = await db.select({ props: pages.props }).from(pages).where(eq(pages.id, src.id)).limit(1)
        const [d] = await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, src.id)).limit(1)
        if (body.title === undefined) title = src.title
        if (body.props === undefined) props = sanitizeTemplateProps(fields, (p?.props ?? {}) as Record<string, unknown>)
        if (d?.state?.length) state = mergeBody(null, toV1(d.state))
      }

      const row = await db.transaction(async (tx) => {
        // One writer at a time per collection (cap, sort order, default flag).
        await tx.execute(sql`SELECT 1 FROM collections WHERE page_id = ${id} FOR UPDATE`)
        const [{ n, maxSort }] = await tx
          .select({ n: sql<number>`count(*)::int`, maxSort: max(collectionRowTemplates.sortOrder) })
          .from(collectionRowTemplates)
          .where(eq(collectionRowTemplates.collectionId, id))
        if (n >= ROW_TEMPLATES_MAX) throw badRequest(`A database can have at most ${ROW_TEMPLATES_MAX} row templates`)
        if (body.isDefault) {
          await tx.update(collectionRowTemplates).set({ isDefault: false }).where(eq(collectionRowTemplates.collectionId, id))
        }
        const [created] = await tx
          .insert(collectionRowTemplates)
          .values({
            collectionId: id,
            name: body.name,
            icon: body.icon ?? null,
            title: title.slice(0, 300),
            props,
            state,
            isDefault: body.isDefault === true,
            sortOrder: (maxSort ?? 0) + 1000,
            createdBy: user.id,
          })
          .returning()
        return created
      })
      return { template: toRowTemplateDTO(row) }
    },
  )

  app.get('/collection-row-templates/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const row = await requireTemplate(idParam(req.params), user.id)
    const out: RowTemplateBodyDTO = { template: toRowTemplateDTO(row), state: bodyOf(row) }
    return out
  })

  app.patch(
    '/collection-row-templates/:id',
    // The editor autosaves (debounced), so this is generous.
    { preHandler: requireUser, bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const tid = idParam(req.params)
      const found = await requireTemplate(tid, user.id)
      await assertPageEditable(found.collectionId, user.id)
      const body = updateRowTemplateSchema.parse(req.body)
      await assertWorkspaceGrowth(db, (await requireCollectionPage(found.collectionId, user.id)).workspaceId, jsonBytes(body)) // full workspace: LIMIT_STORAGE, and the bytes count at once (docs/adr/2533-*)
      const fields = body.props !== undefined ? await loadFields(found.collectionId) : []

      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM collections WHERE page_id = ${found.collectionId} FOR UPDATE`)
        const [cur] = await tx
          .select()
          .from(collectionRowTemplates)
          .where(eq(collectionRowTemplates.id, tid))
          .for('update')
        if (!cur) throw notFound('TEMPLATE_NOT_FOUND', 'Row template not found')
        const set: Partial<typeof collectionRowTemplates.$inferInsert> = { updatedAt: new Date() }
        if (body.name !== undefined) set.name = body.name
        if (body.icon !== undefined) set.icon = body.icon
        if (body.title !== undefined) set.title = body.title
        if (body.props !== undefined) set.props = sanitizeTemplateProps(fields, body.props)
        if (body.sortOrder !== undefined) set.sortOrder = body.sortOrder
        if (body.update !== undefined && body.update.length > 0) {
          // A template body is edited in the browser like a page (docs/adr/2425-*): an app older than
          // the body's newest node type would send the deletion of what it cannot show.
          if (parseSchemaVersion(body.schema) < DOC_SCHEMA_VERSION && schemaOfStoredState(cur.state) > parseSchemaVersion(body.schema)) {
            throw new AppError(409, 'SCHEMA_OUTDATED', 'This template has content that needs a newer version of the app. Reload the page.')
          }
          set.state = mergeBody(cur.state, new Uint8Array(Buffer.from(body.update, 'base64')))
        }
        if (body.isDefault === true) {
          await tx
            .update(collectionRowTemplates)
            .set({ isDefault: false })
            .where(and(eq(collectionRowTemplates.collectionId, cur.collectionId), ne(collectionRowTemplates.id, tid)))
          set.isDefault = true
        } else if (body.isDefault === false) {
          set.isDefault = false
        }
        const [updated] = await tx.update(collectionRowTemplates).set(set).where(eq(collectionRowTemplates.id, tid)).returning()
        return updated
      })
      return { template: toRowTemplateDTO(row) }
    },
  )

  app.delete('/collection-row-templates/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const tid = idParam(req.params)
    const found = await requireTemplate(tid, user.id)
    await assertPageEditable(found.collectionId, user.id)
    await db.delete(collectionRowTemplates).where(eq(collectionRowTemplates.id, tid))
    return reply.code(204).send()
  })

  // One new row. Same path for the web (new row, board column, calendar day), MCP create_row and
  // REST clients, so a template applies the same way everywhere.
  app.post(
    '/pages/:id/collection/rows',
    { preHandler: requireUser, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      // requireCollectionPage without its membership query: the role is needed here anyway.
      const coll = await findVisiblePage(id, user.id)
      if (!coll) throw notFound()
      // Page guests with edit on the collection add rows (docs/adr/2146-*): assertPlacement keeps them
      // inside the trees shared with them at edit level.
      const role = await requireMembership(coll.workspaceId, user.id, { guests: true })
      if (coll.kind !== 'collection') throw badRequest('Not a collection page')
      const body = createRowSchema.parse(req.body ?? {})
      const result = await createRow({
        collection: coll,
        user,
        role,
        template: body.template,
        title: body.title,
        props: body.props,
        inputs: body.inputs,
        tz: body.tz,
        locale: await requestLocale(req, user.id),
      })
      if (role === 'guest') stripAgentKeys(result.row.props)
      return result
    },
  )
}
