import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { pageChanges, pages } from '../db/schema'
import { currentEditActor } from './attribution'
import { notifyPageEdited } from '../notify/producers'
import type { EditActor } from './attribution'
import { computeSectionChanges } from './sectionChanges'
import type { SectionChange } from './sectionChanges'

/**
 * Change feed writer (docs/adr/0932-*).
 *
 * Contract with the section index (context/chunkIndex.ts): after a page's chunks are rewritten,
 * reindexPageChunks calls `recordSectionChanges` once with the section lists before and after.
 * Page-level events (title, parent, trash, restore, visibility, duplicate) come from the page
 * routes through `logPageEvents`.
 *
 * Ordering: every write goes through one process-wide promise chain and each statement runs in
 * its own autocommit, so seq order == commit order and a reader that saw seq N has seen every
 * row ≤ N (no cursor gaps). The chain is in-memory, like the collab state: single instance.
 *
 * Merge: consecutive edits of the same section within MERGE_WINDOW_MS collapse into one row
 * (first before, newest after, new seq) — but only rows above the high-water mark, the highest
 * seq ever handed out in a cursor, so a merge never rewrites a row an agent has already passed.
 */

export interface SectionState {
  anchor: string
  headingPath: string
  blockId: string | null
  /** Section body (light Markdown). In `before`, filled for every section (unchanged ones copy `after`). */
  text: string
  /** Section version (chunker sectionVersion). */
  version: string
  /** Position of the section in the page (0-based). */
  order: number
}

export interface PageSectionDelta {
  pageId: string
  workspaceId: string
  /** Page visibility right now: 'shared' | 'private'. */
  scope: string
  ownerId: string | null
  /** True when the page had never been indexed (new page, or first index after upgrade). */
  firstIndex: boolean
  before: SectionState[]
  after: SectionState[]
}

/** Before/after texts above this size are not stored (row gets large=true). */
export const MAX_TEXT_BYTES = 16 * 1024
export const MERGE_WINDOW_MS = 10 * 60_000
const INSERT_BATCH = 500
const MAX_VIA_CHARS = 80
const MAX_TITLE_BYTES = 1024

// ---------------------------------------------------------------------------
// serialisation + high-water mark
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve()

/** Run `fn` after every change-log write queued before it (process-wide). */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Highest seq ever included in a cursor; null until first use after boot. */
let highWater: number | null = null

async function maxSeq(): Promise<{ seq: number; at: number }> {
  const rows = (await db.execute(
    sql`SELECT coalesce(max(seq), 0)::text AS m, (extract(epoch from now()) * 1000)::float8 AS t FROM page_changes`,
  )) as unknown as { m: string; t: number }[]
  return { seq: Number(rows[0].m), at: Math.floor(Number(rows[0].t)) }
}

async function loadHighWater(): Promise<number> {
  // First use after boot: every existing row may already be behind someone's cursor.
  if (highWater === null) highWater = (await maxSeq()).seq
  return highWater
}

/**
 * Take the current end of the log for a cursor. Runs in the write chain, so no merge can be
 * deciding between "read max" and "raise the high-water mark". `at` is the database clock.
 */
export function reserveCursor(): Promise<{ seq: number; at: number }> {
  return serialized(async () => {
    const cur = await maxSeq()
    highWater = Math.max(highWater ?? 0, cur.seq)
    return cur
  })
}

/** Test hook. */
export function changeLogHighWater(): number | null {
  return highWater
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fits(s: string | null): boolean {
  return s === null || Buffer.byteLength(s, 'utf8') <= MAX_TEXT_BYTES
}

function capVia(v: string | null | undefined): string | null {
  if (!v) return null
  return v.length > MAX_VIA_CHARS ? v.slice(0, MAX_VIA_CHARS) : v
}

function capTitle(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null
  return Buffer.byteLength(s, 'utf8') <= MAX_TITLE_BYTES ? s : s.slice(0, 300)
}

type NewRow = typeof pageChanges.$inferInsert

async function insertRows(rows: NewRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await db.insert(pageChanges).values(rows.slice(i, i + INSERT_BATCH))
  }
}

/** Body of a whole page for page_added (heading lines + bodies). */
function pageText(sections: SectionState[]): string {
  return sections.map((s) => (s.headingPath ? `# ${s.headingPath}\n${s.text}` : s.text)).join('\n\n')
}

// ---------------------------------------------------------------------------
// section changes (from the section index)
// ---------------------------------------------------------------------------

