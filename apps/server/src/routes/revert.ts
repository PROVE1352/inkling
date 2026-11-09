import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { revertChangeSchema, revertPageSchema, revertWorkspaceSchema } from '@inkling/shared'
import type { ActivityItemDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { notFound } from '../errors'
import { idParam, requireMembership, requireMembershipAcl } from '../helpers'
import { requestLocale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { memberOrGuestSql } from '../pageGrants'
import { revertChanges, revertInfo } from '../revert'
import { pageInRangeSql } from '../tokenRange'
import { requireManager } from '../workspaceAdmin'

/**
 * Reverting logged changes (docs/adr/1620-* .. 1624-*). People only (agents get 403 PEOPLE_DECIDE);
 * every route takes `dryRun` for the preview.
 *
 *   GET  /pages/:id/changes?before=&limit=   the page's own change log, newest first, with revert facts
 *   POST /changes/:seq/revert {dryRun}        one change (edit access to its page)
 *   POST /pages/:id/revert {seqs | via, actorId, since, until, dryRun}
 *                                             explicit changes, or one agent's changes on the page in a period
 *   POST /workspaces/:id/revert {via, actorId, since, until, dryRun}
 *                                             one agent's changes in the workspace (owners and admins);
 *                                             each page is written all or nothing, locked pages are reported
 */

const seqParams = z.object({ seq: z.string().regex(/^\d{1,19}$/) })
const pageChangesQuery = z.object({
  before: z.string().regex(/^\d{1,19}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export async function registerRevertRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/changes', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const page = await findVisiblePage(idParam(req.params), user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    const q = pageChangesQuery.parse(req.query)
    const limit = q.limit ?? 20
    const rows = (await db.execute(sql`
      SELECT c.seq::text AS seq, c.page_id AS "pageId", c.kind, c.anchor, c.heading_path AS "headingPath",
             c.actor_id AS "actorId", u.name AS "actorName", c.via_client AS via, c.changed_at AS "changedAt",
             c.large, (c.before_text IS NOT NULL OR c.after_text IS NOT NULL) AS "hasText"
        FROM page_changes c
        LEFT JOIN users u ON u.id = c.actor_id
       WHERE c.page_id = ${page.id} AND (c.scope = 'shared' OR c.owner_id = ${user.id})
         AND ${pageInRangeSql(sql`c.page_id`, sql`c.workspace_id`, user.id)}
         ${q.before ? sql`AND c.seq < ${q.before}::bigint` : sql``}
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
    }[]
    const more = rows.length > limit
    const list = rows.slice(0, limit)
    const info = await revertInfo(page.workspaceId, list)
    const items: ActivityItemDTO[] = list.map((r) => ({
      seq: r.seq,
      pageId: r.pageId,
      pageTitle: page.title,
      kind: r.kind,
      anchor: r.anchor,
      headingPath: r.headingPath,
      actor: r.actorId && r.actorName !== null ? { id: r.actorId, name: r.actorName } : null,
      via: r.via,
      changedAt: new Date(r.changedAt).toISOString(),
      large: r.large,
      hasDiff: r.hasText && !r.large,
      pageCreatedVia: null,
      revert: info.get(r.seq),
    }))
    return { items, next: more ? list[list.length - 1].seq : null }
  })

  app.post(
    '/changes/:seq/revert',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const { seq } = seqParams.parse(req.params)
      const body = revertChangeSchema.parse(req.body ?? {})
      // Where the change lives; someone who cannot see it gets the same 404 as for a seq that does not exist.
      const [row] = (await db.execute(sql`
        SELECT c.workspace_id AS "workspaceId", c.page_id AS "pageId"
          FROM page_changes c
          JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL AND (p.scope = 'shared' OR p.created_by = ${user.id})
           AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, user.id)}
         WHERE c.seq = ${seq}::bigint AND (c.scope = 'shared' OR c.owner_id = ${user.id})
           AND ${memberOrGuestSql(sql`c.workspace_id`, user.id, false)}
      `)) as unknown as { workspaceId: string; pageId: string }[]
      if (!row) throw notFound()
      await requireMembership(row.workspaceId, user.id)
      return revertChanges(user, { workspaceId: row.workspaceId, pageId: row.pageId, seqs: [seq] }, { dryRun: !!body.dryRun, locale: () => requestLocale(req, user.id) })
    },
  )

  app.post(
    '/pages/:id/revert',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const page = await findVisiblePage(idParam(req.params), user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)
      const body = revertPageSchema.parse(req.body ?? {})
      return revertChanges(
        user,
        { workspaceId: page.workspaceId, pageId: page.id, seqs: body.seqs, via: body.via, actorId: body.actorId, since: body.since, until: body.until },
        { dryRun: !!body.dryRun, locale: () => requestLocale(req, user.id) },
      )
    },
  )

  app.post(
    '/workspaces/:id/revert',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const workspaceId = idParam(req.params)
      const { role } = await requireMembershipAcl(workspaceId, user.id)
      requireManager(role)
      const body = revertWorkspaceSchema.parse(req.body ?? {})
      return revertChanges(
        user,
        { workspaceId, via: body.via, actorId: body.actorId, since: body.since, until: body.until },
        { dryRun: !!body.dryRun, locale: () => requestLocale(req, user.id) },
      )
    },
  )
}
