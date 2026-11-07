import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  addMemberSchema,
  createWorkspaceSchema,
  deleteWorkspaceSchema,
  joinWorkspaceSchema,
  renameWorkspaceSchema,
  transferOwnershipSchema,
  updateMemberSchema,
} from '@inkling/shared'
import type {
  CalendarEventDTO,
  DeletedWorkspaceDTO,
  DueItemDTO,
  DueResponseDTO,
  DueSection,
  InvitePreviewDTO,
  MemberCandidateDTO,
  MemberDTO,
  TagCountDTO,
  WorkspaceDeletePreviewDTO,
  WorkspaceDTO,
} from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db, withSsdPlanCosts } from '../db/index'
import { closeUserWorkspaceConnections, closeWorkspaceConnections } from '../liveConnections'
import { precheckEtag } from '../httpCache'
import { indexEpoch, workspaceVersion } from '../versions'
import {
  notifications,
  pageLinks,
  pageTags,
  pageTexts,
  pages,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema'
import { badRequest, forbidden, notFound } from '../errors'
import {
  generateInviteCode,
  idParam,
  lockWorkspaceMembers,
  memberRoleTx,
  ownerCountTx,
  requireMembership,
} from '../helpers'
import type { WorkspaceRole } from '@inkling/shared'
import { pageColumns, toPageDTO, visibleTo } from '../pageDto'
import { escapeLike } from '../util'
import { collectDateItems } from '../md/dateItems'
import { broadcastToUser } from '../collab'
import { invalidateWebhookCache } from '../webhooks'
import {
  listRestorableWorkspaces,
  restoreWorkspace,
  softDeleteWorkspace,
  transferOwnership,
  workspaceDeletePreview,
} from '../workspaceDeletion'

const searchQuerySchema = z.object({ q: z.string().optional() })
const candidateQuerySchema = z.object({ q: z.string().trim().min(1).max(100) })
const dueQuerySchema = z.object({ range: z.enum(['today', 'week']).optional() })


/** Whether the users row shares a workspace with `me` (limits member-add candidates). */
function sharesWorkspaceWith(me: string) {
  return sql`exists (select 1 from ${workspaceMembers} mine join ${workspaceMembers} theirs on theirs.workspace_id = mine.workspace_id join workspaces sw on sw.id = mine.workspace_id and sw.deleted_at is null where mine.user_id = ${me} and theirs.user_id = ${users.id})`
}

/** The date `days` days from today, server-local, as 'YYYY-MM-DD' (local fields, no UTC conversion). */
function localDateISO(days: number): string {
  const n = new Date()
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + days)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** The current month, server-local, as 'YYYY-MM'. */
function currentMonth(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
}

/** First to last day of 'YYYY-MM' as local 'YYYY-MM-DD' strings [from, to]. */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  // new Date(y, m, 0) = last day of month m (1-based) (day 0 of next month index)
  const last = new Date(y, m, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

const ymdSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
const calendarQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  from: ymdSchema.optional(),
  to: ymdSchema.optional(),
})
const invitePreviewQuerySchema = z.object({ code: z.string().trim().min(1).max(20) })
const memberParamsSchema = z.object({ id: z.uuid(), userId: z.uuid() })
const tagPagesParamsSchema = z.object({ id: z.uuid(), tag: z.string().trim().min(1).max(80) })

/**
 * Body match snippet: ±60 chars around the first (case-insensitive) match.
 * Newlines/runs of whitespace collapse to one space; word boundaries are roughly respected. No match → ''.
 */
function buildSnippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const idx = flat.toLowerCase().indexOf(term.toLowerCase())
  if (idx < 0) return ''
  const matchEnd = idx + term.length
  let start = Math.max(0, idx - 60)
  let end = Math.min(flat.length, matchEnd + 60)
  // Rough word boundaries: start after the next space, end before the previous space (the match is kept)
  if (start > 0) {
    const sp = flat.indexOf(' ', start)
    if (sp >= 0 && sp < idx) start = sp + 1
  }
  if (end < flat.length) {
    const sp = flat.lastIndexOf(' ', end)
    if (sp > matchEnd) end = sp
  }
  let snippet = flat.slice(start, end).trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < flat.length) snippet = `${snippet}…`
  return snippet
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  // Workspaces I am a member of
  app.get('/workspaces', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        icon: workspaces.icon,
        inviteCode: workspaces.inviteCode,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      // soft-deleted workspaces are hidden from every member (ADR 0910); owners see them in /workspaces/deleted
      .where(and(eq(workspaceMembers.userId, user.id), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaces.createdAt))

    // The invite code is an owner credential (C-M3): members get '' (DTO field stays a string).
    const result: WorkspaceDTO[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      inviteCode: r.role === 'owner' ? r.inviteCode : '',
      role: r.role,
    }))
    return { workspaces: result }
  })

  // Create a workspace (caller becomes owner)
  app.post('/workspaces', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const body = createWorkspaceSchema.parse(req.body)

    const ws = await db.transaction(async (tx) => {
      const inviteCode = await generateInviteCode(tx)
      const [created] = await tx
        .insert(workspaces)
        .values({ name: body.name, inviteCode, createdBy: user.id })
        .returning()
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: created.id, userId: user.id, role: 'owner' })
      return created
    })

    const dto: WorkspaceDTO = {
      id: ws.id,
      name: ws.name,
      icon: ws.icon,
      inviteCode: ws.inviteCode,
      role: 'owner',
    }
    return { workspace: dto }
  })

  // Join with an invite code (idempotent)
  app.post(
    '/workspaces/join',
    {
      preHandler: requireUser,
      // Throttle invite-code brute force — 10/min per IP
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
    const user = getUser(req)
    const body = joinWorkspaceSchema.parse(req.body)
    const code = body.inviteCode.trim().toUpperCase()

    const ws = (
      await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.inviteCode, code), isNull(workspaces.deletedAt)))
        .limit(1)
    )[0]
    if (!ws) throw notFound('INVALID_CODE', 'Invalid invite code')

    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: user.id, role: 'member' })
      .onConflictDoNothing()

    const membership = (
      await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.userId, user.id),
          ),
        )
        .limit(1)
    )[0]

    const dto: WorkspaceDTO = {
      id: ws.id,
      name: ws.name,
      icon: ws.icon,
      inviteCode: membership.role === 'owner' ? ws.inviteCode : '',
      role: membership.role,
    }
    return { workspace: dto }
  })

  // Invite preview — login required, membership not. Exposes only the workspace name / member count.
  //   Limited to 30/min per IP to slow code enumeration.
  app.get(
    '/workspaces/invite-preview',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { code } = invitePreviewQuerySchema.parse(req.query)
      const normalized = code.trim().toUpperCase()

      const ws = (
        await db
          .select({ id: workspaces.id, name: workspaces.name, icon: workspaces.icon })
          .from(workspaces)
          .where(and(eq(workspaces.inviteCode, normalized), isNull(workspaces.deletedAt)))
          .limit(1)
      )[0]
      if (!ws) throw notFound('INVALID_CODE', 'Invalid invite code')

      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, ws.id))

      const preview: InvitePreviewDTO = {
        name: ws.name,
        icon: ws.icon,
        memberCount: n,
      }
      return preview
    },
  )

  // Member list
  app.get('/workspaces/:id/members', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id))
      .orderBy(asc(workspaceMembers.createdAt))

    const members: MemberDTO[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
    }))
    return { members }
  })

  // Member-add candidate search — people who share another workspace with me and are not members here yet.
  //   Emails of unrelated users are never exposed; newcomers join through the invite link.
  //   Any member can see the invite link, so any member may add people too.
  app.get('/workspaces/:id/member-candidates', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const { q } = candidateQuerySchema.parse(req.query)
    const pattern = `%${escapeLike(q)}%`

    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(
        and(
          or(ilike(users.name, pattern), ilike(users.email, pattern)),
          sharesWorkspaceWith(user.id),
          sql`not exists (select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${id} and ${workspaceMembers.userId} = ${users.id})`,
        ),
      )
      .orderBy(asc(users.name))
      .limit(8)

    const candidates: MemberCandidateDTO[] = rows
    return { candidates }
  })

  // Add an existing user directly — no invite link. The added person gets a notification.
  app.post('/workspaces/:id/members', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const { userId } = addMemberSchema.parse(req.body)

    const target = (
      await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.id, userId), sharesWorkspaceWith(user.id)))
        .limit(1)
    )[0]
    if (!target) throw notFound()

    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(workspaceMembers)
        .values({ workspaceId: id, userId, role: 'member' })
        .onConflictDoNothing()
        .returning({ userId: workspaceMembers.userId })
      if (rows.length === 0) return false
      await tx
        .insert(notifications)
        .values({ userId, type: 'workspace_added', workspaceId: id, actorId: user.id })
      return true
    })
    if (!inserted) throw badRequest('Already a member')
    broadcastToUser(userId, { t: 'notifications' })

    const member: MemberDTO = { ...target, role: 'member' }
    return { member }
  })

  // Change a member's role — owner only. The last owner cannot be demoted.
  app.patch('/workspaces/:id/members/:userId', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id, userId } = memberParamsSchema.parse(req.params)
    const body = updateMemberSchema.parse(req.body)

    await requireMembership(id, user.id)
    await changeMemberRole(user.id, id, userId, body.role)

    const row = (
      await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)),
        )
        .limit(1)
    )[0]
    if (!row) throw notFound()
    const member: MemberDTO = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
    }
    return { member }
  })

  // Remove a member (owner) / leave (any member). The last owner cannot leave.
  //   §D: private pages the leaving user created in this workspace are soft-deleted in the same
  //   transaction (only their author can see them, so they cannot stay with the team).
  app.delete(
    '/workspaces/:id/members/:userId',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req)
      const { id, userId } = memberParamsSchema.parse(req.params)

      await requireMembership(id, user.id)
      await removeMember(user.id, id, userId)
      // The removed member's open collab sockets in this workspace stop receiving/sending now
      // (authorisation is otherwise only checked at connect time — docs/adr/0754-*).
      await closeUserWorkspaceConnections(userId, id)

      return reply.code(204).send()
    },
  )

  // Regenerate the invite code — owner only. Invalidates the old link.
  app.post('/workspaces/:id/invite/regenerate', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)

    const role = await requireMembership(id, user.id)
    if (role !== 'owner') throw forbidden('Only owners can regenerate the invite code')

    const code = await generateInviteCode(db)
    const [ws] = await db
      .update(workspaces)
      .set({ inviteCode: code })
      .where(eq(workspaces.id, id))
      .returning()

    const dto: WorkspaceDTO = {
      id: ws.id,
      name: ws.name,
      icon: ws.icon,
      inviteCode: ws.inviteCode,
      role,
    }
    return { workspace: dto }
  })

  // Rename — owner only
  app.patch('/workspaces/:id', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = renameWorkspaceSchema.parse(req.body)

    const role = await requireMembership(id, user.id)
    if (role !== 'owner') throw forbidden('Only owners can rename the workspace')

    const [ws] = await db
      .update(workspaces)
      .set({ name: body.name })
      .where(eq(workspaces.id, id))
      .returning()

    const dto: WorkspaceDTO = {
      id: ws.id,
      name: ws.name,
      icon: ws.icon,
      inviteCode: ws.inviteCode,
      role,
    }
    return { workspace: dto }
  })

  // ---------------------------------------------------------------------------
  // Workspace deletion (soft, restorable for 30 days) and ownership transfer — ADR 0910 / 0911
  // ---------------------------------------------------------------------------

  // What a deletion affects, for the confirmation dialog — owner only.
  app.get('/workspaces/:id/delete-preview', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)
    if (role !== 'owner') throw forbidden('Only owners can delete the workspace')
    const preview: WorkspaceDeletePreviewDTO = await workspaceDeletePreview(id)
    return preview
  })

  // Soft delete — owner only, body { name } must equal the workspace name. Hidden from everyone at
  // once; members are notified (in-app only, no webhook) and their open documents are closed.
  app.delete('/workspaces/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = deleteWorkspaceSchema.parse(req.body ?? {})
    const res = await softDeleteWorkspace(user.id, id, body.name)
    invalidateWebhookCache(id)
    await closeWorkspaceConnections(id)
    // every member's switcher refetches; AppLayout sends them home when the id is gone
    for (const uid of res.memberIds) broadcastToUser(uid, { t: 'notifications' })
    return reply.code(204).send()
  })

  // Deleted workspaces I own that can still be restored (also shown on the empty-state screen).
  app.get('/workspaces/deleted', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const workspaces: DeletedWorkspaceDTO[] = await listRestorableWorkspaces(user.id)
    return { workspaces }
  })

  // Restore within 30 days — owner only.
  app.post('/workspaces/:id/restore', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const res = await restoreWorkspace(user.id, id)
    invalidateWebhookCache(id)
    for (const uid of res.memberIds) broadcastToUser(uid, { t: 'notifications' })
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
    if (!ws) throw notFound()
    const dto: WorkspaceDTO = {
      id: ws.id,
      name: ws.name,
      icon: ws.icon,
      inviteCode: ws.inviteCode,
      role: 'owner',
    }
    return { workspace: dto }
  })

  // Transfer ownership — the caller (owner) makes an existing member the owner and becomes a member.
  app.post('/workspaces/:id/transfer', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const { userId } = transferOwnershipSchema.parse(req.body)
    await requireMembership(id, user.id)
    await transferOwnership(user.id, id, userId)
    broadcastToUser(userId, { t: 'notifications' })
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id))
      .orderBy(asc(workspaceMembers.createdAt))
    const members: MemberDTO[] = rows
    return { members }
  })

  // Trash: every deleted page (flat), deletedAt desc
  app.get('/workspaces/:id/trash', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)

    const rows = await db
      .select(pageColumns)
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, id),
          isNotNull(pages.deletedAt),
          visibleTo(user.id),
        ),
      )
      .orderBy(desc(pages.deletedAt))

    return { pages: rows.map(toPageDTO) }
  })

  // Search: title ILIKE or body (page_texts) ILIKE (escaped), live pages, visibleTo.
  // Order: title matches first → body matches, each updatedAt desc. limit 20.
  // Body matches get a snippet around the first match (title matches do not).
  app.get('/workspaces/:id/search', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)

    const { q } = searchQuerySchema.parse(req.query)
    const term = (q ?? '').trim()
    if (!term) return { pages: [] }

    const pattern = `%${escapeLike(term)}%`
    const titleMatchExpr = sql<boolean>`(${pages.title} ILIKE ${pattern})`

    // ≥3 chars: candidate ids come from two trigram-indexable probes (title, body) instead of an
    // OR across the join, which detoasted + ILIKEd every body (78 ms → 3 ms on 5k pages,
    // docs/adr/0755-*). Shorter terms have no trigrams, and there the OR form wins because a
    // title hit short-circuits the body test — keep it.
    const matchIds =
      term.length >= 3
        ? sql`${pages.id} IN (
            SELECT p2.id FROM pages p2 WHERE p2.workspace_id = ${id} AND p2.title ILIKE ${pattern}
            UNION
            SELECT t2.page_id FROM page_texts t2 WHERE t2.text ILIKE ${pattern}
          )`
        : or(ilike(pages.title, pattern), ilike(pageTexts.text, pattern))
    const rows = await withSsdPlanCosts((tx) =>
      tx
        .select({
          ...pageColumns,
          bodyText: pageTexts.text,
          titleMatch: titleMatchExpr,
        })
        .from(pages)
        .leftJoin(pageTexts, eq(pageTexts.pageId, pages.id))
        .where(and(eq(pages.workspaceId, id), isNull(pages.deletedAt), visibleTo(user.id), matchIds))
        // title matches (true) first → updatedAt desc within each group
        // id last: deterministic ties (docs/adr/0937-*)
        .orderBy(desc(titleMatchExpr), desc(pages.updatedAt), asc(pages.id))
        .limit(20),
    )

    const result = rows.map((row) => {
      const dto = toPageDTO(row)
      // Snippets only for non-title (body-only) matches.
      if (!row.titleMatch && row.bodyText) {
        const snippet = buildSnippet(row.bodyText, term)
        if (snippet) return { ...dto, snippet }
      }
      return dto
    })

    return { pages: result }
  })

  // Global tag index: per-tag counts over the workspace's live + visibleTo pages.
  //   Tags are stored as written (case kept) but aggregated and sorted by lowercase.
  //   (Stored lowercase-distinct per page, so count = number of pages with that tag.)
  //   Order: count desc → name asc.
  app.get('/workspaces/:id/tags', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)

    const lowerTag = sql<string>`lower(${pageTags.tag})`
    const rows = await db
      .select({ tag: lowerTag, count: sql<number>`count(*)::int` })
      .from(pageTags)
      .innerJoin(pages, eq(pages.id, pageTags.pageId))
      .where(
        and(eq(pages.workspaceId, id), isNull(pages.deletedAt), visibleTo(user.id)),
      )
      .groupBy(lowerTag)
      .orderBy(desc(sql`count(*)`), asc(lowerTag))

    const tags: TagCountDTO[] = rows.map((r) => ({ tag: r.tag, count: r.count }))
    return { tags }
  })

  // Live + visibleTo pages with a given tag (lowercase compare). updatedAt desc.
  app.get('/workspaces/:id/tags/:tag/pages', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id, tag } = tagPagesParamsSchema.parse(req.params)
    await requireMembership(id, user.id)

    const rows = await db
      .selectDistinct(pageColumns)
      .from(pages)
      .innerJoin(pageTags, eq(pageTags.pageId, pages.id))
      .where(
        and(
          eq(pages.workspaceId, id),
          isNull(pages.deletedAt),
          visibleTo(user.id),
          eq(sql`lower(${pageTags.tag})`, tag.toLowerCase()),
        ),
      )
      .orderBy(desc(pages.updatedAt))

    return { pages: rows.map(toPageDTO) }
  })

  // Graph: live + visibleTo pages as nodes, page_links as edges.
  // Collection row pages (parent is a collection) are noise and excluded. Access: members.
  app.get(
    '/workspaces/:id/graph',
    {
      preHandler: requireUser,
      // Hardening H5: throttle full-graph amplification — 60/min per authenticated member IP.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    // Nodes = pages, edges = page_links (index epoch) — ADR 0752.
    if (precheckEtag(req, reply, [user.id, await workspaceVersion(id), indexEpoch()])) return reply

    const parent = alias(pages, 'parent')
    const nodeRows = await db
      .select({
        id: pages.id,
        title: pages.title,
        icon: pages.icon,
        kind: pages.kind,
        parentId: pages.parentId,
      })
      .from(pages)
      .leftJoin(parent, eq(pages.parentId, parent.id))
      .where(
        and(
          eq(pages.workspaceId, id),
          isNull(pages.deletedAt),
          visibleTo(user.id),
          // exclude row pages whose parent is a collection (root pages have no parent → kept)
          or(isNull(pages.parentId), ne(parent.kind, 'collection')),
        ),
      )

    const nodeIds = new Set(nodeRows.map((r) => r.id))
    const idList = [...nodeIds]

    // Edges: fetch links whose source is in the node set, then keep those whose target is too.
    const linkRows = idList.length
      ? await db
          .select({
            source: pageLinks.sourcePageId,
            target: pageLinks.targetPageId,
          })
          .from(pageLinks)
          .where(inArray(pageLinks.sourcePageId, idList))
      : []
    const edges = linkRows.filter((l) => nodeIds.has(l.target))

    // degree (in+out)
    const degree = new Map<string, number>()
    for (const nid of nodeIds) degree.set(nid, 0)
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }

    // Tags (for the graph's "tag nodes" option): page_tags of the node set only — a cheap PK index lookup.
    // Capped to avoid blow-ups (display only, so dropping the excess is fine).
    const tagRows = idList.length
      ? await db
          .select({ pageId: pageTags.pageId, tag: pageTags.tag })
          .from(pageTags)
          .where(inArray(pageTags.pageId, idList))
          .limit(20_000)
      : []

    const nodes = nodeRows.map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      kind: r.kind,
      // for group colours (top-level folder) — the client walks up the parent chain.
      parentId: r.parentId,
      links: degree.get(r.id) ?? 0,
    }))

    return { nodes, edges, tags: tagRows }
  })

  // Due view: dated items (rows, page date properties, tasks in documents) grouped into sections.
  //   Overdue (not done, last 60 days) · today · tomorrow · this week (remaining 7 days) · next 30 days · done
  //   (done, dated from 7 days ago to 30 days ahead). Daily notes are not deadlines and are excluded (calendar
  //   only). One item per row — a due-like date field name (due/deadline and Korean aliases) wins. Dates are
  //   compared as server-local 'YYYY-MM-DD' strings. ?range=today|week is accepted for old clients only (the
  //   response always has every section).
  app.get('/workspaces/:id/due', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    dueQuerySchema.parse(req.query)

    const today = localDateISO(0)
    // Rows/pages (workspace version), page_tasks (index epoch) and the server-local day.
    if (precheckEtag(req, reply, [user.id, await workspaceVersion(id), indexEpoch(), today])) {
      return reply
    }
    const tomorrow = localDateISO(1)
    const weekEnd = localDateISO(6)
    const horizon = localDateISO(30)
    const overdueFrom = localDateISO(-60)
    const doneFrom = localDateISO(-7)

    const all = await collectDateItems(id, user.id, {
      from: overdueFrom,
      to: horizon,
      kinds: ['row', 'page', 'task'],
      rowFields: 'due',
    })

    const counts: Record<DueSection, number> = {
      overdue: 0,
      today: 0,
      tomorrow: 0,
      week: 0,
      next30: 0,
      done: 0,
    }
    const items: DueItemDTO[] = []
    for (const it of all) {
      let section: DueSection | null
      if (it.done) section = it.date >= doneFrom ? 'done' : null
      else if (it.date < today) section = 'overdue'
      else if (it.date === today) section = 'today'
      else if (it.date === tomorrow) section = 'tomorrow'
      else if (it.date <= weekEnd) section = 'week'
      else section = 'next30'
      if (!section) continue
      counts[section]++
      items.push({ ...it, section })
    }
    const res: DueResponseDTO = { today, items, counts }
    return res
  })

  // Global calendar: unified dated items (every date field of rows · page date properties · daily notes · tasks
  //   in documents). ?month=YYYY-MM (default: this month) or ?from=&to= (both YYYY-MM-DD, max 62 days — month
  //   grid padding / week view). Response { events: CalendarEventDTO[] } — DateItemDTO + legacy `type` (= kind).
  app.get('/workspaces/:id/calendar', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)

    const q = calendarQuerySchema.parse(req.query)
    let from: string
    let to: string
    if (q.from && q.to) {
      from = q.from
      to = q.to
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
      if (!(span >= 0 && span <= 62)) throw badRequest('Range must be 0–62 days')
    } else {
      ;({ from, to } = monthRange(q.month ?? currentMonth()))
    }

    const items = await collectDateItems(id, user.id, { from, to, rowFields: 'all' })
    const events: CalendarEventDTO[] = items.map((it) => ({ ...it, type: it.kind }))
    return { events }
  })
}

