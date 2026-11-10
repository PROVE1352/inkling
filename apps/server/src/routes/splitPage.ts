import { and, asc, eq, isNull, max, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  LARGE_PAGE_STATE_BYTES,
  LARGE_PAGE_TOKENS,
  ROTATION_DEFAULT_BYTES,
  setRotationSchema,
  SPLIT_MAX_PAGES,
  splitPageSchema,
} from '@inkling/shared'
import type {
  PageRotationDTO,
  RotationMode,
  RotationTargetDTO,
  SplitPlanDTO,
  SplitSectionDTO,
  WorkspaceRole,
} from '@inkling/shared'
import * as Y from 'yjs'
import { getUser, requireUser } from '../auth'
import type { AuthUser } from '../auth'
import { broadcastToUser, hocuspocus } from '../collab'
import { bumpDocGen } from '../docGen'
import { actorOf, withEditActor } from '../context/attribution'
import { stateBytesV1Sql } from '../context/largePage'
import { db } from '../db/index'
import { pages } from '../db/schema'
import { scheduleDocIndex } from '../docIndexer'
import { assertPageEditable } from '../editLock'
import { AppError, badRequest, notFound } from '../errors'
import { idParam, requireMembershipAcl } from '../helpers'
import { requestLocale } from '../i18n'
import type { Locale } from '../i18n'
import { closePageConnections, liveDoc } from '../liveConnections'
import { linkContainers, planSplit, replaceSections, sectionDoc, SplitError, watchSections } from '../md/splitDoc'
import type { PlannedSection, SplitPlan } from '../md/splitDoc'
import { findVisiblePage } from '../pageDto'
import type { PageRow } from '../pageDto'
import { assertPlacement, withTreeLock } from '../pageTree'
import type { Tx } from '../pageTree'
import { createSnapshot, currentSnapshotSource } from '../snapshotStore'
import { emitWebhookEvent } from '../webhooks'
import { docFromStoredState, STATE_V2 } from '../yState'

/**
 * Splitting a page into subpages (docs/adr/1140-*) and automatic splitting of growing logs plus the
 * one-time "large page" notice to the owner (docs/adr/1141-*).
 *
 *   POST /pages/:id/split              { level, sections?, preview? } → SplitPlanDTO
 *   GET  /pages/:id/rotation           → PageRotationDTO
 *   PUT  /pages/:id/rotation           { mode, maxBytes? } → PageRotationDTO
 *   POST /pages/:id/rotation/target    → RotationTargetDTO (where an append should go; may create the subpage)
 */

const WORDS: Record<Locale, { untitled: string; beforeSplit: string }> = {
  en: { untitled: 'Untitled', beforeSplit: 'Before split' },
  ko: { untitled: '제목 없음', beforeSplit: '나누기 전' },
}

/** Test hook: runs after the subpages are committed, before the sections leave the live document. */
export const splitTestHooks: {
  afterCommit?: (pageId: string) => void | Promise<void>
  /** Bench hook: called at the end of each phase with its name. */
  phase?: (name: string) => void
} = {}
const phase = (name: string) => splitTestHooks.phase?.(name)

interface Editable {
  user: AuthUser
  page: PageRow
  role: WorkspaceRole
}

/** Visible + member + may edit (edit lock, docs/adr/0970-*), like every other body write. */
async function editablePage(user: AuthUser, id: string): Promise<Editable> {
  const page = await findVisiblePage(id, user.id)
  if (!page) throw notFound()
  const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id)
  await assertPageEditable(id, user.id, { role, acl })
  return { user, page, role }
}

