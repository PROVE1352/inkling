import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { setAgentPolicySchema, setPageAgentRulesSchema } from '@inkling/shared'
import type { AgentPolicyDTO, AutoAcceptRules } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { pagePolicyRow, rulesOf, workspacePolicyRow } from '../autoAccept'
import { db } from '../db/index'
import { canManageLock, lockChains, loadLockTarget } from '../editLock'
import { forbidden, notFound } from '../errors'
import { idParam, memberRoleTx, requireMembership } from '../helpers'
import { findVisiblePage } from '../pageDto'
import { isManagerRole, recordAudit, requireManager } from '../workspaceAdmin'

/**
 * Agent edit policy and auto-accept rules (docs/adr/1544-*, 1545-*).
 *
 *   GET /workspaces/:id/agent-policy        the workspace default (members read it)
 *   PUT /workspaces/:id/agent-policy        owners and admins, browser only; audited
 *   GET /pages/:id/agent-rules              the rules of an "auto" lock node
 *   PUT /pages/:id/agent-rules              who may manage the page's lock, browser only; audited
 *
 * Policies are read fresh for every agent write (one indexed lookup), so nothing is cached and no
 * access version is bumped; turning a node to 'auto' is a lock change (it bumps, ADR 1071).
 */

async function requireSession(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('The agent edit policy is only changed in the web app')
}

async function names(ids: (string | null)[]): Promise<Map<string, string>> {
  const list = ids.filter((x): x is string => !!x)
  if (!list.length) return new Map()
  const rows = (await db.execute(sql`SELECT id, name FROM users WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(list)}::jsonb)::uuid)`)) as unknown as {
    id: string
    name: string
  }[]
  return new Map(rows.map((r) => [r.id, r.name]))
}

async function toDto(
  row: Awaited<ReturnType<typeof workspacePolicyRow>>,
  level: AgentPolicyDTO['level'],
  canManage: boolean,
): Promise<AgentPolicyDTO> {
  const n = await names([row?.updatedBy ?? null])
  return {
    level,
    rules: rulesOf(row),
    canManage,
    updatedBy: row?.updatedBy ? { id: row.updatedBy, name: n.get(row.updatedBy) ?? '' } : null,
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  }
}

const rulesJson = (r: AutoAcceptRules) => ({
  modes: JSON.stringify([...new Set(r.modes)]),
  connections: JSON.stringify([...new Set(r.connections)].sort()),
})

export async function registerAgentPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/workspaces/:id/agent-policy', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)
    const row = await workspacePolicyRow(id)
    return { policy: await toDto(row, row?.level ?? 'direct', isManagerRole(role)) }
  })

  app.put('/workspaces/:id/agent-policy', { preHandler: requireSession }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setAgentPolicySchema.parse(req.body)
    await requireMembership(id, user.id)
    await db.transaction(async (tx) => {
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      requireManager(role)
      const before = await workspacePolicyRow(id)
      const j = rulesJson(body.rules)
      await tx.execute(sql`
        INSERT INTO agent_edit_policies (workspace_id, page_id, level, modes, connections, max_lines, max_chars, grace_minutes, updated_by, updated_at)
        VALUES (${id}, NULL, ${body.level}, ${j.modes}::jsonb, ${j.connections}::jsonb, ${body.rules.maxLines}, ${body.rules.maxChars},
                ${body.rules.graceMinutes}, ${user.id}, now())
        ON CONFLICT (workspace_id) WHERE page_id IS NULL DO UPDATE
          SET level = EXCLUDED.level, modes = EXCLUDED.modes, connections = EXCLUDED.connections, max_lines = EXCLUDED.max_lines,
              max_chars = EXCLUDED.max_chars, grace_minutes = EXCLUDED.grace_minutes, updated_by = EXCLUDED.updated_by, updated_at = now()
      `)
      await recordAudit(tx, {
        workspaceId: id,
        actor: user,
        action: 'agent_policy.changed',
        target: { type: 'workspace', id },
        before: { level: before?.level ?? 'direct', ...rulesOf(before) },
        after: { level: body.level, ...body.rules },
      })
    })
    const row = await workspacePolicyRow(id)
    return { policy: await toDto(row, row?.level ?? 'direct', true) }
  })

  app.get('/pages/:id/agent-rules', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const page = await findVisiblePage(idParam(req.params), user.id)
    if (!page) throw notFound()
    const role = await requireMembership(page.workspaceId, user.id)
    const target = await loadLockTarget(db, page.id)
    const chain = (await lockChains(db, [page.id])).get(page.id) ?? []
    const row = await pagePolicyRow(page.id)
    return { policy: await toDto(row, 'auto', canManageLock(target, chain, user.id, role)) }
  })

  app.put('/pages/:id/agent-rules', { preHandler: requireSession }, async (req) => {
    const user = getUser(req)
    const page = await findVisiblePage(idParam(req.params), user.id)
    if (!page) throw notFound()
    const role = await requireMembership(page.workspaceId, user.id)
    const body = setPageAgentRulesSchema.parse(req.body)
    await db.transaction(async (tx) => {
      // The same right as changing the page's lock (docs/adr/0970-*).
      const target = await loadLockTarget(tx, page.id)
      const chain = (await lockChains(tx, [page.id])).get(page.id) ?? []
      if (!canManageLock(target, chain, user.id, role)) {
        throw forbidden('Only workspace owners and admins, or the page owner, can change the auto-accept rules of this page')
      }
      const before = await pagePolicyRow(page.id)
      const j = rulesJson(body.rules)
      await tx.execute(sql`
        INSERT INTO agent_edit_policies (workspace_id, page_id, level, modes, connections, max_lines, max_chars, grace_minutes, updated_by, updated_at)
        VALUES (${page.workspaceId}, ${page.id}, 'auto', ${j.modes}::jsonb, ${j.connections}::jsonb, ${body.rules.maxLines}, ${body.rules.maxChars},
                ${body.rules.graceMinutes}, ${user.id}, now())
        ON CONFLICT (page_id) WHERE page_id IS NOT NULL DO UPDATE
          SET modes = EXCLUDED.modes, connections = EXCLUDED.connections, max_lines = EXCLUDED.max_lines, max_chars = EXCLUDED.max_chars,
              grace_minutes = EXCLUDED.grace_minutes, updated_by = EXCLUDED.updated_by, updated_at = now()
      `)
      await recordAudit(tx, {
        workspaceId: page.workspaceId,
        actor: user,
        action: 'agent_policy.changed',
        target: { type: 'page', id: page.id, label: page.title || 'Untitled' },
        before: { ...rulesOf(before) },
        after: { ...body.rules },
      })
    })
    return { policy: await toDto(await pagePolicyRow(page.id), 'auto', true) }
  })
}
