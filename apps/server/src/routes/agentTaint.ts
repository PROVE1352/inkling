import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { releaseTaintSchema, setAgentTaintSchema } from '@inkling/shared'
import { releaseTaints, suggestOnlyStates } from '../agentTaint'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { workspaces } from '../db/schema'
import { forbidden, notFound } from '../errors'
import { idParam, memberRoleTx, requireMembership } from '../helpers'
import { connectionOwnerSql } from '../teamAgents'
import { capabilitiesFor, isManagerRole, loadPolicy, recordAudit, requireManager } from '../workspaceAdmin'

/**
 * Suggest-only connections after flagged content (docs/adr/2040-* .. 2043-*). Browser sessions only:
 * an agent never lifts its own limit (the MCP server has no tool for it).
 *
 *   PUT  /workspaces/:id/settings/agent-taint            { enabled } owners/admins; audited settings.updated
 *   POST /workspaces/:id/agent-connections/release       { connection } owners/admins, or the connection's
 *                                                         owner: lifts the sources in this workspace
 *   POST /connections/release                            { connection } the connection's owner: lifts every source
 *   GET  /connections/suggest-only                       the caller's own connections that are suggest-only now
 */

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Only a person can lift this, in the web app')
}

async function ownerOf(key: string): Promise<string | null> {
  const [r] = (await db.execute(sql`SELECT ${connectionOwnerSql(sql`${key}::text`)} AS "owner"`)) as unknown as { owner: string | null }[]
  return r?.owner ?? null
}

export async function registerAgentTaintRoutes(app: FastifyInstance): Promise<void> {
  app.put('/workspaces/:id/settings/agent-taint', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setAgentTaintSchema.parse(req.body)
    await requireMembership(id, user.id)
    const result = await db.transaction(async (tx) => {
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      requireManager(role)
      const [cur] = await tx
        .select({ agentTaintDemote: workspaces.agentTaintDemote })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .for('update')
        .limit(1)
      if (!cur) throw notFound()
      if (cur.agentTaintDemote !== body.enabled) {
        await tx.update(workspaces).set({ agentTaintDemote: body.enabled }).where(eq(workspaces.id, id))
        await recordAudit(tx, {
          workspaceId: id,
          actor: user,
          action: 'settings.updated',
          target: { type: 'workspace', id },
          before: { agentTaintDemote: cur.agentTaintDemote },
          after: { agentTaintDemote: body.enabled },
        })
      }
      return { role, settings: await loadPolicy(tx, id) }
    })
    return { settings: result.settings, role: result.role, can: capabilitiesFor(result.role, result.settings) }
  })

  app.post('/workspaces/:id/agent-connections/release', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const { connection } = releaseTaintSchema.parse(req.body)
    const key = connection.toLowerCase()
    const role = await requireMembership(id, user.id)
    const owner = await ownerOf(key)
    if (!owner) throw notFound()
    // A workspace's owners/admins judge the content of their workspace; the connection's owner its own.
    if (!isManagerRole(role) && owner !== user.id) throw forbidden('Only workspace owners and admins, or the person whose connection it is, can lift this')
    const released = await releaseTaints(user, key, id)
    return { released, suggestOnly: (await suggestOnlyStates([key], id)).get(key) ?? null }
  })

  app.post('/connections/release', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { connection } = releaseTaintSchema.parse(req.body)
    const key = connection.toLowerCase()
    if ((await ownerOf(key)) !== user.id) throw notFound()
    const released = await releaseTaints(user, key, null)
    return { released, suggestOnly: null }
  })

  app.get('/connections/suggest-only', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const keys = (await db.execute(sql`
      SELECT 'grant:' || id AS key FROM oauth_grants WHERE user_id = ${user.id}
      UNION ALL SELECT 'token:' || id FROM api_tokens WHERE user_id = ${user.id}
    `)) as unknown as { key: string }[]
    const states = await suggestOnlyStates(keys.map((k) => k.key))
    return { connections: [...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, s]) => ({ key, ...s })) }
  })
}
