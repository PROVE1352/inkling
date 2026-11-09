import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createCommentSchema } from '@inkling/shared'
import type { CommentDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { broadcastToPage } from '../collab'
import { currentAgent } from '../agentAccess'
import { notifyOutboxRow } from '../notify/engine'
import type { Recipient } from '../notify/engine'
import { db } from '../db/index'
import { comments, users } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership, requireMembershipAcl } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { assertPageCommentable, assertPageEditable, CAP_COMMENT } from '../editLock'
import { gatedWriteSql, gateWrite } from '../aclVersion'
import type { CheckedAccess } from '../aclVersion'
import { assertAgentAllowed } from '../agentAccess'
import { outboxCommitted, outboxInsertSql, outboxTopics } from '../outbox'
import type { Exec, OutboxRow } from '../outbox'
import { webhookOutboxRows } from '../webhooks'
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
    // Guests read the comments of pages shared with them (findVisiblePage is narrowed, docs/adr/1252-*).
    await requireMembership(page.workspaceId, user.id, { guests: true })

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
      // Membership + access version, and what the events need (thread root, participants, page
      // creator/owner, mentioned members), read in parallel.
      const [{ role, acl }, ctx] = await Promise.all([
        requireMembershipAcl(page.workspaceId, user.id, { guests: true }),
        commentContext(id, page.workspaceId, body.threadId ?? null, body.mentionUserIds ?? []),
      ])
      // Comments are their own bit: people keep commenting on locked pages; a lock can take it away
      // from agents only (docs/adr/0970-*). No walk without a lock in the workspace (docs/adr/1071-*).
      await assertPageCommentable(id, user.id, role, acl)

      const commentId = randomUUID()
      let threadId: string
      let blockId: string

      if (body.threadId) {
        // Reply: the thread root must belong to this page and be a real root (id === threadId).
        if (ctx.rootBlockId === null) throw badRequest('Thread not found')
        threadId = body.threadId
        // Replies anchor to the same block as the thread root (thread consistency).
        blockId = ctx.rootBlockId
      } else {
        // New thread: threadId = its own id.
        threadId = commentId
        blockId = body.blockId
      }

      const events = await commentEvents({
        pageId: id,
        workspaceId: page.workspaceId,
        threadId,
        commentId,
        actorId: user.id,
        via: user.via ?? null,
        isReply: !!body.threadId,
        body: body.body,
        ctx,
      })
      const values = {
        id: commentId,
        pageId: id,
        blockId,
        threadId,
        authorId: user.id,
        body: body.body,
        // MCP (bearer) posts carry the OAuth client name; browser sessions leave it null.
        viaClient: user.via ?? null,
      }
      // The comment, its notification event and its webhook deliveries commit together, under the
      // write gate (docs/adr/1150-*): one statement while the access version and role are still the
      // ones checked above; otherwise re-checked and written in a gated transaction.
      await gatedCommentWrite(page.workspaceId, user.id, { role, acl }, id, (exec, checked) =>
        insertCommentWithEvents(exec, page.workspaceId, user.id, checked, values, events),
      )
      outboxCommitted(outboxTopics(events).topics)

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
    const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id, { guests: true })
    await assertPageCommentable(comment.pageId, user.id, role, acl)

    const updates: { resolved?: '0' | '1'; body?: string } = {}

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

    // Under the write gate, like the POST (docs/adr/1150-*).
    await gatedCommentWrite(page.workspaceId, user.id, { role, acl }, comment.pageId, (exec, checked) =>
      updateComment(exec, page.workspaceId, user.id, checked, id, updates),
    )

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
    const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id, { guests: true })
    // Deleting needs the COMMENT bit like posting and editing (edit lock and page levels,
    // docs/adr/0970-*, 0971-*, 1251-*): an agent under "agents: read" or a person with a view
    // level cannot remove threads either.
    await assertPageCommentable(comment.pageId, user.id, role, acl)

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

interface CommentContext {
  createdBy: string | null
  ownerId: string | null
  /** Block of the thread root when `threadId` is a root of this page, else null. */
  rootBlockId: string | null
  /** Authors in the thread so far (replies). */
  participants: string[]
  /** Of the mentioned ids, the members of the workspace. */
  mentioned: string[]
}

/** One statement: everything a new comment's checks and events read besides the membership. */
async function commentContext(pageId: string, workspaceId: string, threadId: string | null, mentionUserIds: string[]): Promise<CommentContext> {
  const ids = `{${[...new Set(mentionUserIds)].join(',')}}`
  const [r] = (await db.execute(sql`
    SELECT p.created_by AS "createdBy", p.owner_id AS "ownerId",
           (SELECT c.block_id FROM comments c WHERE c.id = ${threadId} AND c.thread_id = ${threadId} AND c.page_id = ${pageId}) AS "rootBlockId",
           CASE WHEN ${threadId}::uuid IS NULL THEN '{}'::uuid[] ELSE
             (SELECT coalesce(array_agg(DISTINCT c.author_id), '{}') FROM comments c WHERE c.thread_id = ${threadId} AND c.author_id IS NOT NULL) END AS participants,
           (SELECT coalesce(array_agg(m.user_id), '{}') FROM workspace_members m
             WHERE m.workspace_id = ${workspaceId} AND m.user_id = ANY(${ids}::uuid[])) AS mentioned
      FROM pages p WHERE p.id = ${pageId}
  `)) as unknown as CommentContext[]
  return r ?? { createdBy: null, ownerId: null, rootBlockId: null, participants: [], mentioned: [] }
}

