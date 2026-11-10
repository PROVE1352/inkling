import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { pageChanges } from '../db/schema'
import { drainOutbox, enqueue, failRow, OUTBOX_ORIGIN, outboxCommitted, registerOutboxHandler } from '../outbox'
import type { Exec, RetryPolicy } from '../outbox'
import { currentEditActor, liveEditors, windowTypist } from './attribution'
import { notifyPageEdited } from '../notify/producers'
import type { EditActor } from './attribution'
import { computeSectionChanges } from './sectionChanges'
import { changePassStarting, notifyChangesCommitted } from './changeWait'
import { isAgentVia } from '../agentVia'
import type { SectionChange, SectionChangeKind } from './sectionChanges'

/**
 * Change feed writer (docs/adr/0932-*, ordering and outbox: docs/adr/1080-*).
 *
 * Contract with the section index (context/chunkIndex.ts): after a page's chunks are rewritten,
 * reindexPageChunks calls `recordSectionChanges` once with the section lists before and after, in
 * the transaction that rewrote the chunks. Page-level events (title, parent, trash, restore,
 * visibility, duplicate) come from the page routes through `recordPageEvents(…, tx)`, in the
 * route's transaction (docs/adr/1150-*).
 *
 * Write path: the caller only computes the section diff (CPU) and inserts ONE outbox row
 * (topic 'change'). Nothing waits for other writers.
 *
 * Consumer (`runChangeBatch`): under a transaction-scoped advisory lock — one writer of
 * page_changes per database, whichever process gets it — it takes the committed pending rows in
 * outbox-id order, assigns seqs (bigserial), applies the merge rule and deletes the outbox rows, all
 * in one transaction. Because seqs are only handed out while holding the lock and the lock is
 * released after the commit is visible, seq order == commit order: a reader that saw seq N has
 * seen every row ≤ N. `reserveCursor` takes the same lock, so a merge never races a reservation.
 *
 * Merge: consecutive edits of the same section within MERGE_WINDOW_MS collapse into one row (first
 * before, newest after, new seq) — but only rows above the high-water mark (change_feed_state, the
 * highest seq ever handed out in a cursor), so a merge never rewrites a row an agent has already
 * passed. `changed_at` is the log time (the consumer's clock after taking the lock), so it grows
 * with seq like before.
 *
 * Lag: changes_since drains pending rows before it reserves its end (`reserveCursor`), so a change
 * whose write committed before the call is in that call's window. Other readers of page_changes
 * (activity, provenance badge, review) see it after the background consumer: kicked in-process on
 * commit, NOTIFY across processes, OUTBOX_POLL_MS (1 s) poll as the ceiling.
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
/** Lines with "@" kept for agent-written plain-text mentions (notify/producers.ts). */
const MAX_MENTION_TEXT = 8 * 1024

/** pg_advisory_xact_lock key of the single page_changes writer (any constant unique in the app). */
export const CHANGE_LOG_LOCK = 932_1080
/** Outbox rows per consumer transaction. */
export const CHANGE_BATCH = 200
/** Consumer passes changes_since runs before reserving (each ≤ CHANGE_BATCH rows). */
const RESERVE_DRAIN_PASSES = 20
const CHANGE_RETRY: RetryPolicy = { baseMs: 500, factor: 2, capMs: 60_000, maxAttempts: 10 }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ---------------------------------------------------------------------------
// outbox payloads
// ---------------------------------------------------------------------------

interface StoredChange {
  kind: SectionChangeKind
  anchor: string
  prevAnchor: string | null
  headingPath: string
  /** Capped like the stored row: null when absent OR too large (then *Large is true). */
  before: string | null
  after: string | null
  beforeLarge: boolean
  afterLarge: boolean
  /** Agent writes only: the "@" lines of before/after, for text mentions. */
  mBefore?: string
  mAfter?: string
}

