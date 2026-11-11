import { snapshotBudget } from './quota/versions'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from './db/index'
import { AppError } from './errors'
import { liveDoc } from './liveConnections'
import { docToBlocks } from './md/convert'
import type { AnyBlock } from './md/convert'
import {
  applyStoredState,
  STATE_V1,
  STATE_V2,
  stateVectorCovers,
  stateVectorOfStored,
  stateVectorsEqual,
  wholeStateFormat,
  type StateFormat,
} from './yState'

/** Max snapshots kept per page (oldest deleted first beyond it) */
export const MAX_SNAPSHOTS_PER_PAGE = 50
/**
 * AI step rows (the page right after one agent write, docs/adr/2180-*) kept per page and agent client
 * (`via_client`), and per page over all clients; the oldest step rows beyond either go first, so an
 * agent writing in a loop cannot push the people's versions out of the 50-row cap.
 */
export const MAX_AI_STEPS_PER_CLIENT = 20
export const MAX_AI_STEPS_PER_PAGE = 30
/** Automatic snapshot throttle: only store a new one when the last snapshot is older than this */
export const AUTO_SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// Incremental snapshots (docs/adr/1100-*)
//
//   A row holds either the whole document (`base_id` null) or the Yjs diff from its base row's
//   document (`base_id` = the previous snapshot of the page). Diffs are taken against the base's
//   state vector, so a diff holds the structs added since the base plus the delete set; applying
//   base chain + diff rebuilds the document exactly. A whole state is written at least every
//   SNAPSHOT_CHAIN_MAX rows, when the diff would be large (a full rewrite) and whenever anything
//   about the chain is doubtful (no state vector on the base, the new state does not contain the
//   base, the diff does not cover exactly base → new, the chain was found broken). Every row records
//   the state vector of the document it represents; reads verify the rebuilt document against it.
// ---------------------------------------------------------------------------

/** Longest diff chain: every SNAPSHOT_CHAIN_MAX-th row of a chain is a whole state. */
export const SNAPSHOT_CHAIN_MAX = 10
/** A diff bigger than this share of the chain's whole state is stored whole instead. */
export const SNAPSHOT_DIFF_MAX_RATIO = 0.5
/** Recursion bound of chain walks (a cycle or an over-long chain counts as broken). */
const CHAIN_WALK_LIMIT = 64

/** Test/bench counters: rows written whole / as diffs, diffs refused by a check, rows rebased on prune. */
export const snapshotStats = { whole: 0, diff: 0, fallback: 0, rebased: 0, squashed: 0, broken: 0 }

/** Pages whose chain a read found broken: their next snapshot is written whole (bounded, LRU). */
const brokenPages = new Map<string, true>()
function noteBroken(pageId: string): void {
  snapshotStats.broken++
  brokenPages.delete(pageId)
  brokenPages.set(pageId, true)
  if (brokenPages.size > 1_000) {
    const oldest = brokenPages.keys().next().value
    if (oldest !== undefined) brokenPages.delete(oldest)
  }
}

/** What a snapshot is taken of: an in-memory document, or a stored whole state (V1 or V2). */
export type SnapshotSource = Y.Doc | { state: Uint8Array; stateVector?: Uint8Array | null }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Exec = Pick<Tx, 'execute'>

interface ChainHead {
  id: string
  depth: number
  sv: Uint8Array | null
  /** Every ancestor is present and the walk ends at a whole state. */
  rooted: boolean
  /** Byte size of the chain's whole state (the diff-size rule compares against it). */
  rootBytes: number
}

interface EncodedRow {
  state: Uint8Array
  format: StateFormat
  baseId: string | null
  depth: number
  sv: Uint8Array
}

