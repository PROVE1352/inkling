import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  setAgentDefaultParentSchema,
  setChildSortSchema,
  setPinnedSchema,
  setRootSortSchema,
} from '@inkling/shared'
import type { RootSortDTO } from '@inkling/shared'
import { underInstructionPage } from '../agentDefaultParent'
import { gateWrite } from '../aclVersion'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { pages, workspaceMembers, workspaces } from '../db/schema'
import { actorFor, assertCan } from '../editLock'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, memberRoleTx, requireMembership } from '../helpers'
import { isGuestIn } from '../pageGrants'
import { findVisiblePage, pageColumns, toPageDTO, visibleTo } from '../pageDto'
import { capabilitiesFor, loadPolicy, recordAudit, requireManager } from '../workspaceAdmin'

/**
 * Sidebar order (docs/adr/2590-*, 2591-*, 2592-*). Browser sessions only: how the tree is arranged is
 * the people's decision; a token (MCP connection or API token) gets 403.
 *
 *   PUT /pages/:id/pin          { pinned }     people who may edit the page (not guests) → { page }
 *   PUT /pages/:id/child-sort   { childSort }  people who may edit the page (not guests) → { page }
 *   PUT /workspaces/:id/root-sort { section, childSort }
 *        shared = the workspace's top level, any member (as anyone may drag it);
 *        private = the caller's own private section → { rootSort }
 *   PUT /workspaces/:id/settings/agent-default-parent { pageId | null }
 *        owners and admins → { settings, role, can }; audited as settings.updated
 *
 * Pin and order changes bump the page's updated_at like a drag does, so the tree's ETag moves and
 * other members' sidebars pick it up on their next poll.
 */

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Only a person can change the sidebar order, in the web app')
}

/** The caller's top-level order of both sections (members; guests have no top level). */
export async function rootSortFor(workspaceId: string, userId: string): Promise<RootSortDTO> {
  const [row] = await db
    .select({ shared: workspaces.rootChildSort, priv: workspaceMembers.privateChildSort })
    .from(workspaces)
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  const out: RootSortDTO = {}
  if (row?.shared === 'title') out.shared = 'title'
  if (row?.priv === 'title') out.private = 'title'
  return out
}

/** One page switch (pin / child order) under the write gate and the page's edit rights. */
async function setPageFlag(
  req: FastifyRequest,
  set: Partial<{ pinned: boolean; childSort: 'manual' | 'title' }>,
): Promise<{ page: ReturnType<typeof toPageDTO> }> {
  const user = getUser(req)
  const id = idParam(req.params)
  const visible = await findVisiblePage(id, user.id)
  if (!visible) throw notFound()
  // A guest (docs/adr/1252-*) does not arrange the workspace's tree.
  if (isGuestIn(visible.workspaceId, user.id)) throw forbidden('Guests cannot change how the workspace sidebar is ordered')
  const row = await db.transaction(async (tx) => {
    const gate = await gateWrite(tx, visible.workspaceId, user.id)
    if (!gate.role) throw forbidden()
    const [page] = await tx
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.id, id), isNull(pages.deletedAt), visibleTo(user.id)))
      .limit(1)
      .for('update')
    if (!page) throw notFound()
    // the edit lock and page levels decide, as for a rename (docs/adr/0970-*)
    await assertCan(tx, id, actorFor(user.id, gate.role), { acl: gate.acl })
    const [updated] = await tx
      .update(pages)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(pages.id, id))
      .returning(pageColumns)
    return updated
  })
  return { page: toPageDTO(row) }
}

export async function registerSidebarOrderRoutes(app: FastifyInstance): Promise<void> {
  app.put('/pages/:id/pin', { preHandler: requireSessionUser }, async (req) => {
    const body = setPinnedSchema.parse(req.body)
    return setPageFlag(req, { pinned: body.pinned })
  })

  app.put('/pages/:id/child-sort', { preHandler: requireSessionUser }, async (req) => {
    const body = setChildSortSchema.parse(req.body)
    return setPageFlag(req, { childSort: body.childSort })
  })

  app.put('/workspaces/:id/root-sort', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setRootSortSchema.parse(req.body)
    // members only: requireMembership refuses guests (they have no top level)
    await requireMembership(id, user.id)
    if (body.section === 'shared') {
      await db.update(workspaces).set({ rootChildSort: body.childSort }).where(eq(workspaces.id, id))
    } else {
      await db
        .update(workspaceMembers)
        .set({ privateChildSort: body.childSort })
        .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, user.id)))
    }
    return { rootSort: await rootSortFor(id, user.id) }
  })

  app.put('/workspaces/:id/settings/agent-default-parent', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = setAgentDefaultParentSchema.parse(req.body)
    await requireMembership(id, user.id)
    let target: { id: string; title: string } | null = null
    if (body.pageId) {
      const page = await findVisiblePage(body.pageId, user.id)
      // another workspace's page answers like a missing one (docs/adr/1301-*)
      if (!page || page.workspaceId !== id) throw badRequest('Page is invalid')
      if (page.scope !== 'shared') {
        throw new AppError(400, 'DEFAULT_PARENT_PRIVATE', 'Pick a page in the shared section: agents create shared pages')
      }
      if (page.kind === 'collection') {
        throw new AppError(400, 'DEFAULT_PARENT_COLLECTION', 'Pick a page or folder, not a database: pages under a database are its rows')
      }
      // Instruction pages stay locked and agents only suggest there (docs/adr/0975-*, 2579-*).
      if (await underInstructionPage(db, page.id)) {
        throw new AppError(400, 'DEFAULT_PARENT_INSTRUCTIONS', 'Pick a page outside the agent instruction pages')
      }
      target = { id: page.id, title: page.title }
    }
    const result = await db.transaction(async (tx) => {
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      requireManager(role)
      const [cur] = await tx
        .select({ pageId: workspaces.agentDefaultParentId })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .for('update')
        .limit(1)
      if (!cur) throw notFound()
      const next = target?.id ?? null
      if ((cur.pageId ?? null) !== next) {
        await tx.update(workspaces).set({ agentDefaultParentId: next }).where(eq(workspaces.id, id))
        await recordAudit(tx, {
          workspaceId: id,
          actor: user,
          action: 'settings.updated',
          target: { type: 'workspace', id },
          before: { agentDefaultParentId: cur.pageId ?? null },
          after: { agentDefaultParentId: next },
        })
      }
      return { role, settings: await loadPolicy(tx, id) }
    })
    return { settings: result.settings, role: result.role, can: capabilitiesFor(result.role, result.settings) }
  })
}
