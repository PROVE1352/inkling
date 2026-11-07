import { and, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { setAgentInstructionSchema, setPageLockSchema } from '@inkling/shared'
import type { AgentInstructionListDTO, InjectionRule, SuspiciousSectionsDTO } from '@inkling/shared'
import { INJECTION_RULES } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { pages } from '../db/schema'
import { forbidden, notFound } from '../errors'
import { isLargePage, stateBytesV1Sql } from '../context/largePage'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage, visibleTo } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'
import { agentAllowedSql, currentAgent } from '../agentAccess'
import { aclColumns, toAcl } from '../aclVersion'
import { actorFor, CAP_COMMENT, CAP_EDIT, capsFor, pageLockStatus, setPageLock } from '../editLock'
import {
  applicableInstructions,
  instructionBundle,
  instructionRows,
  removeInstruction,
  setInstruction,
  toInstructionDTO,
} from '../agentInstructions'

/**
 * Edit lock and agent instruction routes (docs/adr/0970-*, 0975-*).
 *
 *   GET    /pages/:id/lock                       lock status for the caller (people and agents)
 *   PUT    /pages/:id/lock                       set/unset the page's own lock (web app only)
 *   PUT    /pages/:id/agent-instructions         designate as instructions (owners/admins, web app only)
 *   DELETE /pages/:id/agent-instructions         remove the designation
 *   GET    /workspaces/:id/agent-instructions    list (any member)
 *   GET    /workspaces/:id/agent-instructions/bundle?forPageId=   bodies for get_instructions
 *   GET    /pages/agent-context?ids=…            per page: can (read/comment/edit) + provenance, and
 *                                                the instruction titles that apply (MCP read tools)
 *
 * Lock and designation changes are browser-session only: an agent never edits its own fence (the
 * MCP server has no tool for them either).
 */

async function requireSessionUser(req: FastifyRequest): Promise<void> {
  await requireUser(req)
  if (req.authVia !== 'cookie') throw forbidden('Edit locks and agent instructions are changed in the web app only')
}

const idsQuerySchema = z.object({
  ids: z
    .string()
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.uuid()).min(1).max(50)),
})
const bundleQuerySchema = z.object({ forPageId: z.uuid().optional() })
const contextQuerySchema = idsQuerySchema.extend({ read: z.enum(['0', '1']).optional() })

/** Stored heuristic flags per (page, anchor), rules in canonical order. Reads page_chunks only. */
export async function suspiciousSections(pageIds: string[]): Promise<Map<string, { anchor: string; headingPath: string; rules: InjectionRule[] }[]>> {
  const out = new Map<string, { anchor: string; headingPath: string; rules: InjectionRule[] }[]>()
  if (!pageIds.length) return out
  const rows = (await db.execute(sql`
    SELECT page_id AS "pageId", anchor, min(ord) AS ord, min(heading_path) AS "headingPath",
           array_agg(DISTINCT r) AS rules
      FROM page_chunks, unnest(suspicious) AS r
     WHERE page_id = ANY(${`{${pageIds.join(',')}}`}::uuid[]) AND cardinality(suspicious) > 0
     GROUP BY page_id, anchor
     ORDER BY page_id, min(ord)
  `)) as unknown as { pageId: string; anchor: string; headingPath: string; rules: string[] }[]
  for (const r of rows) {
    const list = out.get(r.pageId) ?? []
    list.push({ anchor: r.anchor, headingPath: r.headingPath, rules: INJECTION_RULES.filter((x) => r.rules.includes(x)) })
    out.set(r.pageId, list)
  }
  return out
}

/**
 * Taint record (docs/adr/0977-*): the agent connection was handed flagged content. Recorded only,
 * at most once a minute per grant; no write path reads it yet.
 */
