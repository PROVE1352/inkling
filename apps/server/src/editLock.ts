import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  LockAgents,
  LockPeople,
  LockPersonDTO,
  PageLockDTO,
  SetPageLockInput,
  WorkspaceAccessRole,
  WorkspaceRole,
} from '@inkling/shared'
import { db } from './db/index'
import { agentInstructions, pageAccessOverrides, pages, users, workspaceMembers } from './db/schema'
import { AppError, badRequest, forbidden, notFound } from './errors'
import { currentAgent } from './agentAccess'
import { assertNotDemoted } from './agentTaint'
import { closePageConnections } from './liveConnections'
import { descendantsCte, lockTree, TREE_MAX_DEPTH } from './pageTree'
import { isManagerRole, recordAudit } from './workspaceAdmin'
import type { AuditActor } from './workspaceAdmin'
import { BoundedLru } from './lru'
import { aclForPages, bumpAcl, cacheable, pageAccess, recountLockedPages } from './aclVersion'
import type { AclState } from './aclVersion'
import { pageIdsInRange } from './tokenRange'
import {
  effectiveLevel,
  grantCaps,
  grantedDescendants,
  grantLevelsFor,
  knownWithoutRows,
  nearestGrants,
  pageAccessError,
  workspaceHasGrants,
} from './pageGrants'

/**
 * Edit lock (docs/adr/0970-*, evaluation order in 0971-*).
 *
 * Nothing is locked by default: every member may edit and comment on every page they can see. A
 * page with `edit_locked = true` is a lock node; its rows in page_access_overrides remove (deny) and
 * add (allow) the bits EDIT and COMMENT for three subjects:
 *
 *   everyone    people (browser sessions and background jobs)
 *   user:<id>   one member (the lock node's pages.owner_id gets an implicit allow EDIT here)
 *   agents      any MCP / OAuth request, whoever's agent it is
 *
 * Evaluation for one page: start from EDIT|COMMENT, then walk the lock nodes on the path from the
 * top level down to the page (nearer nodes later, so they win). At each node apply, in order:
 * everyone, user (both skipped for workspace owners/admins), agents (agent requests only — owners'
 * and admins' agents included). Each layer is `caps = (caps & ~deny) | (allow & ~deny)`: deny is
 * taken out first, then allow is added, and a bit in both deny and allow of one layer stays denied.
 * Bits a node does not mention are inherited unchanged (field-wise inheritance).
 *
 * Enforcement is on the server at every write path (REST routes, Hocuspocus read-only
 * connections, assertPlacement for anything created under a parent). A check reads the workspace's
 * access state (docs/adr/1071-*) first: a workspace without any locked page needs no walk at all;
 * otherwise the lock chain comes from a cache keyed by the access version, or from one recursive
 * CTE capped at TREE_MAX_DEPTH (docs/adr/0800-*). A denial is always re-checked against the
 * database before it is reported, so the error names the current lock node.
 */

export const CAP_EDIT = 1
export const CAP_COMMENT = 2
/**
 * Agents only (docs/adr/1532-*): the agent may not edit but its writes become suggestions a person
 * accepts or rejects. Set by the 'suggest' agents preset (allow SUGGEST, deny EDIT); never part of
 * the default bits, and only kept while the agent's person may edit the page (a suggestion is an
 * edit waiting for a person, so it cannot reach further than the person could).
 */
export const CAP_SUGGEST = 4
/**
 * Markers of the agents row, never effective bits (docs/adr/1544-*): AUTO = the node's suggestions
 * are accepted by its auto-accept rules (with SUGGEST, deny EDIT); DIRECT = agents edit directly here
 * whatever the workspace's default policy says (no EDIT is granted: a lock never loosens).
 */
export const CAP_AUTO = 8
export const CAP_DIRECT = 16
const CAP_ALL = CAP_EDIT | CAP_COMMENT

type Exec = Pick<typeof db, 'execute'>

interface Override {
  s: string
  a: number
  d: number
}

/** One lock node on a page's path. */
export interface LockNode {
  id: string
  title: string
  ownerId: string | null
  overrides: Override[]
}

export interface AccessActor {
  userId: string
  /** 'guest': not a member; their page rows are all they have (docs/adr/1251-*). */
  role: WorkspaceAccessRole | null
  /** The request comes from an agent (MCP / OAuth bearer token). */
  agent: boolean
}

