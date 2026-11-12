import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { reconnectPagesForStorage, reconnectReadOnlyWorkspaceConnections, reconnectWorkspaceForStorage } from '../liveConnections'
import { INDEX_BYTES_PER_BODY_BYTE, clearCollabRefusals, collabFullInMemory, noteCollabAuthorised, noteWorkspaceUsed, setCollabRecountHook } from './collabGrowth'
import { instanceFullNow, instanceStorageLimitBytes } from './instance'
import { fileStorageSql, pageBodyLimitBytes, storageLimitBytes, type QuotaExec } from './room'

/**
 * Storage use of a workspace (LIMIT_WORKSPACE_STORAGE_MB, docs/adr/2506-*).
 *
 * Counted: every column a member can grow without bound through the app or an agent —
 * upload files (`files.size`; with a limit at least 4 KB + 1 KB each, quota/room.ts fileStorageBytes,
 * review N2), page bodies (`page_docs` state and state vector),
 * version history (`page_snapshots` state, state vector, step), handwriting (`page_ink.strokes`),
 * comments, page rows themselves (title, row properties, page properties, aliases; trashed pages
 * included), collection schemas, views and row templates, custom templates, the change log's kept
 * texts (`page_changes`) and agent suggestions (`section_suggestions`).
 *
 * With a storage limit, the search and section indexes derived from those bodies too (page_texts,
 * page_chunks, page_chunk_vectors, page_tasks, page_links, page_tags, page_former_titles; review N3,
 * docs/adr/2545-*). Not counted (bounded elsewhere, listed in the ADRs): Postgres index entries and dead
 * rows (the instance fuse and the demo's filesystem), audit events, notifications, outbox and webhook
 * deliveries, per-user tables.
 *
 * `workspaces.storage_bytes` caches the sum: recounted by the hourly housekeeping, by the usage
 * route when it is older than a minute, after purges, and moved by cheap deltas on the write paths
 * (uploads reserve their bytes in assertWorkspaceRoom, collab stores add the body's growth).
 *
 * With a limit, what a recount cannot see yet stays in the cache (0.22.1, docs/adr/2548-*): a body store's
 * delta until its upsert is in, and its index estimate until an index pass numbered after the store has
 * written the rows. A recount writes `measured + those estimates`, so a recount that runs early (the
 * first store of a workspace, a refusal, the settings screen) no longer wipes them.
 */

export interface StorageCount {
  total: number
  fileBytes: number
}

/**
 * Search and section indexes a member grows by writing (0.22.1, review N3): rows derived from the
 * bodies, counted with a storage limit only (without one the count is that of 0.22.0). Their Postgres
 * index entries (GIN, trigram) and dead rows are not counted: the instance fuse and the demo's own
 * filesystem bound those (docs/adr/2545-*).
 */
const DERIVED_SQL = (workspaceId: string) => sql`
    + (SELECT coalesce(sum(pg_column_size(t.*)), 0) FROM page_texts t WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(pg_column_size(c.*)), 0) FROM page_chunks c WHERE workspace_id = ${workspaceId})
    + (SELECT coalesce(sum(pg_column_size(v.*)), 0) FROM page_chunk_vectors v WHERE workspace_id = ${workspaceId})
    + (SELECT coalesce(sum(pg_column_size(k.*)), 0) FROM page_tasks k WHERE workspace_id = ${workspaceId})
    + (SELECT coalesce(sum(pg_column_size(l.*)), 0) FROM page_links l WHERE source_page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(pg_column_size(g.*)), 0) FROM page_tags g WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(pg_column_size(f.*)), 0) FROM page_former_titles f WHERE workspace_id = ${workspaceId})
`