function lockPage(tx: Exec, pageId: string) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'page-snapshots:' + pageId}))`)
}

async function chainHead(tx: Exec, pageId: string): Promise<ChainHead | null> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE latest AS (
      SELECT id, base_id, depth, state_vector FROM page_snapshots
       WHERE page_id = ${pageId}
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    ), chain AS (
      SELECT id, base_id, octet_length(state) AS bytes, 0 AS n
        FROM page_snapshots WHERE id = (SELECT id FROM latest)
      UNION ALL
      SELECT s.id, s.base_id, octet_length(s.state), c.n + 1
        FROM page_snapshots s JOIN chain c ON s.id = c.base_id
       WHERE s.page_id = ${pageId} AND c.n < ${CHAIN_WALK_LIMIT}
    )
    SELECT l.id, l.depth, l.state_vector AS sv,
           coalesce((SELECT bool_or(base_id IS NULL) FROM chain), false) AS rooted,
           coalesce((SELECT bytes FROM chain WHERE base_id IS NULL LIMIT 1), 0)::int AS "rootBytes"
      FROM latest l
  `)) as unknown as { id: string; depth: number; sv: Uint8Array | null; rooted: boolean; rootBytes: number }[]
  const r = rows[0]
  return r ? { id: r.id, depth: Number(r.depth), sv: r.sv, rooted: !!r.rooted, rootBytes: Number(r.rootBytes) } : null
}

/**
 * The diff covers exactly base → target: for every client, structs from the base's clock up to the
 * target's clock and nothing else. Cheap (parses the diff only).
 */
function diffMatches(diffV2: Uint8Array, base: Map<number, number>, target: Map<number, number>): boolean {
  const { from, to } = Y.parseUpdateMetaV2(diffV2)
  for (const c of to.keys()) if (!target.has(c)) return false
  for (const [client, end] of target) {
    const start = base.get(client) ?? 0
    if (end > start) {
      if (from.get(client) !== start || to.get(client) !== end) return false
    } else if (to.has(client)) return false
  }
  return true
}

/** Encodes `src` as a whole row or as a diff from `head` (see the module comment for the rules). */
function encodeRow(pageId: string, src: SnapshotSource, head: ChainHead | null): EncodedRow {
  const isDoc = src instanceof Y.Doc
  const sv = isDoc ? Y.encodeStateVector(src) : src.stateVector ?? stateVectorOfStored(src.state)
  const whole = (): EncodedRow => {
    snapshotStats.whole++
    if (isDoc) return { state: Y.encodeStateAsUpdateV2(src), format: STATE_V2, baseId: null, depth: 0, sv }
    // A stored state is kept in its own format: converting a legacy V1 state costs a full parse
    // (≈ 110 ms on a 4.5 MB page) and the row stops mattering once the window moves past it.
    return { state: src.state, format: wholeStateFormat(src.state), baseId: null, depth: 0, sv }
  }
  if (!head || !head.sv || !head.rooted || head.depth + 1 >= SNAPSHOT_CHAIN_MAX || brokenPages.has(pageId)) return whole()
  // A document holding pending structs (an update whose dependency never arrived) encodes them, so
  // its diff would not match its state vector: store it whole without the failed-check noise.
  if (isDoc && (src.store.pendingStructs || src.store.pendingDs)) return whole()
  const target = Y.decodeStateVector(sv)
  const base = Y.decodeStateVector(head.sv)
  // The new state must contain the base (true for every write path today: page_docs only grows).
  if (!stateVectorCovers(target, base)) {
    snapshotStats.fallback++
    return whole()
  }
  let diff: Uint8Array
  if (isDoc) diff = Y.encodeStateAsUpdateV2(src, head.sv)
  else if (wholeStateFormat(src.state) === STATE_V2) diff = Y.diffUpdateV2(src.state, head.sv)
  else diff = Y.convertUpdateFormatV1ToV2(Y.diffUpdate(src.state, head.sv))
  const limit = SNAPSHOT_DIFF_MAX_RATIO * Math.max(head.rootBytes, isDoc ? 0 : src.state.length)
  if (diff.length > limit) return whole()
  if (!diffMatches(diff, base, target)) {
    snapshotStats.fallback++
    console.error('[inkling] snapshot diff check failed; storing the whole state', pageId)
    return whole()
  }
  snapshotStats.diff++
  return { state: diff, format: STATE_V2, baseId: head.id, depth: head.depth + 1, sv }
}

