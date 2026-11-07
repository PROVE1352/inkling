import { and, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { CollectionField } from '@inkling/shared'
import { broadcastToUser } from '../collab'
import { db } from '../db/index'
import { collections, notifications, pageTasks, pages, workspaceMembers } from '../db/schema'
import { runHousekeeping } from '../housekeeping'
import { emitWebhookEvent } from '../webhooks'
import { liveWorkspace } from '../workspaceLive'

/**
 * M17 — due-date reminder scan.
 *
 * For every date-type field of every collection, find live child rows due today (server-local
 * YYYY-MM-DD) and issue a 'reminder' notification to their recipients.
 *   - Recipients = row createdBy + assignees in person fields (only if workspace members), deduped.
 *   - Once a day per row: skip if a 'reminder' notification for that row was already created today.
 *   - After insert, pushed immediately over the M16 inbox realtime channel (broadcastToUser).
 *   - Dates are compared only as local 'YYYY-MM-DD' strings — no UTC drift (same as M9).
 *   - Errors are isolated per collection/row so one failure never breaks the whole scan.
 *   - Tasks inside documents (page_tasks) due today and not done also notify the page author (scanTaskReminders).
 */

type Logger = (msg: string) => void

const pad = (n: number): string => String(n).padStart(2, '0')

/** Build today's server-local date as 'YYYY-MM-DD' (from local fields, no UTC conversion). */
export function localTodayISO(): string {
  const n = new Date()
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
}

/** Server-local midnight (today 00:00) — lower bound for "created today" on 'reminder' notifications. */
function localMidnight(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

/**
 * One due-reminder scan. Reused by the index.ts boot scan + hourly interval and by smoke tests (direct call).
 * All errors are isolated and only logged (never breaks the scheduler/server).
 */
export async function scanDueReminders(log: Logger): Promise<void> {
  const today = localTodayISO()
  const midnight = localMidnight()
  let created = 0

  try {
    const cols = await db
      .select({ pageId: collections.pageId, fields: collections.fields })
      .from(collections)

    for (const col of cols) {
      try {
        const fields = (col.fields ?? []) as CollectionField[]
        const dateFieldIds = fields.filter((f) => f.type === 'date').map((f) => f.id)
        if (dateFieldIds.length === 0) continue
        const personFieldIds = fields.filter((f) => f.type === 'person').map((f) => f.id)

        // Live child rows (recipients derived from props/createdBy/workspaceId)
        const rows = await db
          .select({
            id: pages.id,
            props: pages.props,
            createdBy: pages.createdBy,
            workspaceId: pages.workspaceId,
          })
          .from(pages)
          .where(and(eq(pages.parentId, col.pageId), isNull(pages.deletedAt), liveWorkspace(pages.workspaceId)))

        for (const row of rows) {
          try {
            const props = (row.props ?? {}) as Record<string, unknown>
            // Due if any date field equals today (string comparison)
            const due = dateFieldIds.some((fid) => props[fid] === today)
            if (!due) continue

            // Once a day per row: skip if a 'reminder' notification for this row was created today
            const existing = await db
              .select({ id: notifications.id })
              .from(notifications)
              .where(
                and(
                  eq(notifications.type, 'reminder'),
                  eq(notifications.pageId, row.id),
                  gte(notifications.createdAt, midnight),
                ),
              )
              .limit(1)
            if (existing.length > 0) continue

            // Recipients: row author (always) + person assignees (members only), deduped
            const recipients = new Set<string>()
            if (row.createdBy) recipients.add(row.createdBy)

            const assignees = [
              ...new Set(
                personFieldIds
                  .map((fid) => props[fid])
                  .filter((v): v is string => typeof v === 'string' && v.length > 0),
              ),
            ]
            if (assignees.length > 0) {
              const members = await db
                .select({ userId: workspaceMembers.userId })
                .from(workspaceMembers)
                .where(
                  and(
                    eq(workspaceMembers.workspaceId, row.workspaceId),
                    inArray(workspaceMembers.userId, assignees),
                  ),
                )
              for (const m of members) recipients.add(m.userId)
            }

            if (recipients.size === 0) continue

            await db.insert(notifications).values(
              [...recipients].map((userId) => ({
                userId,
                type: 'reminder' as const,
                pageId: row.id,
                workspaceId: row.workspaceId,
                actorId: null,
              })),
            )
            // M16: push to each recipient's inbox channel right away (broadcastToUser isolates failures)
            for (const rid of recipients) broadcastToUser(rid, { t: 'notifications' })
            emitWebhookEvent({ type: 'reminder', workspaceId: row.workspaceId, pageId: row.id })
            created += recipients.size
          } catch (err) {
            log(`[inkling] reminder row failed ${row.id}: ${String(err)}`)
          }
        }
      } catch (err) {
        log(`[inkling] reminder collection failed ${col.pageId}: ${String(err)}`)
      }
    }

    created += await scanTaskReminders(today, midnight, log)

    log(`[inkling] reminder scan done — ${created} sent`)
  } catch (err) {
    log(`[inkling] reminder scan failed: ${String(err)}`)
  }
}

/**
 * Reminders for tasks inside documents (page_tasks) — for every live page with an unfinished task due
 * today, one 'reminder' notification to the page author (once a day per page — same dedupe key as row
 * reminders). Skipped if the author is no longer a workspace member. Errors isolated per page. Returns the count sent.
 */
async function scanTaskReminders(today: string, midnight: Date, log: Logger): Promise<number> {
  let created = 0
  try {
    const due = await db
      .selectDistinct({ pageId: pages.id, createdBy: pages.createdBy, workspaceId: pages.workspaceId })
      .from(pageTasks)
      .innerJoin(pages, eq(pages.id, pageTasks.pageId))
      .where(
        and(
          eq(pageTasks.due, today),
          eq(pageTasks.checked, false),
          isNull(pages.deletedAt),
          isNotNull(pages.createdBy),
          liveWorkspace(pages.workspaceId),
        ),
      )
    for (const p of due) {
      try {
        const owner = p.createdBy as string
        const existing = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.type, 'reminder'),
              eq(notifications.pageId, p.pageId),
              gte(notifications.createdAt, midnight),
            ),
          )
          .limit(1)
        if (existing.length > 0) continue
        const member = await db
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, p.workspaceId), eq(workspaceMembers.userId, owner)))
          .limit(1)
        if (member.length === 0) continue
        await db.insert(notifications).values({ userId: owner, type: 'reminder', pageId: p.pageId, workspaceId: p.workspaceId, actorId: null })
        broadcastToUser(owner, { t: 'notifications' })
        emitWebhookEvent({ type: 'reminder', workspaceId: p.workspaceId, pageId: p.pageId })
        created++
      } catch (err) {
        log(`[inkling] task reminder failed ${p.pageId}: ${String(err)}`)
      }
    }
  } catch (err) {
    log(`[inkling] task reminder scan failed: ${String(err)}`)
  }
  return created
}

