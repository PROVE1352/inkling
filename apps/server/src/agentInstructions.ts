import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  AgentInstructionDTO,
  AgentInstructionMode,
  SetAgentInstructionInput,
  WorkspaceRole,
} from '@inkling/shared'
import { db } from './db/index'
import { agentInstructions, pageDocs, pages } from './db/schema'
import { badRequest, forbidden } from './errors'
import { applyLockChange, loadLockTarget } from './editLock'
import { closePageConnections, liveDocState } from './liveConnections'
import { blocksToMarkdown, stateToBlocks } from './md/convert'
import { lockTree, TREE_MAX_DEPTH } from './pageTree'
import { isManagerRole, recordAudit } from './workspaceAdmin'
import type { AuditActor } from './workspaceAdmin'
import { BoundedLru } from './lru'
import { bumpAcl } from './aclVersion'

/**
 * Agent instruction pages (docs/adr/0975-*).
 *
 * A workspace owner/admin designates a shared document page as instructions for agents. The page
 * is locked in the same transaction (docs/adr/0970-*) so only its editors can change what agents
 * are told; removing the lock removes the designation. Modes:
 *
 *   always  every agent working in the workspace gets it (get_instructions)
 *   match   only for pages under a subtree root (`page:<id>`) or whose title path matches a glob
 *   manual  listed with its description; read on request
 *
 * Order is deterministic: always by (sortOrder, page id); matching ones nearest first — subtree
 * roots by distance (0 = the page itself), then globs by number of literal segments (more first),
 * then (sortOrder, page id). A matching instruction overrides an always one; the first listed
 * matching one overrides later ones.
 */

/** Cap on one instruction body in tool output (characters). */
export const INSTRUCTION_BODY_MAX = 12_000

export interface InstructionRow {
  pageId: string
  workspaceId: string
  title: string
  mode: AgentInstructionMode
  applyTo: string[]
  description: string
  sortOrder: number
}

const byOrder = (a: InstructionRow, b: InstructionRow) =>
  a.sortOrder - b.sortOrder || (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0)

export function toInstructionDTO(r: InstructionRow): AgentInstructionDTO {
  return { pageId: r.pageId, title: r.title, mode: r.mode, applyTo: r.applyTo, description: r.description, sortOrder: r.sortOrder }
}

/**
 * Live instruction pages of the given workspaces: the page must be alive, shared, a document and
 * still carry its own lock (the designation is void otherwise).
 */