type ChangeOp =
  | {
      op: 'sections'
      pageId: string
      workspaceId: string
      scope: string
      ownerId: string | null
      actor: EditActor | null
      /** People typing in the page at log time (excluded from "page you follow changed"). */
      typing: string[]
      /** No in-flight actor and exactly one person typed in this index window: the row is theirs (CF-2). */
      typedBy?: string | null
      changes: StoredChange[]
    }
  | {
      op: 'page_added'
      pageId: string
      workspaceId: string
      scope: string
      ownerId: string | null
      actor: EditActor | null
      text: string | null
      /**
       * The first index's sections as 'added' changes, for a page whose page_added was already
       * logged when it was created (collections and rows, docs/adr/1650-*): the body typed into an
       * empty row later is then logged as added sections instead of being dropped.
       */
      sections?: StoredChange[]
      typing?: string[]
      typedBy?: string | null
    }
  | {
      op: 'events'
      workspaceId: string
      actor: EditActor | null
      events: { pageId: string; kind: PageEventKind; before: string | null; after: string | null; scope: string; ownerId: string | null; keys?: string[] | null; noAuto?: boolean | null }[]
    }
  | { op: 'relabel'; pageIds: string[]; via: string; userId: string }

function pagesOf(op: ChangeOp): string[] {
  switch (op.op) {
    case 'events':
      return [...new Set(op.events.map((e) => e.pageId))]
    case 'relabel':
      return op.pageIds
    default:
      return [op.pageId]
  }
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

function mentionLines(s: string | null): string {
  if (!s) return ''
  const out = s
    .split('\n')
    .filter((l) => /[@＠﹫]/.test(l))
    .join('\n')
  return out.length > MAX_MENTION_TEXT ? out.slice(0, MAX_MENTION_TEXT) : out
}

const actorJson = (a: EditActor | null | undefined): EditActor | null =>
  a ? (a.auto ? { userId: a.userId, via: capVia(a.via), auto: a.auto } : { userId: a.userId, via: capVia(a.via) }) : null

type NewRow = typeof pageChanges.$inferInsert

async function insertRows(exec: Tx, rows: NewRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await exec.insert(pageChanges).values(rows.slice(i, i + INSERT_BATCH))
  }
}

/** Body of a whole page for page_added (heading lines + bodies). */
function pageText(sections: SectionState[]): string {
  return sections.map((s) => (s.headingPath ? `# ${s.headingPath}\n${s.text}` : s.text)).join('\n\n')
}

// ---------------------------------------------------------------------------
// write side: section changes (from the section index)
// ---------------------------------------------------------------------------

/**
 * Queue the section changes of one reindex. Pass the transaction that rewrote the chunks so the
 * log entry commits (or not) with them; without one it autocommits and kicks the consumer.
 */
export async function recordSectionChanges(delta: PageSectionDelta, exec?: Exec): Promise<void> {
  // Captured now: the REST request that caused this index pass is still in flight.
  const actor = actorJson(currentEditActor(delta.pageId))
  let op: ChangeOp
  if (delta.firstIndex && delta.before.length === 0) {
    const text = pageText(delta.after)
    // An empty body (an opened, untyped row) has no section worth reporting.
    const sections = computeSectionChanges([], delta.after).filter((c) => c.headingPath !== '' || (c.after ?? '').trim() !== '')
    op = {
      op: 'page_added',
      pageId: delta.pageId,
      workspaceId: delta.workspaceId,
      scope: delta.scope,
      ownerId: delta.ownerId,
      actor,
      text: fits(text) ? text : null,
      ...(sections.length
        ? {
            sections: firstIndexSections(sections, isAgentVia(actor?.via)),
            typing: liveEditors(delta.pageId),
            typedBy: actor ? null : windowTypist(delta.pageId),
          }
        : {}),
    }
  } else {
    const changes = computeSectionChanges(delta.before, delta.after)
    if (changes.length === 0) return
    op = {
      op: 'sections',
      pageId: delta.pageId,
      workspaceId: delta.workspaceId,
      scope: delta.scope,
      ownerId: delta.ownerId,
      actor,
      typing: liveEditors(delta.pageId),
      typedBy: actor ? null : windowTypist(delta.pageId),
      changes: changes.map((c) => storeChange(c, isAgentVia(actor?.via))),
    }
    // body edits make their author the last editor (docs/adr/2141-*); the first index of a new page does not
    const typist = actor ? null : windowTypist(delta.pageId)
    await markEdited(exec ?? db, [delta.pageId], actor ?? (typist ? { userId: typist, via: null } : null), { touchCollection: true })
  }
  await enqueue(exec ?? db, [{ topic: 'change', workspaceId: delta.workspaceId, payload: op }])
}