export function recordSectionChanges(delta: PageSectionDelta): Promise<void> {
  // Captured now: the REST request that caused this index pass is still in flight.
  const actor = currentEditActor(delta.pageId) ?? null
  if (delta.firstIndex && delta.before.length === 0) {
    return serialized(() => writePageAdded(delta, actor))
  }
  const changes = computeSectionChanges(delta.before, delta.after)
  if (changes.length === 0) return Promise.resolve()
  return serialized(() => writeSectionChanges(delta, changes, actor)).then(() =>
    // Followers of the page and agent-written "@Name" (docs/adr/1001-*, 1002-*): queued, best effort.
    notifyPageEdited({
      pageId: delta.pageId,
      workspaceId: delta.workspaceId,
      actor,
      sections: changes
        .filter((c) => c.kind !== 'moved')
        .map((c) => ({ anchor: c.anchor, before: c.before, after: c.after })),
    }).catch((err) => console.error('[inkling] page update notification failed', delta.pageId, err)),
  )
}

async function writePageAdded(delta: PageSectionDelta, actor: EditActor | null): Promise<void> {
  const text = pageText(delta.after)
  const ok = fits(text)
  // One page_added per page, ever (a duplicate's copy is logged by the route, then indexed later).
  await db.execute(sql`
    INSERT INTO page_changes (workspace_id, page_id, anchor, heading_path, kind, after_text, large, scope, owner_id, actor_id, via_client)
    SELECT ${delta.workspaceId}, ${delta.pageId}, NULL, '', 'page_added', ${ok ? text : null}, ${!ok},
           ${delta.scope}, ${delta.ownerId},
           -- No in-flight writer (e.g. the page was created empty and filled later): the creator
           -- and the client it was created through (pages.created_via, docs/adr/1005-*).
           ${actor ? sql`${actor.userId}::uuid` : sql`(SELECT created_by FROM pages WHERE id = ${delta.pageId})`},
           ${actor ? sql`${capVia(actor.via)}::text` : sql`(SELECT created_via FROM pages WHERE id = ${delta.pageId})`}
    WHERE NOT EXISTS (SELECT 1 FROM page_changes WHERE page_id = ${delta.pageId} AND kind = 'page_added')
  `)
}

async function writeSectionChanges(delta: PageSectionDelta, changes: SectionChange[], actor: EditActor | null): Promise<void> {
  const hwm = await loadHighWater()
  const actorId = actor?.userId ?? null
  const via = capVia(actor?.via)

  // Latest row per modified anchor (one query on the (page_id, anchor, seq) index).
  const modified = changes.filter((c) => c.kind === 'modified')
  const latest = new Map<string, {
    seq: number
    kind: string
    beforeText: string | null
    scope: string
    ownerId: string | null
    actorId: string | null
    viaClient: string | null
    fresh: boolean
  }>()
  if (modified.length) {
    const rows = await db
      .selectDistinctOn([pageChanges.anchor], {
        seq: pageChanges.seq,
        anchor: pageChanges.anchor,
        kind: pageChanges.kind,
        beforeText: pageChanges.beforeText,
        scope: pageChanges.scope,
        ownerId: pageChanges.ownerId,
        actorId: pageChanges.actorId,
        viaClient: pageChanges.viaClient,
        fresh: sql<boolean>`${pageChanges.changedAt} > now() - make_interval(secs => ${MERGE_WINDOW_MS / 1000})`,
      })
      .from(pageChanges)
      .where(and(eq(pageChanges.pageId, delta.pageId), inArray(pageChanges.anchor, modified.map((c) => c.anchor))))
      .orderBy(pageChanges.anchor, desc(pageChanges.seq))
    for (const r of rows) if (r.anchor !== null) latest.set(r.anchor, { ...r, seq: Number(r.seq) })
  }

  const inserts: NewRow[] = []
  for (const c of changes) {
    const prev = c.kind === 'modified' ? latest.get(c.anchor) : undefined
    const mergeable =
      prev &&
      (prev.kind === 'modified' || prev.kind === 'added') &&
      prev.seq > hwm &&
      prev.fresh &&
      prev.scope === delta.scope &&
      prev.ownerId === delta.ownerId &&
      prev.actorId === actorId &&
      prev.viaClient === via
    if (prev && mergeable) {
      const afterOk = fits(c.after)
      if (prev.kind === 'modified' && prev.beforeText !== null && afterOk && prev.beforeText === c.after) {
        // Edited back to where this unseen row started: nothing left to report.
        await db.delete(pageChanges).where(eq(pageChanges.seq, prev.seq))
        continue
      }
      const large = (prev.kind === 'modified' && prev.beforeText === null) || !afterOk
      // One statement: new seq (moves the row to the end of the log), newest after.
      await db.execute(sql`
        UPDATE page_changes
           SET seq = nextval(pg_get_serial_sequence('page_changes', 'seq')),
               after_text = ${afterOk ? c.after : null}, large = ${large},
               heading_path = ${c.headingPath}, changed_at = now()
         WHERE seq = ${prev.seq}
      `)
      continue
    }
    const isMove = c.kind === 'moved'
    const beforeOk = isMove || fits(c.before)
    const afterOk = isMove || fits(c.after)
    inserts.push({
      workspaceId: delta.workspaceId,
      pageId: delta.pageId,
      anchor: c.anchor,
      prevAnchor: c.prevAnchor,
      headingPath: c.headingPath,
      kind: c.kind,
      beforeText: beforeOk ? c.before : null,
      afterText: afterOk ? c.after : null,
      large: !beforeOk || !afterOk,
      scope: delta.scope,
      ownerId: delta.ownerId,
      actorId,
      viaClient: via,
    })
  }
  if (inserts.length) await insertRows(inserts)
}