export async function instructionRows(workspaceIds: string[]): Promise<InstructionRow[]> {
  if (!workspaceIds.length) return []
  const rows = await db
    .select({
      pageId: agentInstructions.pageId,
      workspaceId: agentInstructions.workspaceId,
      title: pages.title,
      mode: agentInstructions.mode,
      applyTo: agentInstructions.applyTo,
      description: agentInstructions.description,
      sortOrder: agentInstructions.sortOrder,
    })
    .from(agentInstructions)
    .innerJoin(pages, eq(pages.id, agentInstructions.pageId))
    .where(
      and(
        inArray(agentInstructions.workspaceId, workspaceIds),
        isNull(pages.deletedAt),
        eq(pages.scope, 'shared'),
        eq(pages.kind, 'doc'),
        eq(pages.editLocked, true),
      ),
    )
  return rows
    .map((r) => ({ ...r, applyTo: Array.isArray(r.applyTo) ? (r.applyTo as string[]) : [] }))
    .sort(byOrder)
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase()

function segMatch(pattern: string, seg: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === seg
  const re = new RegExp(
    '^' + pattern.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$',
    's',
  )
  return re.test(seg)
}

function globMatch(pat: string[], path: string[]): boolean {
  if (pat.length === 0) return path.length === 0
  if (pat[0] === '**') {
    for (let i = 0; i <= path.length; i++) if (globMatch(pat.slice(1), path.slice(i))) return true
    return false
  }
  return path.length > 0 && segMatch(pat[0], path[0]) && globMatch(pat.slice(1), path.slice(1))
}

/** Title path of a page (top level first), as used by applyTo globs: `Untitled` for empty titles. */
export const pathSegment = (title: string) => norm(title || 'Untitled')

/**
 * Rank of a match instruction for one page, or null when it does not apply: [kind, distance].
 * kind 0 = subtree root (distance = levels between the page and that root), kind 1 = glob
 * (distance = −literal segments, so more specific globs sort first).
 */
export function matchRank(applyTo: string[], chain: { id: string; title: string }[]): [number, number] | null {
  // chain: the page first, then its ancestors (nearest first)
  const path = chain.map((c) => pathSegment(c.title)).reverse()
  let best: [number, number] | null = null
  const better = (r: [number, number]) => !best || r[0] < best[0] || (r[0] === best[0] && r[1] < best[1])
  for (const entry of applyTo) {
    if (entry.startsWith('page:')) {
      const id = entry.slice(5).toLowerCase()
      const d = chain.findIndex((c) => c.id === id)
      if (d >= 0 && better([0, d])) best = [0, d]
      continue
    }
    const pat = entry.split('/').map(norm).filter((s) => s.length > 0)
    if (!pat.length) continue
    if (globMatch(pat, path)) {
      const literal = pat.filter((s) => s !== '**' && !/[*?]/.test(s)).length
      if (better([1, -literal])) best = [1, -literal]
    }
  }
  return best
}

/** Ancestor chains with titles (page first), one statement for all ids. */
async function titleChains(pageIds: string[]): Promise<Map<string, { id: string; title: string }[]>> {
  const out = new Map<string, { id: string; title: string }[]>(pageIds.map((id) => [id, []]))
  if (!pageIds.length) return out
  const rows = (await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id AS leaf, id, parent_id, title, 0 AS depth FROM pages WHERE id = ANY(${`{${pageIds.join(',')}}`}::uuid[])
      UNION ALL
      SELECT u.leaf, p.id, p.parent_id, p.title, u.depth + 1 FROM pages p JOIN up u ON p.id = u.parent_id
       WHERE u.depth < ${TREE_MAX_DEPTH}
    )
    SELECT leaf, id, title FROM up ORDER BY leaf, depth
  `)) as unknown as { leaf: string; id: string; title: string }[]
  for (const r of rows) out.get(r.leaf)?.push({ id: r.id, title: r.title })
  return out
}

export interface AppliedInstruction extends InstructionRow {
  rank: [number, number] | null
}

// "This workspace has designation rows at all", per access version (designations change only in
// setInstruction / removeInstruction / unlock, which bump it; docs/adr/1071-*). Only the negative
// answer saves work: rows themselves (titles, trash state) are always read fresh. TTL = memory bound.
const instructionPresence = new BoundedLru<{ v: number; any: boolean }>(20_000, 60 * 60_000)

/** Workspaces of `wsIds` that may have instructions, given their access versions. */
async function workspacesWithInstructions(wsIds: string[], versions: Map<string, number>): Promise<string[]> {
  const known = new Map<string, boolean>()
  for (const ws of wsIds) {
    const hit = instructionPresence.get(ws)
    if (hit && hit.v === versions.get(ws)) known.set(ws, hit.any)
  }
  const unknown = wsIds.filter((ws) => !known.has(ws))
  if (unknown.length) {
    // Read after the versions (the caller read them first): never older than its label.
    const rows = (await db.execute(sql`
      SELECT DISTINCT workspace_id AS ws FROM agent_instructions WHERE workspace_id = ANY(${`{${unknown.join(',')}}`}::uuid[])
    `)) as unknown as { ws: string }[]
    const present = new Set(rows.map((r) => r.ws))
    for (const ws of unknown) {
      known.set(ws, present.has(ws))
      instructionPresence.set(ws, { v: versions.get(ws)!, any: present.has(ws) })
    }
  }
  return wsIds.filter((ws) => known.get(ws))
}

/** Test hook: forget the presence cache. */
export function _resetInstructionPresence(): void {
  instructionPresence.clear()
}

/**
 * Instructions that apply to the given pages (always + matching), in output order. For several
 * pages the union is returned: always ones first, then matching ones by their best rank.
 * `versions` (workspace → access version, read by the caller before this call) lets workspaces
 * without any designation skip the query.
 */
export async function applicableInstructions(
  pages_: { id: string; workspaceId: string }[],
  versions?: Map<string, number>,
): Promise<AppliedInstruction[]> {
  let wsIds = [...new Set(pages_.map((p) => p.workspaceId))].sort()
  if (versions && wsIds.every((ws) => versions.has(ws))) {
    wsIds = await workspacesWithInstructions(wsIds, versions)
    if (!wsIds.length) return []
  }
  const rows = await instructionRows(wsIds)
  if (!rows.length) return []
  const needChains = rows.some((r) => r.mode === 'match')
  const chains = needChains ? await titleChains(pages_.map((p) => p.id)) : new Map()
  const always = rows.filter((r) => r.mode === 'always' && wsIds.includes(r.workspaceId))
  const matched = new Map<string, AppliedInstruction>()
  for (const p of pages_) {
    for (const r of rows) {
      if (r.mode !== 'match' || r.workspaceId !== p.workspaceId) continue
      const rank = matchRank(r.applyTo, chains.get(p.id) ?? [])
      if (!rank) continue
      const cur = matched.get(r.pageId)
      if (!cur || !cur.rank || rank[0] < cur.rank[0] || (rank[0] === cur.rank[0] && rank[1] < cur.rank[1])) {
        matched.set(r.pageId, { ...r, rank })
      }
    }
  }
  const m = [...matched.values()].sort((a, b) => a.rank![0] - b.rank![0] || a.rank![1] - b.rank![1] || byOrder(a, b))
  return [...always.map((r) => ({ ...r, rank: null })), ...m]
}

/** Markdown body of an instruction page (live document first), capped. */
export async function instructionBody(pageId: string): Promise<{ markdown: string; truncated: boolean }> {
  const live = liveDocState(pageId)
  const state = live ?? (await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, pageId)).limit(1))[0]?.state
  const md = state ? (await blocksToMarkdown(stateToBlocks(state), { assetMode: 'absolute' })).markdown.trim() : ''
  return md.length > INSTRUCTION_BODY_MAX
    ? { markdown: md.slice(0, INSTRUCTION_BODY_MAX), truncated: true }
    : { markdown: md, truncated: false }
}

export interface InstructionBundle {
  workspaceId: string
  forPageId: string | null
  always: (AgentInstructionDTO & { markdown: string; truncated: boolean })[]
  matching: (AgentInstructionDTO & { markdown: string; truncated: boolean })[]
  /** Match instructions not applied (no page given, or not matching it). */
  otherMatch: AgentInstructionDTO[]
  manual: AgentInstructionDTO[]
  /** Hash of the always part (stable while those pages do not change). */
  version: string
}

export async function instructionBundle(workspaceId: string, forPage: { id: string; workspaceId: string } | null): Promise<InstructionBundle> {
  const rows = await instructionRows([workspaceId])
  const applied = forPage ? await applicableInstructions([forPage]) : rows.filter((r) => r.mode === 'always').map((r) => ({ ...r, rank: null }))
  const appliedIds = new Set(applied.map((r) => r.pageId))
  const withBody = async (r: InstructionRow) => ({ ...toInstructionDTO(r), ...(await instructionBody(r.pageId)) })
  const always = await Promise.all(applied.filter((r) => r.mode === 'always').map(withBody))
  const matching = await Promise.all(applied.filter((r) => r.mode === 'match').map(withBody))
  const hash = createHash('sha256')
  for (const a of always) hash.update(`${a.pageId}\n${a.title}\n${a.markdown}\n`)
  return {
    workspaceId,
    forPageId: forPage?.id ?? null,
    always,
    matching,
    otherMatch: rows.filter((r) => r.mode === 'match' && !appliedIds.has(r.pageId)).map(toInstructionDTO),
    manual: rows.filter((r) => r.mode === 'manual').map(toInstructionDTO),
    version: hash.digest('hex').slice(0, 12),
  }
}

// ---------------------------------------------------------------------------
// Designation (PUT/DELETE /pages/:id/agent-instructions)
// ---------------------------------------------------------------------------

/**
 * Designate a page as agent instructions (owners/admins, browser sessions). Locks the page in the
 * same transaction when it is not locked yet (default presets: listed editors only).
 */
export async function setInstruction(
  pageId: string,
  actor: AuditActor & { id: string },
  role: WorkspaceRole | null,
  input: SetAgentInstructionInput,
): Promise<void> {
  if (!isManagerRole(role)) throw forbidden('Only workspace owners and admins can designate agent instructions')
  const applyTo = input.mode === 'match' ? [...new Set((input.applyTo ?? []).map((s) => s.trim()))] : []
  if (input.mode === 'match' && applyTo.length === 0) {
    throw badRequest('A match instruction needs applyTo: page:<id> subtree roots or title-path globs such as Projects/**')
  }
  const head = await loadLockTarget(db, pageId)
  const affected = await db.transaction(async (tx) => {
    await lockTree(tx, head.workspaceId)
    await bumpAcl(tx, head.workspaceId)
    const target = await loadLockTarget(tx, pageId)
    if (target.scope !== 'shared') throw badRequest('Only shared pages can be agent instructions')
    if (target.kind !== 'doc') throw badRequest('Only document pages can be agent instructions')
    for (const e of applyTo) {
      if (!e.startsWith('page:')) continue
      const [p] = await tx
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, e.slice(5)), eq(pages.workspaceId, target.workspaceId)))
        .limit(1)
      if (!p) throw badRequest(`applyTo ${e}: no such page in this workspace`)
    }
    let affected: string[] = []
    if (!target.editLocked) affected = await applyLockChange(tx, target, { locked: true }, actor)
    const [prev] = await tx.select().from(agentInstructions).where(eq(agentInstructions.pageId, pageId)).limit(1)
    const values = {
      workspaceId: target.workspaceId,
      mode: input.mode,
      applyTo,
      description: input.description ?? prev?.description ?? '',
      sortOrder: input.sortOrder ?? prev?.sortOrder ?? 0,
      updatedBy: actor.id,
      updatedAt: new Date(),
    }
    await tx
      .insert(agentInstructions)
      .values({ pageId, ...values })
      .onConflictDoUpdate({ target: agentInstructions.pageId, set: values })
    await recordAudit(tx, {
      workspaceId: target.workspaceId,
      actor,
      action: 'instructions.set',
      target: { type: 'page', id: pageId, label: target.title || 'Untitled' },
      before: prev ? { mode: prev.mode, applyTo: prev.applyTo } : null,
      after: { mode: input.mode, applyTo },
    })
    return affected
  })
  if (affected.length) closePageConnections(affected)
}

export async function removeInstruction(pageId: string, actor: AuditActor, role: WorkspaceRole | null): Promise<void> {
  if (!isManagerRole(role)) throw forbidden('Only workspace owners and admins can change agent instructions')
  const head = await loadLockTarget(db, pageId)
  await db.transaction(async (tx) => {
    await bumpAcl(tx, head.workspaceId)
    const removed = await tx.delete(agentInstructions).where(eq(agentInstructions.pageId, pageId)).returning({ mode: agentInstructions.mode })
    if (removed.length) {
      await recordAudit(tx, {
        workspaceId: head.workspaceId,
        actor,
        action: 'instructions.removed',
        target: { type: 'page', id: pageId, label: head.title || 'Untitled' },
        before: { mode: removed[0].mode },
      })
    }
  })
}