/** Delay before the boot scan (ms) — headroom after listen/collab attach. */
const BOOT_DELAY_MS = 5_000
/** Rescan interval (ms) — 1 hour. */
const SCAN_INTERVAL_MS = 60 * 60 * 1_000

/**
 * Start the reminder scheduler: one delayed scan at boot + a rescan every hour.
 * Returns a stop function for shutdown (clears both the boot timer and the interval).
 * Assumes a single-process setInterval (small deployments). Multiple instances may send duplicate
 * notifications — out of scope for v1.
 */
export function startReminderScheduler(log: Logger): () => void {
  // Re-entry guard: a scan that outlives the interval (big instance, slow DB) must not overlap
  // the next one — the dedupe in scanDueReminders is SELECT-then-INSERT (docs/adr/0757-*).
  let running = false
  const tick = async () => {
    if (running) {
      log('[inkling] reminder scan still running — skipping this tick')
      return
    }
    running = true
    try {
      await scanDueReminders(log)
      await runHousekeeping(log)
    } catch (err) {
      console.error('[inkling] reminder tick failed', err)
    } finally {
      running = false
    }
  }
  const bootTimer = setTimeout(() => void tick(), BOOT_DELAY_MS)
  const interval = setInterval(() => void tick(), SCAN_INTERVAL_MS)
  return () => {
    clearTimeout(bootTimer)
    clearInterval(interval)
  }
}
