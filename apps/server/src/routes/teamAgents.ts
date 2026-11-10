import type { FastifyInstance } from 'fastify'
import { teamAgentsQuerySchema } from '@inkling/shared'
import type { TeamAgentsDTO, WorkspaceConnectionDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { idParam, requireMembership } from '../helpers'
import { readTeamAgents, workspaceConnections } from '../teamAgents'

/**
 * Team agents (docs/adr/1862-*). Members only (guests are refused by requireMembership).
 *
 *   GET /workspaces/:id/agent-connections   live connections of the members (mention / assignee pickers)
 *   GET /workspaces/:id/team-agents?since=  the board: claims, open suggestions, what each person's agents
 *                                           did since `since` (default 24 hours, at most 7 days), by person;
 *                                           titles of pages the caller cannot see are left out
 */
export async function registerTeamAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/workspaces/:id/agent-connections', { preHandler: requireUser }, async (req): Promise<{ connections: WorkspaceConnectionDTO[] }> => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    return { connections: await workspaceConnections(id) }
  })

  app.get(
    '/workspaces/:id/team-agents',
    { preHandler: requireUser, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req): Promise<TeamAgentsDTO> => {
      const user = getUser(req)
      const id = idParam(req.params)
      const q = teamAgentsQuerySchema.parse(req.query)
      await requireMembership(id, user.id)
      const now = Date.now()
      const since = q.since ? Date.parse(q.since) : now - 24 * 60 * 60 * 1_000
      return readTeamAgents(id, user.id, Math.min(since, now), now)
    },
  )
}
