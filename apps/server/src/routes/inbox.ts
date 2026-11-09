import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { inboxAckSchema, inboxQuerySchema, INBOX_KINDS } from '@inkling/shared'
import type { InboxKind, WorkspaceRole } from '@inkling/shared'
import { agentAllowedSql } from '../agentAccess'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { CAP_COMMENT, CAP_EDIT, capsFor } from '../editLock'
import { requireMembership } from '../helpers'
import { KINDS, typesForInbox } from '../notify/kinds'
import type { NotifyKind } from '../notify/kinds'
import { liveWorkspace } from '../workspaceLive'
import { currentRange, pageInRangeSql } from '../tokenRange'
import { twoFactorBlockedSql } from '../twoFactorPolicy'

/**
 * Agent inbox (docs/adr/1003-*): the notifications addressed to the connecting person that an
 * agent can act on (mentions, replies, comments on their pages, assignments), in `seq` order after
 * a cursor, not yet acknowledged. Acknowledging is separate from the person's "read" mark: an agent
 * working through its inbox does not clear the bell, and the person reading the bell does not hide
 * work from the agent. GET so read-only tokens can list; ack is a write.
 */

export const INBOX_MAX_ITEMS = 100

export interface InboxItem {
  seq: string
  kind: InboxKind
  type: NotifyKind
  workspaceId: string | null
  pageId: string | null
  pageTitle: string | null
  anchor: string | null
  actorName: string | null
  via: string | null
  excerpt: string | null
  count: number
  createdAt: string
  /** The person already saw it in the app. */
  read: boolean
  /** What the agent may do on the page now (edit lock, docs/adr/0970-*). */
  can: 'edit' | 'comment' | 'read' | null
}

