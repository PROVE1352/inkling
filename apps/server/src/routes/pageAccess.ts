import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  levelRank,
  MAX_PAGE_PEOPLE,
  removeGuestsSchema,
  setPageAccessSchema,
} from '@inkling/shared'
import type {
  AccessCandidateDTO,
  GuestAccessLevel,
  GuestInvitePolicy,
  PageAccessDTO,
  PageAccessLevel,
  PageInviteDTO,
  PageInvitePreviewDTO,
  PagePersonDTO,
  SetPageAccessResult,
  WorkspaceGuestDTO,
  WorkspaceRole,
} from '@inkling/shared'
import { db } from '../db/index'
import { pageGrants, pageInvites, pages, users, workspaces } from '../db/schema'
import { getUser, requireUser } from '../auth'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { findVisiblePage } from '../pageDto'
import { idParam, lockWorkspaceMembers, memberRoleTx, requireMembership } from '../helpers'
import { bumpAcl } from '../aclVersion'
import { lockTree } from '../pageTree'
import { subtreeIds } from '../editLock'
import { effectiveLevel, isManager, nearestGrants } from '../pageGrants'
import { loadPolicy, recordAudit } from '../workspaceAdmin'
import { closeUserPageConnections, closeUserWorkspaceConnections } from '../liveConnections'
import { verificationEnforced } from '../accounts'
import { mailEnabled } from '../env'
import { appOrigin, pageInviteMail, sendMail } from '../mail'

/**
 * People with access to a page tree and guests (docs/adr/1250-*, 1251-*).
 *
 *   GET    /pages/:id/access                     who has their own level here (rows on the path) + the caller's rights
 *   PUT    /pages/:id/access                     give one person (account or email) a level here
 *   DELETE /pages/:id/access/:userId             remove their row on this page
 *   DELETE /pages/:id/invites/:inviteId          withdraw an invitation
 *   GET    /pages/:id/access/candidates?q=       members by name/email; outsiders by exact email only
 *   GET    /workspaces/:id/guests                guests of the workspace and their pages (owners, admins)
 *   POST   /workspaces/:id/guests/remove         remove guests' rows in bulk (owners, admins)
 *   GET    /page-invites/:token                  invitation preview (signed in)
 *   POST   /page-invites/:token/accept           accept: becomes a row for the signed-in account (same email)
 *
 * All of them are browser sessions only (tokenPolicy.ts): access changes are made by people in the
 * web app, like edit locks (docs/adr/0970-*) and members (docs/adr/1204-*). Guests reach none of the
 * page routes here (requireMembership without `guests`): a guest does not see who else has access.
 * Every row change bumps the workspace access version inside the page-tree lock (docs/adr/1071-*)
 * and closes the person's live sockets in the subtree, so a reconnect re-evaluates their level.
 */

const INVITE_DAYS = 14
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Page access is changed in the web app only')
}

/** May `role` (with `myLevel` on the page) add people from outside the workspace here? */
function mayInviteGuests(policy: GuestInvitePolicy, role: WorkspaceRole, myLevel: PageAccessLevel | null): boolean {
  switch (policy) {
    case 'off':
      return false
    case 'owners':
      return role === 'owner'
    case 'admins':
      return isManager(role)
    case 'members':
      return isManager(role) || levelRank(myLevel) >= levelRank('edit')
  }
}

interface Ctx {
  page: { id: string; workspaceId: string; title: string; scope: 'shared' | 'private' }
  role: WorkspaceRole
  myLevel: PageAccessLevel
  canManage: boolean
  canInviteGuests: boolean
  policy: GuestInvitePolicy
}

async function loadCtx(pageId: string, userId: string): Promise<Ctx> {
  const page = await findVisiblePage(pageId, userId)
  if (!page) throw notFound()
  // Members only: a guest never sees the access list (docs/adr/1252-*).
  const role = await requireMembership(page.workspaceId, userId)
  const nearest = (await nearestGrants(db, [pageId], userId)).get(pageId)?.level ?? null
  const myLevel = page.scope === 'private' ? 'full' : (effectiveLevel(role, nearest) ?? 'view')
  const policy = (await loadPolicy(db, page.workspaceId)).guestInvitePolicy ?? 'admins'
  const shared = page.scope === 'shared'
  return {
    page: { id: page.id, workspaceId: page.workspaceId, title: page.title, scope: page.scope },
    role,
    myLevel,
    canManage: shared && (isManager(role) || myLevel === 'full'),
    canInviteGuests: shared && mayInviteGuests(policy, role, myLevel),
    policy,
  }
}