/**
 * Outbox rows of a new comment (A3, docs/adr/1000-*, 1150-*). Notification recipients and their kind:
 *   - members in mentionUserIds                         → 'comment_mention' (direct)
 *   - earlier participants of the thread (on a reply)    → 'comment_reply' (direct)
 *   - the page's creator and document owner              → 'comment' (implicit: no subscription needed)
 *   - subscribers at level 'all'                          → 'comment' (activity)
 * The engine keeps one row per person (highest kind), never the actor, only people who can see
 * the page, applies subscription levels and collapses repeats per thread. Plus the workspace
 * webhooks (Slack/Discord; the shared-page gate is applied at delivery). Agent-written mentions do
 * not ping a channel (docs/adr/1000-*). The rows commit with the comment; the request does not wait
 * for recipients.
 */
async function commentEvents(args: {
  pageId: string
  workspaceId: string
  threadId: string
  commentId: string
  actorId: string
  via: string | null
  isReply: boolean
  body: string
  ctx: CommentContext
}): Promise<OutboxRow[]> {
  const { pageId, workspaceId, threadId, commentId, actorId, via, isReply, body, ctx } = args
  const recipients: Recipient[] = []
  for (const id of [ctx.createdBy, ctx.ownerId]) {
    if (id) recipients.push({ userId: id, kind: 'comment', reason: 'implicit' })
  }
  if (isReply) {
    for (const id of ctx.participants) recipients.push({ userId: id, kind: 'comment_reply', reason: 'direct' })
  }
  // Mentions: workspace members only (the engine re-checks membership and visibility).
  const mentioned = ctx.mentioned.filter((m) => m !== actorId)
  for (const id of mentioned) recipients.push({ userId: id, kind: 'comment_mention', reason: 'direct' })

  const rows: OutboxRow[] = []
  const n = notifyOutboxRow({
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
  if (n) rows.push(n)
  rows.push(...(await webhookOutboxRows({ type: 'comment', workspaceId, pageId, actorId, commentId, via })))
  if (mentioned.length > 0 && !via) {
    rows.push(...(await webhookOutboxRows({ type: 'mention', workspaceId, pageId, actorId, commentId, mentionedUserIds: mentioned })))
  }
  return rows
}

/**
 * Runs `write` (one statement that returns `ok` from `gatedWriteSql`) with the access the request
 * checked. When the version or role moved on since (or the workspace has no acl row yet), re-checks
 * membership, agent block and the comment bit under `gateWrite` and writes in that transaction.
 */
async function gatedCommentWrite(
  workspaceId: string,
  userId: string,
  checked: CheckedAccess,
  pageId: string,
  write: (exec: Exec, checked: CheckedAccess) => Promise<boolean>,
): Promise<void> {
  if (await write(db, checked)) return
  await db.transaction(async (tx) => {
    const gate =
      checked.role === 'guest' ? await gateWrite(tx, workspaceId, userId, { guests: true }) : await gateWrite(tx, workspaceId, userId)
    if (!gate.role) throw forbidden()
    await assertAgentAllowed(workspaceId, gate.acl.version, tx)
    await assertPageEditable(pageId, userId, { role: gate.role, acl: gate.acl, exec: tx, bit: CAP_COMMENT })
    if (!(await write(tx, gate))) throw new Error('comment write: gate changed inside its own transaction')
  })
}

async function insertCommentWithEvents(
  exec: Exec,
  workspaceId: string,
  userId: string,
  checked: CheckedAccess,
  v: { id: string; pageId: string; blockId: string; threadId: string; authorId: string; body: string; viaClient: string | null },
  events: OutboxRow[],
): Promise<boolean> {
  const g = gatedWriteSql(workspaceId, userId, checked)
  const queue = events.length
    ? sql`, queued AS (${outboxInsertSql(events, sql`EXISTS (SELECT 1 FROM written)`)})`
    : sql``
  const [r] = (await exec.execute(sql`
    WITH ${g.ctes},
      written AS (
        INSERT INTO comments (id, page_id, block_id, thread_id, author_id, body, via_client)
        SELECT ${v.id}, ${v.pageId}, ${v.blockId}, ${v.threadId}, ${v.authorId}, ${v.body}, ${v.viaClient} FROM gate_ok
        RETURNING id
      )${queue}
    SELECT ${g.columns}
  `)) as unknown as { ok: boolean }[]
  return !!r?.ok
}

async function updateComment(
  exec: Exec,
  workspaceId: string,
  userId: string,
  checked: CheckedAccess,
  id: string,
  updates: { resolved?: '0' | '1'; body?: string },
): Promise<boolean> {
  const g = gatedWriteSql(workspaceId, userId, checked)
  const [r] = (await exec.execute(sql`
    WITH ${g.ctes},
      written AS (
        UPDATE comments SET resolved = coalesce(${updates.resolved ?? null}::text, resolved), body = coalesce(${updates.body ?? null}::text, body)
         WHERE id = ${id} AND EXISTS (SELECT 1 FROM gate_ok)
        RETURNING id
      )
    SELECT ${g.columns}
  `)) as unknown as { ok: boolean }[]
  return !!r?.ok
}
