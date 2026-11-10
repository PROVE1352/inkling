import { and, asc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  WORKSPACE_GROUPS_MAX,
  createWorkspaceGroupSchema,
  updateWorkspaceGroupSchema,
  workspaceGroupArchiveSchema,
  workspaceGroupOrderSchema,
  workspaceListingPatchSchema,
  workspaceOrderSchema,
} from '@inkling/shared'
import type { WorkspaceGroupDTO, WorkspaceListingDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { workspaceListGroups, workspaceListings } from '../db/schema'
import { badRequest, forbidden, notFound } from '../errors'
import { idParam } from '../helpers'
import { isGuestIn } from '../pageGrants'
import { listingsFor } from '../workspaceListing'

/**
 * A person's own workspace list (docs/adr/2300-*, 2301-*): groups, order, archive.
 *
 *   GET    /api/me/workspace-groups                 → { groups: WorkspaceGroupDTO[] } in the person's order
 *   POST   /api/me/workspace-groups                 { name } → { group }
 *   PATCH  /api/me/workspace-groups/:id             { name?, collapsed? } → { group }
 *   DELETE /api/me/workspace-groups/:id             → 204; its workspaces become ungrouped
 *   PUT    /api/me/workspace-groups/order           { ids } → { groups }
 *   POST   /api/me/workspace-groups/:id/archive     { archived } → { count }  (every workspace in the group)
 *   PATCH  /api/me/workspaces/:id/listing           { archived?, groupId? } → { listing }
 *   PUT    /api/me/workspace-order                  { groupId, ids } → 204   (order inside one group)
 *
 * Browser sessions only, like the sidebar menu order (docs/adr/1020-*): this is how a person's own
 * switcher looks; an agent connection follows the result (archived workspaces left out of its default
 * searches) but cannot change it. Members and guests alike may arrange a workspace they can open;
 * none of this changes who may open what (docs/adr/2302-*), so nothing here bumps the access version.
 */
function sessionOnly(req: FastifyRequest): void {
  if (req.authVia !== 'cookie') throw forbidden('Your workspace list is arranged in the web app')
}
// requireUser as the preHandler itself, so the handler runs inside the request's guest scope
// (isGuestIn below); the browser-only check follows it.
const requireSessionUser = [requireUser, async (req: FastifyRequest) => sessionOnly(req)]

const groupParams = z.object({ id: z.uuid() })

/** 404 unless the caller can open the workspace: a member of a live workspace, or a guest of it. */
async function requireListed(workspaceId: string, userId: string): Promise<void> {
  if (isGuestIn(workspaceId, userId)) return
  const [r] = (await db.execute(sql`
    SELECT 1 AS ok FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.workspace_id = ${workspaceId} AND wm.user_id = ${userId} AND w.deleted_at IS NULL
  `)) as unknown as { ok: number }[]
  if (!r) throw notFound('NOT_FOUND', 'Workspace not found')
}

/** The caller's group, or 404 (another person's group does not exist for them). */
async function ownGroup(groupId: string, userId: string) {
  const [g] = await db
    .select()
    .from(workspaceListGroups)
    .where(and(eq(workspaceListGroups.id, groupId), eq(workspaceListGroups.userId, userId)))
    .limit(1)
  if (!g) throw notFound('NOT_FOUND', 'Group not found')
  return g
}

const toGroupDTO = (g: { id: string; name: string; collapsed: boolean }): WorkspaceGroupDTO => ({ id: g.id, name: g.name, collapsed: g.collapsed })

export async function listGroups(userId: string): Promise<WorkspaceGroupDTO[]> {
  const rows = await db
    .select()
    .from(workspaceListGroups)
    .where(eq(workspaceListGroups.userId, userId))
    .orderBy(asc(workspaceListGroups.position), asc(workspaceListGroups.createdAt), asc(workspaceListGroups.id))
  return rows.map(toGroupDTO)
}

/** Next position at the end of a group (or of the ungrouped ones). */
async function endOf(userId: string, groupId: string | null): Promise<number> {
  const [r] = (await db.execute(sql`
    SELECT coalesce(max(position), -1) + 1 AS n FROM workspace_listings
     WHERE user_id = ${userId} AND ${groupId ? sql`group_id = ${groupId}` : sql`group_id IS NULL`}
  `)) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

export async function registerWorkspaceListingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/workspace-groups', { preHandler: requireSessionUser }, async (req) => {
    return { groups: await listGroups(getUser(req).id) }
  })

  app.post('/me/workspace-groups', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { name } = createWorkspaceGroupSchema.parse(req.body)
    const group = await db.transaction(async (tx) => {
      // one person's groups are created one at a time (the cap and the end position)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`workspace-groups:${user.id}`}))`)
      const [c] = (await tx.execute(sql`
        SELECT count(*)::int AS n, coalesce(max(position), -1) + 1 AS next FROM workspace_list_groups WHERE user_id = ${user.id}
      `)) as unknown as { n: number; next: number }[]
      if (Number(c.n) >= WORKSPACE_GROUPS_MAX) throw badRequest(`At most ${WORKSPACE_GROUPS_MAX} groups`)
      const [g] = await tx.insert(workspaceListGroups).values({ userId: user.id, name, position: Number(c.next) }).returning()
      return g
    })
    return { group: toGroupDTO(group) }
  })

  app.patch('/me/workspace-groups/:id', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { id } = groupParams.parse(req.params)
    const body = updateWorkspaceGroupSchema.parse(req.body)
    await ownGroup(id, user.id)
    const [g] = await db
      .update(workspaceListGroups)
      .set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.collapsed !== undefined ? { collapsed: body.collapsed } : {}) })
      .where(and(eq(workspaceListGroups.id, id), eq(workspaceListGroups.userId, user.id)))
      .returning()
    return { group: toGroupDTO(g) }
  })

  app.delete('/me/workspace-groups/:id', { preHandler: requireSessionUser }, async (req, reply) => {
    const user = getUser(req)
    const { id } = groupParams.parse(req.params)
    await ownGroup(id, user.id)
    await db.transaction(async (tx) => {
      // its workspaces join the ungrouped ones at their end, in the group's order
      await tx.execute(sql`
        WITH base AS (SELECT coalesce(max(position), -1) + 1 AS b FROM workspace_listings WHERE user_id = ${user.id} AND group_id IS NULL),
             moved AS (SELECT workspace_id, row_number() OVER (ORDER BY position NULLS LAST, workspace_id) - 1 AS k
                         FROM workspace_listings WHERE user_id = ${user.id} AND group_id = ${id})
        UPDATE workspace_listings l SET group_id = NULL, position = base.b + moved.k, updated_at = now()
          FROM base, moved WHERE l.user_id = ${user.id} AND l.workspace_id = moved.workspace_id
      `)
      await tx.delete(workspaceListGroups).where(and(eq(workspaceListGroups.id, id), eq(workspaceListGroups.userId, user.id)))
    })
    return reply.code(204).send()
  })

  app.put('/me/workspace-groups/order', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { ids } = workspaceGroupOrderSchema.parse(req.body)
    const current = await listGroups(user.id)
    const mine = new Set(current.map((g) => g.id))
    if (ids.some((id) => !mine.has(id))) throw notFound('NOT_FOUND', 'Group not found')
    // listed groups first in the given order, the others after them as they were
    const order = [...ids, ...current.map((g) => g.id).filter((id) => !ids.includes(id))]
    await db.transaction(async (tx) => {
      for (const [i, id] of order.entries()) {
        await tx.update(workspaceListGroups).set({ position: i }).where(and(eq(workspaceListGroups.id, id), eq(workspaceListGroups.userId, user.id)))
      }
    })
    return { groups: await listGroups(user.id) }
  })

  app.post('/me/workspace-groups/:id/archive', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { id } = groupParams.parse(req.params)
    const { archived } = workspaceGroupArchiveSchema.parse(req.body)
    await ownGroup(id, user.id)
    const rows = (await db.execute(sql`
      UPDATE workspace_listings SET archived_at = ${archived ? sql`coalesce(archived_at, now())` : sql`NULL`}, updated_at = now()
       WHERE user_id = ${user.id} AND group_id = ${id}
      RETURNING workspace_id
    `)) as unknown as { workspace_id: string }[]
    return { count: rows.length }
  })

  app.patch('/me/workspaces/:id/listing', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const workspaceId = idParam(req.params)
    const body = workspaceListingPatchSchema.parse(req.body)
    await requireListed(workspaceId, user.id)
    const set: Partial<typeof workspaceListings.$inferInsert> = { updatedAt: new Date() }
    if (body.archived !== undefined) set.archivedAt = body.archived ? new Date() : null
    if (body.groupId !== undefined) {
      if (body.groupId) await ownGroup(body.groupId, user.id)
      set.groupId = body.groupId
      set.position = await endOf(user.id, body.groupId)
    }
    if (body.archived) {
      // archiving twice keeps the first time
      const [cur] = await db
        .select({ archivedAt: workspaceListings.archivedAt })
        .from(workspaceListings)
        .where(and(eq(workspaceListings.userId, user.id), eq(workspaceListings.workspaceId, workspaceId)))
      if (cur?.archivedAt) set.archivedAt = cur.archivedAt
    }
    await db
      .insert(workspaceListings)
      .values({ userId: user.id, workspaceId, ...set })
      .onConflictDoUpdate({ target: [workspaceListings.userId, workspaceListings.workspaceId], set })
    const listing: WorkspaceListingDTO = (await listingsFor(user.id)).get(workspaceId) ?? {}
    return { listing }
  })

  app.put('/me/workspace-order', { preHandler: requireSessionUser }, async (req, reply) => {
    const user = getUser(req)
    const { groupId, ids } = workspaceOrderSchema.parse(req.body)
    if (groupId) await ownGroup(groupId, user.id)
    for (const id of ids) await requireListed(id, user.id)
    await db.transaction(async (tx) => {
      for (const [i, workspaceId] of ids.entries()) {
        const set = { groupId, position: i, updatedAt: new Date() }
        await tx
          .insert(workspaceListings)
          .values({ userId: user.id, workspaceId, ...set })
          .onConflictDoUpdate({ target: [workspaceListings.userId, workspaceListings.workspaceId], set })
      }
    })
    return reply.code(204).send()
  })
}