/** Comment threads per block id of the page (a thread counts once, at its root's block). */
async function threadsByBlock(pageId: string): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT block_id AS "blockId", count(*)::int AS n FROM comments
     WHERE page_id = ${pageId} AND id = thread_id
     GROUP BY block_id
  `)) as unknown as { blockId: string; n: number }[]
  return new Map(rows.map((r) => [r.blockId, r.n]))
}

function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

function textArray(xs: string[]): string {
  return `{${xs.map((x) => `"${x.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(',')}}`
}

function sectionDto(s: PlannedSection, bytes: number, comments: Map<string, number>, pageId?: string): SplitSectionDTO {
  let n = 0
  for (const id of s.blockIds) n += comments.get(id) ?? 0
  return { blockId: s.blockId, anchor: s.anchor, title: s.title, blocks: s.end - s.start, bytes, comments: n, ...(pageId ? { pageId } : {}) }
}

/** Other people with the page open in an editor (the actor's own tabs and server connections excluded). */
function openBy(pageId: string, userId: string): number {
  const d = hocuspocus.documents.get(pageId)
  if (!d) return 0
  const others = new Set<string>()
  for (const c of d.getConnections()) {
    const uid = (c.context as { userId?: unknown } | undefined)?.userId
    if (typeof uid === 'string' && uid !== userId) others.add(uid)
  }
  return others.size
}

function chosen(plan: SplitPlan, sections: string[] | undefined): PlannedSection[] {
  if (!sections) return plan.sections
  const want = new Set(sections)
  const out = plan.sections.filter((s) => want.has(s.blockId))
  if (out.length !== want.size) throw badRequest('Some sections were not found at that heading level; reload the preview')
  return out
}

/** Preview: the plan from the open document, or from the stored state; nothing is written. */
async function previewSplit(e: Editable, level: number, sections: string[] | undefined): Promise<SplitPlanDTO> {
  const live = liveDoc(e.page.id)
  let doc = live
  if (!doc) {
    const [row] = (await db.execute(sql`SELECT state FROM page_docs WHERE page_id = ${e.page.id}`)) as unknown as { state: Uint8Array }[]
    doc = row ? docFromStoredState(row.state) : new Y.Doc()
  }
  try {
    const plan = planSplit(doc, level)
    const pick = chosen(plan, sections)
    const comments = await threadsByBlock(e.page.id)
    return {
      pageId: e.page.id,
      level,
      levels: plan.levels,
      sections: pick.map((s) => sectionDto(s, sectionDoc(plan, s).state.length, comments)),
      remainingBlocks: plan.total - pick.reduce((n, s) => n + s.end - s.start, 0) + pick.length,
      openBy: openBy(e.page.id, e.user.id),
      preview: true,
    }
  } finally {
    if (!live) doc.destroy()
  }
}

interface NewChild {
  id: string
  title: string
  state: Uint8Array
  stamp: string | null
  scope: string
}

/** Inserts subpages (rows + stored states) under `parent`; returns them in order. Runs in the tree lock. */
async function insertChildren(
  tx: Tx,
  e: Editable,
  items: { title: string; state?: Uint8Array; stateVector?: Uint8Array }[],
): Promise<NewChild[]> {
  // Creating under the page: parent live, depth cap, edit lock on the page, public-folder rule (docs/adr/0800-*, 0970-*).
  const chain = await assertPlacement(tx, { workspaceId: e.page.workspaceId, parentId: e.page.id, role: e.role, userId: e.user.id })
  const scope = chain[0].scope
  const [{ maxSort }] = await tx
    .select({ maxSort: max(pages.sortOrder) })
    .from(pages)
    .where(and(eq(pages.workspaceId, e.page.workspaceId), eq(pages.parentId, e.page.id)))
  let sortOrder = maxSort ?? 0
  // A new leaf changes no lock chain, owner or parent of an existing page: no bumpAcl (like POST /pages).
  const rows = await tx
    .insert(pages)
    .values(
      items.map((it) => ({
        workspaceId: e.page.workspaceId,
        parentId: e.page.id,
        kind: 'doc' as const,
        scope,
        title: it.title,
        sortOrder: (sortOrder += 1000),
        createdBy: e.user.id,
        createdVia: e.user.via ? e.user.via.slice(0, 100) : null,
      })),
    )
    .returning({ id: pages.id, title: pages.title, sortOrder: pages.sortOrder })
  rows.sort((a, b) => a.sortOrder - b.sortOrder)
  const out: NewChild[] = []
  for (let i = 0; i < rows.length; i++) {
    const it = items[i]
    let stamp: string | null = null
    if (it.state) {
      const [d] = (await tx.execute(sql`
        INSERT INTO page_docs (page_id, state, state_format, state_vector, updated_at)
        VALUES (${rows[i].id}, ${Buffer.from(it.state)}, ${STATE_V2}, ${it.stateVector ? Buffer.from(it.stateVector) : null}, now())
        RETURNING updated_at::text AS stamp
      `)) as unknown as { stamp: string }[]
      stamp = d.stamp
    }
    out.push({ id: rows[i].id, title: rows[i].title, state: it.state ?? new Uint8Array(), stamp, scope })
  }
  return out
}

const indexing = new Set<Promise<void>>()

/**
 * New writers of page_docs index what they wrote (AGENTS.md "Derived indexes"). The subpages are
 * indexed one after another after the response (≈ 10 ms each, 160+ for the production page), under
 * the actor for the change feed. Until then search and find_context do not list them yet; reads
 * decode them. A restart in between leaves them to the load-time / boot backfill like any page
 * without an index marker.
 */
function indexChildren(user: AuthUser, children: NewChild[]): void {
  const ids = children.map((c) => c.id)
  const job = withEditActor(ids, actorOf(user), async () => {
    for (const c of children) await scheduleDocIndex(c.id, c.state, true, c.stamp)
  })
    .catch((err) => console.error('[inkling] indexing split subpages failed', err))
    .finally(() => {
      indexing.delete(job)
      phase('subpage index')
    })
  indexing.add(job)
}

/** Waits for the subpage index passes of every split so far (tests, benches, shutdown). */
export async function flushSplitIndexing(): Promise<void> {
  while (indexing.size) await Promise.all([...indexing])
}

/** Undo of a split whose live-document step failed: comments and notifications go back, subpages go away. */
async function undoChildren(pageId: string, children: string[]): Promise<void> {
  if (!children.length) return
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE comments SET page_id = ${pageId} WHERE page_id = ANY(${uuidArray(children)}::uuid[])`)
    await tx.execute(sql`UPDATE notifications SET page_id = ${pageId} WHERE page_id = ANY(${uuidArray(children)}::uuid[])`)
    await tx.execute(sql`DELETE FROM pages WHERE id = ANY(${uuidArray(children)}::uuid[])`)
  })
  closePageConnections(children)
}

async function runSplit(e: Editable, level: number, sections: string[] | undefined, locale: Locale): Promise<SplitPlanDTO> {
  const pageId = e.page.id
  const words = WORDS[locale]
  // Version history keeps the page as it was (restorable like any other version).
  const before = await currentSnapshotSource(pageId)
  if (before) await createSnapshot(pageId, before, words.beforeSplit, e.user.id, e.user.via ?? null)

  phase('snapshot')
  const conn = await hocuspocus.openDirectConnection(pageId)
  phase('open')
  let children: NewChild[] = []
  let committed = false
  try {
    const live = conn.document
    if (!live) throw new Error('Could not open the document')
    // Plan, copies and links are made synchronously from the live document.
    let plan: SplitPlan
    try {
      plan = planSplit(live, level)
    } catch (err) {
      if (err instanceof SplitError) throw badRequest(err.message)
      throw err
    }
    const pick = chosen(plan, sections)
    if (!pick.length) throw badRequest('No section starts with a heading of that level')
    if (pick.length > SPLIT_MAX_PAGES) {
      throw badRequest(`At most ${SPLIT_MAX_PAGES} subpages per split; pass the sections to move (a preview lists them)`)
    }
    const copies = pick.map((s) => sectionDoc(plan, s))
    phase('plan+copies')
    const watch = watchSections(plan, pick)
    try {
      const comments = await threadsByBlock(pageId)
      const moved = pick.flatMap((s, i) => s.blockIds.map((b) => [b, i] as const))
      children = await withTreeLock(e.page.workspaceId, async (tx) => {
        const made = await insertChildren(
          tx,
          e,
          pick.map((s, i) => ({ title: s.title || words.untitled, state: copies[i].state, stateVector: copies[i].stateVector })),
        )
        if (moved.length) {
          const blockIds = moved.map(([b]) => b)
          const targets = moved.map(([, i]) => made[i].id)
          // Comments anchored in a moved block move with it; notifications about them (and body
          // mentions anchored there) point at the new page so their links keep landing on the block.
          await tx.execute(sql`
            WITH v AS (SELECT * FROM unnest(${textArray(blockIds)}::text[], ${uuidArray(targets)}::uuid[]) AS v(block_id, child))
            UPDATE comments c SET page_id = v.child FROM v WHERE c.page_id = ${pageId} AND c.block_id = v.block_id
          `)
          await tx.execute(sql`
            UPDATE notifications n SET page_id = c.page_id FROM comments c
             WHERE n.comment_id = c.id AND n.page_id = ${pageId} AND c.page_id <> ${pageId}
          `)
          await tx.execute(sql`
            WITH v AS (SELECT * FROM unnest(${textArray(blockIds)}::text[], ${uuidArray(targets)}::uuid[]) AS v(block_id, child))
            UPDATE notifications n SET page_id = v.child FROM v
             WHERE n.page_id = ${pageId} AND n.comment_id IS NULL AND n.anchor = v.block_id
          `)
        }
        return made
      })
      committed = true
      phase('db transaction')
      if (splitTestHooks.afterCommit) await splitTestHooks.afterCommit(pageId)

      const links = linkContainers(e.page.workspaceId, children.map((c) => ({ pageId: c.id, title: c.title })))
      let failure: unknown = null
      await withEditActor([pageId, ...children.map((c) => c.id)], actorOf(e.user), async () => {
        await conn.transact((doc) => {
          try {
            if (watch.stale()) throw new SplitError('The page changed while it was being split; try again')
            replaceSections(doc, plan, pick, links, level)
          } catch (err) {
            failure = err
          }
        })
        if (failure) return
        phase('live edit+page store')
      })
      if (failure) {
        await undoChildren(pageId, children.map((c) => c.id))
        children = []
        if (failure instanceof SplitError) throw new AppError(409, 'SPLIT_CONFLICT', failure.message)
        throw failure
      }
      // the moved sections left this body: device copies with edits in them keep those as a
      // recovery item instead of merging into deleted blocks (docs/adr/2201-*)
      await bumpDocGen(pageId)
      indexChildren(e.user, children)
      for (const c of children) {
        if (c.scope === 'shared') emitWebhookEvent({ type: 'page_created', workspaceId: e.page.workspaceId, pageId: c.id, actorId: e.user.id })
      }
      return {
        pageId,
        level,
        levels: plan.levels,
        sections: pick.map((s, i) => sectionDto(s, copies[i].state.length, comments, children[i].id)),
        remainingBlocks: plan.group.length,
        openBy: openBy(pageId, e.user.id),
        preview: false,
      }
    } finally {
      watch.stop()
    }
  } catch (err) {
    // Anything after the commit that did not reach the live document is rolled back by hand.
    if (committed && children.length) await undoChildren(pageId, children.map((c) => c.id)).catch(() => {})
    throw err
  } finally {
    await conn.disconnect()
  }
}

// ---------------------------------------------------------------------------
// rotation (docs/adr/1141-*)
// ---------------------------------------------------------------------------

/** `YYYY-MM` of `now` in the server's time zone (the zone reminders use). */
export function monthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function dayKey(now = new Date()): string {
  return `${monthKey(now)}-${String(now.getDate()).padStart(2, '0')}`
}

interface RotationRow {
  mode: 'month' | 'size' | null
  maxBytes: number | null
  currentId: string | null
  currentTitle: string | null
  currentKey: string | null
  hintedAt: string | null
  /** V1 bytes of the current subpage, or of the page itself when there is none. */
  bytes: string | null
}

async function rotationRow(pageId: string): Promise<RotationRow> {
  const rows = (await db.execute(sql`
    SELECT r.mode, r.max_bytes AS "maxBytes", cp.id AS "currentId", cp.title AS "currentTitle",
           r.current_key AS "currentKey", r.hinted_at::text AS "hintedAt",
           (SELECT ${stateBytesV1Sql()} FROM page_docs d WHERE d.page_id = coalesce(cp.id, p.id)) AS bytes
      FROM pages p
      LEFT JOIN page_rotations r ON r.page_id = p.id
      LEFT JOIN pages cp ON cp.id = r.current_page_id AND cp.parent_id = p.id AND cp.deleted_at IS NULL AND cp.kind = 'doc'
     WHERE p.id = ${pageId}
  `)) as unknown as RotationRow[]
  return rows[0] ?? { mode: null, maxBytes: null, currentId: null, currentTitle: null, currentKey: null, hintedAt: null, bytes: null }
}

function rotationDto(r: RotationRow): PageRotationDTO {
  return {
    mode: r.mode ?? 'off',
    maxBytes: r.maxBytes ?? ROTATION_DEFAULT_BYTES,
    current: r.currentId ? { id: r.currentId, title: r.currentTitle ?? '' } : null,
  }
}

/**
 * Finds or creates the subpage titled `title` under the page (month mode reuses one that already
 * has the name, e.g. made by hand or by an earlier split) and makes it the current one.
 */
async function rotateTo(e: Editable, title: string, key: string | null, reuse: boolean): Promise<{ id: string; title: string; created: boolean }> {
  return withTreeLock(e.page.workspaceId, async (tx) => {
    let found: { id: string; title: string } | undefined
    const siblings = await tx
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(and(eq(pages.parentId, e.page.id), isNull(pages.deletedAt), eq(pages.kind, 'doc')))
      .orderBy(asc(pages.createdAt))
    const taken = new Set(siblings.map((s) => s.title))
    if (reuse) found = siblings.find((s) => s.title === title)
    let created = false
    if (!found) {
      let name = title
      for (let n = 2; taken.has(name); n++) name = `${title} (${n})`
      const [made] = await insertChildren(tx, e, [{ title: name }])
      found = { id: made.id, title: made.title }
      created = true
    } else {
      await assertPlacement(tx, { workspaceId: e.page.workspaceId, parentId: e.page.id, role: e.role, userId: e.user.id })
    }
    await tx.execute(sql`
      INSERT INTO page_rotations (page_id, current_page_id, current_key, updated_at)
      VALUES (${e.page.id}, ${found.id}, ${key}, now())
      ON CONFLICT (page_id) DO UPDATE SET current_page_id = EXCLUDED.current_page_id, current_key = EXCLUDED.current_key, updated_at = now()
    `)
    return { ...found, created }
  })
}

/**
 * The one-time "large page" notice (docs/adr/1141-*): the owner (or, without one, the creator)
 * hears once per page that something keeps appending to a large page. `hinted_at` is claimed in the
 * same statement that decides it, so concurrent appends send one notification.
 */
async function maybeHintLarge(e: Editable, bytes: number): Promise<void> {
  if (bytes < LARGE_PAGE_STATE_BYTES) {
    const [t] = (await db.execute(sql`
      SELECT coalesce(sum(token_estimate), 0)::int AS tokens FROM page_chunks WHERE page_id = ${e.page.id}
    `)) as unknown as { tokens: number }[]
    if ((t?.tokens ?? 0) < LARGE_PAGE_TOKENS) return
  }
  const [owner] = (await db.execute(sql`
    SELECT coalesce(owner_id, created_by) AS id FROM pages WHERE id = ${e.page.id}
  `)) as unknown as { id: string | null }[]
  const to = owner?.id
  if (!to) return
  // The owner must still be a member who can see the page (private pages: their author only).
  if (!(await findVisiblePage(e.page.id, to))) return
  const sent = (await db.execute(sql`
    WITH h AS (
      INSERT INTO page_rotations (page_id, hinted_at) VALUES (${e.page.id}, now())
      ON CONFLICT (page_id) DO UPDATE SET hinted_at = now() WHERE page_rotations.hinted_at IS NULL
      RETURNING page_id
    )
    INSERT INTO notifications (user_id, type, page_id, workspace_id, actor_id, via_client, delivery)
    SELECT ${to}, 'large_page', h.page_id, ${e.page.workspaceId}, ${e.user.id}, ${e.user.via ? e.user.via.slice(0, 100) : null}, 'now'
      FROM h
     WHERE EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${e.page.workspaceId} AND m.user_id = ${to})
    RETURNING id
  `)) as unknown as { id: string }[]
  if (sent.length) broadcastToUser(to, { t: 'notifications' })
}

export async function rotationTarget(e: Editable, now = new Date()): Promise<RotationTargetDTO> {
  const self: RotationTargetDTO = { pageId: e.page.id, title: e.page.title, rotated: false, created: false, mode: 'off' }
  if (e.page.kind !== 'doc') return self
  const r = await rotationRow(e.page.id)
  const mode: RotationMode = r.mode ?? 'off'
  if (mode === 'off') {
    if (!r.hintedAt) await maybeHintLarge(e, Number(r.bytes ?? 0))
    return self
  }
  if (mode === 'month') {
    const key = monthKey(now)
    if (r.currentId && r.currentKey === key) return { pageId: r.currentId, title: r.currentTitle ?? key, rotated: true, created: false, mode }
    const to = await rotateTo(e, key, key, true)
    return { pageId: to.id, title: to.title, rotated: true, created: to.created, mode }
  }
  // size: the current subpage (or the page itself at first) until it stores max_bytes.
  if (Number(r.bytes ?? 0) < (r.maxBytes ?? ROTATION_DEFAULT_BYTES)) {
    return r.currentId ? { pageId: r.currentId, title: r.currentTitle ?? '', rotated: true, created: false, mode } : { ...self, mode }
  }
  const to = await rotateTo(e, dayKey(now), null, false)
  return { pageId: to.id, title: to.title, rotated: true, created: to.created, mode }
}

export async function registerSplitPageRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/pages/:id/split',
    { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const body = splitPageSchema.parse(req.body)
      const e = await editablePage(user, id)
      if (e.page.kind !== 'doc') throw badRequest('Only document pages can be split')
      if (body.preview) return previewSplit(e, body.level, body.sections)
      return runSplit(e, body.level, body.sections, await requestLocale(req, user.id))
    },
  )

  app.get('/pages/:id/rotation', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembershipAcl(page.workspaceId, user.id)
    return rotationDto(await rotationRow(id))
  })

  app.put('/pages/:id/rotation', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setRotationSchema.parse(req.body)
    const e = await editablePage(user, id)
    if (e.page.kind !== 'doc') throw badRequest('Only document pages can split themselves')
    const mode = body.mode === 'off' ? null : body.mode
    await db.execute(sql`
      INSERT INTO page_rotations (page_id, mode, max_bytes, updated_at)
      VALUES (${id}, ${mode}, ${body.maxBytes ?? ROTATION_DEFAULT_BYTES}, now())
      ON CONFLICT (page_id) DO UPDATE SET
        mode = EXCLUDED.mode,
        max_bytes = ${body.maxBytes === undefined ? sql`page_rotations.max_bytes` : sql`EXCLUDED.max_bytes`},
        current_page_id = CASE WHEN page_rotations.mode IS DISTINCT FROM EXCLUDED.mode THEN NULL ELSE page_rotations.current_page_id END,
        current_key = CASE WHEN page_rotations.mode IS DISTINCT FROM EXCLUDED.mode THEN NULL ELSE page_rotations.current_key END,
        updated_at = now()
    `)
    return rotationDto(await rotationRow(id))
  })

  app.post(
    '/pages/:id/rotation/target',
    { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const e = await editablePage(user, idParam(req.params))
      return rotationTarget(e)
    },
  )
}