/** Actor of the current request: agent when it runs inside an MCP / bearer request (agentAccess). */
export function actorFor(userId: string, role: WorkspaceAccessRole | null): AccessActor {
  return { userId, role, agent: currentAgent() !== null }
}

let walks = 0
/** Test hook: number of lock walks (lockChains statements) run by this process. */
export function _lockWalks(): number {
  return walks
}

/** Lock nodes on the path of each leaf, top level first. One statement for any number of leaves. */
export async function lockChains(exec: Exec, leafIds: string[]): Promise<Map<string, LockNode[]>> {
  const out = new Map<string, LockNode[]>(leafIds.map((id) => [id, []]))
  if (!leafIds.length) return out
  walks++
  const rows = (await exec.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id AS leaf, id, parent_id, edit_locked, 0 AS depth FROM pages WHERE id = ANY(${`{${leafIds.join(',')}}`}::uuid[])
      UNION ALL
      SELECT u.leaf, p.id, p.parent_id, p.edit_locked, u.depth + 1 FROM pages p JOIN up u ON p.id = u.parent_id
       WHERE u.depth < ${TREE_MAX_DEPTH}
    )
    SELECT up.leaf, up.id, p.title, p.owner_id AS "ownerId",
           coalesce((SELECT json_agg(json_build_object('s', o.subject, 'a', o.allow, 'd', o.deny) ORDER BY o.subject)
                       FROM page_access_overrides o WHERE o.page_id = up.id), '[]'::json) AS ov
      FROM up JOIN pages p ON p.id = up.id
     WHERE up.edit_locked
     ORDER BY up.leaf, up.depth DESC
  `)) as unknown as { leaf: string; id: string; title: string; ownerId: string | null; ov: Override[] }[]
  for (const r of rows) {
    out.get(r.leaf)?.push({ id: r.id, title: r.title, ownerId: r.ownerId, overrides: r.ov ?? [] })
  }
  return out
}

// Lock chains per leaf page, valid only for the access version they were read under
// (docs/adr/1071-*). The TTL is a memory bound only: validity comes from the version compare.
const chainCache = new BoundedLru<{ ws: string; v: number; chain: LockNode[] }>(50_000, 60 * 60_000)

/**
 * Lock chains of `leaves` given their workspace access state: [] without a lock in the workspace,
 * the cached chain for the same version, else one lockChains walk for all misses (then cached under
 * the version that was read before the walk).
 */
async function chainsFor(exec: Exec, leaves: string[], acl: Map<string, AclState>): Promise<Map<string, LockNode[]>> {
  const out = new Map<string, LockNode[]>()
  const miss: string[] = []
  for (const id of leaves) {
    const a = acl.get(id)
    if (a && !a.hasLocks) out.set(id, [])
    else {
      const hit = a ? chainCache.get(id) : undefined
      if (hit && a && hit.v === a.version && hit.ws === a.workspaceId) out.set(id, hit.chain)
      else miss.push(id)
    }
  }
  if (miss.length) {
    const fresh = await lockChains(exec, miss)
    const store = cacheable(exec)
    for (const id of miss) {
      const chain = fresh.get(id) ?? []
      out.set(id, chain)
      const a = acl.get(id)
      if (a && store) chainCache.set(id, { ws: a.workspaceId, v: a.version, chain })
    }
  }
  return out
}

/** Test hook: forget cached lock chains. */
export function _resetLockChainCache(): void {
  chainCache.clear()
}

function applyLayer(caps: number, o: { a: number; d: number } | undefined): number {
  if (!o) return caps
  return (caps & ~o.d) | (o.a & ~o.d)
}

/**
 * The agents layer of one node. A layer that takes EDIT away without granting SUGGEST also takes an
 * inherited SUGGEST away (docs/adr/1532-*): 'comment'/'read' rows written before SUGGEST existed deny
 * EDIT only, and a nearer stricter node must still win over an outer 'suggest'.
 */
function agentLayer(o: { a: number; d: number } | undefined): { a: number; d: number } | undefined {
  if (!o) return o
  return o.d & CAP_EDIT && !(o.a & CAP_SUGGEST) ? { a: o.a, d: o.d | CAP_SUGGEST } : o
}

/** Effective bits of `actor` on a page whose lock nodes (top level first) are `chain`. */
export function effectiveCaps(chain: LockNode[], actor: AccessActor): number {
  let caps = CAP_ALL
  const manager = isManagerRole(actor.role)
  for (const node of chain) {
    const by = new Map(node.overrides.map((o) => [o.s, o]))
    if (!manager) {
      caps = applyLayer(caps, by.get('everyone'))
      const own = by.get(`user:${actor.userId}`)
      const ownerAllow = node.ownerId === actor.userId ? CAP_EDIT : 0
      caps = applyLayer(caps, own || ownerAllow ? { a: (own?.a ?? 0) | ownerAllow, d: own?.d ?? 0 } : undefined)
    }
    if (actor.agent) caps = applyLayer(caps, agentLayer(by.get('agents')))
  }
  // SUGGEST is an agent bit, and only while the agent's person may edit here (docs/adr/1532-*).
  if (caps & CAP_SUGGEST && (!actor.agent || caps & CAP_EDIT || !(effectiveCaps(chain, { ...actor, agent: false }) & CAP_EDIT))) {
    caps &= ~CAP_SUGGEST
  }
  return caps & ~(CAP_AUTO | CAP_DIRECT)
}

/**
 * The agent edit policy a lock chain sets (docs/adr/1544-*): the nearest node with an agents rule
 * decides — 'direct', 'auto' (with that node's rules) or 'review' (suggestions only) — and null when
 * no node has one (the workspace default applies) or the nearest one only takes rights away
 * (comment/read: the caps refuse the write anyway).
 */
export function chainAgentPolicy(chain: LockNode[]): { level: 'direct' | 'auto' | 'review'; nodeId: string } | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const o = chain[i].overrides.find((x) => x.s === 'agents')
    if (!o) continue
    if (o.a & CAP_DIRECT) return { level: 'direct', nodeId: chain[i].id }
    if (o.a & CAP_AUTO) return { level: 'auto', nodeId: chain[i].id }
    if (o.a & CAP_SUGGEST) return { level: 'review', nodeId: chain[i].id }
    return null
  }
  return null
}

/** chainAgentPolicy for each page (cached lock chains, docs/adr/1071-*). */
export async function lockAgentPolicies(
  exec: Exec,
  pageIds: string[],
): Promise<Map<string, { level: 'direct' | 'auto' | 'review'; nodeId: string } | null>> {
  const states = await aclForPages(exec, pageIds)
  const chains = await chainsFor(exec, pageIds, states)
  return new Map(pageIds.map((id) => [id, chainAgentPolicy(chains.get(id) ?? [])]))
}

/** Presets of a lock node, read back from its override rows. */
export function nodePresets(node: LockNode): { people: LockPeople; agents: LockAgents; editorIds: string[] } {
  const by = new Map(node.overrides.map((o) => [o.s, o]))
  const everyone = by.get('everyone')
  const agents = by.get('agents')
  return {
    people: everyone && everyone.d & CAP_EDIT ? 'editors' : 'everyone',
    agents:
      agents && agents.d & CAP_COMMENT
        ? 'read'
        : agents && agents.a & CAP_DIRECT
          ? 'direct'
          : agents && agents.a & CAP_AUTO
            ? 'auto'
            : agents && agents.a & CAP_SUGGEST
          ? 'suggest'
          : agents && agents.d & CAP_EDIT
            ? 'comment'
            : 'same',
    editorIds: node.overrides
      .filter((o) => o.s.startsWith('user:') && o.a & CAP_EDIT)
      .map((o) => o.s.slice(5))
      .sort(),
  }
}

async function peopleNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** The nearest node of `chain` that takes `bit` away from `actor` (the one to name in errors). */
function blockingNode(chain: LockNode[], actor: AccessActor, bit: number): LockNode {
  for (let i = chain.length; i > 0; i--) {
    if (!(effectiveCaps(chain.slice(0, i), actor) & bit) && effectiveCaps(chain.slice(0, i - 1), actor) & bit) return chain[i - 1]
  }
  return chain[chain.length - 1]
}

/** 403 PAGE_LOCKED naming who can edit and what to do instead (phrased for people and agents). */
export async function pageLockedError(chain: LockNode[], actor: AccessActor, bit = CAP_EDIT): Promise<AppError> {
  const node = blockingNode(chain, actor, bit)
  const presets = nodePresets(node)
  const names = await peopleNames([...(node.ownerId ? [node.ownerId] : []), ...presets.editorIds])
  const editors: LockPersonDTO[] = []
  if (node.ownerId && names.has(node.ownerId)) editors.push({ id: node.ownerId, name: names.get(node.ownerId)! })
  for (const id of presets.editorIds) {
    if (id !== node.ownerId && names.has(id)) editors.push({ id, name: names.get(id)! })
  }
  // A guest is not told who the workspace's editors are (names of members, docs/adr/1252-*), nor the
  // title of a lock node above the pages shared with them.
  if (actor.role === 'guest') {
    const inside = (await pageIdsInRange([node.id], actor.userId)).has(node.id)
    const t = inside ? `"${node.title || 'Untitled'}"` : 'This page'
    return new AppError(403, 'PAGE_LOCKED', `${t} is locked for editing. You can still read it${bit === CAP_COMMENT ? '' : ' and comment'}.`, undefined, {
      lockedPageId: inside ? node.id : null,
      editors: [],
    })
  }
  const title = `"${node.title || 'Untitled'}"`
  // Under 'suggest', an agent whose person may not edit here is refused for the person's reason.
  const suggestive = presets.agents === 'suggest' || presets.agents === 'auto'
  const personBlocked = suggestive && !(effectiveCaps(chain, { ...actor, agent: false }) & CAP_EDIT)
  const agentRule = actor.agent && presets.agents !== 'same' && presets.agents !== 'direct' && !personBlocked
  let message: string
  if (bit === CAP_COMMENT) {
    message = `${title} is locked: agents may not comment on it. Ask a person to comment instead.`
  } else if (agentRule && suggestive) {
    message =
      `${title} is locked for agents (suggestions only): this kind of change cannot be suggested. ` +
      'Use patch_section or update_page; they leave a suggestion that a person accepts or rejects.'
  } else if (agentRule) {
    message =
      `${title} is locked for agents (${presets.agents === 'comment' ? 'comment only' : 'read only'}). ` +
      `A person must make this edit in the web app${presets.agents === 'comment' ? '; you can add a comment with the suggested change' : ''}.`
  } else {
    const who = editors.map((e, i) => (i === 0 && e.id === node.ownerId ? `${e.name} (page owner)` : e.name))
    who.push('workspace owners and admins')
    message = `${title} is locked for editing. Can edit: ${who.join(', ')}. You can still read it and comment.`
  }
  return new AppError(403, 'PAGE_LOCKED', message, undefined, { lockedPageId: node.id, editors })
}

/** Bits of `actor` on each page of `pageIds` (`acl`: access states already read for them). */
export async function capsFor(
  exec: Exec,
  pageIds: string[],
  actor: AccessActor,
  acl?: Map<string, AclState>,
): Promise<Map<string, number>> {
  const states = acl ?? (await aclForPages(exec, pageIds))
  const chains = await chainsFor(exec, pageIds, states)
  // People rows (docs/adr/1251-*): the level's bits AND the lock's bits. No statement in a
  // workspace without rows (cached per access version).
  const levels = await grantLevelsFor(exec, pageIds, actor.userId, states)
  return new Map(
    pageIds.map((id) => {
      const grant = grantCaps(actor.role, levels.get(id) ?? null)
      // SUGGEST survives the people rows only where they allow editing (docs/adr/1532-*).
      return [id, effectiveCaps(chains.get(id) ?? [], actor) & (grant | (grant & CAP_EDIT ? CAP_SUGGEST : 0))]
    }),
  )
}

/**
 * May the agent of this request leave a suggestion on `pageId` (docs/adr/1532-*)? Its person must be
 * able to edit the page (lock, people rows), and the lock must let the agent edit or suggest. Throws
 * the person's PAGE_LOCKED / PAGE_ACCESS when the person may not edit; returns 'edit' when the agent
 * may edit directly, 'suggest' when only suggestions are allowed, null when neither.
 */
export async function suggestionRight(
  exec: Exec,
  pageId: string,
  userId: string,
  role: WorkspaceAccessRole | null,
  acl?: AclState,
): Promise<'edit' | 'suggest' | null> {
  const person: AccessActor = { userId, role, agent: false }
  await assertCan(exec, pageId, person, { acl, person: true })
  const actor = actorFor(userId, role)
  if (!actor.agent) return 'edit'
  const caps = (await capsFor(exec, [pageId], actor, acl ? new Map([[pageId, acl]]) : undefined)).get(pageId) ?? 0
  return caps & CAP_EDIT ? 'edit' : caps & CAP_SUGGEST ? 'suggest' : null
}

/** Throws PAGE_ACCESS unless a fresh (uncached) walk of the people rows grants `bit` after all. */
async function confirmGrantDenied(exec: Exec, leaf: string, actor: AccessActor, bit: number): Promise<void> {
  const level = (await nearestGrants(exec, [leaf], actor.userId)).get(leaf)?.level ?? null
  if (!(grantCaps(actor.role, level) & bit)) throw pageAccessError(effectiveLevel(actor.role, level), bit)
}

/** Throws PAGE_LOCKED for `leaf` unless a fresh (uncached) walk grants `bit` after all. */
async function confirmDenied(exec: Exec, leaf: string, actor: AccessActor, bit: number): Promise<void> {
  const fresh = (await lockChains(exec, [leaf])).get(leaf) ?? []
  if (!(effectiveCaps(fresh, actor) & bit)) throw await pageLockedError(fresh, actor, bit)
}

/** Locked pages strictly below `rootId` (capped walk). */
async function lockedDescendants(exec: Exec, rootId: string): Promise<string[]> {
  const rows = (await exec.execute(sql`
    ${descendantsCte(rootId)}
    SELECT d.id FROM descendants d JOIN pages p ON p.id = d.id WHERE p.edit_locked AND d.id <> ${rootId}
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/**
 * Throws 403 PAGE_LOCKED unless `actor` holds `bit` (default EDIT) on `pageId` — with `subtree`, on
 * every page below it too (trash, move, purge, restore and scope changes carry the subtree along;
 * checking the root and each lock node below it covers every page in between).
 */
export async function assertCan(
  exec: Exec,
  pageId: string,
  actor: AccessActor,
  opts: { subtree?: boolean; bit?: number; acl?: AclState; person?: boolean } = {},
): Promise<void> {
  const acl = opts.acl ?? (await aclForPages(exec, [pageId])).get(pageId)
  await assertCanWalk(exec, pageId, actor, { ...opts, acl })
  // A connection that read flagged content edits nothing directly for a while (docs/adr/2040-*):
  // after the rights above (a write the person may not make keeps its own error). The person check
  // of suggestionRight and every browser/background caller pass through.
  if ((opts.bit ?? CAP_EDIT) & CAP_EDIT && !opts.person) {
    const ws = acl?.workspaceId ?? (await workspaceOfPage(exec, pageId))
    if (ws) await assertNotDemoted(ws)
  }
}

async function workspaceOfPage(exec: Exec, pageId: string): Promise<string | null> {
  const [r] = (await exec.execute(sql`SELECT workspace_id AS "ws" FROM pages WHERE id = ${pageId}`)) as unknown as { ws: string }[]
  return r?.ws ?? null
}

async function assertCanWalk(
  exec: Exec,
  pageId: string,
  actor: AccessActor,
  opts: { subtree?: boolean; bit?: number; acl?: AclState },
): Promise<void> {
  const bit = opts.bit ?? CAP_EDIT
  const acl = opts.acl
  // People rows in the workspace (docs/adr/1251-*); answered from memory per access version.
  const grants = knownWithoutRows(actor.userId) ? false : acl ? await workspaceHasGrants(exec, acl) : true
  // No locked page and no people row anywhere in the workspace: nothing to walk (docs/adr/1071-*).
  if (acl && !acl.hasLocks && !grants) return
  const accessMap = (leaves: string[]) => new Map(acl ? leaves.map((l) => [l, acl]) : [])
  if (grants) {
    const leaves = opts.subtree ? [pageId, ...(await grantedDescendants(exec, pageId, actor.userId))] : [pageId]
    const levels = await grantLevelsFor(exec, leaves, actor.userId, accessMap(leaves))
    for (const leaf of leaves) {
      if (!(grantCaps(actor.role, levels.get(leaf) ?? null) & bit)) await confirmGrantDenied(exec, leaf, actor, bit)
    }
  }
  if (acl && !acl.hasLocks) return
  const leaves = opts.subtree ? [pageId, ...(await lockedDescendants(exec, pageId))] : [pageId]
  const chains = await chainsFor(exec, leaves, accessMap(leaves))
  for (const leaf of leaves) {
    if (!(effectiveCaps(chains.get(leaf) ?? [], actor) & bit)) await confirmDenied(exec, leaf, actor, bit)
  }
}

/** Throws 403 PAGE_LOCKED unless `actor` may edit every page of `pageIds`. */
export async function assertAllEditable(exec: Exec, pageIds: string[], actor: AccessActor): Promise<void> {
  if (!pageIds.length) return
  const ids = [...new Set(pageIds)].sort()
  const states = await aclForPages(exec, ids)
  const chains = await chainsFor(exec, ids, states)
  const levels = await grantLevelsFor(exec, ids, actor.userId, states)
  for (const id of ids) {
    if (!(grantCaps(actor.role, levels.get(id) ?? null) & CAP_EDIT)) await confirmGrantDenied(exec, id, actor, CAP_EDIT)
    if (!(effectiveCaps(chains.get(id) ?? [], actor) & CAP_EDIT)) await confirmDenied(exec, id, actor, CAP_EDIT)
  }
}

/** Role of `userId` in the workspace of `pageId` (null = not a member). */
export async function roleForPage(pageId: string, userId: string): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(pages)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, pages.workspaceId), eq(workspaceMembers.userId, userId)))
    .where(eq(pages.id, pageId))
    .limit(1)
  return row?.role ?? null
}