/**
 * Sections of a first index, kept on the page_added op for pages already logged at creation
 * (docs/adr/1650-*). Most first indexes are new document pages whose op is applied as page_added and
 * these are never used, so the texts ride along only while they are small together; above that the
 * sections are kept without text (the feed says "large change, read section").
 */
const FIRST_INDEX_SECTIONS_MAX_BYTES = 64 * 1024
function firstIndexSections(changes: SectionChange[], agent: boolean): StoredChange[] {
  const stored = changes.map((c) => storeChange(c, agent))
  const bytes = stored.reduce((n, c) => n + (c.after ? Buffer.byteLength(c.after, 'utf8') : 0), 0)
  if (bytes <= FIRST_INDEX_SECTIONS_MAX_BYTES) return stored
  return stored.map((c) => ({ kind: c.kind, anchor: c.anchor, prevAnchor: c.prevAnchor, headingPath: c.headingPath, before: null, after: null, beforeLarge: false, afterLarge: true }))
}

function storeChange(c: SectionChange, agent: boolean): StoredChange {
  const isMove = c.kind === 'moved'
  const beforeOk = isMove || fits(c.before)
  const afterOk = isMove || fits(c.after)
  const out: StoredChange = {
    kind: c.kind,
    anchor: c.anchor,
    prevAnchor: c.prevAnchor,
    headingPath: c.headingPath,
    before: beforeOk ? c.before : null,
    after: afterOk ? c.after : null,
    beforeLarge: !beforeOk,
    afterLarge: !afterOk,
  }
  if (agent && !isMove && c.after && c.after.includes('@')) {
    out.mBefore = mentionLines(c.before)
    out.mAfter = mentionLines(c.after)
  }
  return out
}

// ---------------------------------------------------------------------------
// write side: page-level events (from the page routes)
// ---------------------------------------------------------------------------

export type PageEventKind =
  | 'page_added'
  | 'page_renamed'
  | 'page_moved'
  | 'page_trashed'
  | 'page_restored'
  | 'page_visibility'
  /** Row properties set or cleared (after = the field names, docs/adr/1650-*). */
  | 'page_props'

export interface PageEvent {
  pageId: string
  kind: PageEventKind
  /** page_renamed: old/new title; page_moved: old/new parent id ('' = top level); page_visibility: old/new scope; page_props: after = field names. */
  before?: string | null
  after?: string | null
  /** page_props: the changed field ids (database automations' "field changed" trigger, docs/adr/2240-*). */
  keys?: string[]
  /** page_added of a bulk write that starts no database automation (docs/adr/2240-*). */
  noAuto?: boolean
}

/**
 * Queue page-level events: ONE statement that reads each page's workspace, owner and visibility
 * now (log time) and writes one outbox row per workspace. Routes pass their transaction
 * (docs/adr/1150-*) and call `outboxCommitted(['change'])` after the commit.
 */
