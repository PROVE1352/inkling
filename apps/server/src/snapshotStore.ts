import { sql } from 'drizzle-orm'
import { db } from './db/index'
import { pageSnapshots } from './db/schema'

/** Max snapshots kept per page (oldest deleted first beyond it) */
export const MAX_SNAPSHOTS_PER_PAGE = 50
/** Automatic snapshot throttle: only store a new one when the last snapshot is older than this */
export const AUTO_SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000

/**
 * Keep only the newest MAX_SNAPSHOTS_PER_PAGE snapshots per page and delete older ones.
 * (Keeps the top N by created_at desc.)
 */
export async function pruneSnapshots(pageId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM page_snapshots
    WHERE page_id = ${pageId}
      AND id NOT IN (
        SELECT id FROM page_snapshots
        WHERE page_id = ${pageId}
        ORDER BY created_at DESC
        LIMIT ${MAX_SNAPSHOTS_PER_PAGE}
      )
  `)
}

/**
 * Store one snapshot and prune the excess.
 * Used for explicit stores such as manual snapshots and pre-restore snapshots.
 * `via` = the OAuth client name when an agent (MCP) edit caused the snapshot (docs/adr/0936-*).
 */
export async function createSnapshot(
  pageId: string,
  state: Uint8Array,
  label: string | null,
  createdBy: string | null,
  via: string | null = null,
): Promise<void> {
  await db
    .insert(pageSnapshots)
    .values({ pageId, state: Buffer.from(state), label, createdBy, viaClient: via })
  noteSnapshot(pageId, Date.now())
  await pruneSnapshots(pageId)
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
 * Auto snapshot of the *currently stored* page_docs.state, decided and copied inside Postgres:
 * the previous state is never shipped to Node (it used to be SELECTed in full on every store).
 * Must run before the store hook overwrites page_docs. Never throws.
 */
export async function maybeAutoSnapshotStored(pageId: string): Promise<void> {
  try {
    const known = lastSnapshotAt.get(pageId)
    if (known !== undefined && Date.now() - known < AUTO_SNAPSHOT_THROTTLE_MS) return
    const throttleSec = Math.floor(AUTO_SNAPSHOT_THROTTLE_MS / 1000)
    const rows = (await db.execute(sql`
      WITH last AS (
        SELECT max(created_at) AS at FROM page_snapshots WHERE page_id = ${pageId}
      ), ins AS (
        INSERT INTO page_snapshots (page_id, state)
        SELECT d.page_id, d.state
        FROM page_docs d, last
        WHERE d.page_id = ${pageId}
          AND octet_length(d.state) > 0
          AND (last.at IS NULL OR last.at < now() - make_interval(secs => ${throttleSec}))
        RETURNING created_at
      )
      SELECT (SELECT at FROM last) AS last_at, (SELECT created_at FROM ins) AS inserted_at
    `)) as unknown as { last_at: Date | string | null; inserted_at: Date | string | null }[]
    const row = rows[0]
    const inserted = row?.inserted_at ? new Date(row.inserted_at).getTime() : null
    const last = row?.last_at ? new Date(row.last_at).getTime() : null
    if (inserted !== null) {
      noteSnapshot(pageId, Date.now())
      await pruneSnapshots(pageId)
    } else if (last !== null) {
      noteSnapshot(pageId, last)
    }
  } catch (err) {
    console.error('[inkling] auto snapshot failed', pageId, err)
  }
}
