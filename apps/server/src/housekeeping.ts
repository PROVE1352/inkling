import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { db, relaxStatementTimeout } from './db/index'
import { files, notifications, sessions } from './db/schema'
import { env } from './env'
import { purgeExpiredOAuth } from './oauth'
import { purgeExpiredApiTokens } from './apiTokens'
import { purgeExpiredAccountTokens } from './accounts'
import { purgeDeletedSubtrees, withTreeLock } from './pageTree'
import { purgeExpiredWorkspaces } from './workspaceDeletion'
import { purgeOldChanges } from './context/changeLog'
import { scanReviewDigests, scoreAllWorkspaces } from './review'
import { flushReads, purgeOldReads } from './pageReads'
import { runNotificationHousekeeping } from './notify/digest'

const AUDIT_PURGE_BATCH = 5_000

/**
 * Audit events past their workspace's audit retention (workspaces.audit_retention_days), in
 * bounded batches so one hourly tick never holds a long delete. Returns the number deleted.
 */
export async function purgeOldAuditEvents(now: Date, maxBatches = 20): Promise<number> {
  let total = 0
  for (let i = 0; i < maxBatches; i++) {
    // Per workspace, a range scan of (workspace_id, created_at) below that workspace's cutoff
    // instead of a scan of every event with the retention computed per row (docs/PERFORMANCE.md).
    const rows = (await db.execute(sql`
      DELETE FROM workspace_audit_events WHERE id IN (
        SELECT x.id FROM workspaces w CROSS JOIN LATERAL (
          SELECT e.id FROM workspace_audit_events e
           WHERE e.workspace_id = w.id
             AND e.created_at < ${now.toISOString()}::timestamptz - make_interval(days => w.audit_retention_days)
           LIMIT ${AUDIT_PURGE_BATCH}) x
         LIMIT ${AUDIT_PURGE_BATCH})
      RETURNING id
    `)) as unknown as { id: string }[]
    total += rows.length
    if (rows.length < AUDIT_PURGE_BATCH) break
  }
  return total
}

/**
 * Cleanup of tables that grow forever, piggybacking on the reminder scheduler's hourly tick.
 *   - Expired sessions: they were only deleted on lookup, so abandoned sessions stayed forever.
 *   - Read notifications: there is no delete API, so read notifications older than 90 days are removed.
 *   - Trash: pages in the trash longer than their workspace's trash retention (default 30 days,
 *     docs/adr/0950-*) are permanently deleted.
 *     Same order as manual permanent deletion (routes/pages.ts purge): collect attachment ids -> delete pages -> file rows + blobs.
 *   - Workspaces soft-deleted more than 30 days ago are permanently deleted (docs/adr/0910-*).
 *   - Change feed rows older than CHANGE_FEED_RETENTION_DAYS (docs/adr/0932-*), in bounded batches.
 *   - Audit events older than their workspace's audit retention (default 90 days, docs/adr/0946-*).
 *   - Page read counters: flush the buffer, purge days older than 90 (docs/adr/0953-*).
 *   - The once-a-day review priority batch and review_due webhook digest (docs/adr/0952-*, 0953-*).
 * Exceptions are isolated and only logged (they never break the scheduler).
 */
const READ_NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1_000
/**
 * Permanently delete trash pages (+ descendants) older than their workspace's trash retention
 * (workspaces.trash_retention_days); returns the number of pages deleted.
 */
export async function purgeOldTrash(now: Date, log: (msg: string) => void): Promise<number> {
  // Per workspace, under its tree lock; only rows that are themselves in the trash are walked
  // (a live page under a trashed parent is moved to the root, never purged — A-M10).
  const roots = (await db.execute(sql`
    SELECT p.workspace_id AS "workspaceId", string_agg(p.id::text, ',') AS ids
      FROM pages p JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.deleted_at IS NOT NULL
       AND p.deleted_at < ${now.toISOString()}::timestamptz - make_interval(days => w.trash_retention_days)
     GROUP BY p.workspace_id
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
          // quiet items (no badge) are never "read" by anyone, so they age out the same way
          or(eq(notifications.read, '1'), eq(notifications.delivery, 'quiet')),
          lt(notifications.createdAt, new Date(now.getTime() - READ_NOTIFICATION_TTL_MS)),
        ),
      )
      .returning({ id: notifications.id })
    const t = await purgeOldTrash(now, log)
    const w = await purgeExpiredWorkspaces(now, log)
    // MCP OAuth: expired authorization codes and connections whose refresh token has expired too
    const o = (await purgeExpiredOAuth(now)) + (await purgeExpiredApiTokens(now))
    // Expired password reset codes and email verification tokens
    const a = await purgeExpiredAccountTokens(now)
    // Change feed log retention (an older cursor gets resync_required)
    const c = await purgeOldChanges(now, env.changeFeedRetentionDays)
    const e = await purgeOldAuditEvents(now)
    if (s.length || n.length || t || w || o || a || c || e) {
      log(
        `[inkling] cleanup: deleted ${s.length} expired sessions, ${n.length} old read notifications, ${t} trash pages past their workspace's retention, ${w} workspaces deleted more than 30 days ago, ${o} expired OAuth items and API tokens, ${a} expired reset/verification tokens, ${c} change feed rows older than ${env.changeFeedRetentionDays} days, ${e} audit events past retention`,
      )
    }
    // Page read counters (docs/adr/0953-*): write the buffer, drop days past retention
    await flushReads(log)
    await purgeOldReads(now)
    // Review priority batch once a day per workspace, then the review_due digests built from it
    await scoreAllWorkspaces(now, log)
    const r = await scanReviewDigests(now, log)
    if (r) log(`[inkling] review digests: ${r} workspace(s)`)
    // Notification mail sweeps, AI-edit summaries and digest mail (docs/adr/1004-*)
    await runNotificationHousekeeping(now, log)
  } catch (err) {
    log(`[inkling] cleanup job failed: ${String(err)}`)
  }
}