export async function recordPageEvents(events: PageEvent[], actor: EditActor | null, exec?: Exec): Promise<void> {
  if (events.length === 0) return
  const data = events.map((e, i) => {
    const small = e.kind === 'page_renamed' || e.kind === 'page_props' ? capTitle : (s: string | null | undefined) => s ?? null
    return { ord: i, page_id: e.pageId, kind: e.kind, before: small(e.before), after: small(e.after), keys: e.keys?.slice(0, 100) ?? null, no_auto: e.noAuto || null }
  })
  const x = exec ?? db
  // A visibility change is stored with the union of both sides, so everyone who could see the
  // page before OR after gets the row (made-shared: new readers; made-private: "removed").
  const out = (await x.execute(sql`
    WITH ev AS (
      SELECT x.ord, x.page_id, x.kind, x.before, x.after, x.keys, x.no_auto
        FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS x(ord int, page_id uuid, kind text, before text, after text, keys jsonb, no_auto boolean)
    ), ins AS (
      INSERT INTO outbox (topic, origin, workspace_id, payload)
      SELECT 'change', ${OUTBOX_ORIGIN}, p.workspace_id, jsonb_build_object(
               'op', 'events',
               'workspaceId', p.workspace_id,
               'actor', ${JSON.stringify(actorJson(actor))}::jsonb,
               'events', jsonb_agg(jsonb_build_object(
                  'pageId', ev.page_id, 'kind', ev.kind, 'before', ev.before, 'after', ev.after,
                  'scope', CASE WHEN ev.kind = 'page_visibility'
                                THEN CASE WHEN ev.before = 'shared' OR ev.after = 'shared' THEN 'shared' ELSE 'private' END
                                ELSE p.scope END,
                  'ownerId', p.created_by, 'keys', ev.keys, 'noAuto', ev.no_auto) ORDER BY ev.ord))
        FROM ev JOIN pages p ON p.id = ev.page_id
       GROUP BY p.workspace_id
      RETURNING id
    )
    SELECT 1 AS z FROM ins LIMIT 1
  `)) as unknown as unknown[]
  await markEdited(x, events.filter((e) => EDIT_KINDS.has(e.kind)).map((e) => e.pageId), actor)
  if (out.length > 0 && x === db) outboxCommitted(['change'])
}

/** Page events that make the actor the page's last editor (docs/adr/2141-*). */
const EDIT_KINDS = new Set<PageEventKind>(['page_renamed', 'page_props'])

/**
 * Last editor (docs/adr/2141-*): every logged property, title or body change writes its actor onto
 * the page in the same transaction as the log entry, so a collection's "Last edited by" is the
 * change feed's newest actor (and its via) without reading page_changes, which is pruned and merged.
 * A change with no known actor leaves the previous editor.
 */
async function markEdited(x: Exec, pageIds: string[], actor: EditActor | null | undefined, opts: { touchCollection?: boolean } = {}): Promise<void> {
  if (!actor || pageIds.length === 0) return
  const ids = [...new Set(pageIds)]
  const via = capVia(actor.via)
  const set = sql`
    UPDATE pages SET edited_by = ${actor.userId}::uuid, edited_via = ${via}
     WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])
       AND (edited_by IS DISTINCT FROM ${actor.userId}::uuid OR edited_via IS DISTINCT FROM ${via})
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${actor.userId}::uuid)`
  if (!opts.touchCollection) {
    await x.execute(set)
    return
  }
  // A body edit is indexed seconds after the store bumped updated_at: the collection's version moves
  // again when its "Last edited by" changes, so a client that polled in between sees the new editor.
  await x.execute(sql`
    WITH u AS (${set} RETURNING parent_id)
    UPDATE collections SET updated_at = now()
     WHERE page_id IN (SELECT parent_id FROM u WHERE parent_id IS NOT NULL)
       AND fields @> '[{"type":"editedBy"}]'::jsonb
  `)
}

/**
 * Field keys whose value differs between two prop objects (JSON equality), for a page_props event.
 */
export function changedPropKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
}

/**
 * The page_props event text (docs/adr/1650-*): the changed fields' names at log time, in the
 * collection's field order (unknown keys after, by key), comma separated. Values are not logged:
 * they can be option ids, people or relation ids, and the feed points at query_rows for them.
 */
export function propsEventText(fields: { id: string; name: string }[], keys: string[]): string {
  const want = new Set(keys)
  const named = fields.filter((f) => want.has(f.id))
  const known = new Set(named.map((f) => f.id))
  const rest = keys.filter((k) => !known.has(k)).sort()
  return [...named.map((f) => f.name.replace(/\s+/g, ' ').trim() || f.id), ...rest].join(', ')
}