const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`

export async function readInbox(
  userId: string,
  q: { workspaceId?: string; cursor?: string; kinds?: InboxKind[] },
): Promise<{ items: InboxItem[]; more: boolean; unacked: number }> {
  const kinds = q.kinds?.length ? q.kinds : [...INBOX_KINDS]
  const types = typesForInbox(kinds)
  if (!types.length) return { items: [], more: false, unacked: 0 }
  const typeList = sql.join(types.map((t) => sql`${t}`), sql`, `)
  const where = sql`
    n.user_id = ${userId} AND n.acked_at IS NULL AND n.type IN (${typeList})
    ${q.workspaceId ? sql`AND coalesce(n.workspace_id, p.workspace_id) = ${q.workspaceId}` : sql``}
    AND (n.page_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND (p.scope = 'shared' OR p.created_by = ${userId})))
    AND (n.page_id IS NULL OR ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, userId)})
    AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = coalesce(n.workspace_id, p.workspace_id) AND m.user_id = ${userId})
    AND ${liveWorkspace(sql`coalesce(n.workspace_id, p.workspace_id)`)}
    AND ${agentAllowedSql(sql`coalesce(n.workspace_id, p.workspace_id)`)}
    AND NOT ${twoFactorBlockedSql(sql`coalesce(n.workspace_id, p.workspace_id)`, userId)}`
  const rows = (await db.execute(sql`
    SELECT n.seq::text AS seq, n.type, coalesce(n.workspace_id, p.workspace_id) AS "workspaceId", n.page_id AS "pageId",
           p.title AS "pageTitle", n.anchor, a.name AS "actorName", n.via_client AS via, n.excerpt, n.count,
           n.created_at AS "createdAt", n.read
      FROM notifications n
      LEFT JOIN pages p ON p.id = n.page_id
      LEFT JOIN users a ON a.id = n.actor_id
     WHERE ${where} ${q.cursor ? sql`AND n.seq > ${q.cursor}::bigint` : sql``}
     ORDER BY n.seq
     LIMIT ${INBOX_MAX_ITEMS + 1}
  `)) as unknown as {
    seq: string
    type: NotifyKind
    workspaceId: string | null
    pageId: string | null
    pageTitle: string | null
    anchor: string | null
    actorName: string | null
    via: string | null
    excerpt: string | null
    count: number
    createdAt: Date | string
    read: '0' | '1'
  }[]
  const [{ n: unacked }] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM notifications n LEFT JOIN pages p ON p.id = n.page_id WHERE ${where}
  `)) as unknown as { n: number }[]
  const more = rows.length > INBOX_MAX_ITEMS
  const list = rows.slice(0, INBOX_MAX_ITEMS)

  // Agent capabilities per page, one capsFor per workspace (role differs per workspace).
  const caps = new Map<string, number>()
  const byWs = new Map<string, string[]>()
  for (const r of list) {
    if (!r.pageId || !r.workspaceId) continue
    const l = byWs.get(r.workspaceId) ?? []
    l.push(r.pageId)
    byWs.set(r.workspaceId, l)
  }
  if (byWs.size) {
    const roles = (await db.execute(sql`
      SELECT workspace_id AS "workspaceId", role FROM workspace_members
       WHERE user_id = ${userId} AND workspace_id = ANY(${uuidArray([...byWs.keys()])})
    `)) as unknown as { workspaceId: string; role: WorkspaceRole }[]
    const roleOf = new Map(roles.map((r) => [r.workspaceId, r.role]))
    for (const [ws, pageIds] of byWs) {
      const m = await capsFor(db, [...new Set(pageIds)], { userId, role: roleOf.get(ws) ?? null, agent: true })
      for (const [pid, c] of m) caps.set(pid, c)
    }
  }
  const items: InboxItem[] = list.map((r) => {
    const c = r.pageId ? caps.get(r.pageId) : undefined
    return {
      seq: r.seq,
      kind: KINDS[r.type].inbox ?? 'comment',
      type: r.type,
      workspaceId: r.workspaceId,
      pageId: r.pageId,
      pageTitle: r.pageTitle,
      anchor: r.anchor,
      actorName: r.actorName,
      via: r.via,
      excerpt: r.excerpt,
      count: r.count,
      createdAt: new Date(r.createdAt).toISOString(),
      read: r.read === '1',
      can: c === undefined ? null : c & CAP_EDIT ? 'edit' : c & CAP_COMMENT ? 'comment' : 'read',
    }
  })
  return { items, more, unacked }
}

export async function registerInboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/inbox', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const q = inboxQuerySchema.parse(req.query)
    if (q.workspaceId) await requireMembership(q.workspaceId, user.id)
    return readInbox(user.id, q)
  })

  // Acknowledge inbox items: by seq ids, or everything up to and including a cursor.
  app.post('/inbox/ack', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const b = inboxAckSchema.parse(req.body)
    const types = sql.join(typesForInbox([...INBOX_KINDS]).map((t) => sql`${t}`), sql`, `)
    const byIds = b.ids?.length ? sql`seq = ANY(${`{${b.ids.join(',')}}`}::bigint[])` : sql`false`
    const byCursor = b.cursor ? sql`seq <= ${b.cursor}::bigint` : sql`false`
    // A range-limited connection acknowledges only items it could read (docs/adr/1200-*).
    const inRange = currentRange(user.id)
      ? sql`AND seq IN (SELECT n.seq FROM notifications n LEFT JOIN pages p ON p.id = n.page_id
             WHERE n.user_id = ${user.id}
               AND ${agentAllowedSql(sql`coalesce(n.workspace_id, p.workspace_id)`)}
               AND (n.page_id IS NULL OR ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, user.id)}))`
      : sql``
    const rows = (await db.execute(sql`
      UPDATE notifications SET acked_at = now()
       WHERE user_id = ${user.id} AND acked_at IS NULL AND type IN (${types}) AND (${byIds} OR ${byCursor}) ${inRange}
      RETURNING seq
    `)) as unknown as { seq: string }[]
    return { acked: rows.length }
  })
}