const RECOUNT_SQL = (workspaceId: string) => sql`
  WITH p AS (SELECT id FROM pages WHERE workspace_id = ${workspaceId})
  SELECT
    (SELECT coalesce(sum(${fileStorageSql(sql`size`)}), 0) FROM files WHERE workspace_id = ${workspaceId})::bigint AS files,
    (
      (SELECT coalesce(sum(octet_length(state) + coalesce(octet_length(state_vector), 0)), 0)
         FROM page_docs WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(octet_length(state) + coalesce(octet_length(state_vector), 0) + coalesce(pg_column_size(step), 0)), 0)
         FROM page_snapshots WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(pg_column_size(strokes)), 0) FROM page_ink WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(octet_length(body)), 0) FROM comments WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(octet_length(title) + pg_column_size(props) + pg_column_size(properties) + pg_column_size(aliases)
                           + coalesce(octet_length(icon), 0) + coalesce(octet_length(cover_url), 0)), 0)
         FROM pages WHERE workspace_id = ${workspaceId})
    + (SELECT coalesce(sum(pg_column_size(fields)), 0) FROM collections WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(pg_column_size(config) + octet_length(name)), 0) FROM collection_views WHERE page_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(pg_column_size(t.*)), 0) FROM collection_row_templates t WHERE collection_id IN (SELECT id FROM p))
    + (SELECT coalesce(sum(pg_column_size(content) + pg_column_size(default_props) + octet_length(name)
                           + coalesce(octet_length(description), 0)), 0)
         FROM templates WHERE workspace_id = ${workspaceId})
    + (SELECT coalesce(sum(coalesce(octet_length(before_text), 0) + coalesce(octet_length(after_text), 0)), 0)
         FROM page_changes WHERE workspace_id = ${workspaceId})
    + (SELECT coalesce(sum(octet_length(markdown)), 0) FROM section_suggestions WHERE workspace_id = ${workspaceId})
    ${storageLimitBytes() == null ? sql`` : DERIVED_SQL(workspaceId)}
    )::bigint AS other
`

/** Count a workspace's storage now (no cache). */
export async function countWorkspaceStorage(exec: QuotaExec, workspaceId: string): Promise<StorageCount> {
  const [r] = (await exec.execute(RECOUNT_SQL(workspaceId))) as unknown as { files: string | number; other: string | number }[]
  const fileBytes = Number(r?.files ?? 0)
  return { fileBytes, total: fileBytes + Number(r?.other ?? 0) }
}

// ---------------------------------------------------------------------------
// Store estimates a recount has not seen yet (0.22.1, docs/adr/2548-*)
// ---------------------------------------------------------------------------

interface StoreEstimate {
  /** The body's change (state + state vector) this store added to the cache. */
  body: number
  /** Its index rows, estimated (INDEX_BYTES_PER_BODY_BYTE per byte the body grew). */
  index: number
  /** indexPassSeq() once the store's upsert was in; null while it is in flight. */
  armedAt: number | null
  /** An index pass numbered after armedAt wrote its rows: a recount that starts now sees them. */
  indexed: boolean
  at: number
}

/** Workspace → page → the estimates of its stores that no recount has seen yet. */
const estimates = new Map<string, Map<string, StoreEstimate[]>>()
/** The workspace of each page in `estimates` (the store's upsert and the index pass name only the page). */
const estimatePage = new Map<string, string>()
/** Pages whose store found the cache stale: recounted once their upsert is in (noteBodyStoreWritten). */
const staleAfterStore = new Map<string, string>()
/** Estimates older than this are dropped by the next recount (an index pass that never ran). */
export const ESTIMATE_MAX_AGE_MS = 10 * 60 * 1000
/** At most this many estimates per page: older ones merge into the next (counted until the later is seen). */
const ESTIMATES_PER_PAGE = 8

/**
 * Body stores and recounts of one workspace take turns (in this process): a store's delta and its
 * estimate go in together, so a recount either sees both or neither. Only with a storage limit.
 */
