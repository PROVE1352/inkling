import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db, relaxStatementTimeout } from './db/index'
import { files, notifications, sessions } from './db/schema'
import { env } from './env'
import { purgeExpiredOAuth } from './oauth'
import { purgeExpiredAccountTokens } from './accounts'
import { purgeDeletedSubtrees, withTreeLock } from './pageTree'
import { purgeExpiredWorkspaces } from './workspaceDeletion'

/**
 * Cleanup of tables that grow forever, piggybacking on the reminder scheduler's hourly tick.
 *   - Expired sessions: they were only deleted on lookup, so abandoned sessions stayed forever.
 *   - Read notifications: there is no delete API, so read notifications older than 90 days are removed.
 *   - Trash: pages in the trash for more than 30 days are permanently deleted.
 *     Same order as manual permanent deletion (routes/pages.ts purge): collect attachment ids -> delete pages -> file rows + blobs.
 *   - Workspaces soft-deleted more than 30 days ago are permanently deleted (docs/adr/0910-*).
 * Exceptions are isolated and only logged (they never break the scheduler).
 */
const READ_NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1_000
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1_000

/** Permanently delete trash pages (+ descendants) older than 30 days; returns the number of pages deleted. */
async function purgeOldTrash(now: Date, log: (msg: string) => void): Promise<number> {
  const cutoff = new Date(now.getTime() - TRASH_TTL_MS)
  // Per workspace, under its tree lock; only rows that are themselves in the trash are walked
  // (a live page under a trashed parent is moved to the root, never purged — A-M10).
  const roots = (await db.execute(sql`
    SELECT workspace_id AS "workspaceId", string_agg(id::text, ',') AS ids FROM pages
     WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff.toISOString()}::timestamptz
     GROUP BY workspace_id
  `)) as unknown as { workspaceId: string; ids: string }[]
  let purged = 0
  const attached: { id: string }[] = []
  for (const r of roots) {
    const res = await withTreeLock(r.workspaceId, async (tx) => {
      await relaxStatementTimeout(tx)
      return purgeDeletedSubtrees(tx, r.ids.split(',').filter(Boolean))
    })
    purged += res.purged
    for (const id of res.fileIds) attached.push({ id })
  }

  const fileIds = attached.map((r) => r.id)
  if (fileIds.length > 0) {
    try {
      await db.delete(files).where(inArray(files.id, fileIds))
    } catch (err) {
      log(`[inkling] trash cleanup: failed to delete attachment file rows: ${String(err)}`)
    }
    for (const fid of fileIds) {
      try {
        await unlink(path.join(env.dataDir, 'uploads', fid))
      } catch {
        // Already gone or deletion failed: ignore (best effort)
      }
    }
  }
  return purged
}

export async function runHousekeeping(log: (msg: string) => void): Promise<void> {
  try {
    const now = new Date()
    const s = await db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ token: sessions.token })
    const n = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.read, '1'),
          lt(notifications.createdAt, new Date(now.getTime() - READ_NOTIFICATION_TTL_MS)),
        ),
      )
      .returning({ id: notifications.id })
    const t = await purgeOldTrash(now, log)
    const w = await purgeExpiredWorkspaces(now, log)
    // MCP OAuth: expired authorization codes and connections whose refresh token has expired too
    const o = await purgeExpiredOAuth(now)
    // Expired password reset codes and email verification tokens
    const a = await purgeExpiredAccountTokens(now)
    if (s.length || n.length || t || w || o || a) {
      log(
        `[inkling] cleanup: deleted ${s.length} expired sessions, ${n.length} old read notifications, ${t} trash pages older than 30 days, ${w} workspaces deleted more than 30 days ago, ${o} expired OAuth items, ${a} expired reset/verification tokens`,
      )
    }
  } catch (err) {
    log(`[inkling] cleanup job failed: ${String(err)}`)
  }
}
