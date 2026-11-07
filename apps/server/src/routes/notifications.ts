import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { NotificationDTO, NotificationType } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { notifications, pages, users, workspaceMembers, workspaces } from '../db/schema'
import { visibleTo } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'

const markReadSchema = z.object({
  ids: z.array(z.uuid()).max(500).optional(),
})

/**
 * Notification visibility: mine, and either no pageId or the page is live and visible to me.
 * Notifications about deleted / invisible pages are hidden (reuses pageColumns visibleTo).
 * Use only in queries that leftJoin pages.
 */
function visibleNotifCond(userId: string): SQL {
  return and(
    eq(notifications.userId, userId),
    or(
      isNull(notifications.pageId),
      and(isNull(pages.deletedAt), visibleTo(userId)),
    ),
    // Page notifications only while still a member of the page's workspace (C-L11: a member who
    // left kept receiving comment/reminder notifications of shared pages, rows without
    // workspace_id included).
    or(
      isNull(notifications.pageId),
      sql`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${pages.workspaceId} and ${workspaceMembers.userId} = ${userId})`,
    ),
    // workspace notifications only while still a member
    or(
      isNull(notifications.workspaceId),
      sql`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${notifications.workspaceId} and ${workspaceMembers.userId} = ${userId})`,
    ),
    // Soft-deleted workspace (ADR 0910): its page and workspace notifications disappear with it,
    // except the `workspace_deleted` notice itself, which is the point.
    or(isNull(notifications.pageId), liveWorkspace(pages.workspaceId)),
    or(
      isNull(notifications.workspaceId),
      eq(notifications.type, 'workspace_deleted'),
      liveWorkspace(notifications.workspaceId),
    ),
  ) as SQL
}

/** Current unread count (over visible notifications). */
async function countUnread(userId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .leftJoin(pages, eq(pages.id, notifications.pageId))
    .where(and(visibleNotifCond(userId), eq(notifications.read, '0')))
  return n
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  // My latest 50 notifications + unread count. Joins pageTitle / actorName. Skips invisible pages.
  app.get('/notifications', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)

    const actor = alias(users, 'actor')
    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        pageId: notifications.pageId,
        read: notifications.read,
        createdAt: notifications.createdAt,
        pageTitle: pages.title,
        workspaceId: notifications.workspaceId,
        workspaceName: workspaces.name,
        actorName: actor.name,
      })
      .from(notifications)
      .leftJoin(pages, eq(pages.id, notifications.pageId))
      .leftJoin(workspaces, eq(workspaces.id, notifications.workspaceId))
      .leftJoin(actor, eq(actor.id, notifications.actorId))
      .where(visibleNotifCond(user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(50)

    const result: NotificationDTO[] = rows.map((r) => ({
      id: r.id,
      type: r.type as NotificationType,
      pageId: r.pageId,
      pageTitle: r.pageTitle ?? null,
      workspaceId: r.workspaceId ?? null,
      workspaceName: r.workspaceName ?? null,
      actorName: r.actorName ?? null,
      read: r.read === '1',
      createdAt: r.createdAt.toISOString(),
    }))

    const unread = await countUnread(user.id)
    return { notifications: result, unread }
  })

  // Mark read: the given ids, or all when absent (or empty). Mine only.
  app.post('/notifications/read', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { ids } = markReadSchema.parse(req.body ?? {})

    if (ids && ids.length > 0) {
      await db
        .update(notifications)
        .set({ read: '1' })
        .where(and(eq(notifications.userId, user.id), inArray(notifications.id, ids)))
    } else {
      await db
        .update(notifications)
        .set({ read: '1' })
        .where(and(eq(notifications.userId, user.id), eq(notifications.read, '0')))
    }

    const unread = await countUnread(user.id)
    return { unread }
  })
}