const wsTurns = new Map<string, Promise<unknown>>()
function inTurn<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  const prev = wsTurns.get(workspaceId) ?? Promise.resolve()
  const job = prev.catch(() => {}).then(run)
  const tail = job.catch(() => {})
  wsTurns.set(workspaceId, tail)
  void tail.then(() => {
    if (wsTurns.get(workspaceId) === tail) wsTurns.delete(workspaceId)
  })
  return job
}

function addEstimate(workspaceId: string, pageId: string, body: number, index: number): void {
  let pagesOf = estimates.get(workspaceId)
  if (!pagesOf) estimates.set(workspaceId, (pagesOf = new Map()))
  let list = pagesOf.get(pageId)
  if (!list) pagesOf.set(pageId, (list = []))
  list.push({ body, index, armedAt: null, indexed: false, at: Date.now() })
  if (list.length > ESTIMATES_PER_PAGE) {
    const [a] = list.splice(0, 1)
    list[0].body += a.body
    list[0].index += a.index
  }
  estimatePage.set(pageId, workspaceId)
}

/** Bytes of the workspace's estimates no recount has seen (what the cache holds beyond the last count). */
export function unseenEstimateBytes(workspaceId: string): number {
  let n = 0
  for (const list of estimates.get(workspaceId)?.values() ?? []) for (const e of list) n += e.body + e.index
  return n
}

/**
 * The store's upsert of `pageId` is in (written) or failed: its estimates are armed with the index pass
 * number now, so a pass numbered after it (scheduled right after this call, collab.ts storeDocument) marks
 * the index rows as written. A failed store drops its estimate: the cache keeps the delta as an upper
 * bound until the next recount. A store that found the cache stale recounts now, after its upsert
 * (0.22.1: it used to recount beside the upsert and count the page without its new body).
 */
export function noteBodyStoreWritten(pageId: string, passSeq: number, written = true): void {
  if (!estimatePage.size && !staleAfterStore.size) return // no storage limit: nothing was noted
  const ws = estimatePage.get(pageId)
  const list = ws ? estimates.get(ws)?.get(pageId) : undefined
  if (ws && list) {
    if (written) for (const e of list) e.armedAt ??= passSeq
    else dropPage(ws, pageId, (e) => e.armedAt === null)
  }
  const stale = staleAfterStore.get(pageId)
  if (stale !== undefined) {
    staleAfterStore.delete(pageId)
    recountSoon(stale)
  }
}

/** An index pass numbered `seq` wrote the rows of `pageId` (docIndexer.ts onIndexPassDone). */
export function noteIndexPassDone(pageId: string, seq: number): void {
  if (!estimatePage.size) return
  const ws = estimatePage.get(pageId)
  let landed = false
  for (const e of (ws && estimates.get(ws)?.get(pageId)) || [])
    if (e.armedAt !== null && seq > e.armedAt && !e.indexed) landed = e.indexed = true
  // the rows are in: a recount now puts them in place of the estimate (instead of up to 40 s later), so a
  // count that ran while the pass was writing does not hold rows and estimate together for long
  if (ws && landed && !indexedRecount.has(ws)) {
    const t = setTimeout(() => {
      indexedRecount.delete(ws)
      recountSoon(ws)
    }, INDEXED_RECOUNT_MS)
    t.unref?.()
    indexedRecount.set(ws, t)
  }
}
/** Index passes that land together (several pages, one pass after another) share one recount. */
const INDEXED_RECOUNT_MS = 500
const indexedRecount = new Map<string, NodeJS.Timeout>()

function dropPage(workspaceId: string, pageId: string, drop: (e: StoreEstimate) => boolean): void {
  const pagesOf = estimates.get(workspaceId)
  const list = pagesOf?.get(pageId)
  if (!pagesOf || !list) return
  const keep = list.filter((e) => !drop(e))
  if (keep.length) pagesOf.set(pageId, keep)
  else {
    pagesOf.delete(pageId)
    estimatePage.delete(pageId)
    if (!pagesOf.size) estimates.delete(workspaceId)
  }
}

