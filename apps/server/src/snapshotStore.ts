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
export const snapshotStats = { whole: 0, diff: 0, fallback: 0, rebased: 0, broken: 0 }

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
): Promise<void> {
  const row = encodeRow(pageId, src, await chainHead(tx, pageId))
  await tx.execute(sql`
    INSERT INTO page_snapshots (page_id, state, label, created_by, via_client, state_format, base_id, depth, state_vector)
    VALUES (${pageId}, ${Buffer.from(row.state)}, ${label}, ${createdBy}, ${via}, ${row.format}, ${row.baseId}, ${row.depth}, ${Buffer.from(row.sv)})
  `)
  // A whole row heals a chain a read found broken.
  if (row.baseId === null) brokenPages.delete(pageId)
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
    SELECT id, base_id AS "baseId", depth FROM page_snapshots
     WHERE page_id = ${pageId}
     ORDER BY created_at DESC, id DESC
  `)) as unknown as { id: string; baseId: string | null; depth: number }[]
  if (rows.length <= MAX_SNAPSHOTS_PER_PAGE) return
  const keep = rows.slice(0, MAX_SNAPSHOTS_PER_PAGE).reverse() // oldest first
  const drop = rows.slice(MAX_SNAPSHOTS_PER_PAGE).map((r) => r.id)
  const dropped = new Set(drop)
  const base = new Map(keep.map((r) => [r.id, r.baseId]))
  for (const r of keep) {
    if (!r.baseId || !dropped.has(r.baseId)) continue
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
): Promise<void> {
  const source: SnapshotSource = src instanceof Uint8Array ? { state: src } : src
  await db.transaction(async (tx) => {
    await lockPage(tx, pageId)
    await insertSnapshot(tx, pageId, source, label, createdBy, via)
    await pruneSnapshots(pageId, tx)
  })
  noteSnapshot(pageId, Date.now())
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

/**
 * Whether the page already has an agent (via_client set) snapshot inside the auto-snapshot
 * throttle window — the "AI edit" marker after an MCP append is skipped then, so an agent
 * appending in a loop cannot churn the 50-snapshot cap (docs/adr/0936-*).
 */
export async function hasRecentAgentSnapshot(pageId: string): Promise<boolean> {
  const throttleSec = Math.floor(AUTO_SNAPSHOT_THROTTLE_MS / 1000)
  const rows = (await db.execute(sql`
    SELECT 1 AS hit FROM page_snapshots
     WHERE page_id = ${pageId}
       AND via_client IS NOT NULL
       AND created_at > now() - make_interval(secs => ${throttleSec})
     LIMIT 1
  `)) as unknown as { hit: number }[]
  return rows.length > 0
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
 */
export async function maybeAutoSnapshotStored(pageId: string): Promise<void> {
  try {
    const known = lastSnapshotAt.get(pageId)
    if (known !== undefined && Date.now() - known < AUTO_SNAPSHOT_THROTTLE_MS) return
    const throttleSec = Math.floor(AUTO_SNAPSHOT_THROTTLE_MS / 1000)
    const due = async (tx: Exec): Promise<boolean> => {
      const [r] = (await tx.execute(sql`
        SELECT max(created_at) AS at,
               (max(created_at) IS NULL OR max(created_at) < now() - make_interval(secs => ${throttleSec})) AS due
          FROM page_snapshots WHERE page_id = ${pageId}
      `)) as unknown as { at: Date | string | null; due: boolean }[]
      if (!r?.due && r?.at) noteSnapshot(pageId, new Date(r.at).getTime())
      return !!r?.due
    }
    if (!(await due(db))) return
    const inserted = await db.transaction(async (tx) => {
      await lockPage(tx, pageId)
      if (!(await due(tx))) return false
      const [doc] = (await tx.execute(sql`
        SELECT state, state_vector AS sv FROM page_docs WHERE page_id = ${pageId} AND octet_length(state) > 0
      `)) as unknown as { state: Uint8Array; sv: Uint8Array | null }[]
      if (!doc) return false
      await insertSnapshot(tx, pageId, { state: doc.state, stateVector: doc.sv }, null, null, null)
      await pruneSnapshots(pageId, tx)
      return true
    })
    if (inserted) noteSnapshot(pageId, Date.now())
  } catch (err) {
    console.error('[inkling] auto snapshot failed', pageId, err)
  }
}