/**
 * Edit guard for routes: `userId` (as a person or, inside an MCP request, as an agent) may edit
 * `pageId` (and its subtree with `subtree`). `role` and the workspace access state `acl` are looked
 * up (one statement) when not given; routes pass what requireMembershipAcl already returned.
 */
export async function assertPageEditable(
  pageId: string,
  userId: string,
  opts: { subtree?: boolean; role?: WorkspaceAccessRole | null; exec?: Exec; acl?: AclState; bit?: number } = {},
): Promise<void> {
  const exec = opts.exec ?? db
  let role = opts.role
  let acl = opts.acl
  if (role === undefined || acl === undefined) {
    const found = await pageAccess(exec, pageId, userId)
    if (role === undefined) role = found?.role ?? null
    acl ??= found?.acl
  }
  await assertCan(exec, pageId, actorFor(userId, role), { subtree: opts.subtree, acl, bit: opts.bit })
}

/** Comment guard (comments are a separate bit: people keep commenting on locked pages). */
export async function assertPageCommentable(
  pageId: string,
  userId: string,
  role?: WorkspaceAccessRole | null,
  acl?: AclState,
): Promise<void> {
  await assertPageEditable(pageId, userId, { role, acl, bit: CAP_COMMENT })
}

// ---------------------------------------------------------------------------
// Lock status and changes (GET/PUT /pages/:id/lock)
// ---------------------------------------------------------------------------

