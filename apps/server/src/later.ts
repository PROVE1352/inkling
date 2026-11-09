import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { LaterItemDTO, LaterKind, LaterListDTO, NotificationType } from '@inkling/shared'
import { LATER_LIST_MAX } from '@inkling/shared'
import { agentAllowedSql } from './agentAccess'
import { db } from './db/index'
import { notifyOutboxRow } from './notify/engine'
import { enqueue, outboxCommitted } from './outbox'
import type { OutboxRow } from './outbox'
import { memberOrGuestSql } from './pageGrants'
import { pageInRangeSql } from './tokenRange'
import { twoFactorBlockedSql } from './twoFactorPolicy'
import { liveWorkspace } from './workspaceLive'

/**
 * Later list and reminders (docs/adr/1410-*, 1411-*).
 *
 * Items keep ids only. Whether the person may see the target is decided when the list is read
 * (`targetVisibleSql`), so a page made private, a workspace the person left or that now blocks
 * them by its two-step requirement (docs/adr/1300-*) shows the item without its title.
 *
 * Reminders: a sweep claims due rows (`reminded_at = now()`, FOR UPDATE SKIP LOCKED) and queues
 * one notification event per row through the outbox in the same transaction (docs/adr/1081-*). The
 * claim and the event commit together, so a crash before the commit leaves the row due (it fires
 * on the next sweep, after a restart too) and a crash after it leaves the event in the outbox (the
 * notification consumer writes it exactly once). The event re-checks visibility like every other
 * notification; mail re-checks it again at send time.
 */

/**
 * SQL boolean over a page aliased `p`: `userId` can open it now. Live page they can see (shared, or
 * their own private page), member or guest of a live workspace that does not block them, inside the
 * connection's range and not blocked for this agent. Same terms as the agent inbox and the mailer.
 */
export function targetVisibleSql(userId: string): SQL {
  return sql`(p.id IS NOT NULL AND p.deleted_at IS NULL
    AND (p.scope = 'shared' OR p.created_by = ${userId})
    AND ${memberOrGuestSql(sql`p.workspace_id`, userId)}
    AND ${liveWorkspace(sql`p.workspace_id`)}
    AND NOT ${twoFactorBlockedSql(sql`p.workspace_id`, userId)}
    AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, userId)})`
}

interface LaterRow {
  id: string
  kind: LaterKind
  workspaceId: string
  pageId: string
  threadId: string | null
  anchor: string | null
  remindAt: Date | string | null
  remindTz: string | null
  remindedAt: Date | string | null
  doneAt: Date | string | null
  createdAt: Date | string
  accessible: boolean
  pageTitle: string | null
  threadBody: string | null
  threadAuthor: string | null
  notifType: NotificationType | null
  notifExcerpt: string | null
  notifActor: string | null
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())

