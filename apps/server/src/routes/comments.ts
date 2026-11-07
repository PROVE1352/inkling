import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createCommentSchema } from '@inkling/shared'
import type { CommentDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { broadcastToPage } from '../collab'
import { currentAgent } from '../agentAccess'
import { notify } from '../notify/engine'
import type { Recipient } from '../notify/engine'
import { db } from '../db/index'
import { comments, pages, users, workspaceMembers } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { assertPageCommentable } from '../editLock'
import { emitWebhookEvent } from '../webhooks'
import { isManagerRole } from '../workspaceAdmin'

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
  viaClient: string | null
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
    viaClient: r.viaClient,
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
  viaClient: comments.viaClient,
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
      const role = await requireMembership(page.workspaceId, user.id)
      // Comments are their own bit: people keep commenting on locked pages; a lock can take it away
      // from agents only (docs/adr/0970-*).
      await assertPageCommentable(id, user.id, role)

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
        // MCP (bearer) posts carry the OAuth client name; browser sessions leave it null.
        viaClient: user.via ?? null,
      })

      await generateCommentNotifications({
        pageId: id,
        workspaceId: page.workspaceId,
        threadId,
        commentId,
        actorId: user.id,
        via: user.via ?? null,
        isReply: !!body.threadId,
        body: body.body,
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
        viaClient: user.via ?? null,
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
    const role = await requireMembership(page.workspaceId, user.id)
    await assertPageCommentable(comment.pageId, user.id, role)

    const updates: Partial<typeof comments.$inferInsert> = {}

    if (patch.resolved !== undefined) {
      // resolve toggles only on the thread root (the root's resolved is the whole thread's state)
      if (comment.threadId !== id) {
        throw badRequest('Only the thread root can be resolved')
      }
      // An agent closes only threads its own person started (docs/adr/1006-*): a remark someone
      // else made about the page stays open until a person resolves it.
      if (currentAgent() && comment.authorId !== user.id) {
        throw new AppError(
          403,
          'AGENT_RESOLVE_NOT_ALLOWED',
          'Agents can only resolve threads started by the person they act for; reply instead and let a person resolve it',
        )
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

    // owners and admins moderate comments (docs/adr/0945-*)
    if (comment.authorId !== user.id && !isManagerRole(role)) {
      throw forbidden('Only the author, an owner or an admin can delete this comment')
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
 * Notifications on comment creation (A3, docs/adr/1000-*). Recipients and their kind:
 *   - members in mentionUserIds                         → 'comment_mention' (direct)
 *   - earlier participants of the thread (on a reply)    → 'comment_reply' (direct)
 *   - the page's creator and document owner              → 'comment' (implicit: no subscription needed)
 *   - subscribers at level 'all'                          → 'comment' (activity)
 * The engine keeps one row per person (highest kind), never the actor, only people who can see
 * the page, applies subscription levels and collapses repeats per thread. Runs after the insert,
 * queued: the request does not wait for it.
 */
async function generateCommentNotifications(args: {
  pageId: string
  workspaceId: string
  threadId: string
  commentId: string
  actorId: string
  via: string | null
  isReply: boolean
  body: string
  mentionUserIds: string[]
}): Promise<void> {
  const { pageId, workspaceId, threadId, commentId, actorId, via, isReply, body, mentionUserIds } = args
  const recipients: Recipient[] = []

  const [pageRow] = await db
    .select({ createdBy: pages.createdBy, ownerId: pages.ownerId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  for (const id of [pageRow?.createdBy, pageRow?.ownerId]) {
    if (id) recipients.push({ userId: id, kind: 'comment', reason: 'implicit' })
  }

  if (isReply) {
    const participants = await db
      .selectDistinct({ authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.threadId, threadId))
    for (const p of participants) {
      if (p.authorId) recipients.push({ userId: p.authorId, kind: 'comment_reply', reason: 'direct' })
    }
  }

  // Mentions: workspace members only (the engine re-checks membership and visibility).
  const uniqueMentions = [...new Set(mentionUserIds)].filter((m) => m !== actorId)
  let mentioned: string[] = []
  if (uniqueMentions.length > 0) {
    const members = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, uniqueMentions)))
    mentioned = members.map((m) => m.userId)
    for (const id of mentioned) recipients.push({ userId: id, kind: 'comment_mention', reason: 'direct' })
  }

  // Workspace webhooks (Slack/Discord) — fire-and-forget; shared-page-only gate is applied at delivery.
  // Agent-written mentions do not ping a channel (docs/adr/1000-*).
  emitWebhookEvent({ type: 'comment', workspaceId, pageId, actorId, commentId, via })
  if (mentioned.length > 0 && !via) {
    emitWebhookEvent({ type: 'mention', workspaceId, pageId, actorId, commentId, mentionedUserIds: mentioned })
  }

  notify({
    workspaceId,
    pageId,
    actorId,
    via,
    recipients,
    followers: 'comment',
    commentId,
    threadId,
    anchor: null,
    excerpt: body,
  })
}