/** Rows on the page's path, nearest per person (the ones that decide), with names and guest flags. */
async function peopleOnPath(pageId: string, workspaceId: string, viewerId: string): Promise<PagePersonDTO[]> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${pageId}
      UNION ALL
      SELECT p.id, p.parent_id, u.depth + 1 FROM pages p JOIN up u ON p.id = u.parent_id WHERE u.depth < 64
    )
    SELECT DISTINCT ON (g.user_id) g.user_id AS "userId", g.level, g.page_id AS "pageId",
           u.name, u.email, p.title, (p.scope = 'shared' OR p.created_by = ${viewerId}) AS "titleVisible",
           NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${workspaceId} AND m.user_id = g.user_id) AS guest
      FROM up
      JOIN page_grants g ON g.page_id = up.id
      JOIN users u ON u.id = g.user_id
      JOIN pages p ON p.id = up.id
     ORDER BY g.user_id, up.depth
  `)) as unknown as {
    userId: string
    level: PageAccessLevel
    pageId: string
    name: string
    email: string
    title: string
    titleVisible: boolean
    guest: boolean
  }[]
  return rows
    .map((r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      level: r.guest && r.level === 'full' ? ('edit' as const) : r.level,
      guest: r.guest,
      inheritedFrom: r.pageId === pageId ? null : { pageId: r.pageId, title: r.titleVisible ? r.title : '' },
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.userId < b.userId ? -1 : 1))
}

async function invitesOf(pageId: string): Promise<PageInviteDTO[]> {
  const rows = await db
    .select()
    .from(pageInvites)
    .where(and(eq(pageInvites.pageId, pageId), sql`${pageInvites.expiresAt} > now()`))
    .orderBy(pageInvites.email)
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    level: r.level,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }))
}

async function accessDTO(ctx: Ctx, viewerId: string): Promise<PageAccessDTO> {
  const isPrivate = ctx.page.scope === 'private'
  return {
    pageId: ctx.page.id,
    people: isPrivate ? [] : await peopleOnPath(ctx.page.id, ctx.page.workspaceId, viewerId),
    invites: !isPrivate && (ctx.canManage || ctx.canInviteGuests) ? await invitesOf(ctx.page.id) : [],
    myLevel: ctx.myLevel,
    canManage: ctx.canManage,
    canInviteGuests: ctx.canInviteGuests,
    guestPolicy: ctx.policy,
    private: isPrivate,
  }
}

/**
 * Writes one row inside the page-tree lock with a new access version. Re-reads the target's role and
 * the page under the lock. Returns whether anything changed.
 */
async function writeRow(
  ctx: Ctx,
  actor: { id: string; name: string },
  targetId: string,
  level: PageAccessLevel,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockTree(tx, ctx.page.workspaceId)
    await lockWorkspaceMembers(tx, ctx.page.workspaceId)
    await bumpAcl(tx, ctx.page.workspaceId)
    const [p] = await tx
      .select({ scope: pages.scope, deletedAt: pages.deletedAt })
      .from(pages)
      .where(eq(pages.id, ctx.page.id))
      .limit(1)
    if (!p || p.deletedAt) throw notFound()
    if (p.scope !== 'shared') throw badRequest('Private pages are their author’s only')
    const myRole = await memberRoleTx(tx, ctx.page.workspaceId, actor.id)
    if (myRole !== ctx.role) throw forbidden()
    const targetRole = await memberRoleTx(tx, ctx.page.workspaceId, targetId)
    if (isManager(targetRole)) throw badRequest('Owners and admins always have full access')
    if (!targetRole && level === 'full') throw badRequest('Guests can have view, comment or edit access')
    const [existing] = await tx
      .select({ level: pageGrants.level })
      .from(pageGrants)
      .where(and(eq(pageGrants.pageId, ctx.page.id), eq(pageGrants.userId, targetId)))
      .limit(1)
    if (existing?.level === level) return false
    if (!existing) {
      const [{ n }] = (await tx.execute(sql`
        SELECT (SELECT count(*) FROM page_grants WHERE page_id = ${ctx.page.id})
             + (SELECT count(*) FROM page_invites WHERE page_id = ${ctx.page.id} AND expires_at > now()) AS n
      `)) as unknown as { n: string }[]
      if (Number(n) >= MAX_PAGE_PEOPLE) throw badRequest(`A page can have at most ${MAX_PAGE_PEOPLE} people of its own`)
    }
    await tx
      .insert(pageGrants)
      .values({ pageId: ctx.page.id, userId: targetId, level, createdBy: actor.id })
      .onConflictDoUpdate({ target: [pageGrants.pageId, pageGrants.userId], set: { level, updatedAt: new Date() } })
    const [who] = await tx.select({ name: users.name }).from(users).where(eq(users.id, targetId)).limit(1)
    await recordAudit(tx, {
      workspaceId: ctx.page.workspaceId,
      actor,
      action: existing ? 'page.access_changed' : 'page.access_granted',
      target: { type: 'page', id: ctx.page.id, label: ctx.page.title || 'Untitled' },
      before: existing ? { person: who?.name ?? targetId, level: existing.level } : null,
      after: { person: who?.name ?? targetId, level, guest: !targetRole },
    })
    return true
  })
}

/** Checks what the caller may do to `targetId`'s row (role read now; the write re-reads it under the lock). */
async function assertMayChange(ctx: Ctx, actorId: string, targetId: string, level: PageAccessLevel | null): Promise<void> {
  if (ctx.page.scope !== 'shared') throw badRequest('Private pages are their author’s only')
  const targetRole = await memberRoleTx(db, ctx.page.workspaceId, targetId)
  if (targetId === actorId && !isManager(ctx.role) && level !== null) {
    throw badRequest('Ask someone with full access to change your own access')
  }
  if (isManager(targetRole)) throw badRequest('Owners and admins always have full access')
  if (!targetRole && level === 'full') throw badRequest('Guests can have view, comment or edit access')
  if (targetRole) {
    if (!ctx.canManage) throw forbidden('Only people with full access to this page can change members’ access')
  } else {
    // A new guest needs the guest policy, even for owners and admins (policy 'off' means nobody);
    // an existing guest's row can be lowered, changed or removed by whoever manages the page.
    const [row] = await db
      .select({ level: pageGrants.level })
      .from(pageGrants)
      .where(and(eq(pageGrants.pageId, ctx.page.id), eq(pageGrants.userId, targetId)))
      .limit(1)
    const allowed = row ? ctx.canManage || ctx.canInviteGuests : ctx.canInviteGuests
    if (!allowed) throw forbidden('The workspace settings do not allow you to share this page with people outside the workspace')
  }
  // Nobody hands out more than they have (owners and admins have full everywhere).
  if (level && !isManager(ctx.role) && levelRank(level) > levelRank(ctx.myLevel)) {
    throw forbidden('You cannot give more access than you have')
  }
}

const userParams = z.object({ id: z.uuid(), userId: z.uuid() })
const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() })
const tokenParams = z.object({ token: z.string().min(20).max(100) })
const candidatesQuery = z.object({ q: z.string().trim().max(320).default('') })

async function loadInvite(token: string) {
  const [row] = (await db.execute(sql`
    SELECT i.id, i.page_id AS "pageId", i.email, i.level, i.expires_at AS "expiresAt",
           p.workspace_id AS "workspaceId", p.title, w.name AS "workspaceName", iu.name AS "invitedBy"
      FROM page_invites i
      JOIN pages p ON p.id = i.page_id AND p.deleted_at IS NULL AND p.scope = 'shared'
      JOIN workspaces w ON w.id = p.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN users iu ON iu.id = i.invited_by
     WHERE i.token_hash = ${sha256(token)} AND i.expires_at > now()
  `)) as unknown as {
    id: string
    pageId: string
    email: string
    level: GuestAccessLevel
    workspaceId: string
    title: string
    workspaceName: string
    invitedBy: string | null
  }[]
  if (!row) throw notFound('INVALID_INVITE', 'This invitation is not valid any more')
  return row
}

/** The signed-in account may take an invitation for `email`: same address, verified where the server verifies. */
async function emailMatches(userId: string, email: string): Promise<boolean> {
  const [u] = await db
    .select({ email: users.email, verifiedAt: users.emailVerifiedAt, origin: users.origin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!u || u.email.toLowerCase() !== email) return false
  if (verificationEnforced() && !u.verifiedAt && u.origin !== 'delegated' && u.origin !== 'oidc') return false
  return true
}

export async function registerPageAccessRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/access', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const ctx = await loadCtx(idParam(req.params), user.id)
    return { access: await accessDTO(ctx, user.id) }
  })

  app.put('/pages/:id/access', { preHandler: requireSessionUser }, async (req): Promise<SetPageAccessResult> => {
    const user = getUser(req)
    const body = setPageAccessSchema.parse(req.body)
    const ctx = await loadCtx(idParam(req.params), user.id)
    let targetId = body.userId ?? null
    if (!targetId && body.email) {
      // Exact address only: the dialog never lists the instance's accounts by prefix.
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${body.email.toLowerCase()}`)
        .limit(1)
      targetId = u?.id ?? null
    }
    if (!targetId) {
      // No account with that address: an invitation (guests only, so the guest policy decides).
      if (!ctx.canInviteGuests) {
        throw forbidden('The workspace settings do not allow you to share this page with people outside the workspace')
      }
      if (ctx.page.scope !== 'shared') throw badRequest('Private pages are their author’s only')
      if (body.level === 'full') throw badRequest('Guests can have view, comment or edit access')
      if (!isManager(ctx.role) && levelRank(body.level) > levelRank(ctx.myLevel)) throw forbidden('You cannot give more access than you have')
      return createInvite(req, ctx, user, body.email!.toLowerCase(), body.level)
    }
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).limit(1)
    if (!exists) throw notFound()
    await assertMayChange(ctx, user.id, targetId, body.level)
    const changed = await writeRow(ctx, user, targetId, body.level)
    if (changed) closeUserPageConnections(targetId, await subtreeIds(db, ctx.page.id))
    return { access: await accessDTO(await loadCtx(ctx.page.id, user.id), user.id) }
  })

  app.delete('/pages/:id/access/:userId', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { id, userId } = userParams.parse(req.params)
    const ctx = await loadCtx(id, user.id)
    if (userId !== user.id) await assertMayChange(ctx, user.id, userId, null)
    const removed = await db.transaction(async (tx) => {
      await lockTree(tx, ctx.page.workspaceId)
      await lockWorkspaceMembers(tx, ctx.page.workspaceId)
      await bumpAcl(tx, ctx.page.workspaceId)
      const rows = await tx
        .delete(pageGrants)
        .where(and(eq(pageGrants.pageId, id), eq(pageGrants.userId, userId)))
        .returning({ level: pageGrants.level })
      if (!rows.length) return false
      const [who] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1)
      await recordAudit(tx, {
        workspaceId: ctx.page.workspaceId,
        actor: user,
        action: 'page.access_removed',
        target: { type: 'page', id, label: ctx.page.title || 'Untitled' },
        before: { person: who?.name ?? userId, level: rows[0].level },
      })
      return true
    })
    if (!removed) throw notFound()
    closeUserPageConnections(userId, await subtreeIds(db, id))
    return { access: await accessDTO(await loadCtx(id, user.id), user.id) }
  })

  app.delete('/pages/:id/invites/:inviteId', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { id, inviteId } = inviteParams.parse(req.params)
    const ctx = await loadCtx(id, user.id)
    if (!(ctx.canManage || ctx.canInviteGuests)) throw forbidden()
    const rows = await db
      .delete(pageInvites)
      .where(and(eq(pageInvites.id, inviteId), eq(pageInvites.pageId, id)))
      .returning({ id: pageInvites.id })
    if (!rows.length) throw notFound()
    return { access: await accessDTO(ctx, user.id) }
  })

  app.get('/pages/:id/access/candidates', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const { q } = candidatesQuery.parse(req.query)
    const ctx = await loadCtx(idParam(req.params), user.id)
    if (!(ctx.canManage || ctx.canInviteGuests)) throw forbidden()
    const out: AccessCandidateDTO[] = []
    if (q && ctx.canManage) {
      // Members of this workspace by name or email (what the members list already shows them).
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      const rows = (await db.execute(sql`
        SELECT u.id AS "userId", u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ${ctx.page.workspaceId} AND m.role = 'member' AND m.user_id <> ${user.id}
           AND (u.name ILIKE ${like} OR u.email ILIKE ${like})
         ORDER BY u.name, u.id LIMIT 8
      `)) as unknown as { userId: string; name: string; email: string }[]
      for (const r of rows) out.push({ ...r, guest: false })
    }
    if (ctx.canInviteGuests && z.email().safeParse(q).success) {
      // Outsiders: an exact address only, never a prefix search over the instance's accounts.
      const rows = (await db.execute(sql`
        SELECT u.id AS "userId", u.name, u.email FROM users u
         WHERE lower(u.email) = ${q.toLowerCase()}
           AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${ctx.page.workspaceId} AND m.user_id = u.id)
         LIMIT 1
      `)) as unknown as { userId: string; name: string; email: string }[]
      for (const r of rows) out.push({ ...r, guest: true })
    }
    return { candidates: out }
  })

  // ---------------------------------------------------------------------------
  // Workspace guest list (owners and admins)
  // ---------------------------------------------------------------------------

  app.get('/workspaces/:id/guests', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)
    if (!isManager(role)) throw forbidden('Only owners and admins can see the guests')
    const rows = (await db.execute(sql`
      SELECT g.user_id AS "userId", u.name, u.email, g.page_id AS "pageId", p.title, g.level
        FROM page_grants g
        JOIN pages p ON p.id = g.page_id AND p.workspace_id = ${id} AND p.deleted_at IS NULL
        JOIN users u ON u.id = g.user_id
       WHERE NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${id} AND m.user_id = g.user_id)
       ORDER BY u.name, g.user_id, p.title, g.page_id
    `)) as unknown as { userId: string; name: string; email: string; pageId: string; title: string; level: PageAccessLevel }[]
    const byUser = new Map<string, WorkspaceGuestDTO>()
    for (const r of rows) {
      const g = byUser.get(r.userId) ?? { userId: r.userId, name: r.name, email: r.email, pages: [] }
      g.pages.push({ pageId: r.pageId, title: r.title, level: r.level === 'full' ? 'edit' : r.level })
      byUser.set(r.userId, g)
    }
    return { guests: [...byUser.values()] }
  })

  app.post('/workspaces/:id/guests/remove', { preHandler: requireSessionUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = removeGuestsSchema.parse(req.body)
    const removed = await db.transaction(async (tx) => {
      await lockTree(tx, id)
      await lockWorkspaceMembers(tx, id)
      await bumpAcl(tx, id)
      const role = await memberRoleTx(tx, id, user.id)
      if (!role) throw forbidden()
      if (!isManager(role)) throw forbidden('Only owners and admins can remove guests')
      const rows = (await tx.execute(sql`
        DELETE FROM page_grants g USING pages p
         WHERE p.id = g.page_id AND p.workspace_id = ${id}
           AND g.user_id = ANY(${`{${body.userIds.join(',')}}`}::uuid[])
           AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ${id} AND m.user_id = g.user_id)
        RETURNING g.user_id AS "userId"
      `)) as unknown as { userId: string }[]
      const people = [...new Set(rows.map((r) => r.userId))]
      if (people.length) {
        await recordAudit(tx, {
          workspaceId: id,
          actor: user,
          action: 'guests.removed',
          target: { type: 'workspace', id },
          after: { guests: people.length, rows: rows.length },
        })
      }
      return people
    })
    for (const u of removed) await closeUserWorkspaceConnections(u, id)
    return { removed: removed.length }
  })

  // ---------------------------------------------------------------------------
  // Invitations for addresses without an account
  // ---------------------------------------------------------------------------

  app.get(
    '/page-invites/:token',
    { preHandler: requireSessionUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const { token } = tokenParams.parse(req.params)
      const inv = await loadInvite(token)
      const preview: PageInvitePreviewDTO = {
        workspaceName: inv.workspaceName,
        pageTitle: inv.title,
        level: inv.level,
        invitedBy: inv.invitedBy,
        emailMatches: await emailMatches(user.id, inv.email),
      }
      return { invite: preview }
    },
  )

  app.post(
    '/page-invites/:token/accept',
    { preHandler: requireSessionUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const { token } = tokenParams.parse(req.params)
      const inv = await loadInvite(token)
      // A forwarded link is not an invitation: the account must have the invited address.
      if (!(await emailMatches(user.id, inv.email))) {
        throw new AppError(403, 'INVITE_EMAIL_MISMATCH', 'This invitation is for another email address')
      }
      await db.transaction(async (tx) => {
        await lockTree(tx, inv.workspaceId)
        await lockWorkspaceMembers(tx, inv.workspaceId)
        await bumpAcl(tx, inv.workspaceId)
        const gone = await tx.delete(pageInvites).where(eq(pageInvites.id, inv.id)).returning({ id: pageInvites.id })
        if (!gone.length) throw notFound('INVALID_INVITE', 'This invitation is not valid any more')
        // A member already sees the page; their level stays what it is.
        if (await memberRoleTx(tx, inv.workspaceId, user.id)) return
        const [cur] = await tx
          .select({ level: pageGrants.level })
          .from(pageGrants)
          .where(and(eq(pageGrants.pageId, inv.pageId), eq(pageGrants.userId, user.id)))
          .limit(1)
        if (cur && levelRank(cur.level) >= levelRank(inv.level)) return
        await tx
          .insert(pageGrants)
          .values({ pageId: inv.pageId, userId: user.id, level: inv.level, createdBy: null })
          .onConflictDoUpdate({ target: [pageGrants.pageId, pageGrants.userId], set: { level: inv.level, updatedAt: new Date() } })
        await recordAudit(tx, {
          workspaceId: inv.workspaceId,
          actor: user,
          action: 'page.access_granted',
          target: { type: 'page', id: inv.pageId, label: inv.title || 'Untitled' },
          after: { person: user.name, level: inv.level, guest: true, via: 'invitation' },
        })
      })
      return { workspaceId: inv.workspaceId, pageId: inv.pageId }
    },
  )
}