function firstLine(s: string | null, max = 200): string | null {
  if (!s) return null
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function toDto(r: LaterRow): LaterItemDTO {
  const ok = r.accessible
  return {
    id: r.id,
    kind: r.kind,
    workspaceId: r.workspaceId,
    pageId: r.pageId,
    threadId: r.threadId,
    anchor: ok ? r.anchor : null,
    accessible: ok,
    // Nothing taken from the target leaves the server while the person cannot see it.
    pageTitle: ok ? (r.pageTitle ?? '') : null,
    preview: ok ? firstLine(r.kind === 'notification' ? (r.notifExcerpt ?? r.threadBody) : r.threadBody) : null,
    actorName: ok ? (r.kind === 'notification' ? r.notifActor : r.threadAuthor) : null,
    notificationType: ok ? r.notifType : null,
    remindAt: iso(r.remindAt),
    remindTz: r.remindTz,
    reminded: r.remindedAt !== null,
    done: r.doneAt !== null,
    doneAt: iso(r.doneAt),
    createdAt: iso(r.createdAt)!,
  }
}

/**
 * The person's items (newest first, open or done) with the target joined live. `where` narrows
 * further (one id, one target key). Items of a workspace outside an agent connection's range or
 * blocked for that agent are left out entirely, not just redacted.
 */
export async function readLater(
  userId: string,
  q: { workspaceId?: string; state?: 'open' | 'done'; where?: SQL; limit?: number },
): Promise<LaterListDTO> {
  const scope = sql`l.user_id = ${userId}
    ${q.workspaceId ? sql`AND l.workspace_id = ${q.workspaceId}` : sql``}
    AND ${agentAllowedSql(sql`l.workspace_id`)}`
  const state = q.state === undefined ? sql`` : q.state === 'done' ? sql`AND l.done_at IS NOT NULL` : sql`AND l.done_at IS NULL`
  const rows = (await db.execute(sql`
    SELECT l.id, l.kind, l.workspace_id AS "workspaceId", l.page_id AS "pageId", l.thread_id AS "threadId", l.anchor,
           l.remind_at AS "remindAt", l.remind_tz AS "remindTz", l.reminded_at AS "remindedAt", l.done_at AS "doneAt",
           l.created_at AS "createdAt",
           ${targetVisibleSql(userId)} AS accessible,
           p.title AS "pageTitle",
           left(rc.body, 400) AS "threadBody", ra.name AS "threadAuthor",
           n.type AS "notifType", n.excerpt AS "notifExcerpt", na.name AS "notifActor"
      FROM later_items l
      LEFT JOIN pages p ON p.id = l.page_id
      LEFT JOIN comments rc ON rc.id = l.thread_id
      LEFT JOIN users ra ON ra.id = rc.author_id
      LEFT JOIN notifications n ON n.id = l.notification_id AND n.user_id = l.user_id
      LEFT JOIN users na ON na.id = n.actor_id
     WHERE ${scope} ${state} ${q.where ? sql`AND ${q.where}` : sql``}
     ORDER BY CASE WHEN l.done_at IS NULL THEN l.created_at ELSE l.done_at END DESC, l.id
     LIMIT ${q.limit ?? LATER_LIST_MAX}
  `)) as unknown as LaterRow[]
  const [c] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE l.done_at IS NULL)::int AS open,
           count(*) FILTER (WHERE l.done_at IS NULL AND l.reminded_at IS NOT NULL)::int AS due
      FROM later_items l WHERE ${scope}
  `)) as unknown as { open: number; due: number }[]
  return { items: rows.map(toDto), open: c?.open ?? 0, due: c?.due ?? 0 }
}

// --- reminder sweep ------------------------------------------------------------------

/** Rows claimed per sweep transaction. */
export const LATER_SWEEP_BATCH = 500
/** Upper bound between sweeps (other processes' new reminders, clock drift); the timer usually fires earlier. */
export const LATER_SWEEP_MAX_WAIT_MS = 60_000

export const laterStats = { sweeps: 0, fired: 0 }

/** Fault injection for the crash tests: runs after a sweep's writes, before its commit. */
export const laterTestHooks: { beforeCommit?: () => void | Promise<void> } = {}

/**
 * One sweep: claim up to LATER_SWEEP_BATCH due reminders and queue their notification events in the
 * same transaction. Returns how many were claimed.
 */
export async function runLaterSweep(): Promise<number> {
  const n = await db.transaction(async (tx) => {
    const due = (await tx.execute(sql`
      WITH due AS (
        SELECT id FROM later_items
         WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL AND remind_at <= now()
         ORDER BY remind_at
         LIMIT ${LATER_SWEEP_BATCH}
           FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE later_items l SET reminded_at = now() FROM due WHERE l.id = due.id
        RETURNING l.id, l.user_id, l.workspace_id, l.page_id, l.thread_id, l.anchor, l.remind_at, l.notification_id
      )
      SELECT c.id, c.user_id AS "userId", c.workspace_id AS "workspaceId", c.page_id AS "pageId",
             c.thread_id AS "threadId", c.anchor, c.remind_at AS "remindAt",
             coalesce(left(rc.body, 400), n.excerpt) AS excerpt
        FROM claimed c
        LEFT JOIN comments rc ON rc.id = c.thread_id
        LEFT JOIN notifications n ON n.id = c.notification_id
    `)) as unknown as {
      id: string
      userId: string
      workspaceId: string
      pageId: string
      threadId: string | null
      anchor: string | null
      remindAt: Date | string
      excerpt: string | null
    }[]
    if (!due.length) return 0
    const rows: OutboxRow[] = []
    for (const d of due) {
      const row = notifyOutboxRow({
        workspaceId: d.workspaceId,
        pageId: d.pageId,
        // No actor: the engine never notifies the actor, and the person set this up for themselves.
        actorId: null,
        via: null,
        recipients: [{ userId: d.userId, kind: 'later_reminder', reason: 'direct' }],
        commentId: d.threadId,
        threadId: d.threadId,
        anchor: d.anchor,
        excerpt: d.excerpt,
      })
      // Second guard next to the claim: the same reminder (item + instant) is queued once while its
      // event is pending, e.g. a reminder set again to the same minute right after it was claimed.
      if (row) rows.push({ ...row, dedupeKey: `later:${d.id}:${new Date(d.remindAt).getTime()}` })
    }
    await enqueue(tx, rows)
    await laterTestHooks.beforeCommit?.()
    return due.length
  })
  laterStats.sweeps++
  if (n > 0) {
    laterStats.fired += n
    outboxCommitted(['notify'])
  }
  return n
}

/** When the next reminder is due (null = none). */
async function nextDue(): Promise<Date | null> {
  const [r] = (await db.execute(sql`
    SELECT min(remind_at) AS at FROM later_items WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL
  `)) as unknown as { at: Date | string | null }[]
  return r?.at ? new Date(r.at) : null
}

let timer: NodeJS.Timeout | null = null
let timerAt = 0
let running: Promise<void> | null = null
let stopped = true
let log: (msg: string) => void = (m) => console.error(m)

function arm(at: number): void {
  if (stopped) return
  const now = Date.now()
  const when = Math.min(Math.max(at, now), now + LATER_SWEEP_MAX_WAIT_MS)
  if (timer && timerAt <= when) return
  if (timer) clearTimeout(timer)
  timerAt = when
  timer = setTimeout(() => {
    timer = null
    void tick()
  }, when - now)
  timer.unref?.()
}

async function tick(): Promise<void> {
  if (running) return running
  running = (async () => {
    try {
      // Drain a backlog (a long downtime) batch by batch.
      for (let i = 0; i < 100; i++) if ((await runLaterSweep()) < LATER_SWEEP_BATCH) break
      const next = await nextDue()
      arm(next ? next.getTime() : Date.now() + LATER_SWEEP_MAX_WAIT_MS)
    } catch (err) {
      log(`[later] reminder sweep failed: ${String(err)}`)
      arm(Date.now() + 5_000)
    } finally {
      running = null
    }
  })()
  return running
}

/** A reminder was set (or moved) in this process: make sure the timer fires by then. */
export function wakeLaterReminders(at: Date | null): void {
  if (at) arm(at.getTime())
}

/** Start the reminder timer (index.ts). Sweeps once right away: reminders that came due while down fire now. */
export function startLaterReminders(logger: (msg: string) => void): () => void {
  log = logger
  stopped = false
  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}
