/**
 * Chart data (docs/adr/1602-*).
 *
 *   POST /api/workspaces/:id/charts/aggregate  ChartAggregateInput → ChartDataDTO
 *
 * One endpoint for chart blocks, chart views and agents. A read: read-only tokens may call it.
 * Access is the collection query path's: membership of the workspace (range, two-step, guests
 * refused — requireMembership), then the collection as a page the viewer can see
 * (requireCollectionPage: visibility, live page, live workspace) in that same workspace, and a
 * view of that collection. Anything else is 404 NOT_FOUND, whether it is missing or hidden. A query
 * source runs as the viewer through the query block's own path (runWorkspaceQuery).
 */
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { chartAggregateSchema } from '@inkling/shared'
import type { ChartDataDTO, ViewConfig } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { aggregateCollection, aggregateQuery } from '../charts/aggregate'
import { db } from '../db/index'
import { collectionViews } from '../db/schema'
import { notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requireCollectionPage } from './collections'

const utcToday = () => new Date().toISOString().slice(0, 10)

export async function registerChartRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/workspaces/:id/charts/aggregate',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 240, timeWindow: '1 minute' }, bearerReadOnlyOk: true },
    },
    async (req): Promise<ChartDataDTO> => {
      const user = getUser(req)
      const workspaceId = idParam(req.params)
      await requireMembership(workspaceId, user.id)
      const body = chartAggregateSchema.parse(req.body)
      const { source, today, tzOffsetMinutes, ...input } = body
      if (source.type === 'query') {
        return aggregateQuery(user.id, workspaceId, source.query, input, today ?? utcToday(), tzOffsetMinutes ?? 0)
      }
      let page
      try {
        page = await requireCollectionPage(source.collectionId, user.id)
      } catch (err) {
        // not a collection (400 there) reads as not found here: the chart cannot tell kinds apart
        if ((err as { statusCode?: number; status?: number }).status === 400) throw notFound()
        throw err
      }
      if (page.workspaceId !== workspaceId) throw notFound()
      let view: { name: string; config: ViewConfig } | undefined
      if (source.viewId) {
        const [v] = await db
          .select({ pageId: collectionViews.pageId, name: collectionViews.name, config: collectionViews.config })
          .from(collectionViews)
          .where(eq(collectionViews.id, source.viewId))
          .limit(1)
        if (!v || v.pageId !== page.id) throw notFound()
        view = { name: v.name, config: (v.config ?? {}) as ViewConfig }
      }
      return aggregateCollection(
        { collectionId: page.id, workspaceId, title: page.title, ...(view ? { view } : {}) },
        input,
        { kind: 'user', userId: user.id },
      )
    },
  )
}
