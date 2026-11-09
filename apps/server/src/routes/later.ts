import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  LATER_MAX_OPEN,
  LATER_REMIND_MAX_DAYS,
  laterQuerySchema,
  laterTargetQuerySchema,
  saveLaterSchema,
  updateLaterSchema,
} from '@inkling/shared'
import type { LaterItemDTO, LaterKind } from '@inkling/shared'
import { agentAllowedSql } from '../agentAccess'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { AppError, badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { readLater, wakeLaterReminders } from '../later'
import { findVisiblePage } from '../pageDto'

/**
 * Later list (docs/adr/1410-*, 1411-*): save a page, a comment thread or a notification, mark it
 * done, set a reminder. Every route acts on the caller's own rows only; saving checks that the
 * caller can see the target now. GET is open to read-only tokens (the MCP `later` tool).
 */

const SKEW_MS = 60_000

/** The reminder instant: in the future (a minute of clock skew allowed), at most LATER_REMIND_MAX_DAYS ahead. */
function remindInstant(v: string | null | undefined): Date | null | undefined {
  if (v === undefined || v === null) return v
  const at = new Date(v)
  const now = Date.now()
  if (Number.isNaN(at.getTime())) throw badRequest('remindAt: invalid date')
  if (at.getTime() < now - SKEW_MS) throw badRequest('remindAt: the time has already passed')
  if (at.getTime() > now + LATER_REMIND_MAX_DAYS * 86_400_000) throw badRequest(`remindAt: at most ${LATER_REMIND_MAX_DAYS} days ahead`)
  return at
}

interface Target {
  kind: LaterKind
  workspaceId: string
  pageId: string
  threadId: string | null
  notificationId: string | null
  anchor: string | null
  key: string
}

/** Resolve what is being saved and check the caller can see it now (404 otherwise, docs/adr/1301-*). */
async function resolveTarget(userId: string, b: ReturnType<typeof saveLaterSchema.parse>): Promise<Target> {
  let pageId: string
  let threadId: string | null = null
  let notificationId: string | null = null
  let anchor: string | null = b.anchor ?? null
  if (b.kind === 'page') {
    pageId = b.pageId!
  } else if (b.kind === 'thread') {
    const [c] = (await db.execute(sql`
      SELECT page_id AS "pageId" FROM comments WHERE id = ${b.threadId!} AND thread_id = id
    `)) as unknown as { pageId: string }[]
    if (!c) throw notFound('NOT_FOUND', 'Thread not found')
    pageId = c.pageId
    threadId = b.threadId!
  } else {
    const [n] = (await db.execute(sql`
      SELECT n.page_id AS "pageId", n.anchor, c.thread_id AS "threadId"
        FROM notifications n LEFT JOIN comments c ON c.id = n.comment_id
       WHERE n.id = ${b.notificationId!} AND n.user_id = ${userId}
    `)) as unknown as { pageId: string | null; anchor: string | null; threadId: string | null }[]
    if (!n) throw notFound('NOT_FOUND', 'Notification not found')
    if (!n.pageId) throw badRequest('This notification is not about a page; there is nothing to come back to')
    pageId = n.pageId
    threadId = n.threadId
    notificationId = b.notificationId!
    anchor = anchor ?? n.anchor
  }
  const page = await findVisiblePage(pageId, userId)
  if (!page) throw notFound()
  await requireMembership(page.workspaceId, userId, { guests: true })
  const key = b.kind === 'page' ? `page:${pageId}` : b.kind === 'thread' ? `thread:${threadId}` : `notification:${notificationId}`
  return { kind: b.kind, workspaceId: page.workspaceId, pageId, threadId, notificationId, anchor, key }
}

async function itemById(userId: string, id: string): Promise<LaterItemDTO | null> {
  const r = await readLater(userId, { where: sql`l.id = ${id}`, limit: 1 })
  return r.items[0] ?? null
}

export async function registerLaterRoutes(app: FastifyInstance): Promise<void> {
  app.get('/later', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const q = laterQuerySchema.parse(req.query)
    if (q.workspaceId) await requireMembership(q.workspaceId, user.id, { guests: true })
    return readLater(user.id, q)
  })

  // Is this page / thread / notification on my list (for the save buttons)?
  app.get('/later/target', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const q = laterTargetQuerySchema.parse(req.query)
    const key = q.pageId ? `page:${q.pageId}` : q.threadId ? `thread:${q.threadId}` : `notification:${q.notificationId}`
    const r = await readLater(user.id, { where: q.id ? sql`l.id = ${q.id}` : sql`l.target_key = ${key}`, limit: 1 })
    return { item: r.items[0] ?? null }
  })

  // Save (again). Saving a target that is already on the list reopens it; a reminder in the body
  // replaces the old one.
  app.post('/later', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const b = saveLaterSchema.parse(req.body)
    const remindAt = remindInstant(b.remindAt)
    const t = await resolveTarget(user.id, b)
    const setRemind = remindAt !== undefined
    const rows = (await db.execute(sql`
      WITH cap AS (
        SELECT count(*) AS n FROM later_items WHERE user_id = ${user.id} AND done_at IS NULL AND target_key <> ${t.key}
      )
      INSERT INTO later_items (user_id, workspace_id, kind, page_id, thread_id, notification_id, anchor, target_key, remind_at, remind_tz)
      SELECT ${user.id}, ${t.workspaceId}, ${t.kind}, ${t.pageId}, ${t.threadId}, ${t.notificationId}, ${t.anchor}, ${t.key},
             ${remindAt ? remindAt.toISOString() : null}::timestamptz, ${remindAt ? (b.remindTz ?? null) : null}
        FROM cap WHERE cap.n < ${LATER_MAX_OPEN}
      ON CONFLICT (user_id, target_key) DO UPDATE SET
        done_at = NULL,
        anchor = coalesce(EXCLUDED.anchor, later_items.anchor),
        remind_at = ${setRemind ? sql`EXCLUDED.remind_at` : sql`later_items.remind_at`},
        remind_tz = ${setRemind ? sql`EXCLUDED.remind_tz` : sql`later_items.remind_tz`},
        reminded_at = ${setRemind ? sql`NULL` : sql`later_items.reminded_at`},
        updated_at = now()
      RETURNING id, (xmax = 0) AS inserted
    `)) as unknown as { id: string; inserted: boolean }[]
    if (!rows[0]) {
      throw new AppError(409, 'LATER_FULL', `At most ${LATER_MAX_OPEN} open items: mark some done or delete them first`)
    }
    if (remindAt) wakeLaterReminders(remindAt)
    const item = await itemById(user.id, rows[0].id)
    return reply.code(rows[0].inserted ? 201 : 200).send({ item })
  })

  app.patch('/later/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const b = updateLaterSchema.parse(req.body)
    const remindAt = remindInstant(b.remindAt)
    const setRemind = remindAt !== undefined
    const done = b.done === undefined ? sql`done_at` : b.done ? sql`coalesce(done_at, now())` : sql`NULL`
    const rows = (await db.execute(sql`
      UPDATE later_items SET
        done_at = ${done},
        remind_at = ${setRemind ? sql`${remindAt ? remindAt.toISOString() : null}::timestamptz` : sql`remind_at`},
        remind_tz = ${setRemind ? sql`${remindAt ? (b.remindTz ?? null) : null}` : sql`remind_tz`},
        reminded_at = ${setRemind ? sql`NULL` : sql`reminded_at`},
        updated_at = now()
       WHERE id = ${id} AND user_id = ${user.id} AND ${agentAllowedSql(sql`workspace_id`)}
      RETURNING id
    `)) as unknown as { id: string }[]
    if (!rows[0]) throw notFound()
    if (remindAt) wakeLaterReminders(remindAt)
    return { item: await itemById(user.id, id) }
  })

  app.delete('/later/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const rows = (await db.execute(sql`DELETE FROM later_items WHERE id = ${id} AND user_id = ${user.id} AND ${agentAllowedSql(sql`workspace_id`)} RETURNING id`)) as unknown as {
      id: string
    }[]
    if (!rows[0]) throw notFound()
    return reply.code(204).send()
  })
}
