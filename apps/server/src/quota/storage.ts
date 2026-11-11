import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { closePageConnections, closeWorkspaceConnections, reconnectReadOnlyWorkspaceConnections } from '../liveConnections'
import { clearCollabRefusals, collabFullInMemory, noteCollabAuthorised, noteWorkspaceUsed, setCollabRecountHook } from './collabGrowth'
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

/**
 * Recount one workspace and store the cache (storage_bytes, storage_checked_at, over_storage).
 * A workspace that just went past its limit has its live editing connections closed: they come back
 * read-only (collab.ts). Returns the count.
 */
export async function recountWorkspaceStorage(workspaceId: string): Promise<StorageCount & { over: boolean }> {
  const limit = storageLimitBytes()
  const count = await countWorkspaceStorage(db, workspaceId)
  // full = the limit is reached (>=), the same boundary as assertWorkspaceRoom and the web's isStorageFull
  const over = limit != null && count.total >= limit
  const [prev] = (await db.execute(sql`
    WITH old AS (SELECT over_storage FROM workspaces WHERE id = ${workspaceId})
    UPDATE workspaces SET storage_bytes = ${count.total}, storage_checked_at = now(), over_storage = ${over}
     WHERE id = ${workspaceId}
    RETURNING (SELECT over_storage FROM old) AS was
  `)) as unknown as { was: boolean | null }[]
  noteWorkspaceUsed(workspaceId, count.total)
  if (over && prev && !prev.was) await closeWorkspaceConnections(workspaceId)
  // back under the limit (files or pages deleted, the trash emptied), or room found after live updates
  // were refused on a cached number (quota/collabGrowth.ts): the read-only connections reconnect and
  // are authorised again, so editing comes back without reopening the page
  else if (!over && (clearCollabRefusals(workspaceId) > 0 || prev?.was)) await reconnectReadOnlyWorkspaceConnections(workspaceId)
  return { ...count, over }
}

/** Recount when a limit is set (after a purge, an emptied trash); never throws. */
export function recountSoon(workspaceId: string): void {
  if (storageLimitBytes() == null) return
  void recountWorkspaceStorage(workspaceId).catch((err: unknown) => console.warn('[inkling] storage recount failed', workspaceId, err))
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

/**
 * Bytes of index rows (page_texts, page_chunks with their tsvector, tasks, links, tags) per byte a
 * stored body grows, reserved at store time until the recount sees the real rows (review N3). Measured
 * for 0.22.1 with 1 MB appends: 2.2 on prose-like text, 2.3 on the review's random words; the lower
 * whole number, so the estimate does not shut a workspace that has room (the recount 40 s later puts
 * the real number in either way, docs/adr/2545-*).
 */
export const INDEX_BYTES_PER_BODY_BYTE = 2

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
 * storeDocument, before the upsert): moves the workspace's cached use by the body's growth (and by the
 * auto version copy the store just took, `snapshotBytes`), flips the workspace read-only when that
 * passes the limit (closing its live connections, which come back read-only), and closes the page's
 * own connections when this one body passes the per-page cap. The store itself always goes through:
 * refusing it would only arm the retry timer and pin the document in memory (what does not fit is
 * refused before it is applied, quota/collabGrowth.ts). Returns the cached use after the move (null =
 * no limit or the update failed). No limit → nothing at all. Never throws.
 */
export async function noteBodyStore(pageId: string, bytes: number, snapshotBytes = 0): Promise<number | null> {
  const limit = storageLimitBytes()
  if (limit == null) return null
  try {
    // The search and section indexes of the new text are written 8–30 s later (docIndexer.ts, debounced):
    // their bytes are reserved now as an estimate, INDEX_BYTES_PER_BODY_BYTE per byte the body grew, and a
    // recount once the index pass has landed puts the real number in (review N3, docs/adr/2545-*).
    const [r] = (await db.execute(sql`
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
    if (!r) return null
    if (Number(r.growth) > 0) recountAfterIndex(r.workspaceId)
    const pageCap = pageBodyLimitBytes()
    if (pageCap != null && bytes > pageCap) closePageConnections([pageId])
    if (r.stale) {
      // after this store's upsert, so the recount sees the new body
      setImmediate(() => recountSoon(r.workspaceId))
    } else if (!r.over && Number(r.used) >= limit) {
      await db.execute(sql`UPDATE workspaces SET over_storage = true WHERE id = ${r.workspaceId}`)
      await closeWorkspaceConnections(r.workspaceId)
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
