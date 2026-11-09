import { and, desc, eq, inArray, isNotNull, isNull, like, lt, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  auditQuerySchema,
  blockAgentSchema,
  bulkUnpublishSchema,
  setLivingSchema,
  setAgentInkSchema,
  setPageOwnerSchema,
  setTwoFactorPolicySchema,
  updateWorkspaceSettingsSchema,
} from '@inkling/shared'
import type {
  AgentBlockDTO,
  AgentConnectionDTO,
  AuditAction,
  AuditEventDTO,
  AuditPageDTO,
  ReviewDueDTO,
  TwoFactorPolicyDTO,
  WorkspaceRole,
  WorkspaceSettingsDTO,
} from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import {
  oauthClients,
  oauthGrants,
  pages,
  users,
  workspaceAgentAccess,
  workspaceAgentBlocks,
  workspaceAuditEvents,
  workspaceMembers,
  workspaces,
} from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, lockWorkspaceMembers, memberRoleTx, requireMembership } from '../helpers'
import { bumpAcl } from '../aclVersion'
import { canWriteFromScopes } from '../oauth'
import { findVisiblePage } from '../pageDto'
import { assertPageEditable } from '../editLock'
import { computeReviewScores, ensureReviewScores, listReviewBucket, localISODate, pageReview } from '../review'
import { countReads } from '../pageReads'
import { closeUserWorkspaceConnections } from '../liveConnections'
import { secretBoxAvailable } from '../secretBox'
import { twoFactorBlockedSql, twoFactorDeadline, userSatisfiesTwoFactor } from '../twoFactorPolicy'
import { enqueueAssignments } from '../notify/producers'
import { outboxCommitted } from '../outbox'
import {
  capabilitiesFor,
  diffFields,
  isManagerRole,
  loadPolicy,
  policyColumns,
  recordAudit,
  requireManager,
  requireOwner,
} from '../workspaceAdmin'
import { CLEARED_SHARE_LINK } from '../shareSettings'
import { usageSince, workspaceUsageFor } from '../connectionUsage'
import type { AgentConnectionUsageDTO } from '@inkling/shared'

/**
 * Workspace settings screen API (docs/adr/0945-* .. 0952-*): settings, audit log, connected
 * agents and blocks, public link management, document owner / review.
 *
 * Browser sessions only: an MCP token never reaches workspace administration (same rule as the
 * admin API), and review sign-off is a human action.
 */
/** GET settings → `twoFactor` (docs/adr/1112-*). Managers also get who has not turned 2FA on yet. */
async function twoFactorPolicyDTO(workspaceId: string, userId: string, role: WorkspaceRole): Promise<TwoFactorPolicyDTO> {
  const [ws] = await db
    .select({ at: workspaces.twoFactorRequiredAt, grace: workspaces.twoFactorGraceDays })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!ws) throw notFound()
  const deadline = twoFactorDeadline(ws.at, ws.grace)
  const dto: TwoFactorPolicyDTO = {
    required: ws.at !== null,
    graceDays: ws.grace,
    requiredAt: ws.at ? ws.at.toISOString() : null,
    deadline: deadline ? deadline.toISOString() : null,
    available: secretBoxAvailable(),
    selfSatisfied: await userSatisfiesTwoFactor(userId),
  }
  if (isManagerRole(role)) {
    const rows = (await db.execute(sql`
      SELECT u.id, u.name, count(*) OVER ()::int AS total
        FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ${workspaceId}
         AND u.origin NOT IN ('delegated', 'oidc')
         AND NOT EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id AND t.enabled_at IS NOT NULL)
       ORDER BY u.name, u.id
       LIMIT 50
    `)) as unknown as { id: string; name: string; total: number }[]
    dto.membersWithout = { count: rows[0]?.total ?? 0, members: rows.map((r) => ({ id: r.id, name: r.name })) }
  }
  return dto
}

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Workspace administration is only available in the web app')
}

const blockParamsSchema = z.object({ id: z.uuid(), blockId: z.uuid() })
const reviewDueQuerySchema = z.object({ mine: z.enum(['0', '1']).optional() })