// ---------------------------------------------------------------------------
// page-level events (from the page routes)
// ---------------------------------------------------------------------------

export type PageEventKind =
  | 'page_added'
  | 'page_renamed'
  | 'page_moved'
  | 'page_trashed'
  | 'page_restored'
  | 'page_visibility'

export interface PageEvent {
  pageId: string
  kind: PageEventKind
  /** page_renamed: old/new title; page_moved: old/new parent id ('' = top level); page_visibility: old/new scope. */
  before?: string | null
  after?: string | null
}

export function recordPageEvents(events: PageEvent[], actor: EditActor | null): Promise<void> {
  if (events.length === 0) return Promise.resolve()
  return serialized(async () => {
    // Workspace, owner and current visibility of every page in one query per 1000 ids.
    const info = new Map<string, { workspaceId: string; scope: string; createdBy: string | null }>()
    const ids = [...new Set(events.map((e) => e.pageId))]
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await db
        .select({ id: pages.id, workspaceId: pages.workspaceId, scope: pages.scope, createdBy: pages.createdBy })
        .from(pages)
        .where(inArray(pages.id, ids.slice(i, i + 1000)))
      for (const r of rows) info.set(r.id, r)
    }
    const rows: NewRow[] = []
    for (const e of events) {
      const p = info.get(e.pageId)
      if (!p) continue // purged meanwhile
      // A visibility change is stored with the union of both sides, so everyone who could see
      // the page before OR after gets the row (made-shared: new readers; made-private: "removed").
      const scope =
        e.kind === 'page_visibility' ? (e.before === 'shared' || e.after === 'shared' ? 'shared' : 'private') : p.scope
      const small = e.kind === 'page_renamed' ? capTitle : (s: string | null | undefined) => s ?? null
      rows.push({
        workspaceId: p.workspaceId,
        pageId: e.pageId,
        anchor: null,
        headingPath: '',
        kind: e.kind,
        beforeText: small(e.before),
        afterText: small(e.after),
        scope,
        ownerId: p.createdBy,
        actorId: actor?.userId ?? null,
        viaClient: capVia(actor?.via),
      })
    }
    if (rows.length) await insertRows(rows)
  })
}

/** Route helper: best effort, after the route's own transaction; never fails the request. */
export async function logPageEvents(events: PageEvent[], actor: EditActor | null): Promise<void> {
  try {
    await recordPageEvents(events, actor)
  } catch (err) {
    console.error('[inkling] change feed: page event write failed', err)
  }
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

const PURGE_BATCH = 5_000
const PURGE_MAX_BATCHES = 40

/** Delete rows older than `retentionDays`, in bounded batches (housekeeping). Returns rows deleted. */
export async function purgeOldChanges(now: Date, retentionDays: number): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000)
  let total = 0
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const rows = (await db.execute(sql`
      DELETE FROM page_changes WHERE seq IN (
        SELECT seq FROM page_changes WHERE changed_at < ${cutoff.toISOString()}::timestamptz
         ORDER BY changed_at LIMIT ${PURGE_BATCH})
      RETURNING seq
    `)) as unknown as unknown[]
    total += rows.length
    if (rows.length < PURGE_BATCH) break
  }
  return total
}