/**
 * Best effort, in its own statement after a write that has no transaction to put the events in;
 * never fails the request. Routes with a transaction use `recordPageEvents(…, tx)` instead.
 */
export async function logPageEvents(events: PageEvent[], actor: EditActor | null): Promise<void> {
  try {
    await recordPageEvents(events, actor)
  } catch (err) {
    console.error('[inkling] change feed: page event write failed', err)
  }
}

/**
 * Provenance of pages created by an agent request (notify/provenance.ts): `page_added` rows of
 * these pages get the client name. Queued behind the page_added rows of the same request, so it
 * also reaches rows that are still in the outbox.
 */
export async function recordCreatedVia(pageIds: string[], via: string, userId: string, exec?: Exec): Promise<void> {
  if (pageIds.length === 0) return
  const op: ChangeOp = { op: 'relabel', pageIds, via, userId }
  await enqueue(exec ?? db, [{ topic: 'change', payload: op }])
}

// ---------------------------------------------------------------------------
// consumer
// ---------------------------------------------------------------------------

/** Fault injection for the crash tests: runs after the batch's writes, before its commit. */
export const changeLogTestHooks: { beforeCommit?: () => void | Promise<void> } = {}

let log: (msg: string) => void = (m) => console.error(m)
export function setChangeLogLogger(fn: (msg: string) => void): void {
  log = fn
}

let stateRowExists = false

/**
 * The high-water mark and the batch's log time (the clock after the lock, so it grows with seq
 * across batches) in one round trip. The row is created at first use with max(seq): every row
 * that existed before may already be behind a cursor.
 */
async function highWaterAndClock(tx: Tx): Promise<{ hwm: number; at: Date }> {
  if (!stateRowExists) {
    await tx.execute(sql`
      INSERT INTO change_feed_state (id, high_water) SELECT 1, coalesce(max(seq), 0) FROM page_changes
      ON CONFLICT (id) DO NOTHING
    `)
    stateRowExists = true
  }
  const rows = (await tx.execute(sql`
    SELECT high_water::text AS h, clock_timestamp() AS t FROM change_feed_state WHERE id = 1
  `)) as unknown as { h: string; t: Date | string }[]
  if (!rows[0]) {
    stateRowExists = false // deleted under us (tests, restore): recreate next time
    throw new Error('change_feed_state row missing')
  }
  return { hwm: Number(rows[0].h), at: new Date(rows[0].t) }
}

/**
 * One consumer pass. Returns the number of outbox rows materialised. Fast path: the whole batch
 * in one transaction without savepoints; if any row fails, the batch is rolled back and redone
 * with a savepoint per row so only the failing rows are retried.
 */
export async function runChangeBatch(): Promise<number> {
  try {
    return await changePass(false)
  } catch (err) {
    log(`[change-log] batch failed, isolating rows: ${String(err)}`)
    return changePass(true)
  }
}

/** Workspace of a log op (for waking changes_since waits, docs/adr/1551-*); relabel adds no rows. */
function workspaceOf(op: ChangeOp): string | null {
  return op.op === 'relabel' ? null : op.workspaceId
}

