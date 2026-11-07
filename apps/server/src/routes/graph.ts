import type { FastifyInstance } from 'fastify'
import { getUser, requireUser } from '../auth'
import { idParam, requireMembership } from '../helpers'
import { precheckEtag } from '../httpCache'
import { linkIslands } from '../linkIslands'
import { indexEpoch, workspaceVersion } from '../versions'

/**
 * Link islands and unlinked pages (docs/adr/1123-*). Lives beside GET /workspaces/:id/graph
 * (routes/workspaces.ts) and uses the same node rules and the same version key for its ETag.
 */
export async function registerGraphRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/workspaces/:id/graph/islands',
    {
      preHandler: requireUser,
      // Same throttle as the full graph (H5): a full scan of pages + page_links per miss.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = getUser(req)
      const id = idParam(req.params)
      await requireMembership(id, user.id)
      // Graph data version: pages (workspaceVersion) + page_links (indexEpoch) — ADR 0752.
      if (precheckEtag(req, reply, [user.id, await workspaceVersion(id), indexEpoch()])) return reply
      return linkIslands(id, user.id)
    },
  )
}
