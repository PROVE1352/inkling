import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createCommentSchema } from '@inkling/shared'
import type { CommentDTO, NotificationType } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { broadcastToPage, broadcastToUser } from '../collab'
import { db } from '../db/index'
import { comments, notifications, pages, users, workspaceMembers } from '../db/schema'
import { badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { emitWebhookEvent } from '../webhooks'

/** Display name for a removed/deleted author (comments whose author_id was set null), in the viewer's locale. */
const DELETED_AUTHOR: Record<Locale, string> = { en: '(deleted user)', ko: '(삭제된 사용자)' }

const updateCommentSchema = z
  .object({
    resolved: z.boolean().optional(),
    body: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((d) => d.resolved !== undefined || d.body !== undefined, {
    message: 'Either resolved or body is required',
  })

/** Comment join row (with author name) → CommentDTO */
type CommentJoinRow = {
  id: string
  pageId: string
  blockId: string
  threadId: string
  authorId: string | null
  body: string
  resolved: '0' | '1'
  createdAt: Date
  authorName: string | null
}

function toCommentDTO(r: CommentJoinRow, deletedAuthor: string): CommentDTO {
  return {
    id: r.id,
    pageId: r.pageId,
    blockId: r.blockId,
    threadId: r.threadId,
    author: { id: r.authorId, name: r.authorName ?? deletedAuthor },
    body: r.body,
    resolved: r.resolved === '1',
    createdAt: r.createdAt.toISOString(),
  }
}

/** Join columns with the author name (users leftJoin) */
const commentJoinColumns = {
  id: comments.id,
  pageId: comments.pageId,
  blockId: comments.blockId,
  threadId: comments.threadId,
  authorId: comments.authorId,
  body: comments.body,
  resolved: comments.resolved,
  createdAt: comments.createdAt,
  authorName: users.name,
} as const

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  // All comments of a page (threads and replies as a flat array, createdAt asc). Visibility guard.
  app.get('/pages/:id/comments', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const rows = (await db
      .select(commentJoinColumns)
      .from(comments)
      .leftJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.pageId, id))
      .orderBy(asc(comments.createdAt))) as CommentJoinRow[]

    const deleted = rows.some((r) => r.authorName === null)
      ? DELETED_AUTHOR[await requestLocale(req, user.id)]
      : ''
    return { comments: rows.map((r) => toCommentDTO(r, deleted)) }
  })

  // Post a comment (new thread or reply) + notifications. Spam guard 30/min.
  app.post(
    '/pages/:id/comments',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const body = createCommentSchema.parse(req.body)

      const page = await findVisiblePage(id, user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)

      const commentId = randomUUID()
      let threadId: string
      let blockId: string

      if (body.threadId) {
        // Reply: the thread root must belong to this page and be a real root (id === threadId).
        const root = (
          await db
            .select({ blockId: comments.blockId })
            .from(comments)
            .where(
              and(
                eq(comments.id, body.threadId),
                eq(comments.threadId, body.threadId),
                eq(comments.pageId, id),
              ),
            )
            .limit(1)
        )[0]
        if (!root) throw badRequest('Thread not found')
        threadId = body.threadId
        // Replies anchor to the same block as the thread root (thread consistency).
        blockId = root.blockId
      } else {
        // New thread: threadId = its own id.
        threadId = commentId
        blockId = body.blockId
      }

      await db.insert(comments).values({
        id: commentId,
        pageId: id,
        blockId,
        threadId,
        authorId: user.id,
        body: body.body,
      })

      await generateCommentNotifications({
        pageId: id,
        workspaceId: page.workspaceId,
        threadId,
        commentId,
        actorId: user.id,
        mentionUserIds: body.mentionUserIds ?? [],
      })

      // Push to clients that have the page open (invalidate the comment list). The helper isolates failures.
      broadcastToPage(id, { t: 'comments' })

      const dto: CommentDTO = {
        id: commentId,
        pageId: id,
        blockId,
        threadId,
        author: { id: user.id, name: user.name },
        body: body.body,
        resolved: false,
        createdAt: new Date().toISOString(),
      }
      return { comment: dto }
    },
  )

  // Edit a comment: toggle resolved (thread root only) or edit the body (author only). Visibility guard.
  app.patch('/comments/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const patch = updateCommentSchema.parse(req.body)

    const comment = (
      await db
        .select({
          pageId: comments.pageId,
          threadId: comments.threadId,
          authorId: comments.authorId,
        })
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
    )[0]
    if (!comment) throw notFound()

    const page = await findVisiblePage(comment.pageId, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    const updates: Partial<typeof comments.$inferInsert> = {}

    if (patch.resolved !== undefined) {
      // resolve toggles only on the thread root (the root's resolved is the whole thread's state)
      if (comment.threadId !== id) {
        throw badRequest('Only the thread root can be resolved')
      }
      updates.resolved = patch.resolved ? '1' : '0'
    }

    if (patch.body !== undefined) {
      // only the author may edit the body
      if (comment.authorId !== user.id) {
        throw forbidden('Only the author can edit this comment')
      }
      updates.body = patch.body
    }

    await db.update(comments).set(updates).where(eq(comments.id, id))

    broadcastToPage(comment.pageId, { t: 'comments' })

    const author = alias(users, 'author')
    const row = (
      await db
        .select({ ...commentJoinColumns, authorName: author.name })
        .from(comments)
        .leftJoin(author, eq(author.id, comments.authorId))
        .where(eq(comments.id, id))
        .limit(1)
    )[0] as CommentJoinRow
    return {
      comment: toCommentDTO(row, row.authorName === null ? DELETED_AUTHOR[await requestLocale(req, user.id)] : ''),
    }
  })

  // Delete a comment: author or workspace owner. Deleting a thread root deletes its replies too.
  app.delete('/comments/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const comment = (
      await db
        .select({
          pageId: comments.pageId,
          threadId: comments.threadId,
          authorId: comments.authorId,
        })
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
    )[0]
    if (!comment) throw notFound()

    const page = await findVisiblePage(comment.pageId, user.id)
    if (!page) throw notFound()
    const role = await requireMembership(page.workspaceId, user.id)

    if (comment.authorId !== user.id && role !== 'owner') {
      throw forbidden('Only the author or an owner can delete this comment')
    }

    if (comment.threadId === id) {
      // thread root → cascade to replies (delete everything with this threadId)
      await db.delete(comments).where(eq(comments.threadId, id))
    } else {
      await db.delete(comments).where(eq(comments.id, id))
    }
    // Referencing notifications (notifications.comment_id) go away via onDelete cascade.

    broadcastToPage(comment.pageId, { t: 'comments' })

    return reply.code(204).send()
  })
}

