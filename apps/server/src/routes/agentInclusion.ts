import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AgentPendingWorkspaceDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { users, workspaceMembers, workspaces } from '../db/schema'
import { forbidden, notFound } from '../errors'
import { idParam } from '../helpers'
import { SESSION_ONLY_MESSAGE } from '../tokenPolicy'

/**
 * Workspaces someone else added a person to (docs/adr/2580-*).
 *
 *   GET  /api/me/agent-pending-workspaces        → { workspaces: AgentPendingWorkspaceDTO[] }
 *   POST /api/workspaces/:id/agent-include       → { workspaceId }   (idempotent)
 *
 * A direct add (POST /api/workspaces/:id/members) is not the person's own step, so the membership waits:
 * every connection whose range is "all" leaves that workspace out (tokenRange.ts scopeFromColumns) until
 * the person includes it here. Browser sessions only, twice over: SESSION_ONLY in tokenPolicy.ts refuses
 * every bearer request in requireUser, and the handlers check again. An agent can neither list these
 * workspaces (their names are chosen by whoever added the person) nor let itself in.
 */
function sessionOnly(req: FastifyRequest): void {
  if (req.authVia !== 'cookie') throw forbidden(SESSION_ONLY_MESSAGE)
}
const requireSessionUser = [requireUser, async (req: FastifyRequest) => sessionOnly(req)]

export async function registerAgentInclusionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/agent-pending-workspaces', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const adder = alias(users, 'adder')
    const rows = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        workspaceName: workspaces.name,
        addedByName: adder.name,
        addedAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .leftJoin(adder, eq(adder.id, workspaceMembers.addedBy))
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.agentsPending, true), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    const out: AgentPendingWorkspaceDTO[] = rows.map((r) => ({
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName,
      addedByName: r.addedByName ?? null,
      addedAt: r.addedAt.toISOString(),
    }))
    return { workspaces: out }
  })

  app.post('/workspaces/:id/agent-include', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    // Members only (a guest has no membership to include); a deleted workspace answers 404 like elsewhere.
    const rows = await db.execute(sql`
      UPDATE workspace_members m SET agents_pending = false
        FROM workspaces w
       WHERE m.workspace_id = ${id}::uuid AND m.user_id = ${user.id}::uuid
         AND w.id = m.workspace_id AND w.deleted_at IS NULL
      RETURNING m.workspace_id
    `)
    if (!(rows as unknown as unknown[]).length) throw notFound()
    return { workspaceId: id }
  })
}