async function insertSnapshot(
  tx: Exec,
  pageId: string,
  src: SnapshotSource,
  label: string | null,
  createdBy: string | null,
  via: string | null,
  extra: { digest?: string; step?: StepMeta | null } = {},
): Promise<string> {
  const row = encodeRow(pageId, src, await chainHead(tx, pageId))
  const digest = extra.digest ?? stateDigest(src)
  const step = extra.step ? JSON.stringify(extra.step) : null
  const [ins] = (await tx.execute(sql`
    INSERT INTO page_snapshots (page_id, state, label, created_by, via_client, state_format, base_id, depth, state_vector, digest, step)
    VALUES (${pageId}, ${Buffer.from(row.state)}, ${label}, ${createdBy}, ${via}, ${row.format}, ${row.baseId}, ${row.depth}, ${Buffer.from(row.sv)}, ${digest}, ${step}::jsonb)
    RETURNING id
  `)) as unknown as { id: string }[]
  // A whole row heals a chain a read found broken.
  if (row.baseId === null) brokenPages.delete(pageId)
  return ins.id
}

// ---------------------------------------------------------------------------
// Content digest (docs/adr/2180-*)
// ---------------------------------------------------------------------------

/**
 * Digest of a document: sha256 of its state vector and its delete set (an update with no structs).
 * Two documents of one page with the same digest have the same content; a delete-only edit leaves the
 * state vector alone but changes the delete set. The bytes are the same whether they come from a live
 * document or a stored V1/V2 state (Yjs writes both sorted), so a digest taken from the live document
 * matches one taken later from page_docs. ≈ 0.5 ms from a live document, ≈ 16 ms from a stored 4.7 MB
 * state (one lazy pass over the update, no document built).
 */