/** Before a count: what it will see. The body of an armed store (its upsert is in), the index of an indexed one. */
function seenNow(workspaceId: string): Map<StoreEstimate, { body: boolean; index: boolean }> {
  const seen = new Map<StoreEstimate, { body: boolean; index: boolean }>()
  const old = Date.now() - ESTIMATE_MAX_AGE_MS
  for (const list of estimates.get(workspaceId)?.values() ?? [])
    for (const e of list) {
      const expired = e.at < old
      seen.set(e, { body: expired || e.armedAt !== null, index: expired || e.indexed })
    }
  return seen
}

/** After a count: forget what it saw; returns the bytes of what it did not see. */
function settleSeen(workspaceId: string, seen: Map<StoreEstimate, { body: boolean; index: boolean }>): number {
  const pagesOf = estimates.get(workspaceId)
  if (!pagesOf) return 0
  for (const [page, list] of [...pagesOf]) {
    for (const e of list) {
      const s = seen.get(e)
      if (!s) continue
      if (s.body) e.body = 0
      if (s.index) e.index = 0
    }
    dropPage(workspaceId, page, (e) => e.body === 0 && e.index === 0)
  }
  return unseenEstimateBytes(workspaceId)
}

/** Test hook: forget every estimate. */
export function _resetStoreEstimates(): void {
  for (const t of indexedRecount.values()) clearTimeout(t)
  indexedRecount.clear()
  estimates.clear()
  estimatePage.clear()
  staleAfterStore.clear()
}

const recounts = new Set<Promise<unknown>>()
/** Test hook: resolves when no recount started by recountSoon is running. */
export async function storageRecountsSettled(): Promise<void> {
  while (recounts.size) await Promise.allSettled([...recounts])
}

/**
 * Recount one workspace and store the cache (storage_bytes, storage_checked_at, over_storage).
 * With a limit the cache is the count plus the store estimates the count could not see yet (above).
 * A workspace that just went past its limit has its live editing connections made read-only and
 * reconnected (liveConnections.ts reconnectWorkspaceForStorage). Returns the count; `total` is what the
 * cache holds now.
 */
export async function recountWorkspaceStorage(workspaceId: string): Promise<StorageCount & { over: boolean }> {
  const limit = storageLimitBytes()
  const run = async () => {
    const seen = limit == null ? null : seenNow(workspaceId)
    const count = await countWorkspaceStorage(db, workspaceId)
    const total = count.total + (seen ? settleSeen(workspaceId, seen) : 0)
    // full = the limit is reached (>=), the same boundary as assertWorkspaceRoom and the web's isStorageFull
    const over = limit != null && total >= limit
    const [prev] = (await db.execute(sql`
      WITH old AS (SELECT over_storage FROM workspaces WHERE id = ${workspaceId})
      UPDATE workspaces SET storage_bytes = ${total}, storage_checked_at = now(), over_storage = ${over}
       WHERE id = ${workspaceId}
      RETURNING (SELECT over_storage FROM old) AS was
    `)) as unknown as { was: boolean | null }[]
    return { count, total, over, prev }
  }
  const { count, total, over, prev } = limit == null ? await run() : await inTurn(workspaceId, run)
  noteWorkspaceUsed(workspaceId, total)
  if (over && prev && !prev.was) await reconnectWorkspaceForStorage(workspaceId)
  // back under the limit (files or pages deleted, the trash emptied), or room found after live updates
  // were refused on a cached number (quota/collabGrowth.ts): the read-only connections reconnect and
  // are authorised again, so editing comes back without reopening the page
  else if (!over && (clearCollabRefusals(workspaceId) > 0 || prev?.was)) await reconnectReadOnlyWorkspaceConnections(workspaceId)
  // estimates still waiting for their index pass: another recount once it has had time to land
  if (limit != null && estimates.has(workspaceId)) recountAfterIndex(workspaceId)
  return { ...count, total, over }
}

