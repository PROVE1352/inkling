import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { LargePageDTO, LargePagesDTO, PageSizeDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { isLargePage, LARGE_PAGE_STATE_BYTES, LARGE_PAGE_TOKENS, stateBytesV1Sql, V2_TO_V1_BYTES } from '../context/largePage'
import { db } from '../db/index'
import { forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage, visibleTo } from '../pageDto'

/** Rows of the workspace list (largest first); a workspace with more large pages than this has bigger problems. */
const LIST_LIMIT = 100

/**
 * "Large page" notice for people (docs/adr/1103-*): the size facts of one page for the line above
 * the document, and the list of large pages for owners and admins in workspace settings. Same
 * thresholds as the agent hint (docs/adr/1043-*), read from columns only (no decode).
 */
export async function registerLargePageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/size', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    const [r] = (await db.execute(sql`
      SELECT coalesce((SELECT ${stateBytesV1Sql()} FROM page_docs d WHERE d.page_id = ${id}), 0)::bigint AS "stateBytes",
             coalesce((SELECT sum(c.token_estimate) FROM page_chunks c WHERE c.page_id = ${id}), 0)::bigint AS tokens
    `)) as unknown as { stateBytes: string | number; tokens: string | number }[]
    const stateBytes = Number(r?.stateBytes ?? 0)
    const tokens = Number(r?.tokens ?? 0)
    const dto: PageSizeDTO = { stateBytes, tokens, large: page.kind === 'doc' && isLargePage(stateBytes, tokens) }
    return dto
  })

  app.get('/workspaces/:id/large-pages', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const wsId = idParam(req.params)
    const role = await requireMembership(wsId, user.id)
    if (role !== 'owner' && role !== 'admin') throw forbidden('Only owners and admins can see this')
    // Candidates are found from page_docs sizes (TOAST header) and per-page token sums; the
    // history size is summed for the result rows only.
    const minStored = Math.floor(LARGE_PAGE_STATE_BYTES / V2_TO_V1_BYTES)
    const rows = (await db.execute(sql`
      WITH tok AS (
        SELECT c.page_id, sum(c.token_estimate)::bigint AS tokens
          FROM page_chunks c JOIN pages ON pages.id = c.page_id
         WHERE pages.workspace_id = ${wsId}
         GROUP BY c.page_id
      ), cand AS (
        SELECT pages.id, pages.title, pages.icon, pages.updated_at,
               coalesce(${stateBytesV1Sql()}, 0)::bigint AS "stateBytes", coalesce(tok.tokens, 0)::bigint AS tokens
          FROM pages
          LEFT JOIN page_docs d ON d.page_id = pages.id
          LEFT JOIN tok ON tok.page_id = pages.id
         WHERE pages.workspace_id = ${wsId}
           AND pages.kind = 'doc'
           AND pages.deleted_at IS NULL
           AND ${visibleTo(user.id)}
           AND (octet_length(d.state) >= ${minStored} OR tok.tokens >= ${LARGE_PAGE_TOKENS})
      )
      SELECT cand.*, coalesce(s.bytes, 0)::bigint AS "snapshotBytes", coalesce(s.n, 0)::int AS "snapshotCount"
        FROM cand
        LEFT JOIN LATERAL (
          SELECT sum(octet_length(ps.state)) AS bytes, count(*) AS n FROM page_snapshots ps WHERE ps.page_id = cand.id
        ) s ON true
       WHERE cand."stateBytes" >= ${LARGE_PAGE_STATE_BYTES} OR cand.tokens >= ${LARGE_PAGE_TOKENS}
       ORDER BY cand."stateBytes" DESC, cand.tokens DESC, cand.id
       LIMIT ${LIST_LIMIT}
    `)) as unknown as {
      id: string
      title: string
      icon: string | null
      updated_at: Date | string
      stateBytes: string | number
      tokens: string | number
      snapshotBytes: string | number
      snapshotCount: number
    }[]
    const pages: LargePageDTO[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      stateBytes: Number(r.stateBytes),
      tokens: Number(r.tokens),
      updatedAt: new Date(r.updated_at).toISOString(),
      snapshotBytes: Number(r.snapshotBytes),
      snapshotCount: Number(r.snapshotCount),
    }))
    const dto: LargePagesDTO = { pages, thresholds: { stateBytes: LARGE_PAGE_STATE_BYTES, tokens: LARGE_PAGE_TOKENS } }
    return dto
  })
}