/**
 * Notifications on comment creation (A3).
 *   (a) the page author (createdBy), unless it is me      — 'comment'
 *   (b) earlier participants of the thread (except me)     — 'comment'
 *   (c) workspace members in mentionUserIds (except me)   — 'comment_mention' (mention wins)
 * One notification per person (deduped), never to myself.
 */
async function generateCommentNotifications(args: {
  pageId: string
  workspaceId: string
  threadId: string
  commentId: string
  actorId: string
  mentionUserIds: string[]
}): Promise<void> {
  const { pageId, workspaceId, threadId, commentId, actorId, mentionUserIds } = args
  const recipients = new Map<string, NotificationType>()

  // (a) page author — pageColumns has no createdBy, so query it directly
  const [pageRow] = await db
    .select({ createdBy: pages.createdBy })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (pageRow?.createdBy && pageRow.createdBy !== actorId) {
    recipients.set(pageRow.createdBy, 'comment')
  }

  // (b) earlier thread participants (includes my new comment, but the actor is excluded)
  const participants = await db
    .selectDistinct({ authorId: comments.authorId })
    .from(comments)
    .where(eq(comments.threadId, threadId))
  for (const p of participants) {
    if (p.authorId && p.authorId !== actorId && !recipients.has(p.authorId)) {
      recipients.set(p.authorId, 'comment')
    }
  }

  // (c) mentions — workspace members only; a mention overrides 'comment' (more specific)
  const uniqueMentions = [...new Set(mentionUserIds)].filter((m) => m !== actorId)
  if (uniqueMentions.length > 0) {
    const members = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.userId, uniqueMentions),
        ),
      )
    for (const m of members) recipients.set(m.userId, 'comment_mention')
  }

  // Workspace webhooks (Slack/Discord) — fire-and-forget; shared-page-only gate is applied at delivery.
  emitWebhookEvent({ type: 'comment', workspaceId, pageId, actorId, commentId })
  const mentioned = [...recipients].filter(([, t]) => t === 'comment_mention').map(([id]) => id)
  if (mentioned.length > 0) {
    emitWebhookEvent({ type: 'mention', workspaceId, pageId, actorId, commentId, mentionedUserIds: mentioned })
  }

  if (recipients.size === 0) return

  await db.insert(notifications).values(
    [...recipients].map(([userId, type]) => ({
      userId,
      type,
      pageId,
      workspaceId,
      actorId,
      commentId,
    })),
  )

  // Signal each recipient's inbox channel right away. The helper isolates failures.
  for (const recipientId of recipients.keys()) {
    broadcastToUser(recipientId, { t: 'notifications' })
  }
}