/**
 * Role change under the workspace member lock (A-H2): the actor's own role and the owner count
 * are read inside the same transaction that writes, so two owners demoting each other at the
 * same time cannot both succeed and leave the workspace without an owner.
 */
export async function changeMemberRole(
  actorId: string,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockWorkspaceMembers(tx, workspaceId)
    const myRole = await memberRoleTx(tx, workspaceId, actorId)
    if (!myRole) throw forbidden()
    if (myRole !== 'owner') throw forbidden('Only owners can change member roles')
    const target = await memberRoleTx(tx, workspaceId, userId)
    if (!target) throw notFound()
    if (target === 'owner' && role !== 'owner' && (await ownerCountTx(tx, workspaceId)) <= 1) {
      throw badRequest('The last owner cannot be demoted')
    }
    await tx
      .update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
  })
}

/**
 * Removal by an owner, or leaving (actor = user), under the workspace member lock (A-H2).
 * When an owner removes someone else the invite code is regenerated in the same transaction:
 * the removed member knew it and could otherwise rejoin at once (C-M3).
 */
export async function removeMember(
  actorId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const isSelf = actorId === userId
  await db.transaction(async (tx) => {
    await lockWorkspaceMembers(tx, workspaceId)
    const myRole = await memberRoleTx(tx, workspaceId, actorId)
    if (!myRole) throw forbidden()
    if (!isSelf && myRole !== 'owner') throw forbidden('Only owners can remove members')
    const target = await memberRoleTx(tx, workspaceId, userId)
    if (!target) throw notFound()
    if (target === 'owner' && (await ownerCountTx(tx, workspaceId)) <= 1) {
      throw badRequest('The last owner cannot leave')
    }
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    // soft-delete the leaving user's private pages in this workspace (shared pages belong to the team and stay)
    await tx
      .update(pages)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          eq(pages.createdBy, userId),
          eq(pages.scope, 'private'),
          isNull(pages.deletedAt),
        ),
      )
    if (!isSelf) {
      const code = await generateInviteCode(tx)
      await tx.update(workspaces).set({ inviteCode: code }).where(eq(workspaces.id, workspaceId))
    }
  })
}