async function changePass(isolate: boolean): Promise<number> {
  automationQueued = false
  automationForeign = false
  let notified = false
  let notifiedForeign = false
  const logged = new Set<string>()
  const passEpoch = changePassStarting()
  const n = await db.transaction(async (tx) => {
    logged.clear()
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHANGE_LOG_LOCK})`)
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, payload, attempts, origin, available_at <= clock_timestamp() AS due
        FROM outbox WHERE topic = 'change' AND state = 'pending'
       ORDER BY outbox.id LIMIT ${CHANGE_BATCH}
         FOR UPDATE SKIP LOCKED
    `)) as unknown as { id: string; payload: ChangeOp; attempts: number; origin: string | null; due: boolean }[]
    if (rows.length === 0) return 0
    const { hwm, at } = await highWaterAndClock(tx)
    // Rows of one page are applied in order: a page with a failed or not-yet-due row waits.
    const blocked = new Set<string>()
    const done: string[] = []
    for (const r of rows) {
      const ids = pagesOf(r.payload)
      if (!r.due || ids.some((id) => blocked.has(id))) {
        for (const id of ids) blocked.add(id)
        continue
      }
      if (!isolate) {
        if (await applyOp(tx, r.payload, hwm, at, r.origin)) {
          notified = true
          if (r.origin !== OUTBOX_ORIGIN) notifiedForeign = true
        }
        done.push(r.id)
        const w = workspaceOf(r.payload)
        if (w) logged.add(w)
        continue
      }
      try {
        const res = await tx.transaction((sp) => applyOp(sp, r.payload, hwm, at, r.origin))
        if (res) {
          notified = true
          if (r.origin !== OUTBOX_ORIGIN) notifiedForeign = true
        }
        done.push(r.id)
        const w = workspaceOf(r.payload)
        if (w) logged.add(w)
      } catch (err) {
        for (const id of ids) blocked.add(id)
        const s = await failRow(tx, 'change', Number(r.id), r.attempts + 1, err, CHANGE_RETRY)
        log(`[change-log] outbox row ${r.id} failed (${s}): ${String(err)}`)
      }
    }
    if (done.length) await tx.execute(sql`DELETE FROM outbox WHERE id = ANY(${`{${done.join(',')}}`}::bigint[])`)
    await changeLogTestHooks.beforeCommit?.()
    return done.length
  })
  // Follower events carry the origin of their change row: another process is told (docs/adr/1150-*).
  if (notified) outboxCommitted(['notify'], { foreign: notifiedForeign })
  if (automationQueued) outboxCommitted(['automation'], { foreign: automationForeign })
  // Committed: changes_since calls waiting on these workspaces read again (docs/adr/1551-*).
  if (n > 0 && logged.size) notifyChangesCommitted(logged, passEpoch)
  return n
}

registerOutboxHandler('change', runChangeBatch, CHANGE_BATCH)

/** Process every committed change-log row (tests, shutdown, readers that need their own writes). */
export function drainChangeLog(maxPasses = 50): Promise<number> {
  return drainOutbox('change', maxPasses)
}

/**
 * Queues database automation runs for logged page events; returns true when it queued any
 * (automations/queue.ts registers it, so this module does not import the automation code).
 */
export type AutomationEventHook = (
  tx: Tx,
  workspaceId: string,
  actor: EditActor | null,
  events: Extract<ChangeOp, { op: 'events' }>['events'],
  /** The writer's process: the runs belong to it like notification followers (docs/adr/1150-*). */
  origin: string | null,
) => Promise<boolean>
let automationHook: AutomationEventHook | null = null
let automationQueued = false
let automationForeign = false
export function setAutomationEventHook(fn: AutomationEventHook | null): void {
  automationHook = fn
}