export function stateDigest(src: SnapshotSource): string {
  let sv: Uint8Array
  let ds: Uint8Array
  if (src instanceof Y.Doc) {
    sv = Y.encodeStateVector(src)
    ds = Y.encodeStateAsUpdateV2(src, sv)
  } else {
    sv = Y.encodeStateVector(Y.decodeStateVector(src.stateVector ?? stateVectorOfStored(src.state)))
    ds = wholeStateFormat(src.state) === STATE_V2 ? Y.diffUpdateV2(src.state, sv) : Y.convertUpdateFormatV1ToV2(Y.diffUpdate(src.state, sv))
  }
  return createHash('sha256').update(sv).update(ds).digest('hex').slice(0, 32)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A snapshot whose chain cannot be rebuilt (a base row is missing or its bytes do not add up). */
export class SnapshotChainError extends AppError {
  constructor(message = 'This version can no longer be read') {
    super(409, 'SNAPSHOT_UNAVAILABLE', message)
  }
}

/**
 * The document of snapshot `sid` of `pageId`: its chain applied from the whole state up, verified
 * against the row's state vector. null = no such snapshot; throws SnapshotChainError when broken.
 */
export async function snapshotDoc(pageId: string, sid: string, tx: Exec = db): Promise<Y.Doc | null> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, base_id, state, state_format, state_vector, 0 AS n
        FROM page_snapshots WHERE id = ${sid} AND page_id = ${pageId}
      UNION ALL
      SELECT s.id, s.base_id, s.state, s.state_format, s.state_vector, c.n + 1
        FROM page_snapshots s JOIN chain c ON s.id = c.base_id
       WHERE s.page_id = ${pageId} AND c.n < ${CHAIN_WALK_LIMIT}
    )
    SELECT id, base_id AS "baseId", state, state_format AS format, state_vector AS sv, n FROM chain ORDER BY n DESC
  `)) as unknown as { id: string; baseId: string | null; state: Uint8Array; format: number; sv: Uint8Array | null; n: number }[]
  if (rows.length === 0) return null
  const target = rows[rows.length - 1]
  const broken = (why: string): never => {
    noteBroken(pageId)
    console.error(`[inkling] snapshot ${sid} of ${pageId} cannot be rebuilt: ${why}`)
    throw new SnapshotChainError()
  }
  if (rows[0].baseId !== null) broken('a base row is missing')
  const doc = new Y.Doc()
  try {
    for (const r of rows) applyStoredState(doc, r.state, Number(r.format) === STATE_V2 ? STATE_V2 : STATE_V1)
  } catch (err) {
    doc.destroy()
    broken(`decode failed (${(err as Error).message})`)
  }
  // Pending structs are not checked here: a live document can carry them for good (an update whose
  // dependency never arrived) and its encodings include them, so a whole row may legitimately
  // rebuild with pending structs. A missing link shows in the state vector instead (pending
  // structs do not count towards it).
  if (target.sv && !stateVectorsEqual(Y.encodeStateVector(doc), target.sv)) {
    doc.destroy()
    broken('the rebuilt document does not match the recorded state vector')
  }
  return doc
}

/** Blocks of a snapshot (null = no such snapshot). */
export async function snapshotBlocks(pageId: string, sid: string): Promise<AnyBlock[] | null> {
  const doc = await snapshotDoc(pageId, sid)
  // Left to the GC after the read, like stateToBlocks.
  return doc ? docToBlocks(doc) : null
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Rows to delete, newest first in `rows`: AI step rows beyond MAX_AI_STEPS_PER_CLIENT per client or
 * MAX_AI_STEPS_PER_PAGE per page (oldest first), then whatever is left beyond MAX_SNAPSHOTS_PER_PAGE.
 */
export function pruneSet(rows: { id: string; via: string | null; isStep: boolean }[]): string[] {
  const { total: maxKept, perClient: maxPerClient, perPage: maxPerPage } = snapshotBudget()
  const drop: string[] = []
  const perClient = new Map<string, number>()
  let steps = 0
  let kept = 0
  for (const r of rows) {
    if (r.isStep) {
      const n = (perClient.get(r.via ?? '') ?? 0) + 1
      perClient.set(r.via ?? '', n)
      steps++
      if (n > maxPerClient || steps > maxPerPage) {
        drop.push(r.id)
        continue
      }
    }
    kept++
    if (kept > maxKept) drop.push(r.id)
  }
  return drop
}

/**
 * Squash for a kept row whose base is being dropped (docs/adr/2180-*): when the dropped rows between it
 * and the nearest kept row of its chain are all V2 diffs, the row becomes the diff from that kept row —
 * `mergeUpdatesV2` of the dropped diffs and its own (deletes only grow, so the merge is exactly kept →
 * row). Checked like any new diff (`diffMatches` against both state vectors). Returns the new base id,
 * or null when the chain reaches a dropped whole row, a V1 or vector-less row, or the check fails —
 * then the row is rebuilt and stored whole as before. Cost: merging a few small diffs instead of
 * rebuilding and encoding the whole document (≈ 55–88 ms on a 4.5 MB page, ADR 1100), and no new
 * whole row when an old AI step in the middle of a chain is dropped.
 */
async function squashOntoKept(tx: Exec, pageId: string, rowId: string, dropped: Set<string>): Promise<string | null> {
  const chain = (await tx.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, base_id, state_format, state_vector, 0 AS n
        FROM page_snapshots WHERE id = ${rowId} AND page_id = ${pageId}
      UNION ALL
      SELECT s.id, s.base_id, s.state_format, s.state_vector, c.n + 1
        FROM page_snapshots s JOIN chain c ON s.id = c.base_id
       WHERE s.page_id = ${pageId} AND c.n < ${CHAIN_WALK_LIMIT}
    )
    SELECT id, base_id AS "baseId", state_format AS format, state_vector AS sv FROM chain ORDER BY n
  `)) as unknown as { id: string; baseId: string | null; format: number; sv: Uint8Array | null }[]
  // chain[0] = the row, then its ancestors; the diffs to merge are the row's and its dropped ancestors'
  const target = chain[0]
  if (!target?.sv) return null
  const parts: string[] = []
  let kept: (typeof chain)[number] | null = null
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i]
    if (i > 0 && !dropped.has(r.id)) {
      kept = r
      break
    }
    if (r.baseId === null || Number(r.format) !== STATE_V2) return null
    parts.push(r.id)
  }
  if (!kept?.sv || parts.length < 2) return null
  const rows = (await tx.execute(sql`
    SELECT id, state FROM page_snapshots WHERE page_id = ${pageId} AND id IN (${sql.join(parts.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { id: string; state: Uint8Array }[]
  const byId = new Map(rows.map((r) => [r.id, r.state]))
  if (parts.some((id) => !byId.has(id))) return null
  // oldest first: the kept row's child … the row itself
  const merged = Y.mergeUpdatesV2(parts.reverse().map((id) => byId.get(id)!))
  if (!diffMatches(merged, Y.decodeStateVector(kept.sv), Y.decodeStateVector(target.sv))) return null
  await tx.execute(sql`
    UPDATE page_snapshots SET state = ${Buffer.from(merged)}, state_format = ${STATE_V2}, base_id = ${kept.id} WHERE id = ${target.id}
  `)
  return kept.id
}

/**
 * Keep only the newest MAX_SNAPSHOTS_PER_PAGE snapshots per page and delete older ones. A kept row
 * whose base is being deleted is rebased first: its document is rebuilt from the chain (still
 * complete at that point) and stored whole; the depths of rows built on it are recomputed.
 */
export async function pruneSnapshots(pageId: string, tx?: Exec): Promise<void> {
  if (!tx) {
    await db.transaction(async (t) => {
      await lockPage(t, pageId)
      await pruneSnapshots(pageId, t)
    })
    return
  }
  const rows = (await tx.execute(sql`
    SELECT id, base_id AS "baseId", depth, via_client AS via, (step IS NOT NULL) AS "isStep" FROM page_snapshots
     WHERE page_id = ${pageId}
     ORDER BY created_at DESC, id DESC
  `)) as unknown as { id: string; baseId: string | null; depth: number; via: string | null; isStep: boolean }[]
  const drop = pruneSet(rows)
  if (drop.length === 0) return
  const dropped = new Set(drop)
  const keep = rows.filter((r) => !dropped.has(r.id)).reverse() // oldest first
  const base = new Map(keep.map((r) => [r.id, r.baseId]))
  for (const r of keep) {
    if (!r.baseId || !dropped.has(r.baseId)) continue
    // A row whose dropped ancestors are diffs from a kept row: its diff absorbs theirs (docs/adr/2180-*).
    const kept = await squashOntoKept(tx, pageId, r.id, dropped)
    if (kept) {
      base.set(r.id, kept)
      snapshotStats.squashed++
      continue
    }
    try {
      const doc = await snapshotDoc(pageId, r.id, tx)
      if (!doc) continue
      const state = Y.encodeStateAsUpdateV2(doc)
      await tx.execute(sql`
        UPDATE page_snapshots
           SET state = ${Buffer.from(state)}, state_format = ${STATE_V2}, base_id = NULL, depth = 0,
               state_vector = ${Buffer.from(Y.encodeStateVector(doc))}
         WHERE id = ${r.id}
      `)
      base.set(r.id, null)
      snapshotStats.rebased++
    } catch (err) {
      // Unreadable already; it stays unreadable (reads answer SNAPSHOT_UNAVAILABLE) and drops off later.
      if (!(err instanceof SnapshotChainError)) throw err
    }
  }
  // Depth = distance to the whole state; only rows whose chain got shorter change.
  const depth = new Map<string, number>()
  for (const r of keep) {
    const b = base.get(r.id) ?? null
    const d = b === null ? 0 : depth.has(b) ? depth.get(b)! + 1 : Number(r.depth)
    depth.set(r.id, d)
    if (d !== Number(r.depth)) await tx.execute(sql`UPDATE page_snapshots SET depth = ${d} WHERE id = ${r.id}`)
  }
  await tx.execute(sql`DELETE FROM page_snapshots WHERE page_id = ${pageId} AND id IN (${sql.join(
    drop.map((id) => sql`${id}`),
    sql`, `,
  )})`)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Store one snapshot and prune the excess.
 * Used for explicit stores such as manual snapshots and pre-restore snapshots.
 * `via` = the OAuth client name when an agent (MCP) edit caused the snapshot (docs/adr/0936-*).
 * `src` is the live document (cheapest: the diff is encoded from it directly) or a stored state.
 */
export async function createSnapshot(
  pageId: string,
  src: SnapshotSource | Uint8Array,
  label: string | null,
  createdBy: string | null,
  via: string | null = null,
): Promise<string> {
  const source: SnapshotSource = src instanceof Uint8Array ? { state: src } : src
  const id = await db.transaction(async (tx) => {
    await lockPage(tx, pageId)
    const id = await insertSnapshot(tx, pageId, source, label, createdBy, via)
    await pruneSnapshots(pageId, tx)
    return id
  })
  noteSnapshot(pageId, Date.now())
  return id
}

// ---------------------------------------------------------------------------
// AI steps (docs/adr/2180-*, 2181-*)
//
//   Every agent write leaves the page right after it as one "AI edit" row with `step` (what that write
//   changed: tool, sections, lines), so a person or the agent can go back to any step. Right before
//   the write, the page is compared (digest) with the newest row: equal (nothing happened since the
//   agent's previous step) → nothing is stored; different (first agent write, or someone edited in
//   between) → a "Before AI edit" row of the current page is stored first, so the people's edits in
//   between stay a version of their own. A write that changes nothing (same digest after) leaves no
//   step row.
// ---------------------------------------------------------------------------

/** What one agent write changed (page_snapshots.step). Lines are Markdown lines of the edited sections. */
export interface StepMeta {
  tool: string
  mode?: string
  /** Section anchors written (at most 3; `more` counts the rest). Empty or absent = the whole body. */
  sections?: string[]
  more?: number
  added?: number
  removed?: number
  /** restore_version: the version brought back. */
  restoredFrom?: string
}

async function newestRow(tx: Exec, pageId: string): Promise<{ id: string; digest: string | null } | null> {
  const [r] = (await tx.execute(sql`
    SELECT id, digest FROM page_snapshots WHERE page_id = ${pageId} ORDER BY created_at DESC, id DESC LIMIT 1
  `)) as unknown as { id: string; digest: string | null }[]
  return r ?? null
}

/**
 * Before an agent write: the id of a version equal to the page right now — the newest row when its
 * digest matches (the agent's previous step, nobody edited since), else a new row labelled `label`
 * ("Before AI edit", "Before restore"). null when the page has no body yet.
 */
export async function agentStepStart(pageId: string, user: { id: string; via?: string | null }, label: string): Promise<string | null> {
  const src = await currentSnapshotSource(pageId)
  if (!src) return null
  const digest = stateDigest(src)
  return db.transaction(async (tx) => {
    await lockPage(tx, pageId)
    const newest = await newestRow(tx, pageId)
    if (newest && newest.digest === digest) return newest.id
    const id = await insertSnapshot(tx, pageId, src, label, user.id, user.via ?? null, { digest })
    await pruneSnapshots(pageId, tx)
    return id
  })
}

/**
 * After an agent write: the page as one AI step row (label "AI edit", `step` = what changed). Nothing
 * is stored when the page equals the newest row (the write changed nothing). Returns the row id.
 */
export async function agentStepEnd(pageId: string, user: { id: string; via?: string | null }, label: string, step: StepMeta): Promise<string | null> {
  const src = await currentSnapshotSource(pageId)
  if (!src) return null
  const digest = stateDigest(src)
  return db.transaction(async (tx) => {
    await lockPage(tx, pageId)
    const newest = await newestRow(tx, pageId)
    if (newest && newest.digest === digest) return null
    const id = await insertSnapshot(tx, pageId, src, label, user.id, user.via ?? null, { digest, step })
    await pruneSnapshots(pageId, tx)
    return id
  })
}

/**
 * What "the current version" of a page is for a snapshot: the in-memory document when it is open
 * (page_docs trails it by the store debounce, ADR 0757), else the stored state. null = no body.
 */
export async function currentSnapshotSource(pageId: string): Promise<SnapshotSource | null> {
  const live = liveDoc(pageId)
  if (live) return live
  const [row] = (await db.execute(sql`
    SELECT state, state_vector AS sv FROM page_docs WHERE page_id = ${pageId}
  `)) as unknown as { state: Uint8Array; sv: Uint8Array | null }[]
  return row ? { state: row.state, stateVector: row.sv } : null
}

// ---------------------------------------------------------------------------
// Auto-snapshot throttle cache (docs/adr/0750-*)
//   pageId -> epoch ms of the newest snapshot we know of. Only used to *skip* the DB check while
//   the throttle window is certainly still open; a miss or an old entry always asks the DB.
//   Bounded (insertion-order LRU); a stale entry can only delay one auto snapshot by < 10 min.
// ---------------------------------------------------------------------------
const MAX_THROTTLE_ENTRIES = 5_000
const lastSnapshotAt = new Map<string, number>()

function noteSnapshot(pageId: string, at: number): void {
  lastSnapshotAt.delete(pageId)
  lastSnapshotAt.set(pageId, at)
  if (lastSnapshotAt.size > MAX_THROTTLE_ENTRIES) {
    const oldest = lastSnapshotAt.keys().next().value
    if (oldest !== undefined) lastSnapshotAt.delete(oldest)
  }
}

/** Forget throttle state (page deleted / snapshots purged). */
export function forgetSnapshotThrottle(pageId: string): void {
  lastSnapshotAt.delete(pageId)
}

/**
 * Auto snapshot of the *currently stored* page_docs.state (the version before the store that is
 * about to overwrite it). The throttle is decided in Postgres without reading the state; only a
 * snapshot that is due ships the stored state to Node, where it becomes a diff from the previous
 * snapshot (docs/adr/1100-*). Must run before the store hook overwrites page_docs. Never throws.
 * Returns the bytes of the state it copied (0 when none), an upper bound of what the version adds
 * (it may be kept as a diff): the storage limit's cache moves by it (quota/storage.ts noteBodyStore).
 */
export async function maybeAutoSnapshotStored(pageId: string): Promise<number> {
  try {
    const known = lastSnapshotAt.get(pageId)
    if (known !== undefined && Date.now() - known < AUTO_SNAPSHOT_THROTTLE_MS) return 0
    const throttleSec = Math.floor(AUTO_SNAPSHOT_THROTTLE_MS / 1000)
    const due = async (tx: Exec): Promise<boolean> => {
      const [r] = (await tx.execute(sql`
        SELECT max(created_at) AS at,
               (max(created_at) IS NULL OR max(created_at) < now() - make_interval(secs => ${throttleSec})) AS due
          FROM page_snapshots WHERE page_id = ${pageId} AND step IS NULL
      `)) as unknown as { at: Date | string | null; due: boolean }[]
      if (!r?.due && r?.at) noteSnapshot(pageId, new Date(r.at).getTime())
      return !!r?.due
    }
    if (!(await due(db))) return 0
    let added = 0
    const inserted = await db.transaction(async (tx) => {
      await lockPage(tx, pageId)
      if (!(await due(tx))) return false
      const [doc] = (await tx.execute(sql`
        SELECT state, state_vector AS sv FROM page_docs WHERE page_id = ${pageId} AND octet_length(state) > 0
      `)) as unknown as { state: Uint8Array; sv: Uint8Array | null }[]
      if (!doc) return false
      const src = { state: doc.state, stateVector: doc.sv }
      const digest = stateDigest(src)
      // The stored page is already the newest version (an agent's step row, docs/adr/2180-*): nothing
      // new to keep. Noted like a snapshot so the next stores within the window do not look again.
      if ((await newestRow(tx, pageId))?.digest === digest) return true
      await insertSnapshot(tx, pageId, src, null, null, null, { digest })
      await pruneSnapshots(pageId, tx)
      added = doc.state.length + (doc.sv?.length ?? 0)
      return true
    })
    if (inserted) noteSnapshot(pageId, Date.now())
    return added
  } catch (err) {
    console.error('[inkling] auto snapshot failed', pageId, err)
    return 0
  }
}

/**
 * The next store of this page may take an auto snapshot (the 10-minute throttle is not known to be
 * closed). Read from memory only: the collab storage check (quota/collabGrowth.ts) reserves the stored
 * body for that copy while it is possible.
 */
export function autoSnapshotMayBeDue(pageId: string): boolean {
  const known = lastSnapshotAt.get(pageId)
  return known === undefined || Date.now() - known >= AUTO_SNAPSHOT_THROTTLE_MS
}