/** Recount when a limit is set (after a purge, an emptied trash); never throws. */
export function recountSoon(workspaceId: string): void {
  if (storageLimitBytes() == null) return
  const job = recountWorkspaceStorage(workspaceId).catch((err: unknown) => console.warn('[inkling] storage recount failed', workspaceId, err))
  recounts.add(job)
  void job.finally(() => recounts.delete(job))
}

// a live update refused for the workspace's use recounts it (the cache may hold upper bounds)
setCollabRecountHook(recountSoon)

/** Hourly housekeeping: recount every live workspace while a storage limit is set. */
export async function recountAllWorkspaces(): Promise<number> {
  if (storageLimitBytes() == null) return 0
  const ids = (await db.execute(sql`SELECT id FROM workspaces ORDER BY storage_checked_at NULLS FIRST`)) as unknown as { id: string }[]
  let n = 0
  for (const { id } of ids) {
    try {
      await recountWorkspaceStorage(id)
      n++
    } catch (err) {
      console.warn('[inkling] storage recount failed', id, err)
    }
  }
  return n
}

/** A full recount from the store path at most this often per workspace (the deltas fill the gaps). */
export const STORE_RECOUNT_MS = 10 * 60 * 1000

/** Index bytes estimated per byte a stored body grows: defined with the collab admission (quota/collabGrowth.ts). */
export { INDEX_BYTES_PER_BODY_BYTE }

/** The recount after a body grew waits this long: past the index pass's longest wait (30 s, docIndexer.ts). */
export const INDEX_SETTLE_MS = 40_000

const settling = new Map<string, NodeJS.Timeout>()

/**
 * One recount of the workspace INDEX_SETTLE_MS from now (none if one is pending already): replaces the
 * index estimates with the rows the index pass wrote. No storage limit → nothing.
 */
export function recountAfterIndex(workspaceId: string): void {
  if (storageLimitBytes() == null || settling.has(workspaceId)) return
  const t = setTimeout(() => {
    settling.delete(workspaceId)
    recountSoon(workspaceId)
  }, INDEX_SETTLE_MS)
  t.unref?.()
  settling.set(workspaceId, t)
}

/**
 * The collab store is about to write `bytes` (state + state vector) for a page (collab.ts
 * storeDocument, before the upsert): moves the workspace's cached use by the body's growth, its index
 * estimate and the auto version copy the store just took (`snapshotBytes`), keeps the body's change and
 * the estimate as an estimate a recount has not seen (docs/adr/2548-*; noteBodyStoreWritten arms it once the
 * upsert is in), flips the workspace read-only when the cache passes the limit (its editing connections
 * reconnect read-only, liveConnections.ts reconnectWorkspaceForStorage), and makes the page's own
 * connections read-only when this one body passes the per-page cap. The store itself always goes through:
 * refusing it would only arm the retry timer and pin the document in memory (what does not fit is refused
 * before it is applied, quota/collabGrowth.ts). Returns the cached use after the move (null = no limit or
 * the update failed). No limit → nothing at all. Never throws.
 */
