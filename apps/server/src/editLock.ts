import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  LockAgents,
  LockPeople,
  LockPersonDTO,
  PageLockDTO,
  SetPageLockInput,
  WorkspaceRole,
} from '@inkling/shared'
import { db } from './db/index'
import { agentInstructions, pageAccessOverrides, pages, users, workspaceMembers } from './db/schema'
import { AppError, badRequest, forbidden, notFound } from './errors'
import { currentAgent } from './agentAccess'
import { closePageConnections } from './liveConnections'
import { descendantsCte, lockTree, TREE_MAX_DEPTH } from './pageTree'
import { isManagerRole, recordAudit } from './workspaceAdmin'
import type { AuditActor } from './workspaceAdmin'

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
 * connections, assertPlacement for anything created under a parent). No cache: each check is one
 * recursive CTE capped at TREE_MAX_DEPTH, like the tree-integrity walks (docs/adr/0800-*).
 */

export const CAP_EDIT = 1
export const CAP_COMMENT = 2
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
  role: WorkspaceRole | null
  /** The request comes from an agent (MCP / OAuth bearer token). */
  agent: boolean
}

/** Actor of the current request: agent when it runs inside an MCP / bearer request (agentAccess). */
export function actorFor(userId: string, role: WorkspaceRole | null): AccessActor {
  return { userId, role, agent: currentAgent() !== null }
}

/** Lock nodes on the path of each leaf, top level first. One statement for any number of leaves. */
export async function lockChains(exec: Exec, leafIds: string[]): Promise<Map<string, LockNode[]>> {
  const out = new Map<string, LockNode[]>(leafIds.map((id) => [id, []]))
  if (!leafIds.length) return out
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

function applyLayer(caps: number, o: { a: number; d: number } | undefined): number {
  if (!o) return caps
  return (caps & ~o.d) | (o.a & ~o.d)
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
    if (actor.agent) caps = applyLayer(caps, by.get('agents'))
  }
  return caps
}

/** Presets of a lock node, read back from its override rows. */
export function nodePresets(node: LockNode): { people: LockPeople; agents: LockAgents; editorIds: string[] } {
  const by = new Map(node.overrides.map((o) => [o.s, o]))
  const everyone = by.get('everyone')
  const agents = by.get('agents')
  return {
    people: everyone && everyone.d & CAP_EDIT ? 'editors' : 'everyone',
    agents: agents && agents.d & CAP_COMMENT ? 'read' : agents && agents.d & CAP_EDIT ? 'comment' : 'same',
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
  const title = `"${node.title || 'Untitled'}"`
  const agentRule = actor.agent && presets.agents !== 'same'
  let message: string
  if (bit === CAP_COMMENT) {
    message = `${title} is locked: agents may not comment on it. Ask a person to comment instead.`
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

/** Bits of `actor` on each page of `pageIds`. */
export async function capsFor(exec: Exec, pageIds: string[], actor: AccessActor): Promise<Map<string, number>> {
  const chains = await lockChains(exec, pageIds)
  return new Map(pageIds.map((id) => [id, effectiveCaps(chains.get(id) ?? [], actor)]))
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
  opts: { subtree?: boolean; bit?: number } = {},
): Promise<void> {
  const bit = opts.bit ?? CAP_EDIT
  const leaves = opts.subtree ? [pageId, ...(await lockedDescendants(exec, pageId))] : [pageId]
  const chains = await lockChains(exec, leaves)
  for (const leaf of leaves) {
    const chain = chains.get(leaf) ?? []
    if (!(effectiveCaps(chain, actor) & bit)) throw await pageLockedError(chain, actor, bit)
  }
}

/** Throws 403 PAGE_LOCKED unless `actor` may edit every page of `pageIds` (one statement for all). */
export async function assertAllEditable(exec: Exec, pageIds: string[], actor: AccessActor): Promise<void> {
  if (!pageIds.length) return
  const ids = [...new Set(pageIds)].sort()
  const chains = await lockChains(exec, ids)
  for (const id of ids) {
    const chain = chains.get(id) ?? []
    if (!(effectiveCaps(chain, actor) & CAP_EDIT)) throw await pageLockedError(chain, actor)
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
 * `pageId` (and its subtree with `subtree`). `role` is looked up when not given.
 */
export async function assertPageEditable(
  pageId: string,
  userId: string,
  opts: { subtree?: boolean; role?: WorkspaceRole | null; exec?: Exec } = {},
): Promise<void> {
  const role = opts.role !== undefined ? opts.role : await roleForPage(pageId, userId)
  await assertCan(opts.exec ?? db, pageId, actorFor(userId, role), { subtree: opts.subtree })
}

/** Comment guard (comments are a separate bit: people keep commenting on locked pages). */
export async function assertPageCommentable(pageId: string, userId: string, role?: WorkspaceRole | null): Promise<void> {
  const r = role !== undefined ? role : await roleForPage(pageId, userId)
  await assertCan(db, pageId, actorFor(userId, r), { bit: CAP_COMMENT })
}

// ---------------------------------------------------------------------------
// Lock status and changes (GET/PUT /pages/:id/lock)
// ---------------------------------------------------------------------------

interface LockTarget {
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
function canManageLock(target: LockTarget, chain: LockNode[], userId: string, role: WorkspaceRole | null): boolean {
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
  const caps = effectiveCaps(chain, actor)
  const [instr] = await db.select().from(agentInstructions).where(eq(agentInstructions.pageId, pageId)).limit(1)
  return {
    pageId,
    locked: !!root,
    own: target.editLocked,
    lockRoot: root ? { id: root.id, title: root.title } : null,
    owner: root?.ownerId ? person(root.ownerId) : null,
    editors: presets
      ? presets.editorIds
          .map(person)
          .filter((p): p is LockPersonDTO => p !== null)
          .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
      : [],
    people: presets?.people ?? null,
    agents: presets?.agents ?? null,
    canEdit: (caps & CAP_EDIT) !== 0,
    canComment: (caps & CAP_COMMENT) !== 0,
    canManage: canManageLock(target, chain, actor.userId, actor.role),
    instructions: instr
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
    rows.push({ pageId, subject: 'agents', userId: null, allow: 0, deny: agents === 'read' ? CAP_EDIT | CAP_COMMENT : CAP_EDIT })
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
  if (input.locked !== target.editLocked) {
    await tx.update(pages).set({ editLocked: input.locked }).where(eq(pages.id, target.id))
    await recordAudit(tx, {
      workspaceId: ws,
      actor,
      action: input.locked ? 'page.locked' : 'page.unlocked',
      target: { type: 'page', id: target.id, label },
      ...(input.locked ? { after: { people: next.people, agents: next.agents, editors: nm(next.editorIds) } } : {}),
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
      before: { people: prev.people, agents: prev.agents, editors: nm(prev.editorIds) },
      after: { people: next.people, agents: next.agents, editors: nm(next.editorIds) },
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
