/**
 * Database row templates (docs/adr/1180-1184, docs/TEMPLATES.md "Row templates").
 *
 * A collection keeps up to ROW_TEMPLATES_MAX templates in `collection_row_templates`: a title
 * pattern, property defaults by field id and a body (Yjs V1 update of the 'document' fragment).
 * They are not pages, so search, backlinks, query blocks, the graph, webhooks and the MCP page
 * lists never see them; the only readers are the routes in routes/rowTemplates.ts and the
 * template/duplicate copies.
 *
 * `createRow` is the one way a row is made from a template (web "New row", board column "+",
 * calendar day "+", MCP create_row, REST POST /pages/:id/collection/rows): placement and the row
 * cap like the batch route, webhooks and createdVia like POST /pages, assignments for person
 * defaults, indexing after commit like instantiateTree.
 */
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import type { CollectionField, RowDTO, RowTemplateDTO, TemplateCursorDTO, TemplateInputDTO, WorkspaceRole } from '@inkling/shared'
import { COLLECTION_MAX_ROWS, ROW_TEMPLATE_BODY_MAX_BYTES, ROW_TEMPLATE_DATE_RE, ROW_TEMPLATES_MAX } from '@inkling/shared'
import { db } from './db/index'
import { collectionRowTemplates, collections, pageDocs, pages, workspaces } from './db/schema'
import { AppError, badRequest, notFound } from './errors'
import type { AuthUser } from './auth'
import type { Locale } from './i18n'
import { stateToBlocks } from './md/convert'
import { reindexPageLinks } from './md/linkIndex'
import { reindexPageTags } from './md/tagIndex'
import { reindexPageTasks } from './md/taskIndex'
import { reindexPageText } from './md/textIndex'
import { reindexPageChunks } from './context/chunkIndex'
import { nonMemberPersonIds } from './collectionRelations'
import { sanitizeBatchProps } from './routes/collectionsExt'
import { parseDateValue } from './collectionQuery/filter'
import { enqueueAssignments, newAssignees, taskAssignments } from './notify/producers'
import { enqueueWebhookEvent } from './webhooks'
import { outboxCommitted } from './outbox'
import type { OutboxTopic } from './outbox'
import { assertPlacement, withTreeLock } from './pageTree'
import { pageColumns, toRowDTO } from './pageDto'
import type { PageRow } from './pageDto'
import { applyStoredState, toV1 } from './yState'
import { docTexts, transformDocState } from './templates/structure'
import { collectInputs, formatDate, renderString, wallClock } from './templates/variables'
import type { VarContext } from './templates/variables'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RowTemplateRow = typeof collectionRowTemplates.$inferSelect

// ---------------------------------------------------------------------------
// defaults: validation at save, resolution at create
// ---------------------------------------------------------------------------

/**
 * Keep only defaults that fit the field definitions: unknown fields, relations and rollups are
 * dropped; dates accept the relative forms; person accepts a member id or 'me'. Text/URL keep
 * their variables. Used when a template is saved and again when it is used (a field may have
 * changed type or lost an option since).
 */
export function sanitizeTemplateProps(
  fields: CollectionField[],
  props: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!props) return out
  const byId = new Map(fields.map((f) => [f.id, f]))
  for (const [key, value] of Object.entries(props)) {
    const f = byId.get(key)
    if (!f || value === null || value === undefined) continue
    if (f.type === 'date') {
      if (typeof value === 'string' && ROW_TEMPLATE_DATE_RE.test(value.trim().toLowerCase())) out[key] = value.trim().toLowerCase()
      continue
    }
    if (f.type === 'person') {
      if (value === 'me' || (typeof value === 'string' && UUID_RE.test(value))) out[key] = value
      continue
    }
    // Everything else: the row value rules (relations/rollups are dropped there).
    const { set } = sanitizeBatchProps(new Map([[key, f]]), { [key]: value })
    if (key in set) out[key] = set[key]
  }
  return out
}

/**
 * Concrete row values from template defaults: relative dates against `today` (the creator's day),
 * 'me' → the creator, text variables rendered.
 */
