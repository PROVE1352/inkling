import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { followThreadSchema, THREADS_LIST_MAX, threadsQuerySchema } from '@inkling/shared'
import type { ThreadFollowDTO, ThreadListDTO, ThreadSummaryDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { broadcastToUser } from '../collab'
import { db } from '../db/index'
import { notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { targetVisibleSql } from '../later'
import { findVisiblePage } from '../pageDto'

/**
 * Followed comment threads (docs/adr/1412-*).
 *
 * A follow row is written when someone starts or replies in a thread (unless they turned
 * auto-follow off) or with the follow button; `following = false` remembers an unfollow. The
 * followers are the recipients of `comment_reply` (routes/comments.ts). The Threads view below is
 * computed from `comments` at read time: replies by someone else newer than `last_read_at`.
 */

const excerpt = (s: string | null, max = 200): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The thread root (id = thread_id) and its page, visible to the caller; 404 otherwise. */
async function visibleThread(threadId: string, userId: string): Promise<{ pageId: string; workspaceId: string }> {
  const [c] = (await db.execute(sql`
    SELECT page_id AS "pageId" FROM comments WHERE id = ${threadId} AND thread_id = id
  `)) as unknown as { pageId: string }[]
  if (!c) throw notFound('NOT_FOUND', 'Thread not found')
  const page = await findVisiblePage(c.pageId, userId)
  if (!page) throw notFound('NOT_FOUND', 'Thread not found')
  await requireMembership(page.workspaceId, userId, { guests: true })
  return { pageId: c.pageId, workspaceId: page.workspaceId }
}

/** Mark a thread read: the Threads view and the bell items of that thread (reply, comment, mention). */
export async function markThreadRead(userId: string, threadId: string): Promise<number> {
  await db.execute(sql`
    UPDATE thread_follows SET last_read_at = now(), updated_at = now() WHERE user_id = ${userId} AND thread_id = ${threadId}
  `)
  const rows = (await db.execute(sql`
    UPDATE notifications SET read = '1'
     WHERE user_id = ${userId} AND read = '0'
       AND group_key IN (${`cr:${threadId}`}, ${`c:${threadId}`}, ${`cm:${threadId}`})
    RETURNING id
  `)) as unknown as { id: string }[]
  if (rows.length) broadcastToUser(userId, { t: 'notifications' })
  return rows.length
}

export async function readThreads(userId: string, workspaceId: string, all: boolean): Promise<ThreadListDTO> {
  const rows = (await db.execute(sql`
    WITH f AS (
      SELECT thread_id, last_read_at FROM thread_follows
       WHERE user_id = ${userId} AND workspace_id = ${workspaceId} AND following
    ), s AS (
      SELECT f.thread_id, f.last_read_at,
             count(*) FILTER (WHERE c.id <> f.thread_id)::int AS replies,
             count(*) FILTER (WHERE c.id <> f.thread_id AND c.created_at > f.last_read_at
                               AND c.author_id IS DISTINCT FROM ${userId})::int AS "newReplies",
             max(c.created_at) AS "lastActivityAt"
        FROM f JOIN comments c ON c.thread_id = f.thread_id
       GROUP BY f.thread_id, f.last_read_at
    ), v AS (
      SELECT s.*, r.page_id, r.block_id, r.resolved, r.body AS root_body, r.author_id AS root_author_id,
             p.title, p.workspace_id
        FROM s
        JOIN comments r ON r.id = s.thread_id
        JOIN pages p ON p.id = r.page_id
       WHERE ${targetVisibleSql(userId)}
         ${all ? sql`` : sql`AND s."newReplies" > 0`}
    )
    SELECT v.thread_id AS "threadId", v.page_id AS "pageId", v.workspace_id AS "workspaceId", v.title AS "pageTitle",
           v.block_id AS "blockId", v.resolved, ra.name AS "rootAuthor", left(v.root_body, 400) AS "rootBody",
           v."newReplies", v.replies, v."lastActivityAt", v.last_read_at AS "lastReadAt",
           lr.body AS "lastBody", lr.created_at AS "lastAt", lr.name AS "lastAuthor",
           count(*) FILTER (WHERE v."newReplies" > 0) OVER () AS unread
      FROM v
      LEFT JOIN users ra ON ra.id = v.root_author_id
      LEFT JOIN LATERAL (
        SELECT left(c.body, 400) AS body, c.created_at, u.name FROM comments c LEFT JOIN users u ON u.id = c.author_id
         WHERE c.thread_id = v.thread_id AND c.id <> v.thread_id
         ORDER BY c.created_at DESC LIMIT 1
      ) lr ON true
     ORDER BY v."lastActivityAt" DESC, v.thread_id
     LIMIT ${THREADS_LIST_MAX}
  `)) as unknown as {
    threadId: string
    pageId: string
    workspaceId: string
    pageTitle: string | null
    blockId: string
    resolved: '0' | '1'
    rootAuthor: string | null
    rootBody: string | null
    newReplies: number
    replies: number
    lastActivityAt: Date | string
    lastReadAt: Date | string
    lastBody: string | null
    lastAt: Date | string | null
    lastAuthor: string | null
    unread: string | number
  }[]
  const threads: ThreadSummaryDTO[] = rows.map((r) => ({
    threadId: r.threadId,
    pageId: r.pageId,
    workspaceId: r.workspaceId,
    pageTitle: r.pageTitle ?? '',
    blockId: r.blockId,
    resolved: r.resolved === '1',
    rootAuthor: r.rootAuthor,
    rootExcerpt: excerpt(r.rootBody),
    newReplies: Number(r.newReplies),
    replies: Number(r.replies),
    lastReply: r.lastAt ? { author: r.lastAuthor, excerpt: excerpt(r.lastBody), createdAt: new Date(r.lastAt).toISOString() } : null,
    lastActivityAt: new Date(r.lastActivityAt).toISOString(),
    lastReadAt: new Date(r.lastReadAt).toISOString(),
  }))
  return { threads, unread: rows.length ? Number(rows[0].unread) : 0 }
}

async function followState(userId: string, threadId: string): Promise<ThreadFollowDTO> {
  const [r] = (await db.execute(sql`
    SELECT following, source FROM thread_follows WHERE user_id = ${userId} AND thread_id = ${threadId}
  `)) as unknown as { following: boolean; source: 'auto' | 'manual' }[]
  return { threadId, following: r?.following ?? false, source: r?.source ?? null }
}

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  // The Threads view: followed threads with new replies (or all followed threads with all=1), newest activity first.
  app.get('/threads', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const q = threadsQuerySchema.parse(req.query)
    await requireMembership(q.workspaceId, user.id, { guests: true })
    return readThreads(user.id, q.workspaceId, q.all)
  })

  // My follow rows on one page (the comment panel's follow buttons).
  app.get('/pages/:id/thread-follows', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id, { guests: true })
    const rows = (await db.execute(sql`
      SELECT thread_id AS "threadId", following, source FROM thread_follows WHERE user_id = ${user.id} AND page_id = ${id}
    `)) as unknown as ThreadFollowDTO[]
    return { follows: rows }
  })

  app.get('/threads/:id/follow', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await visibleThread(id, user.id)
    return followState(user.id, id)
  })

  // Follow / unfollow. Following by hand starts "read" now: earlier replies are not listed as new.
  app.put('/threads/:id/follow', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const b = followThreadSchema.parse(req.body)
    const t = await visibleThread(id, user.id)
    await db.execute(sql`
      INSERT INTO thread_follows (user_id, thread_id, page_id, workspace_id, following, source, last_read_at)
      VALUES (${user.id}, ${id}, ${t.pageId}, ${t.workspaceId}, ${b.following}, 'manual', now())
      ON CONFLICT (user_id, thread_id) DO UPDATE SET
        following = EXCLUDED.following,
        source = CASE WHEN thread_follows.following = EXCLUDED.following THEN thread_follows.source ELSE 'manual' END,
        last_read_at = CASE WHEN NOT thread_follows.following AND EXCLUDED.following THEN now() ELSE thread_follows.last_read_at END,
        updated_at = now()
    `)
    return followState(user.id, id)
  })

  // Opened from the Threads view (or the comment panel): read up to now, bell items of the thread too.
  app.post('/threads/:id/read', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await visibleThread(id, user.id)
    const notifications = await markThreadRead(user.id, id)
    return { ok: true, notificationsRead: notifications }
  })
}