async function createInvite(
  req: FastifyRequest,
  ctx: Ctx,
  actor: { id: string; name: string },
  email: string,
  level: GuestAccessLevel,
): Promise<SetPageAccessResult> {
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000)
  const invite = await db.transaction(async (tx) => {
    const [{ n }] = (await tx.execute(sql`
      SELECT (SELECT count(*) FROM page_grants WHERE page_id = ${ctx.page.id})
           + (SELECT count(*) FROM page_invites WHERE page_id = ${ctx.page.id} AND expires_at > now()) AS n
    `)) as unknown as { n: string }[]
    if (Number(n) >= MAX_PAGE_PEOPLE) throw badRequest(`A page can have at most ${MAX_PAGE_PEOPLE} people of its own`)
    // One live invitation per address and page: a new one replaces the old link.
    await tx.delete(pageInvites).where(and(eq(pageInvites.pageId, ctx.page.id), eq(pageInvites.email, email)))
    const [row] = await tx
      .insert(pageInvites)
      .values({ pageId: ctx.page.id, email, level, tokenHash: sha256(token), invitedBy: actor.id, expiresAt })
      .returning()
    await recordAudit(tx, {
      workspaceId: ctx.page.workspaceId,
      actor,
      action: 'page.guest_invited',
      target: { type: 'page', id: ctx.page.id, label: ctx.page.title || 'Untitled' },
      after: { email, level },
    })
    return row
  })
  const url = `${appOrigin(req)}/invite/page/${token}`
  let mailed = false
  if (mailEnabled) {
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.page.workspaceId)).limit(1)
    try {
      await sendMail(email, pageInviteMail({ inviter: actor.name, pageTitle: ctx.page.title, workspaceName: ws?.name ?? '', url, expiresAt }))
      mailed = true
    } catch (err) {
      req.log.warn({ err }, 'page invite mail failed')
    }
  }
  const dto: PageInviteDTO = {
    id: invite.id,
    email,
    level,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    ...(mailed ? {} : { link: url }),
  }
  return { access: await accessDTO(ctx, actor.id), invite: dto, mailed }
}
