import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { setAgentUploadsSchema } from '@inkling/shared'
import { agentUploadEnv } from '../agentUploads'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { workspaces } from '../db/schema'
import { AppError, forbidden, notFound } from '../errors'
import { idParam, memberRoleTx, requireMembership } from '../helpers'
import { capabilitiesFor, loadPolicy, recordAudit, requireManager } from '../workspaceAdmin'

/**
 * "Uploads by AI agents" of a workspace (docs/adr/2065-*).
 *
 *   PUT /workspaces/:id/settings/agent-uploads { value: 'default' | 'on' | 'off' }
 *       owners and admins, browser only (like settings/agent-taint) → { settings, role, can };
 *       audited as settings.updated. 409 AGENT_UPLOADS_NEVER for 'on' while the server says never.
 */

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Only a person can change this, in the web app')
}

export async function registerAgentUploadRoutes(app: FastifyInstance): Promise<void> {
  app.put('/workspaces/:id/settings/agent-uploads', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setAgentUploadsSchema.parse(req.body)
    await requireMembership(id, user.id)
    const next = body.value === 'default' ? null : body.value
    const result = await db.transaction(async (tx) => {
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      requireManager(role)
      if (next === 'on' && agentUploadEnv.mode === 'never') {
        throw new AppError(409, 'AGENT_UPLOADS_NEVER', 'This server turns uploads by AI agents off everywhere (AGENT_UPLOADS=never); ask the server admin')
      }
      const [cur] = await tx
        .select({ agentUploads: workspaces.agentUploads })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .for('update')
        .limit(1)
      if (!cur) throw notFound()
      if ((cur.agentUploads ?? null) !== next) {
        await tx.update(workspaces).set({ agentUploads: next }).where(eq(workspaces.id, id))
        await recordAudit(tx, {
          workspaceId: id,
          actor: user,
          action: 'settings.updated',
          target: { type: 'workspace', id },
          before: { agentUploads: cur.agentUploads ?? 'default' },
          after: { agentUploads: body.value },
        })
      }
      return { role, settings: await loadPolicy(tx, id) }
    })
    return { settings: result.settings, role: result.role, can: capabilitiesFor(result.role, result.settings) }
  })
}
