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
import { twoFactorBlockedSql } from '../twoFactorPolicy'
import { registerNotificationSettingsRoutes } from './notificationSettings'
import { currentRange, rangeWorkspaceSql } from '../tokenRange'

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
    // A workspace whose 2FA requirement blocks the user (docs/adr/1112-*): its page notifications
    // (titles) are held back until 2FA is on; they come back then.
    or(isNull(notifications.pageId), sql`not ${twoFactorBlockedSql(pages.workspaceId, userId)}`),
    // ...and its workspace-level notifications (AI summaries carry page titles), except the
    // `workspace_deleted` notice (docs/adr/1300-*).
    or(
      isNull(notifications.workspaceId),
      eq(notifications.type, 'workspace_deleted'),
      sql`not ${twoFactorBlockedSql(notifications.workspaceId, userId)}`,
    ),
    // Soft-deleted workspace (ADR 0910): its page and workspace notifications disappear with it,
    // except the `workspace_deleted` notice itself, which is the point.
    or(isNull(notifications.pageId), liveWorkspace(pages.workspaceId)),
    // A range-limited connection (docs/adr/1200-*): workspace notifications of workspaces in range
    // only (page notifications are narrowed by visibleTo above). `true` otherwise.
    or(isNull(notifications.workspaceId), rangeWorkspaceSql(notifications.workspaceId, currentRange(userId))),
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
    .where(and(visibleNotifCond(userId), eq(notifications.read, '0'), eq(notifications.delivery, 'now')))
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
        via: notifications.viaClient,
        count: notifications.count,
        excerpt: notifications.excerpt,
        anchor: notifications.anchor,
        delivery: notifications.delivery,
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
      via: r.via,
      count: r.count,
      excerpt: r.excerpt,
      anchor: r.anchor,
      quiet: r.delivery === 'quiet',
    }))

    const unread = await countUnread(user.id)
    return { notifications: result, unread }
  })

  // Mark read: the given ids, or all when absent (or empty). Mine only.
  app.post('/notifications/read', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { ids } = markReadSchema.parse(req.body ?? {})

    // A range-limited connection marks only notifications it can see (docs/adr/1200-*).
    const visibleOnly = currentRange(user.id)
      ? inArray(
          notifications.id,
          db.select({ id: notifications.id }).from(notifications).leftJoin(pages, eq(pages.id, notifications.pageId)).where(visibleNotifCond(user.id)),
        )
      : undefined
    if (ids && ids.length > 0) {
      await db
        .update(notifications)
        .set({ read: '1' })
        .where(and(eq(notifications.userId, user.id), inArray(notifications.id, ids), visibleOnly))
      // Opening one comment item reads its thread in the Threads view too (docs/adr/1412-*); "mark all
      // read" does not: the Threads view is the list of what is left to read.
      await db.execute(sql`
        UPDATE thread_follows f SET last_read_at = now(), updated_at = now()
          FROM notifications n JOIN comments c ON c.id = n.comment_id
         WHERE n.user_id = ${user.id} AND n.id = ANY(${`{${ids.join(',')}}`}::uuid[])
           AND n.type IN ('comment', 'comment_reply', 'comment_mention')
           AND f.user_id = ${user.id} AND f.thread_id = c.thread_id
      `)
    } else {
      await db
        .update(notifications)
        .set({ read: '1' })
        .where(and(eq(notifications.userId, user.id), eq(notifications.read, '0'), visibleOnly))
    }

    const unread = await countUnread(user.id)
    return { unread }
  })

  await registerNotificationSettingsRoutes(app)
}