function toAuditDTO(r: typeof workspaceAuditEvents.$inferSelect): AuditEventDTO {
  return {
    id: String(r.id),
    action: r.action as AuditAction,
    actor: { id: r.actorId, name: r.actorName },
    viaClient: r.viaClient,
    target: r.targetType ? { type: r.targetType, id: r.targetId, label: r.targetLabel } : null,
    before: (r.before as Record<string, unknown> | null) ?? null,
    after: (r.after as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

/** Usage of an agent connection in one workspace since start (docs/adr/1552-*), numbers only. */
function usageHere(workspaceId: string, grantId: string): AgentConnectionUsageDTO | null {
  const u = workspaceUsageFor(workspaceId, grantId)
  if (!u) return null
  return { calls: u.calls, errors: u.errors, tokens: u.tokens, cacheHits: u.cacheHits, lastUsedAt: new Date(u.lastUsedAt).toISOString() }
}

export async function registerWorkspaceAdminRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  // Members see the policies that affect them (read-only); owners edit them.
  app.get('/workspaces/:id/settings', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)
    const settings: WorkspaceSettingsDTO = await loadPolicy(db, id)
    return { settings, role, can: capabilitiesFor(role, settings), twoFactor: await twoFactorPolicyDTO(id, user.id, role) }
  })

  // "Require two-step verification" (docs/adr/1112-*): owners and admins. Turning it on needs
  // APP_SECRET_KEY (members must be able to comply) and the caller's own 2FA.
  app.put('/workspaces/:id/settings/two-factor', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setTwoFactorPolicySchema.parse(req.body)
    await requireMembership(id, user.id)
    if (body.required) {
      if (!secretBoxAvailable()) {
        throw new AppError(501, 'TWO_FACTOR_UNAVAILABLE', 'Two-step verification is not available on this server (APP_SECRET_KEY is not set)')
      }
      if (!(await userSatisfiesTwoFactor(user.id))) {
        throw new AppError(403, 'TWO_FACTOR_SELF_REQUIRED', 'Turn on two-step verification for your own account first')
      }
    }
    const changed = await db.transaction(async (tx) => {
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      requireManager(role)
      const [cur] = await tx
        .select({ at: workspaces.twoFactorRequiredAt, grace: workspaces.twoFactorGraceDays })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .for('update')
        .limit(1)
      if (!cur) throw notFound()
      const before = { twoFactorRequired: cur.at !== null, twoFactorGraceDays: cur.grace }
      const after = { twoFactorRequired: body.required, twoFactorGraceDays: body.graceDays ?? cur.grace }
      if (before.twoFactorRequired === after.twoFactorRequired && before.twoFactorGraceDays === after.twoFactorGraceDays) {
        return false
      }
      // The grace period runs from when the requirement was turned on; changing only the number of
      // days keeps that moment (shortening it can end the grace period at once).
      // The moment comes from the database clock: the deadline is compared with now() in SQL
      // (twoFactorBlockedSql), and an app clock ahead of the database's would leave a member
      // unblocked (and connected) for that skew after a grace of 0 days (docs/adr/1242-*).
      const at = !body.required ? null : (cur.at ?? sql`now()`)
      await tx
        .update(workspaces)
        .set({ twoFactorRequiredAt: at, twoFactorGraceDays: after.twoFactorGraceDays })
        .where(eq(workspaces.id, id))
      const diff = diffFields(before, after)
      await recordAudit(tx, {
        workspaceId: id,
        actor: user,
        action: 'settings.updated',
        target: { type: 'workspace', id },
        before: diff?.before ?? null,
        after: diff?.after ?? null,
      })
      return true
    })
    // Members now past the deadline lose their live editing sockets; their next request gets 403.
    if (changed && body.required) {
      const blocked = (await db.execute(sql`
        SELECT m.user_id AS "userId" FROM workspace_members m
         WHERE m.workspace_id = ${id} AND ${twoFactorBlockedSql(sql`m.workspace_id`, sql`m.user_id`)}
      `)) as unknown as { userId: string }[]
      for (const b of blocked) await closeUserWorkspaceConnections(b.userId, id)
    }
    const role = await requireMembership(id, user.id)
    return { twoFactor: await twoFactorPolicyDTO(id, user.id, role) }
  })

  // "Agents can read handwriting" (docs/adr/1510-*): owners and admins, like the 2FA requirement.
  // A read permission for MCP connections, not a lock: nothing to bump in the access version.
  app.put('/workspaces/:id/settings/agent-ink', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setAgentInkSchema.parse(req.body)
    await requireMembership(id, user.id)
    const result = await db.transaction(async (tx) => {
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      requireManager(role)
      const [cur] = await tx
        .select({ agentInkRead: workspaces.agentInkRead })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .for('update')
        .limit(1)
      if (!cur) throw notFound()
      if (cur.agentInkRead !== body.enabled) {
        await tx.update(workspaces).set({ agentInkRead: body.enabled }).where(eq(workspaces.id, id))
        await recordAudit(tx, {
          workspaceId: id,
          actor: user,
          action: 'settings.updated',
          target: { type: 'workspace', id },
          before: { agentInkRead: cur.agentInkRead },
          after: { agentInkRead: body.enabled },
        })
      }
      return { role, settings: await loadPolicy(tx, id) }
    })
    return { settings: result.settings, role: result.role, can: capabilitiesFor(result.role, result.settings) }
  })

  app.patch('/workspaces/:id/settings', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = updateWorkspaceSettingsSchema.parse(req.body)
    await requireMembership(id, user.id)
    const { unpublishExisting, ...patch } = body
    if (unpublishExisting && patch.publicSharingDisabled !== true) {
      throw badRequest('unpublishExisting needs publicSharingDisabled: true')
    }

    const result = await db.transaction(async (tx) => {
      // Member lock: the invite toggle must not race a join; row lock: publish checks it FOR SHARE.
      await lockWorkspaceMembers(tx, id)
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      requireOwner(role)
      const [cur] = await tx.select(policyColumns).from(workspaces).where(eq(workspaces.id, id)).for('update').limit(1)
      if (!cur) throw notFound()
      const diff = diffFields(cur, patch)
      let unpublished = 0
      if (Object.keys(patch).length > 0) {
        // a new review interval changes every λ: recompute the priority batch on next use
        const extra = diff && 'reviewIntervalDays' in diff.after ? { reviewScoredOn: null } : {}
        await tx.update(workspaces).set({ ...patch, ...extra }).where(eq(workspaces.id, id))
      }
      if (unpublishExisting) {
        const rows = await tx
          .update(pages)
          .set(CLEARED_SHARE_LINK)
          .where(and(eq(pages.workspaceId, id), isNotNull(pages.shareToken)))
          .returning({ id: pages.id })
        unpublished = rows.length
      }
      if (diff || unpublished > 0) {
        await recordAudit(tx, {
          workspaceId: id,
          actor: user,
          action: 'settings.updated',
          target: { type: 'workspace', id },
          before: diff?.before ?? null,
          after: { ...(diff?.after ?? {}), ...(unpublished > 0 ? { unpublishedLinks: unpublished } : {}) },
        })
      }
      return { role, settings: { ...cur, ...patch }, unpublished }
    })
    return { settings: result.settings, role: result.role, can: capabilitiesFor(result.role, result.settings), unpublished: result.unpublished }
  })

  // ---------------------------------------------------------------------------
  // Audit log (owners and admins)
  // ---------------------------------------------------------------------------

  app.get('/workspaces/:id/audit', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)
    requireManager(role)
    const q = auditQuerySchema.parse(req.query)
    const limit = q.limit ?? 50
    const conds = [eq(workspaceAuditEvents.workspaceId, id)]
    if (q.action) {
      conds.push(
        q.action.includes('.')
          ? eq(workspaceAuditEvents.action, q.action)
          : like(workspaceAuditEvents.action, `${q.action}.%`),
      )
    }
    if (q.actorId) conds.push(eq(workspaceAuditEvents.actorId, q.actorId))
    if (q.cursor) conds.push(lt(workspaceAuditEvents.id, Number(q.cursor)))
    const rows = await db
      .select()
      .from(workspaceAuditEvents)
      .where(and(...conds))
      .orderBy(desc(workspaceAuditEvents.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const { auditRetentionDays } = await loadPolicy(db, id)
    const res: AuditPageDTO = {
      events: page.map(toAuditDTO),
      nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
      retentionDays: auditRetentionDays,
    }
    return res
  })

  // ---------------------------------------------------------------------------
  // Connected agents (owners and admins) — docs/adr/0947-*
  // ---------------------------------------------------------------------------

  app.get('/workspaces/:id/agents', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)
    requireManager(role)

    const blockRows = await db
      .select({
        id: workspaceAgentBlocks.id,
        userId: workspaceAgentBlocks.userId,
        userName: users.name,
        clientId: workspaceAgentBlocks.clientId,
        clientName: workspaceAgentBlocks.clientName,
        createdBy: workspaceAgentBlocks.createdBy,
        createdAt: workspaceAgentBlocks.createdAt,
      })
      .from(workspaceAgentBlocks)
      .innerJoin(users, eq(users.id, workspaceAgentBlocks.userId))
      .where(eq(workspaceAgentBlocks.workspaceId, id))
      .orderBy(desc(workspaceAgentBlocks.createdAt))
    const creatorIds = [...new Set(blockRows.map((b) => b.createdBy).filter((x): x is string => !!x))]
    const creators = creatorIds.length
      ? new Map(
          (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, creatorIds))).map(
            (u) => [u.id, u.name],
          ),
        )
      : new Map<string, string>()
    const blocks: AgentBlockDTO[] = blockRows.map((b) => ({
      id: b.id,
      user: { id: b.userId, name: b.userName },
      client: b.clientId ? { id: b.clientId, name: b.clientName ?? '' } : null,
      createdBy: b.createdBy ? (creators.get(b.createdBy) ?? null) : null,
      createdAt: b.createdAt.toISOString(),
    }))

    // Connections that reached this workspace, of people who are still members.
    const rows = await db
      .select({
        grantId: workspaceAgentAccess.grantId,
        userId: workspaceAgentAccess.userId,
        userName: users.name,
        clientId: workspaceAgentAccess.clientId,
        clientName: oauthClients.name,
        scope: oauthGrants.scope,
        firstUsedAt: workspaceAgentAccess.firstUsedAt,
        lastUsedAt: workspaceAgentAccess.lastUsedAt,
      })
      .from(workspaceAgentAccess)
      .innerJoin(oauthGrants, eq(oauthGrants.id, workspaceAgentAccess.grantId))
      .innerJoin(oauthClients, eq(oauthClients.id, workspaceAgentAccess.clientId))
      .innerJoin(users, eq(users.id, workspaceAgentAccess.userId))
      .innerJoin(
        workspaceMembers,
        and(eq(workspaceMembers.workspaceId, workspaceAgentAccess.workspaceId), eq(workspaceMembers.userId, workspaceAgentAccess.userId)),
      )
      .where(eq(workspaceAgentAccess.workspaceId, id))
      .orderBy(desc(workspaceAgentAccess.lastUsedAt))
    const isBlocked = (userId: string, clientId: string) =>
      blockRows.some((b) => b.userId === userId && (b.clientId === null || b.clientId === clientId))
    const connections: AgentConnectionDTO[] = rows.map((r) => ({
      grantId: r.grantId,
      user: { id: r.userId, name: r.userName },
      client: { id: r.clientId, name: r.clientName },
      access: canWriteFromScopes(r.scope ?? '') ? 'write' : 'read',
      firstUsedAt: r.firstUsedAt.toISOString(),
      lastUsedAt: r.lastUsedAt.toISOString(),
      blocked: isBlocked(r.userId, r.clientId),
      usage: usageHere(id, r.grantId),
    }))
    // Numbers since the server started, per process (docs/adr/1552-*).
    return { connections, blocks, usageSince: usageSince().toISOString() }
  })

  // Block a member's agent connections here. Admins cannot block an owner's agents.
  app.post('/workspaces/:id/agents/blocks', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = blockAgentSchema.parse(req.body)
    await requireMembership(id, user.id)
    const clientId = body.clientId ?? null

    const block = await db.transaction(async (tx) => {
      await lockWorkspaceMembers(tx, id)
      // New access version + exclusive write gate: agent writes in flight finish first, later ones
      // see the block (docs/adr/1071-*).
      await bumpAcl(tx, id)
      const myRole = await memberRoleTx(tx, id, user.id)
      if (!myRole) throw forbidden()
      requireManager(myRole)
      const targetRole = await memberRoleTx(tx, id, body.userId)
      if (!targetRole) throw badRequest('That person is not a member of this workspace')
      if (myRole !== 'owner' && targetRole === 'owner') throw forbidden("Admins can't block an owner's agents")
      let clientName: string | null = null
      if (clientId) {
        const [c] = await tx.select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1)
        if (!c) throw notFound('NOT_FOUND', 'Unknown agent client')
        clientName = c.name
      }
      const inserted = await tx
        .insert(workspaceAgentBlocks)
        .values({ workspaceId: id, userId: body.userId, clientId, clientName, createdBy: user.id })
        .onConflictDoNothing()
        .returning()
      const [target] = await tx.select({ name: users.name }).from(users).where(eq(users.id, body.userId)).limit(1)
      if (inserted.length > 0) {
        await recordAudit(tx, {
          workspaceId: id,
          actor: user,
          action: 'agent.blocked',
          target: { type: 'agent', id: clientId, label: clientName ?? 'all agents' },
          after: { user: target?.name ?? null, client: clientName ?? 'all' },
        })
        return inserted[0]
      }
      const [existing] = await tx
        .select()
        .from(workspaceAgentBlocks)
        .where(
          and(
            eq(workspaceAgentBlocks.workspaceId, id),
            eq(workspaceAgentBlocks.userId, body.userId),
            clientId ? eq(workspaceAgentBlocks.clientId, clientId) : isNull(workspaceAgentBlocks.clientId),
          ),
        )
        .limit(1)
      return existing
    })
    return { block: { id: block.id } }
  })

  app.delete('/workspaces/:id/agents/blocks/:blockId', { preHandler: requireSessionUser }, async (req, reply) => {
    const user = getUser(req)
    const { id, blockId } = blockParamsSchema.parse(req.params)
    await requireMembership(id, user.id)
    await db.transaction(async (tx) => {
      await lockWorkspaceMembers(tx, id)
      await bumpAcl(tx, id)
      const myRole = await memberRoleTx(tx, id, user.id)
      if (!myRole) throw forbidden()
      requireManager(myRole)
      const [b] = await tx
        .select({ userId: workspaceAgentBlocks.userId, clientName: workspaceAgentBlocks.clientName, clientId: workspaceAgentBlocks.clientId })
        .from(workspaceAgentBlocks)
        .where(and(eq(workspaceAgentBlocks.id, blockId), eq(workspaceAgentBlocks.workspaceId, id)))
        .limit(1)
      if (!b) throw notFound()
      if (myRole !== 'owner' && (await memberRoleTx(tx, id, b.userId)) === 'owner') {
        throw forbidden("Admins can't change blocks on an owner's agents")
      }
      await tx.delete(workspaceAgentBlocks).where(eq(workspaceAgentBlocks.id, blockId))
      const [target] = await tx.select({ name: users.name }).from(users).where(eq(users.id, b.userId)).limit(1)
      await recordAudit(tx, {
        workspaceId: id,
        actor: user,
        action: 'agent.unblocked',
        target: { type: 'agent', id: b.clientId, label: b.clientName ?? 'all agents' },
        before: { user: target?.name ?? null, client: b.clientName ?? 'all' },
      })
    })
    return reply.code(204).send()
  })

  // ---------------------------------------------------------------------------
  // Public links (owners and admins) — docs/adr/0949-*
  // ---------------------------------------------------------------------------

  // Remove public links: the given pages, or every link in the workspace when pageIds is omitted.
  app.post('/workspaces/:id/shared/unpublish', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)
    requireManager(role)
    const { pageIds } = bulkUnpublishSchema.parse(req.body ?? {})
    const removed = await db.transaction(async (tx) => {
      const rows = await tx
        .update(pages)
        .set(CLEARED_SHARE_LINK)
        .where(
          and(eq(pages.workspaceId, id), isNotNull(pages.shareToken), pageIds ? inArray(pages.id, pageIds) : undefined),
        )
        .returning({ id: pages.id, title: pages.title, scope: pages.scope, createdBy: pages.createdBy })
      for (const r of rows) {
        // a private page's title is never written into a log other members read
        const label = r.scope === 'private' && r.createdBy !== user.id ? null : r.title
        await recordAudit(tx, { workspaceId: id, actor: user, action: 'share.unpublished', target: { type: 'page', id: r.id, label } })
      }
      return rows.length
    })
    return { unpublished: removed }
  })

  // ---------------------------------------------------------------------------
  // Document owner and review — docs/adr/0951-*
  // ---------------------------------------------------------------------------

  // Review priority lists visible to the caller (any member); mine=1 → only documents I own.
  // Scores come from the daily batch, computed here first if today's has not run yet (docs/adr/0953-*).
  app.get('/workspaces/:id/review-due', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const q = reviewDueQuerySchema.parse(req.query)
    const { reviewIntervalDays } = await loadPolicy(db, id)
    const empty = { intervalDays: reviewIntervalDays, today: localISODate(new Date()), items: [], archive: [], living: [] }
    if (reviewIntervalDays == null) return empty satisfies ReviewDueDTO
    await ensureReviewScores(id)
    const opts = { ownerId: q.mine === '1' ? user.id : undefined }
    const res: ReviewDueDTO = {
      ...empty,
      items: await listReviewBucket(id, user.id, 'stale', opts),
      archive: await listReviewBucket(id, user.id, 'archive', opts),
      living: await listReviewBucket(id, user.id, 'living', opts),
    }
    return res
  })

  // Web page view → read counter (page totals only, docs/adr/0953-*). The SPA sends one per page open.
  app.post(
    '/pages/:id/view',
    { preHandler: requireSessionUser, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { page } = await guardReviewPage(req)
      countReads([page.id])
      return reply.code(204).send()
    },
  )

  async function guardReviewPage(req: FastifyRequest) {
    const user = getUser(req)
    const pageId = idParam(req.params)
    const page = await findVisiblePage(pageId, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)
    return { user, page }
  }

  app.get('/pages/:id/review', { preHandler: requireSessionUser }, async (req) => {
    const { page } = await guardReviewPage(req)
    return { review: await pageReview(page.id) }
  })

  // Set or clear the document owner. The owner must be a member; a private page can only be owned by its author.
  app.put('/pages/:id/owner', { preHandler: requireSessionUser }, async (req) => {
    const { user, page } = await guardReviewPage(req)
    // The owner of a locked page is one of its editors: only someone who may edit it can change it.
    await assertPageEditable(page.id, user.id)
    const { ownerId } = setPageOwnerSchema.parse(req.body)
    if (ownerId) {
      const [m] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, page.workspaceId), eq(workspaceMembers.userId, ownerId)))
        .limit(1)
      if (!m) throw badRequest('The owner must be a member of this workspace')
      if (page.scope === 'private') {
        const [row] = await db.select({ createdBy: pages.createdBy }).from(pages).where(eq(pages.id, page.id)).limit(1)
        if (row?.createdBy !== ownerId) throw badRequest('Only the author can own a private page')
      }
    }
    const [prev] = await db.select({ ownerId: pages.ownerId }).from(pages).where(eq(pages.id, page.id)).limit(1)
    // The owner of a lock page is one of its implicit editors: new access version in the same
    // transaction (docs/adr/1071-*).
    const queued = await db.transaction(async (tx) => {
      await bumpAcl(tx, page.workspaceId)
      await tx.update(pages).set({ ownerId }).where(eq(pages.id, page.id))
      // A new owner hears about it (docs/adr/1000-*); the event commits with the change (docs/adr/1150-*).
      return ownerId && ownerId !== prev?.ownerId
        ? enqueueAssignments(tx, [{ workspaceId: page.workspaceId, pageId: page.id, actorId: user.id, via: user.via ?? null, kind: 'page_owner', userIds: [ownerId], field: 'owner' }])
        : []
    })
    outboxCommitted(queued)
    await computeReviewScores(page.workspaceId, new Date(), [page.id])
    return { review: await pageReview(page.id) }
  })

  // "Mark reviewed": now, by the caller. Does not touch updated_at (no content change).
  app.post('/pages/:id/review', { preHandler: requireSessionUser }, async (req) => {
    const { user, page } = await guardReviewPage(req)
    if (page.kind === 'folder') throw badRequest('Folders are not reviewed')
    await db.update(pages).set({ reviewedAt: sql`now()`, reviewedBy: user.id }).where(eq(pages.id, page.id))
    // the page's priority row follows at once (the rest of the workspace keeps today's batch)
    await computeReviewScores(page.workspaceId, new Date(), [page.id])
    return { review: await pageReview(page.id) }
  })

  // Living-document override: true = always living, false = never, null = automatic.
  app.put('/pages/:id/living', { preHandler: requireSessionUser }, async (req) => {
    const { user, page } = await guardReviewPage(req)
    await assertPageEditable(page.id, user.id)
    const { living } = setLivingSchema.parse(req.body)
    await db.update(pages).set({ livingOverride: living }).where(eq(pages.id, page.id))
    await computeReviewScores(page.workspaceId, new Date(), [page.id])
    return { review: await pageReview(page.id) }
  })
}