async function markTainted(): Promise<void> {
  const agent = currentAgent()
  if (!agent) return
  try {
    await db.execute(sql`
      UPDATE oauth_grants SET tainted_at = now()
       WHERE id = ${agent.grantId} AND (tainted_at IS NULL OR tainted_at < now() - interval '1 minute')
    `)
  } catch (err) {
    console.error('[inkling] taint record failed', err)
  }
}

async function guardPage(req: FastifyRequest) {
  const user = getUser(req)
  const id = idParam(req.params)
  const page = await findVisiblePage(id, user.id)
  if (!page) throw notFound()
  const role = await requireMembership(page.workspaceId, user.id)
  return { user, page, role }
}

export interface AgentContextDTO {
  pages: {
    id: string
    /** e.g. "read,comment,edit" for the caller (agent rules apply to MCP requests). */
    can: string
    createdBy: string | null
    /** Last logged change: editor name and agent client (null name = live web typing). */
    lastEdit: { name: string | null; via: string | null } | null
    /** Sections whose indexed text matched injection heuristics (docs/adr/0977-*), by anchor. */
    suspicious: { anchor: string; rules: string[] }[]
    /** Stored state ≥ 1 MiB or indexed body ≥ 50k tokens (docs/adr/1043-*): tools add a read-by-section hint. */
    large: boolean
  }[]
  /** Instructions that apply to any of the pages, in output order (titles only). */
  applies: { pageId: string; title: string; mode: string }[]
}

/**
 * Per-page facts for MCP tool output (GET /pages/agent-context and, without the HTTP round trip,
 * mcpTools/agentContext.ts — docs/adr/1070-*). Must run in the caller's agent scope (runAsAgent) so
 * agent blocks and agent lock rules apply. `ids`: at most 50 page ids, output follows their order.
 * The workspace access version read with the pages keys the lock-chain and instruction caches
 * (docs/adr/1071-*).
 */
export async function agentContextFor(userId: string, ids: string[], opts: { read?: boolean } = {}): Promise<AgentContextDTO> {
  if (!ids.length) return { pages: [], applies: [] }
  const acl = aclColumns(sql`pages.workspace_id`)
  // Visible, live pages in live workspaces the caller belongs to (and that do not block this agent).
  const rows = (await db.execute(sql`
    SELECT pages.id, pages.workspace_id AS "workspaceId", m.role,
           cu.name AS "createdBy", lc.seq IS NOT NULL AS "hasChange",
           au.name AS "editorName", lc.via_client AS "via",
           (SELECT ${stateBytesV1Sql()} FROM page_docs d WHERE d.page_id = pages.id) AS "stateBytes",
           (SELECT sum(c.token_estimate) FROM page_chunks c WHERE c.page_id = pages.id) AS "tokens",
           ${acl.version} AS "aclVersion", ${acl.hasLocks} AS "hasLocks"
      FROM pages
      JOIN workspace_members m ON m.workspace_id = pages.workspace_id AND m.user_id = ${userId}
      LEFT JOIN workspace_acl_versions a ON a.workspace_id = pages.workspace_id
      LEFT JOIN users cu ON cu.id = pages.created_by
      LEFT JOIN LATERAL (
        SELECT c.seq, c.actor_id, c.via_client FROM page_changes c WHERE c.page_id = pages.id ORDER BY c.seq DESC LIMIT 1
      ) lc ON true
      LEFT JOIN users au ON au.id = lc.actor_id
     WHERE pages.id = ANY(${`{${ids.join(',')}}`}::uuid[])
       AND ${and(isNull(pages.deletedAt), visibleTo(userId), liveWorkspace(pages.workspaceId), agentAllowedSql(pages.workspaceId))}
  `)) as unknown as {
    id: string
    workspaceId: string
    role: 'owner' | 'admin' | 'member'
    createdBy: string | null
    hasChange: boolean
    editorName: string | null
    via: string | null
    stateBytes: number | string | null
    tokens: number | string | null
    aclVersion: number | string
    hasLocks: boolean
  }[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => !!r)
  const aclOf = new Map(ordered.map((r) => [r.id, toAcl(r.workspaceId, r.aclVersion, r.hasLocks)]))
  // Caps per page with the caller's role in that page's workspace (no walk without locks, cached chains otherwise).
  const caps = new Map<string, number>()
  for (const role of new Set(ordered.map((r) => r.role))) {
    const subset = ordered.filter((r) => r.role === role).map((r) => r.id)
    for (const [k, v] of await capsFor(db, subset, actorFor(userId, role), aclOf)) caps.set(k, v)
  }
  const versions = new Map(ordered.map((r) => [r.workspaceId, Number(r.aclVersion)]))
  const applies = await applicableInstructions(
    ordered.map((r) => ({ id: r.id, workspaceId: r.workspaceId })),
    versions,
  )
  const flags = await suspiciousSections(ordered.map((r) => r.id))
  if (opts.read && flags.size) await markTainted()
  return {
    pages: ordered.map((r) => {
      const c = caps.get(r.id) ?? 0
      return {
        id: r.id,
        can: ['read', ...(c & CAP_COMMENT ? ['comment'] : []), ...(c & CAP_EDIT ? ['edit'] : [])].join(','),
        createdBy: r.createdBy,
        lastEdit: r.hasChange ? { name: r.editorName, via: r.via } : null,
        suspicious: (flags.get(r.id) ?? []).map((f) => ({ anchor: f.anchor, rules: f.rules })),
        large: isLargePage(Number(r.stateBytes ?? 0), Number(r.tokens ?? 0)),
      }
    }),
    applies: applies.map((a) => ({ pageId: a.pageId, title: a.title, mode: a.mode })),
  }
}

