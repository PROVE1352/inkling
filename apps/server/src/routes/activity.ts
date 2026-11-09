import { and, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { activityQuerySchema } from '@inkling/shared'
import type { ActivityItemDTO, ActivityPageDTO, ChangeDiffDTO, PageProvenanceDTO, SnapshotDiffDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { diffOps } from '../context/diff'
import { db } from '../db/index'
import { pageDocs, pageSnapshots } from '../db/schema'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { memberOrGuestSql } from '../pageGrants'
import { blocksToMarkdown, stateToBlocks } from '../md/convert'
import { findVisiblePage } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'
import { snapshotBlocks } from '../snapshotStore'
import type { AnyBlock } from '../md/convert'
import { pageInRangeSql } from '../tokenRange'

/**
 * Activity screen and diffs for people (docs/adr/1005-*). Reads the change log the agent feed
 * writes (page_changes, docs/adr/0932-*) with the same permission rule:
 *   - live membership of the row's workspace,
 *   - the row's visibility WHEN LOGGED (shared, or the caller owned the private page then),
 *   - the page's visibility NOW for its title (a trashed or privatised page keeps its rows but
 *     shows no title), and NOW for any text (diffs need the page to be visible now).
 */

const DEFAULT_LIMIT = 50
const PAGE_EVENT_KINDS = ['page_added', 'page_renamed', 'page_moved', 'page_trashed', 'page_restored', 'page_visibility']

function kindFilter(kind: string | undefined): SQL {
  if (kind === 'page') return sql`AND c.kind IN (${sql.join(PAGE_EVENT_KINDS.map((k) => sql`${k}`), sql`, `)})`
  if (kind === 'edit') return sql`AND c.kind NOT IN (${sql.join(PAGE_EVENT_KINDS.map((k) => sql`${k}`), sql`, `)})`
  return sql``
}

const diffParamsSchema = z.object({ seq: z.string().regex(/^\d{1,19}$/) })
const snapshotDiffParams = z.object({ id: z.uuid(), sid: z.uuid() })
const snapshotDiffQuery = z.object({ against: z.union([z.literal('current'), z.uuid()]).optional() })

/** A diff for display: whole lines kept (people read context), capped like the agent feed. */
function opsFor(before: string, after: string): { ops: ChangeDiffDTO['ops']; large: boolean } {
  const ops = diffOps(before, after)
  return ops ? { ops, large: false } : { ops: null, large: true }
}

async function markdownOf(state: Uint8Array | Buffer): Promise<string> {
  return markdownOfBlocks(stateToBlocks(state))
}

async function markdownOfBlocks(blocks: AnyBlock[]): Promise<string> {
  const { markdown } = await blocksToMarkdown(blocks, { assetMode: 'absolute' })
  return markdown
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  // Workspace activity, newest first, people and agents, filtered. Cursor = `before` (a seq).
  app.get('/workspaces/:id/activity', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const q = activityQuerySchema.parse(req.query)
    const limit = q.limit ?? DEFAULT_LIMIT
    const visibleNow = sql`(p.id IS NOT NULL AND p.deleted_at IS NULL AND (p.scope = 'shared' OR p.created_by = ${user.id}))`
    const rootFilter = q.rootId
      ? sql`AND c.page_id IN (
          WITH RECURSIVE sub AS (
            SELECT id, 0 AS depth FROM pages WHERE id = ${q.rootId} AND workspace_id = ${id}
            UNION ALL
            SELECT ch.id, sub.depth + 1 FROM pages ch JOIN sub ON ch.parent_id = sub.id WHERE sub.depth < 64
          ) SELECT id FROM sub)`
      : sql``
    const rows = (await db.execute(sql`
      SELECT c.seq::text AS seq, c.page_id AS "pageId", c.kind, c.anchor, c.heading_path AS "headingPath",
             c.actor_id AS "actorId", u.name AS "actorName", c.via_client AS via, c.changed_at AS "changedAt",
             c.large, (c.before_text IS NOT NULL OR c.after_text IS NOT NULL) AS "hasText",
             CASE WHEN ${visibleNow} THEN p.title END AS title,
             CASE WHEN ${visibleNow} THEN p.created_via END AS "createdVia"
        FROM page_changes c
        LEFT JOIN pages p ON p.id = c.page_id
        LEFT JOIN users u ON u.id = c.actor_id
       WHERE c.workspace_id = ${id}
         AND ${liveWorkspace(sql`c.workspace_id`)}
         AND (c.scope = 'shared' OR c.owner_id = ${user.id})
         AND ${pageInRangeSql(sql`c.page_id`, sql`c.workspace_id`, user.id)}
         ${q.before ? sql`AND c.seq < ${q.before}::bigint` : sql``}
         ${q.actor === 'human' ? sql`AND c.via_client IS NULL` : q.actor === 'ai' ? sql`AND c.via_client IS NOT NULL` : sql``}
         ${q.via ? sql`AND c.via_client = ${q.via}` : sql``}
         ${q.userId ? sql`AND c.actor_id = ${q.userId}` : sql``}
         ${kindFilter(q.kind)}
         ${q.aiPagesOnly === '1' ? sql`AND p.created_via IS NOT NULL AND ${visibleNow}` : sql``}
         ${rootFilter}
       ORDER BY c.seq DESC
       LIMIT ${limit + 1}
    `)) as unknown as {
      seq: string
      pageId: string
      kind: string
      anchor: string | null
      headingPath: string
      actorId: string | null
      actorName: string | null
      via: string | null
      changedAt: Date | string
      large: boolean
      hasText: boolean
      title: string | null
      createdVia: string | null
    }[]
    const more = rows.length > limit
    const page = rows.slice(0, limit)
    const items: ActivityItemDTO[] = page.map((r) => ({
      seq: r.seq,
      pageId: r.pageId,
      pageTitle: r.title,
      kind: r.kind,
      anchor: r.anchor,
      headingPath: r.headingPath,
      actor: r.actorId && r.actorName !== null ? { id: r.actorId, name: r.actorName } : null,
      via: r.via,
      changedAt: new Date(r.changedAt).toISOString(),
      large: r.large,
      // Texts are only shown for pages visible now.
      hasDiff: r.hasText && r.title !== null && !r.large,
      pageCreatedVia: r.createdVia,
    }))
    const clients = (await db.execute(sql`
      SELECT DISTINCT via_client AS via FROM page_changes
       WHERE workspace_id = ${id} AND via_client IS NOT NULL AND (scope = 'shared' OR owner_id = ${user.id})
         AND ${pageInRangeSql(sql`page_id`, sql`workspace_id`, user.id)}
       ORDER BY 1 LIMIT 50
    `)) as unknown as { via: string }[]
    const dto: ActivityPageDTO = { items, next: more ? page[page.length - 1].seq : null, clients: clients.map((c) => c.via) }
    return dto
  })

  // One change with its before/after and a line diff (people's view of a change-feed row).
  app.get('/changes/:seq/diff', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { seq } = diffParamsSchema.parse(req.params)
    const [row] = (await db.execute(sql`
      SELECT c.seq::text AS seq, c.workspace_id AS "workspaceId", c.page_id AS "pageId", c.kind, c.heading_path AS "headingPath",
             c.actor_id AS "actorId", u.name AS "actorName", c.via_client AS via, c.changed_at AS "changedAt",
             c.before_text AS before, c.after_text AS after, c.large, p.title
        FROM page_changes c
        JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL AND (p.scope = 'shared' OR p.created_by = ${user.id})
         AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, user.id)}
        LEFT JOIN users u ON u.id = c.actor_id
       WHERE c.seq = ${seq}::bigint
         AND (c.scope = 'shared' OR c.owner_id = ${user.id})
         AND ${liveWorkspace(sql`c.workspace_id`)}
         -- someone outside the workspace gets the same 404 as for a seq that does not exist (docs/adr/1301-*)
         AND ${memberOrGuestSql(sql`c.workspace_id`, user.id, false)}
    `)) as unknown as {
      seq: string
      workspaceId: string
      pageId: string
      kind: string
      headingPath: string
      actorId: string | null
      actorName: string | null
      via: string | null
      changedAt: Date | string
      before: string | null
      after: string | null
      large: boolean
      title: string
    }[]
    if (!row) throw notFound()
    await requireMembership(row.workspaceId, user.id)
    const d = row.large ? { ops: null, large: true } : opsFor(row.before ?? '', row.after ?? '')
    const dto: ChangeDiffDTO = {
      seq: row.seq,
      pageId: row.pageId,
      pageTitle: row.title,
      kind: row.kind,
      headingPath: row.headingPath,
      actor: row.actorId && row.actorName !== null ? { id: row.actorId, name: row.actorName } : null,
      via: row.via,
      changedAt: new Date(row.changedAt).toISOString(),
      before: row.before,
      after: row.after,
      ops: d.ops,
      large: row.large || d.large,
    }
    return dto
  })

  // Version history diff: a snapshot against the current document or another snapshot.
  app.get('/pages/:id/snapshots/:sid/diff', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id, sid } = snapshotDiffParams.parse(req.params)
    const { against = 'current' } = snapshotDiffQuery.parse(req.query)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    // Versions are rebuilt from their diff chains (docs/adr/1100-*); metadata is read on its own.
    const meta = async (sid2: string) =>
      (
        await db
          .select({ label: pageSnapshots.label, createdAt: pageSnapshots.createdAt })
          .from(pageSnapshots)
          .where(and(eq(pageSnapshots.id, sid2), eq(pageSnapshots.pageId, id)))
          .limit(1)
      )[0]
    const snap = await meta(sid)
    if (!snap) throw notFound()
    let to: SnapshotDiffDTO['to']
    let after: string
    if (against === 'current') {
      const cur = (await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, id)).limit(1))[0]
      after = cur?.state ? await markdownOf(cur.state) : ''
      to = { id: 'current', label: null, createdAt: null }
    } else {
      if (against === sid) throw badRequest('Pick a different version to compare with')
      const other = await meta(against)
      if (!other) throw notFound()
      const otherBlocks = await snapshotBlocks(id, against)
      if (!otherBlocks) throw notFound()
      after = await markdownOfBlocks(otherBlocks)
      to = { id: against, label: other.label, createdAt: other.createdAt.toISOString() }
    }
    const fromBlocks = await snapshotBlocks(id, sid)
    if (!fromBlocks) throw notFound()
    const before = await markdownOfBlocks(fromBlocks)
    const d = opsFor(before, after)
    const dto: SnapshotDiffDTO = {
      from: { id: sid, label: snap.label, createdAt: snap.createdAt.toISOString() },
      to,
      ops: d.ops,
      large: d.large,
    }
    return dto
  })

  // "Written by AI · last AI edit" badge of a page.
  app.get('/pages/:id/provenance', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    const [row] = (await db.execute(sql`
      SELECT p.created_via AS "createdVia", cu.name AS "createdByName", lc.changed_at AS at, lc.via_client AS via, au.name AS "actorName"
        FROM pages p
        LEFT JOIN users cu ON cu.id = p.created_by
        LEFT JOIN LATERAL (
          SELECT c.changed_at, c.via_client, c.actor_id FROM page_changes c
           WHERE c.page_id = p.id AND c.via_client IS NOT NULL
           ORDER BY c.seq DESC LIMIT 1
        ) lc ON true
        LEFT JOIN users au ON au.id = lc.actor_id
       WHERE p.id = ${id} AND (p.scope = 'shared' OR p.created_by = ${user.id})
    `)) as unknown as { createdVia: string | null; createdByName: string | null; at: Date | string | null; via: string | null; actorName: string | null }[]
    if (!row) throw notFound()
    const dto: PageProvenanceDTO = {
      createdVia: row.createdVia,
      createdByName: row.createdByName,
      lastAgentEdit: row.at && row.via ? { at: new Date(row.at).toISOString(), via: row.via, actorName: row.actorName } : null,
    }
    return dto
  })
}