/** Returns true when it queued notification events. */
async function applyOp(tx: Tx, op: ChangeOp, hwm: number, at: Date, origin: string | null): Promise<boolean> {
  switch (op.op) {
    case 'page_added': {
      if (await writePageAdded(tx, op, at)) return false
      // Already logged at creation (collections, rows: docs/adr/1650-*): the first body is new sections.
      if (!op.sections?.length) return false
      return writeSectionChanges(
        tx,
        { op: 'sections', pageId: op.pageId, workspaceId: op.workspaceId, scope: op.scope, ownerId: op.ownerId, actor: op.actor, typing: op.typing ?? [], typedBy: op.typedBy ?? null, changes: op.sections },
        hwm,
        at,
        origin,
      )
    }
    case 'sections':
      return writeSectionChanges(tx, op, hwm, at, origin)
    case 'events': {
      const rows: NewRow[] = op.events.map((e) => ({
        workspaceId: op.workspaceId,
        pageId: e.pageId,
        anchor: null,
        headingPath: '',
        kind: e.kind,
        beforeText: e.before,
        afterText: e.after,
        scope: e.scope,
        ownerId: e.ownerId,
        actorId: op.actor?.userId ?? null,
        viaClient: capVia(op.actor?.via),
        changedAt: at,
      }))
      if (rows.length) await insertRows(tx, rows)
      // Database automations (docs/adr/2240-*): rows added or changed in a collection with enabled
      // rules queue their runs here, in the transaction that logs the change: once, after the write committed.
      // Any process may apply these rows, also one that never loaded the automation code (a CLI, a
      // test, a process without the routes): the hook is loaded here then, so no row event is lost.
      if (!automationHook && op.events.some((e) => e.kind === 'page_added' || e.kind === 'page_props')) await import('../automations/queue')
      if (automationHook && (await automationHook(tx, op.workspaceId, op.actor, op.events, origin))) {
        automationQueued = true
        if (origin !== OUTBOX_ORIGIN) automationForeign = true
      }
      return false
    }
    case 'relabel': {
      const ids = sql`${`{${op.pageIds.join(',')}}`}::uuid[]`
      await tx.execute(sql`
        UPDATE page_changes SET via_client = ${capVia(op.via)}, actor_id = coalesce(actor_id, ${op.userId}::uuid)
         WHERE page_id = ANY(${ids}) AND kind = 'page_added' AND via_client IS NULL
      `)
      return false
    }
  }
}

/** Returns false when the page already had its page_added row (nothing written). */
async function writePageAdded(tx: Tx, op: Extract<ChangeOp, { op: 'page_added' }>, at: Date): Promise<boolean> {
  const actor = op.actor
  // One page_added per page, ever (a duplicate's copy is logged by the route, then indexed later).
  const rows = (await tx.execute(sql`
    INSERT INTO page_changes (workspace_id, page_id, anchor, heading_path, kind, after_text, large, scope, owner_id, actor_id, via_client, changed_at)
    SELECT ${op.workspaceId}, ${op.pageId}, NULL, '', 'page_added', ${op.text}, ${op.text === null},
           ${op.scope}, ${op.ownerId},
           -- No in-flight writer (e.g. the page was created empty and filled later): the creator
           -- and the client it was created through (pages.created_via, docs/adr/1005-*).
           ${actor ? sql`${actor.userId}::uuid` : sql`(SELECT created_by FROM pages WHERE id = ${op.pageId})`},
           ${actor ? sql`${capVia(actor.via)}::text` : sql`(SELECT created_via FROM pages WHERE id = ${op.pageId})`},
           ${at.toISOString()}::timestamptz
    WHERE NOT EXISTS (SELECT 1 FROM page_changes WHERE page_id = ${op.pageId} AND kind = 'page_added')
    RETURNING 1 AS x
  `)) as unknown as unknown[]
  return rows.length > 0
}