export async function registerEditLockRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/lock', { preHandler: requireUser }, async (req) => {
    const { user, page, role } = await guardPage(req)
    return pageLockStatus(page.id, actorFor(user.id, role))
  })

  app.put('/pages/:id/lock', { preHandler: requireSessionUser }, async (req) => {
    const { user, page, role } = await guardPage(req)
    const body = setPageLockSchema.parse(req.body)
    await setPageLock(page.id, user, role, body)
    return pageLockStatus(page.id, actorFor(user.id, role))
  })

  app.put('/pages/:id/agent-instructions', { preHandler: requireSessionUser }, async (req) => {
    const { user, page, role } = await guardPage(req)
    const body = setAgentInstructionSchema.parse(req.body)
    await setInstruction(page.id, user, role, body)
    return pageLockStatus(page.id, actorFor(user.id, role))
  })

  app.delete('/pages/:id/agent-instructions', { preHandler: requireSessionUser }, async (req) => {
    const { user, page, role } = await guardPage(req)
    await removeInstruction(page.id, user, role)
    return pageLockStatus(page.id, actorFor(user.id, role))
  })

  app.get('/workspaces/:id/agent-instructions', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const dto: AgentInstructionListDTO = { instructions: (await instructionRows([id])).map(toInstructionDTO) }
    return dto
  })

  app.get('/workspaces/:id/agent-instructions/bundle', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    const { forPageId } = bundleQuerySchema.parse(req.query)
    let forPage: { id: string; workspaceId: string } | null = null
    if (forPageId) {
      const p = await findVisiblePage(forPageId, user.id)
      if (!p || p.workspaceId !== id) throw notFound()
      forPage = { id: p.id, workspaceId: p.workspaceId }
    }
    return instructionBundle(id, forPage)
  })

  app.get('/pages/:id/suspicious', { preHandler: requireUser }, async (req) => {
    const { page } = await guardPage(req)
    const dto: SuspiciousSectionsDTO = { pageId: page.id, sections: (await suspiciousSections([page.id])).get(page.id) ?? [] }
    return dto
  })

  app.get('/pages/agent-context', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { ids, read } = contextQuerySchema.parse(req.query)
    return agentContextFor(user.id, ids, { read: read === '1' })
  })
}