export function resolveTemplateProps(
  fields: CollectionField[],
  defaults: Record<string, unknown>,
  opts: { today: string; userId: string; render: (s: string) => string },
): Record<string, unknown> {
  const clean = sanitizeTemplateProps(fields, defaults)
  const byId = new Map(fields.map((f) => [f.id, f]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(clean)) {
    const f = byId.get(key)!
    if (f.type === 'date') {
      const d = parseDateValue(String(value), opts.today)
      if (d) out[key] = d
    } else if (f.type === 'person') {
      out[key] = value === 'me' ? opts.userId : value
    } else if ((f.type === 'text' || f.type === 'url') && typeof value === 'string') {
      out[key] = opts.render(value).slice(0, 10_000)
    } else {
      out[key] = value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const textDefaults = (props: unknown): string[] =>
  Object.values((props ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string')

/** Inputs of a template: title, text defaults, then the body (order of first appearance). */
export function templateInputs(row: Pick<RowTemplateRow, 'title' | 'props' | 'state'>): TemplateInputDTO[] {
  const body = row.state && row.state.length ? docTexts(row.state) : []
  return collectInputs([row.title, ...textDefaults(row.props), ...body])
}

/** Whether a body has anything beyond one empty paragraph. */
export function bodyHasContent(state: Uint8Array | null): boolean {
  if (!state || state.length === 0) return false
  const doc = new Y.Doc()
  try {
    applyStoredState(doc, state)
    const frag = doc.getXmlFragment('document')
    // blockGroup > blockContainer*: more than one block, or one block with text/children.
    const group = frag.get(0)
    if (!(group instanceof Y.XmlElement)) return frag.length > 0
    if (group.length > 1) return true
    const only = group.get(0)
    if (!(only instanceof Y.XmlElement)) return false
    const content = only.get(0)
    if (only.length > 1) return true
    if (content instanceof Y.XmlElement) {
      if (content.nodeName !== 'paragraph') return true
      return content.toArray().some((c) => !(c instanceof Y.XmlText) || c.length > 0)
    }
    return false
  } finally {
    doc.destroy()
  }
}

export function toRowTemplateDTO(row: RowTemplateRow): RowTemplateDTO {
  return {
    id: row.id,
    collectionId: row.collectionId,
    name: row.name,
    icon: row.icon,
    title: row.title,
    props: (row.props ?? {}) as Record<string, unknown>,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
    inputs: templateInputs(row),
    hasBody: bodyHasContent(row.state),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listRowTemplates(collectionId: string): Promise<RowTemplateRow[]> {
  return db
    .select()
    .from(collectionRowTemplates)
    .where(eq(collectionRowTemplates.collectionId, collectionId))
    .orderBy(asc(collectionRowTemplates.sortOrder), asc(collectionRowTemplates.createdAt), asc(collectionRowTemplates.id))
}

// ---------------------------------------------------------------------------
// body updates
// ---------------------------------------------------------------------------

/**
 * Merge a client update into the stored body. Both are V1 updates of one Y.Doc's history, so a
 * merge keeps concurrent edits from two editors. Throws 400 on a damaged update or an oversized
 * result.
 */
export function mergeBody(stored: Uint8Array | null, update: Uint8Array): Buffer {
  const doc = new Y.Doc()
  try {
    if (stored && stored.length) applyStoredState(doc, stored)
    try {
      Y.applyUpdate(doc, update)
    } catch {
      throw new AppError(400, 'TEMPLATE_INVALID', 'The template body update is damaged')
    }
    const out = Buffer.from(Y.encodeStateAsUpdate(doc))
    if (out.length > ROW_TEMPLATE_BODY_MAX_BYTES) {
      throw new AppError(400, 'TEMPLATE_TOO_LARGE', 'The template body is too large')
    }
    return out
  } finally {
    doc.destroy()
  }
}

// ---------------------------------------------------------------------------
// create a row
// ---------------------------------------------------------------------------

export interface CreateRowArgs {
  collection: PageRow
  user: Pick<AuthUser, 'id' | 'name' | 'via'>
  role: WorkspaceRole
  /** undefined = the collection's default; null = empty row; id = that template. */
  template: string | null | undefined
  title?: string
  props?: Record<string, unknown>
  inputs?: Record<string, string>
  tz?: string
  locale: Locale
}

export interface CreateRowResult {
  row: RowDTO
  templateId: string | null
  cursor?: TemplateCursorDTO
}

async function pickTemplate(collectionId: string, template: string | null | undefined): Promise<RowTemplateRow | null> {
  if (template === null) return null
  const cond =
    template === undefined
      ? and(eq(collectionRowTemplates.collectionId, collectionId), eq(collectionRowTemplates.isDefault, true))
      : and(eq(collectionRowTemplates.collectionId, collectionId), eq(collectionRowTemplates.id, template))
  const [row] = await db.select().from(collectionRowTemplates).where(cond).limit(1)
  if (!row && template !== undefined) throw notFound('TEMPLATE_NOT_FOUND', 'Row template not found in this collection')
  return row ?? null
}

export async function createRow(a: CreateRowArgs): Promise<CreateRowResult> {
  const coll = a.collection
  const tpl = await pickTemplate(coll.id, a.template)
  // Field definitions only when there are values to check (an empty row needs none).
  const needFields = !!tpl || (a.props !== undefined && Object.keys(a.props).length > 0)
  const fields = needFields
    ? (((
        await db.select({ fields: collections.fields }).from(collections).where(eq(collections.pageId, coll.id)).limit(1)
      )[0]?.fields ?? []) as CollectionField[])
    : []

  // Explicit values: the batch rules (relations need PATCH /pages/:id/props), non-members → 400.
  const explicit = sanitizeBatchProps(new Map(fields.map((f) => [f.id, f])), a.props).set
  if ((await nonMemberPersonIds(coll.workspaceId, fields, [explicit])).length) {
    throw badRequest('Person cells may only reference members of this workspace')
  }

  let title = (a.title ?? '').trim().slice(0, 300)
  let props: Record<string, unknown> = explicit
  let state: Buffer | undefined
  let cursor: { blockId: string; offset: number } | undefined
  if (tpl) {
    const ws = (await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, coll.workspaceId)).limit(1))[0]
    const now = wallClock(new Date(), a.tz)
    const ctx: VarContext = {
      title: '',
      author: a.user.name,
      workspace: ws?.name ?? '',
      locale: a.locale,
      now,
      inputs: a.inputs ?? {},
    }
    // Title first, so {{title}} in the body and the defaults is the row's title.
    if (!title) title = renderString(tpl.title, ctx).text.trim().slice(0, 300)
    ctx.title = title
    const defaults = resolveTemplateProps(fields, (tpl.props ?? {}) as Record<string, unknown>, {
      today: formatDate(now, 'YYYY-MM-DD', a.locale),
      userId: a.user.id,
      render: (s) => renderString(s, ctx).text,
    })
    // A member removed since the template was saved: drop that default instead of failing.
    const gone = new Set(await nonMemberPersonIds(coll.workspaceId, fields, [defaults]))
    for (const [k, v] of Object.entries(defaults)) if (typeof v === 'string' && gone.has(v)) delete defaults[k]
    props = { ...defaults, ...explicit }
    if (tpl.state && tpl.state.length) {
      const r = transformDocState(tpl.state, {
        render: (s, allowCursor) => renderString(s, ctx, allowCursor),
        // Internal links keep their targets: the template is not a tree of its own.
        remapHref: () => null,
        wantCursor: true,
      })
      state = r.state
      cursor = r.cursor
    }
  }

  let queued: OutboxTopic[] = []
  const row = await withTreeLock(coll.workspaceId, async (tx) => {
    // Placement re-checks the collection under the tree lock: live, editable for this person or
    // agent (edit lock, docs/adr/0970-*), within the depth cap. New rows add nothing public.
    const chain = await assertPlacement(tx, {
      workspaceId: coll.workspaceId,
      parentId: coll.id,
      role: a.role,
      userId: a.user.id,
      publicRule: false,
    })
    // Row cap and next sort order in one pass over the collection's children.
    const [{ n, maxSort }] = await tx
      .select({ n: sql<number>`count(*) FILTER (WHERE ${pages.deletedAt} IS NULL)::int`, maxSort: max(pages.sortOrder) })
      .from(pages)
      .where(and(eq(pages.workspaceId, coll.workspaceId), eq(pages.parentId, coll.id)))
    if (n + 1 > COLLECTION_MAX_ROWS) throw badRequest(`A collection can hold at most ${COLLECTION_MAX_ROWS} rows`)
    const [created] = await tx
      .insert(pages)
      .values({
        workspaceId: coll.workspaceId,
        parentId: coll.id,
        kind: 'doc',
        scope: chain[0].scope,
        title,
        // The template's icon becomes the row's icon, as a page made from a template keeps its icon.
        icon: tpl?.icon ?? null,
        props,
        sortOrder: (maxSort ?? 0) + 1000,
        createdBy: a.user.id,
        createdVia: a.user.via ? a.user.via.slice(0, 100) : null,
      })
      .returning({ ...pageColumns, props: pages.props })
    if (state) await tx.insert(pageDocs).values({ pageId: created.id, state })
    // Person defaults and values are assignments (docs/adr/1000-*); webhooks like POST /pages.
    // Both commit with the row (docs/adr/1150-*).
    queued = await enqueueAssignments(
      tx,
      taskAssignments({
        workspaceId: coll.workspaceId,
        rowId: created.id,
        actorId: a.user.id,
        via: a.user.via ?? null,
        changes: newAssignees(fields, {}, props),
      }),
    )
    if (created.scope === 'shared') {
      const n = await enqueueWebhookEvent(tx, { type: 'page_created', workspaceId: coll.workspaceId, pageId: created.id, actorId: a.user.id })
      if (n > 0) queued = [...queued, 'webhook']
    }
    return created
  })
  outboxCommitted(queued)

  // Indexing after commit (best-effort, like instantiateTree): search, chunks, tags, tasks, links.
  if (state) {
    try {
      const blocks = stateToBlocks(state)
      await reindexPageText(row.id, blocks)
      await reindexPageChunks(row.id, blocks)
      await reindexPageTags(row.id, blocks)
      await reindexPageTasks(row.id, blocks)
      await reindexPageLinks(row.id, blocks)
    } catch (err) {
      console.error('[inkling] row template: indexing failed', row.id, err)
    }
  }
  const dto = toRowDTO(row, (row.props ?? {}) as Record<string, unknown>)
  return {
    row: dto,
    templateId: tpl?.id ?? null,
    ...(cursor ? { cursor: { pageId: row.id, ...cursor } } : {}),
  }
}

// ---------------------------------------------------------------------------
// copies: duplicate a collection, save as / instantiate a structure template
// ---------------------------------------------------------------------------

/** Plain form of a row template inside a structure template tree (TNode.rowTemplates). */
export interface TRowTemplate {
  name: string
  icon: string | null
  title: string
  props: Record<string, unknown>
  /** base64 Yjs V1 update; missing = empty body */
  state?: string
  isDefault: boolean
}

/** Templates of these collections, for a snapshot. Person defaults other than 'me' are dropped. */
export async function snapshotRowTemplates(
  collectionIds: string[],
  fieldsOf: (collectionId: string) => CollectionField[],
): Promise<Map<string, TRowTemplate[]>> {
  const out = new Map<string, TRowTemplate[]>()
  if (collectionIds.length === 0) return out
  const rows = await db
    .select()
    .from(collectionRowTemplates)
    .where(inArray(collectionRowTemplates.collectionId, collectionIds))
    .orderBy(asc(collectionRowTemplates.sortOrder), asc(collectionRowTemplates.createdAt), asc(collectionRowTemplates.id))
  for (const r of rows) {
    const fields = fieldsOf(r.collectionId)
    const persons = new Set(fields.filter((f) => f.type === 'person').map((f) => f.id))
    const props = { ...((r.props ?? {}) as Record<string, unknown>) }
    for (const k of Object.keys(props)) if (persons.has(k) && props[k] !== 'me') delete props[k]
    const list = out.get(r.collectionId) ?? []
    list.push({
      name: r.name,
      icon: r.icon,
      title: r.title,
      props,
      ...(r.state && r.state.length ? { state: Buffer.from(toV1(r.state)).toString('base64') } : {}),
      isDefault: r.isDefault,
    })
    out.set(r.collectionId, list)
  }
  return out
}

/** Insert rows for TRowTemplate lists (inside the caller's transaction). At most one default each. */
export async function insertRowTemplates(
  tx: Pick<typeof db, 'insert'>,
  entries: { collectionId: string; templates: TRowTemplate[]; userId: string; remapHref?: (href: string) => string | null }[],
): Promise<void> {
  const values: (typeof collectionRowTemplates.$inferInsert)[] = []
  for (const e of entries) {
    let seenDefault = false
    e.templates.slice(0, ROW_TEMPLATES_MAX).forEach((t, i) => {
      let state: Buffer | null = t.state ? Buffer.from(t.state, 'base64') : null
      // Links between pages of a structure template point at the new pages; variables stay
      // (they are filled when a row is created, not when the structure is).
      if (state && e.remapHref) state = transformDocState(state, { render: (s) => ({ text: s }), remapHref: e.remapHref, wantCursor: false }).state
      const isDefault = t.isDefault && !seenDefault
      if (isDefault) seenDefault = true
      values.push({
        collectionId: e.collectionId,
        name: t.name.slice(0, 60) || 'Template',
        icon: t.icon,
        title: t.title.slice(0, 300),
        props: t.props,
        state,
        isDefault,
        sortOrder: (i + 1) * 1000,
        createdBy: e.userId,
      })
    })
  }
  for (let i = 0; i < values.length; i += 100) await tx.insert(collectionRowTemplates).values(values.slice(i, i + 100))
}

/**
 * Duplicate (POST /pages/:id/duplicate): copy the templates of copied collections inside Postgres
 * (old → new collection id map), like the page bodies. Links in the bodies keep pointing at the
 * originals, as in the copied pages (duplicate does not rewrite links).
 */
export async function copyRowTemplates(
  tx: Pick<typeof db, 'execute'>,
  idMap: Map<string, string>,
  collectionIds: string[],
  userId: string,
): Promise<void> {
  if (collectionIds.length === 0) return
  const map = JSON.stringify(Object.fromEntries(collectionIds.map((id) => [id, idMap.get(id)])))
  await tx.execute(sql`
    INSERT INTO collection_row_templates
      (collection_id, name, icon, title, props, state, is_default, sort_order, created_by)
    SELECT m.new_id::uuid, t.name, t.icon, t.title, t.props, t.state, t.is_default, t.sort_order, ${userId}
      FROM collection_row_templates t
      JOIN jsonb_each_text(${map}::jsonb) AS m(old_id, new_id) ON t.collection_id = m.old_id::uuid
  `)
}