async function writeSectionChanges(
  tx: Tx,
  op: Extract<ChangeOp, { op: 'sections' }>,
  hwm: number,
  at: Date,
  origin: string | null,
): Promise<boolean> {
  // Live typing is the typist's when one person typed in the index window (CF-2, docs/adr/1625-*).
  const actorId = op.actor?.userId ?? op.typedBy ?? null
  const via = capVia(op.actor?.via)
  const changes = op.changes

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
    const rows = await tx
      .selectDistinctOn([pageChanges.anchor], {
        seq: pageChanges.seq,
        anchor: pageChanges.anchor,
        kind: pageChanges.kind,
        beforeText: pageChanges.beforeText,
        scope: pageChanges.scope,
        ownerId: pageChanges.ownerId,
        actorId: pageChanges.actorId,
        viaClient: pageChanges.viaClient,
        fresh: sql<boolean>`${pageChanges.changedAt} > ${at.toISOString()}::timestamptz - make_interval(secs => ${MERGE_WINDOW_MS / 1000})`,
      })
      .from(pageChanges)
      .where(and(eq(pageChanges.pageId, op.pageId), inArray(pageChanges.anchor, modified.map((c) => c.anchor))))
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
      prev.scope === op.scope &&
      prev.ownerId === op.ownerId &&
      prev.actorId === actorId &&
      prev.viaClient === via
    if (prev && mergeable) {
      const afterOk = !c.afterLarge
      if (prev.kind === 'modified' && prev.beforeText !== null && afterOk && prev.beforeText === c.after) {
        // Edited back to where this unseen row started: nothing left to report.
        await tx.delete(pageChanges).where(eq(pageChanges.seq, prev.seq))
        latest.delete(c.anchor)
        continue
      }
      const large = (prev.kind === 'modified' && prev.beforeText === null) || !afterOk
      // One statement: new seq (moves the row to the end of the log), newest after.
      await tx.execute(sql`
        UPDATE page_changes
           SET seq = nextval(pg_get_serial_sequence('page_changes', 'seq')),
               after_text = ${afterOk ? c.after : null}, large = ${large},
               heading_path = ${c.headingPath}, changed_at = ${at.toISOString()}::timestamptz
         WHERE seq = ${prev.seq}
      `)
      continue
    }
    inserts.push({
      workspaceId: op.workspaceId,
      pageId: op.pageId,
      anchor: c.anchor,
      prevAnchor: c.prevAnchor,
      headingPath: c.headingPath,
      kind: c.kind,
      beforeText: c.before,
      afterText: c.after,
      large: c.beforeLarge || c.afterLarge,
      scope: op.scope,
      ownerId: op.ownerId,
      actorId,
      viaClient: via,
      changedAt: at,
    })
  }
  if (inserts.length) await insertRows(tx, inserts)

  // Followers of the page and agent-written "@Name" (docs/adr/1001-*, 1002-*): queued in this
  // transaction, so they exist exactly when the log rows do.
  const sections = changes
    .filter((c) => c.kind !== 'moved')
    .map((c) => ({ anchor: c.anchor, before: c.mBefore ?? c.before, after: c.mAfter ?? c.after }))
  if (sections.length === 0) return false
  await notifyPageEdited({ pageId: op.pageId, workspaceId: op.workspaceId, actor: op.actor, sections, typing: op.typing }, tx, origin)
  return true
}

// ---------------------------------------------------------------------------
// cursor reservation (reader side)
// ---------------------------------------------------------------------------

/**
 * Take the current end of the log for a cursor. First materialises every committed outbox row
 * (bounded: RESERVE_DRAIN_PASSES × CHANGE_BATCH), then, under the writer lock, raises the
 * high-water mark to the end and returns it. `at` is the database clock after the lock: every row
 * materialised later carries a later changed_at.
 */
export async function reserveCursor(): Promise<{ seq: number; at: number }> {
  // Usually the background consumer was faster: one cheap probe instead of a consumer pass.
  const [due] = (await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM outbox WHERE topic = 'change' AND state = 'pending' AND available_at <= now()) AS d
  `)) as unknown as { d: boolean }[]
  if (due?.d) await drainOutbox('change', RESERVE_DRAIN_PASSES)
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHANGE_LOG_LOCK})`)
    // The end is max(seq), or the mark if newer rows were all purged meanwhile (a cursor handed
    // out earlier must never be "past the end").
    const rows = (await tx.execute(sql`
      INSERT INTO change_feed_state AS s (id, high_water)
      SELECT 1, coalesce(max(seq), 0) FROM page_changes
      ON CONFLICT (id) DO UPDATE SET high_water = greatest(s.high_water, EXCLUDED.high_water)
      RETURNING high_water::text AS m, (extract(epoch from clock_timestamp()) * 1000)::float8 AS t
    `)) as unknown as { m: string; t: number }[]
    return { seq: Number(rows[0].m), at: Math.floor(Number(rows[0].t)) }
  })
}

/** Test hook: the persisted high-water mark (null before first use). */
export async function changeLogHighWater(): Promise<number | null> {
  const rows = (await db.execute(sql`SELECT high_water::text AS h FROM change_feed_state WHERE id = 1`)) as unknown as { h: string }[]
  return rows[0] ? Number(rows[0].h) : null
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
