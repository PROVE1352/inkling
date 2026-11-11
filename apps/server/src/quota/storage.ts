import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { closePageConnections, closeWorkspaceConnections, reconnectReadOnlyWorkspaceConnections } from '../liveConnections'
import { pageBodyLimitBytes, storageLimitBytes, type QuotaExec } from './room'

/**
 * Storage use of a workspace (LIMIT_WORKSPACE_STORAGE_MB, docs/adr/2506-*).
 *
 * Counted: every column a member can grow without bound through the app or an agent —
 * upload files (`files.size`, the blobs on disk), page bodies (`page_docs` state and state vector),
 * version history (`page_snapshots` state, state vector, step), handwriting (`page_ink.strokes`),
 * comments, page rows themselves (title, row properties, page properties, aliases; trashed pages
 * included), collection schemas, views and row templates, custom templates, the change log's kept
 * texts (`page_changes`) and agent suggestions (`section_suggestions`).
 *
 * Not counted (derived from the above or bounded elsewhere, listed in the ADR): search and section
 * indexes, audit events, notifications, outbox and webhook deliveries, per-user tables.
 *
 * `workspaces.storage_bytes` caches the sum: recounted by the hourly housekeeping, by the usage
 * route when it is older than a minute, after purges, and moved by cheap deltas on the write paths
 * (uploads reserve their bytes in assertWorkspaceRoom, collab stores add the body's growth).
 */

export interface StorageCount {
  total: number
  fileBytes: number
}

const RECOUNT_SQL = (workspaceId: string) => sql`
  WITH p AS (SELECT id FROM pages WHERE workspace_id = ${workspaceId})
  SELECT
    (SELECT coalesce(sum(size), 0) FROM files WHERE workspace_id = ${workspaceId})::bigint AS files,
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
  if (over && prev && !prev.was) await closeWorkspaceConnections(workspaceId)
  // back under the limit (files or pages deleted, the trash emptied): the read-only connections
  // reconnect and are authorised again, so editing comes back without reopening the page
  else if (!over && prev?.was) await reconnectReadOnlyWorkspaceConnections(workspaceId)
  return { ...count, over }
}

/** Recount when a limit is set (after a purge, an emptied trash); never throws. */
export function recountSoon(workspaceId: string): void {
  if (storageLimitBytes() == null) return
  void recountWorkspaceStorage(workspaceId).catch((err: unknown) => console.warn('[inkling] storage recount failed', workspaceId, err))
}

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
 * The collab store is about to write `bytes` (state + state vector) for a page (collab.ts
 * storeDocument, before the upsert): moves the workspace's cached use by the body's growth, flips the
 * workspace read-only when that passes the limit (closing its live connections, which come back
 * read-only), and closes the page's own connections when this one body passes the per-page cap.
 * The store itself always goes through: refusing it would only arm the retry timer and pin the
 * document in memory. No limit → nothing at all. Never throws.
 */
export async function noteBodyStore(pageId: string, bytes: number): Promise<void> {
  const limit = storageLimitBytes()
  if (limit == null) return
  try {
    const [r] = (await db.execute(sql`
      UPDATE workspaces w
         SET storage_bytes = greatest(0, w.storage_bytes + ${bytes} - coalesce(
               (SELECT octet_length(d.state) + coalesce(octet_length(d.state_vector), 0) FROM page_docs d WHERE d.page_id = ${pageId}), 0))
        FROM pages p
       WHERE p.id = ${pageId} AND w.id = p.workspace_id
      RETURNING w.id AS "workspaceId", w.storage_bytes AS used, w.over_storage AS over,
                (w.storage_checked_at IS NULL OR w.storage_checked_at < now() - make_interval(secs => ${STORE_RECOUNT_MS / 1000})) AS stale
    `)) as unknown as { workspaceId: string; used: string | number; over: boolean; stale: boolean }[]
    if (!r) return
    const pageCap = pageBodyLimitBytes()
    if (pageCap != null && bytes > pageCap) closePageConnections([pageId])
    if (r.stale) {
      // after this store's upsert, so the recount sees the new body
      setImmediate(() => recountSoon(r.workspaceId))
    } else if (!r.over && Number(r.used) >= limit) {
      await db.execute(sql`UPDATE workspaces SET over_storage = true WHERE id = ${r.workspaceId}`)
      await closeWorkspaceConnections(r.workspaceId)
    }
  } catch (err) {
    console.warn('[inkling] storage note failed', pageId, err)
  }
}

/**
 * A live editing connection to this page must be read-only for storage: the workspace is past its
 * limit, or the page's stored body is past the per-page cap. No limit → false without a read.
 */
export async function collabStorageReadOnly(pageId: string, workspaceId: string): Promise<boolean> {
  const limit = storageLimitBytes()
  if (limit == null) return false
  const pageCap = pageBodyLimitBytes()!
  const [r] = (await db.execute(sql`
    SELECT w.over_storage AS over, w.storage_bytes AS used,
           coalesce((SELECT octet_length(state) FROM page_docs WHERE page_id = ${pageId}), 0) AS body
      FROM workspaces w WHERE w.id = ${workspaceId}
  `)) as unknown as { over: boolean; used: string | number; body: number }[]
  if (!r) return false
  return r.over || Number(r.used) >= limit || Number(r.body) > pageCap
}