export interface LockTarget {
  id: string
  workspaceId: string
  title: string
  scope: 'shared' | 'private'
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  ownerId: string | null
  editLocked: boolean
}

export async function loadLockTarget(exec: Pick<typeof db, 'select'>, pageId: string): Promise<LockTarget> {
  const [p] = await exec
    .select({
      id: pages.id,
      workspaceId: pages.workspaceId,
      title: pages.title,
      scope: pages.scope,
      kind: pages.kind,
      ownerId: pages.ownerId,
      editLocked: pages.editLocked,
    })
    .from(pages)
    .where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))
    .limit(1)
  if (!p) throw notFound()
  return p
}

/**
 * May `userId` change the own lock of `target`? Workspace owners/admins; or the page owner while
 * they can edit it as a person (a nested lock must not become a way around an outer one).
 */
export function canManageLock(target: LockTarget, chain: LockNode[], userId: string, role: WorkspaceAccessRole | null): boolean {
  if (target.scope !== 'shared') return false
  if (isManagerRole(role)) return true
  return target.ownerId === userId && (effectiveCaps(chain, { userId, role, agent: false }) & CAP_EDIT) !== 0
}

export async function pageLockStatus(pageId: string, actor: AccessActor): Promise<PageLockDTO> {
  const target = await loadLockTarget(db, pageId)
  const chain = (await lockChains(db, [pageId])).get(pageId) ?? []
  const root = chain[chain.length - 1] ?? null
  const presets = root ? nodePresets(root) : null
  const names = await peopleNames(root ? [...(root.ownerId ? [root.ownerId] : []), ...presets!.editorIds] : [])
  const person = (id: string): LockPersonDTO | null => (names.has(id) ? { id, name: names.get(id)! } : null)
  // People rows (docs/adr/1251-*): the caller's level here, intersected with the lock bits.
  const level = (await nearestGrantLevel(pageId, actor.userId)) ?? null
  const caps = effectiveCaps(chain, actor) & grantCaps(actor.role, level)
  const [instr] = await db.select().from(agentInstructions).where(eq(agentInstructions.pageId, pageId)).limit(1)
  return {
    pageId,
    locked: !!root,
    own: target.editLocked,
    // the lock may come from above a range-limited connection's subtree: no title then (docs/adr/1202-*)
    lockRoot: root ? { id: root.id, title: (await pageIdsInRange([root.id], actor.userId)).has(root.id) ? root.title : '' } : null,
    owner: root?.ownerId && actor.role !== 'guest' ? person(root.ownerId) : null,
    editors: presets && actor.role !== 'guest'
      ? presets.editorIds
          .map(person)
          .filter((p): p is LockPersonDTO => p !== null)
          .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
      : [],
    people: presets?.people ?? null,
    agents: presets?.agents ?? null,
    canEdit: (caps & CAP_EDIT) !== 0,
    canComment: (caps & CAP_COMMENT) !== 0,
    canManage: actor.role !== 'guest' && canManageLock(target, chain, actor.userId, actor.role),
    level: effectiveLevel(actor.role, level) ?? 'view',
    ...(actor.role === 'guest' ? { guest: true } : {}),
    // apply_to can name pages or title paths outside a guest's pages (docs/adr/1252-*)
    instructions: instr && actor.role !== 'guest'
      ? {
          pageId,
          title: target.title,
          mode: instr.mode,
          applyTo: Array.isArray(instr.applyTo) ? (instr.applyTo as string[]) : [],
          description: instr.description,
          sortOrder: instr.sortOrder,
        }
      : null,
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function nearestGrantLevel(pageId: string, userId: string) {
  if (knownWithoutRows(userId)) return null
  return (await nearestGrants(db, [pageId], userId)).get(pageId)?.level
}

/** Ids of `rootId` and its subtree (capped walk). */
export async function subtreeIds(exec: Exec, rootId: string): Promise<string[]> {
  const rows = (await exec.execute(sql`${descendantsCte(rootId)} SELECT id FROM descendants`)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/** Override rows for a set of presets. */
function presetRows(pageId: string, people: LockPeople, agents: LockAgents, editorIds: string[]) {
  const rows: { pageId: string; subject: string; userId: string | null; allow: number; deny: number }[] = []
  if (people === 'editors') rows.push({ pageId, subject: 'everyone', userId: null, allow: 0, deny: CAP_EDIT })
  if (agents !== 'same') {
    // 'suggest' allows SUGGEST and denies EDIT; the stricter presets deny SUGGEST too (docs/adr/1532-*).
    // 'auto' adds the AUTO marker, 'direct' is a marker only (docs/adr/1544-*).
    rows.push(
      agents === 'suggest' || agents === 'auto'
        ? { pageId, subject: 'agents', userId: null, allow: CAP_SUGGEST | (agents === 'auto' ? CAP_AUTO : 0), deny: CAP_EDIT }
        : agents === 'direct'
          ? { pageId, subject: 'agents', userId: null, allow: CAP_DIRECT, deny: 0 }
          : { pageId, subject: 'agents', userId: null, allow: 0, deny: agents === 'read' ? CAP_EDIT | CAP_COMMENT | CAP_SUGGEST : CAP_EDIT | CAP_SUGGEST },
    )
  }
  for (const id of editorIds) rows.push({ pageId, subject: `user:${id}`, userId: id, allow: CAP_EDIT, deny: 0 })
  return rows
}

/**
 * Sets the own lock of a page inside `tx` (which must hold the workspace tree lock): on/off, the
 * people/agents presets and the editors. Audits each change in the same transaction. Turning the
 * lock off also removes an agent-instruction designation (docs/adr/0975-*). Returns the subtree ids
 * whose live connections must re-authenticate, or [] when nothing changed.
 */
export async function applyLockChange(tx: Tx, target: LockTarget, input: SetPageLockInput, actor: AuditActor): Promise<string[]> {
  const label = target.title || 'Untitled'
  const ws = target.workspaceId
  // Access version + exclusive write gate before any page row is touched (docs/adr/1071-*):
  // writes in flight finish first, later ones see the new rules.
  await bumpAcl(tx, ws)
  const before = nodePresets({
    id: target.id,
    title: target.title,
    ownerId: target.ownerId,
    overrides: (await tx.select().from(pageAccessOverrides).where(eq(pageAccessOverrides.pageId, target.id))).map((o) => ({
      s: o.subject,
      a: o.allow,
      d: o.deny,
    })),
  })
  // A page that was never locked has no rows: its "before" presets are the defaults of a new lock.
  const fresh = !target.editLocked
  const prev = fresh ? { people: 'editors' as LockPeople, agents: 'same' as LockAgents, editorIds: before.editorIds } : before
  const next = {
    people: input.people ?? prev.people,
    agents: input.agents ?? prev.agents,
    editorIds: input.editorIds !== undefined ? [...new Set(input.editorIds.map((s) => s.toLowerCase()))].sort() : prev.editorIds,
  }
  if (input.editorIds !== undefined && next.editorIds.length) {
    const members = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ws), inArray(workspaceMembers.userId, next.editorIds)))
    if (members.length !== next.editorIds.length) throw badRequest('Every editor must be a member of this workspace')
  }

  let changed = false
  const names = await peopleNames([...new Set([...prev.editorIds, ...next.editorIds])])
  const nm = (ids: string[]) => ids.map((id) => names.get(id) ?? id)
  // editorIds beside the names: account deletion removes a person's name from these rows by id only
  // (account/deletion.ts AUDIT_NAME_ID_PAIRS); the audit screen does not show them.
  if (input.locked !== target.editLocked) {
    await tx.update(pages).set({ editLocked: input.locked }).where(eq(pages.id, target.id))
    await recountLockedPages(tx, ws)
    await recordAudit(tx, {
      workspaceId: ws,
      actor,
      action: input.locked ? 'page.locked' : 'page.unlocked',
      target: { type: 'page', id: target.id, label },
      ...(input.locked ? { after: { people: next.people, agents: next.agents, editors: nm(next.editorIds), editorIds: next.editorIds } } : {}),
    })
    changed = true
    if (!input.locked) {
      const removed = await tx
        .delete(agentInstructions)
        .where(eq(agentInstructions.pageId, target.id))
        .returning({ mode: agentInstructions.mode })
      if (removed.length) {
        await recordAudit(tx, {
          workspaceId: ws,
          actor,
          action: 'instructions.removed',
          target: { type: 'page', id: target.id, label },
          before: { mode: removed[0].mode },
          after: { reason: 'unlocked' },
        })
      }
    }
  }
  const rulesChanged =
    prev.people !== next.people || prev.agents !== next.agents || prev.editorIds.join(',') !== next.editorIds.join(',')
  if (rulesChanged || (fresh && input.locked)) {
    await tx.delete(pageAccessOverrides).where(eq(pageAccessOverrides.pageId, target.id))
    const rows = presetRows(target.id, next.people, next.agents, next.editorIds)
    if (rows.length) await tx.insert(pageAccessOverrides).values(rows)
  }
  if (rulesChanged && !(fresh && input.locked)) {
    await recordAudit(tx, {
      workspaceId: ws,
      actor,
      action: 'page.lock_editors_changed',
      target: { type: 'page', id: target.id, label },
      before: { people: prev.people, agents: prev.agents, editors: nm(prev.editorIds), editorIds: prev.editorIds },
      after: { people: next.people, agents: next.agents, editors: nm(next.editorIds), editorIds: next.editorIds },
    })
    changed = true
  }
  return changed ? subtreeIds(tx, target.id) : []
}

/** PUT /pages/:id/lock (browser sessions only: an agent never changes its own fence). */
export async function setPageLock(
  pageId: string,
  user: AuditActor & { id: string },
  role: WorkspaceRole | null,
  input: SetPageLockInput,
): Promise<void> {
  const head = await loadLockTarget(db, pageId)
  const affected = await db.transaction(async (tx) => {
    await lockTree(tx, head.workspaceId)
    const target = await loadLockTarget(tx, pageId)
    if (target.scope === 'private') throw badRequest('Private pages are already editable by their author only')
    const chain = (await lockChains(tx, [pageId])).get(pageId) ?? []
    if (!canManageLock(target, chain, user.id, role)) {
      throw forbidden('Only workspace owners and admins, or the page owner, can change the edit lock of this page')
    }
    return applyLockChange(tx, target, input, user)
  })
  // Live editors re-authenticate and get the new read-only/read-write mode (docs/adr/0970-*).
  if (affected.length) closePageConnections(affected)
}