export async function noteBodyStore(pageId: string, bytes: number, snapshotBytes = 0): Promise<number | null> {
  const limit = storageLimitBytes()
  if (limit == null) return null
  try {
    const [page] = (await db.execute(sql`SELECT workspace_id AS ws FROM pages WHERE id = ${pageId}`)) as unknown as { ws: string }[]
    if (!page) return null
    // The search and section indexes of the new text are written 8–30 s later (docIndexer.ts, debounced):
    // their bytes are reserved now as an estimate, INDEX_BYTES_PER_BODY_BYTE per byte the body grew, and
    // stay in the cache until a recount sees the rows (review N3, docs/adr/2545-*, 2548-*).
    const r = await inTurn(page.ws, async () => {
      const [row] = (await db.execute(sql`
        WITH old AS (
          SELECT coalesce((SELECT octet_length(d.state) + coalesce(octet_length(d.state_vector), 0) FROM page_docs d WHERE d.page_id = ${pageId}), 0) AS n
        )
        UPDATE workspaces w
           SET storage_bytes = greatest(0, w.storage_bytes + ${bytes} + ${snapshotBytes} - old.n
                                           + ${INDEX_BYTES_PER_BODY_BYTE} * greatest(0, ${bytes} - old.n))
          FROM pages p, old
         WHERE p.id = ${pageId} AND w.id = p.workspace_id
        RETURNING w.id AS "workspaceId", w.storage_bytes AS used, w.over_storage AS over,
                  (w.storage_checked_at IS NULL OR w.storage_checked_at < now() - make_interval(secs => ${STORE_RECOUNT_MS / 1000})) AS stale,
                  (${bytes} - old.n) AS growth
      `)) as unknown as { workspaceId: string; used: string | number; over: boolean; stale: boolean; growth: string | number }[]
      if (row) {
        const growth = Number(row.growth)
        addEstimate(row.workspaceId, pageId, growth, INDEX_BYTES_PER_BODY_BYTE * Math.max(0, growth))
      }
      return row
    })
    if (!r) return null
    if (Number(r.growth) > 0) recountAfterIndex(r.workspaceId)
    const pageCap = pageBodyLimitBytes()
    if (pageCap != null && bytes > pageCap) reconnectPagesForStorage([pageId])
    if (r.stale) {
      // once this store's upsert is in (noteBodyStoreWritten), so the recount sees the new body
      staleAfterStore.set(pageId, r.workspaceId)
    } else if (!r.over && Number(r.used) >= limit) {
      await db.execute(sql`UPDATE workspaces SET over_storage = true WHERE id = ${r.workspaceId}`)
      await reconnectWorkspaceForStorage(r.workspaceId)
    }
    return Number(r.used)
  } catch (err) {
    console.warn('[inkling] storage note failed', pageId, err)
    return null
  }
}

/**
 * A live editing connection to this page must be read-only for storage: the instance fuse has tripped
 * (LIMIT_INSTANCE_STORAGE_MB), the workspace is past its limit, the page's stored body is past the
 * per-page cap, or what is live in memory says so (an update to this page was refused lately, or the
 * unsaved growth fills the workspace: quota/collabGrowth.ts). Notes the database's numbers for the
 * live counters. Neither setting → false without a read.
 */
export async function collabStorageReadOnly(pageId: string, workspaceId: string): Promise<boolean> {
  if (instanceStorageLimitBytes() != null && instanceFullNow()) return true
  const limit = storageLimitBytes()
  if (limit == null) return false
  const pageCap = pageBodyLimitBytes()!
  const read = async () =>
    (
      (await db.execute(sql`
        SELECT w.over_storage AS over, w.storage_bytes AS used,
               coalesce(w.storage_checked_at > now() - interval '10 seconds', false) AS fresh,
               coalesce((SELECT octet_length(state) FROM page_docs WHERE page_id = ${pageId}), 0) AS body
          FROM workspaces w WHERE w.id = ${workspaceId}
      `)) as unknown as { over: boolean; used: string | number; fresh: boolean; body: number }[]
    )[0]
  let r = await read()
  if (!r) return false
  // The cache says full but was not recounted lately: it may hold upper bounds (quota/room.ts
  // assertWorkspaceGrowth), so count before closing editing for this connection.
  if (!r.over && Number(r.used) >= limit && !r.fresh) {
    await recountWorkspaceStorage(workspaceId)
    r = (await read()) ?? r
  }
  noteCollabAuthorised(pageId, workspaceId, Number(r.body), Number(r.used))
  return r.over || Number(r.used) >= limit || Number(r.body) > pageCap || collabFullInMemory(pageId, workspaceId)
}
