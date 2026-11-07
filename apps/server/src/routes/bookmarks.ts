import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { BookmarkDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { bookmarks, pages } from '../db/schema'
import { notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage, visibleTo } from '../pageDto'

export async function registerBookmarkRoutes(app: FastifyInstance): Promise<void> {
  // My bookmarks — live pages of the workspace visible to me only, sortOrder asc.
  app.get('/workspaces/:id/bookmarks', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)

    const rows = await db
      .select({
        pageId: bookmarks.pageId,
        sortOrder: bookmarks.sortOrder,
        title: pages.title,
        icon: pages.icon,
        kind: pages.kind,
        workspaceId: pages.workspaceId,
      })
      .from(bookmarks)
      .innerJoin(pages, eq(pages.id, bookmarks.pageId))
      .where(
        and(
          eq(bookmarks.userId, user.id),
          eq(pages.workspaceId, id),
          isNull(pages.deletedAt),
          visibleTo(user.id),
        ),
      )
      .orderBy(asc(bookmarks.sortOrder))

    const result: BookmarkDTO[] = rows.map((r) => ({
      pageId: r.pageId,
      title: r.title,
      icon: r.icon,
      kind: r.kind,
      workspaceId: r.workspaceId,
      sortOrder: r.sortOrder,
    }))
    return { bookmarks: result }
  })

  // Toggle a bookmark — findVisiblePage guard. Delete if present (off), else insert at my max+1000 (on).
  app.post('/pages/:id/bookmark', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const existing = (
      await db
        .select({ pageId: bookmarks.pageId })
        .from(bookmarks)
        .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.pageId, id)))
        .limit(1)
    )[0]

    if (existing) {
      await db
        .delete(bookmarks)
        .where(and(eq(bookmarks.userId, user.id), eq(bookmarks.pageId, id)))
      return { bookmarked: false }
    }

    const [{ maxSort }] = await db
      .select({ maxSort: sql<number | null>`max(${bookmarks.sortOrder})` })
      .from(bookmarks)
      .where(eq(bookmarks.userId, user.id))
    const nextSort = (maxSort ?? 0) + 1000

    await db
      .insert(bookmarks)
      .values({ userId: user.id, pageId: id, sortOrder: nextSort })
      .onConflictDoNothing()
    return { bookmarked: true }
  })
}
