import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { and, asc, between, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { WorkspaceDTO } from '@inkling/shared'
import { db } from '../db/index'
import { comments, pages } from '../db/schema'
import { memberWorkspaceIds } from '../context/retrieve'
import { findVisiblePage, visibleTo } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'
import { runAsConnection } from './agentContext'
import { call, ToolError } from './core'
import type { ToolCtx } from './core'
import { resolvePageRef } from './shortIds'
import { cleanText } from './trust'
import { FULL_RE, isIdOrPrefix, MESSAGES, planOfShape } from './idSchema'
import type { IdKind, Plan } from './idSchema'

/**
 * Id arguments of every MCP tool (docs/adr/1940-*, 1941-*).
 *
 * Schema: a plain string. The id rule is a zod refinement, which the tool list does not show (a
 * `z.uuid()` field printed a 190-character pattern; 51 of them were ~2.5k of the ~16.5k tokens every
 * client loads). Validation still happens before the handler, with a message that says which id is
 * expected and where to get it.
 *
 * Resolution: before a handler runs, `resolveIdArgs` (installed on the server like the meter)
 * replaces each id argument by the full id. A full id passes through unchanged and unchecked (the
 * REST route checks access as before). A prefix of at least 8 hex characters is resolved among what
 * this connection can see — pages (member workspaces, agent blocks and the connection range applied,
 * visible, live), workspaces (list_workspaces), comment threads (on such pages) — so another member's
 * private page never makes a prefix ambiguous and never appears in an error.
 *
 * Kinds come from the helper that built the field; fields built with the shared `uuid()` (also used
 * by modules owned elsewhere) get their kind from the field name (FIELD_KINDS). A `uuid()` field
 * whose name is not listed takes a full id only.
 */

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

const AMBIGUOUS_SHOWN = 5
const asUuid = (hex32: string) =>
  `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`

function prefixRange(ref: string): { hex: string; lo: string; hi: string } {
  const hex = ref.trim().toLowerCase().replace(/-/g, '')
  return { hex, lo: asUuid(hex.padEnd(32, '0')), hi: asUuid(hex.padEnd(32, 'f')) }
}

function ambiguous(hex: string, what: string, rows: { id: string; label: string }[]): ToolError {
  const shown = rows.slice(0, AMBIGUOUS_SHOWN).map((r) => `${r.id} "${cleanText(r.label || 'Untitled').replace(/\s+/g, ' ')}"`)
  return new ToolError(
    `"${hex}" matches ${rows.length > AMBIGUOUS_SHOWN ? `more than ${AMBIGUOUS_SHOWN}` : rows.length} ${what}: ${shown.join(', ')}. ` +
      'Pass a longer prefix or the full id.',
  )
}

/** A trashed page by id prefix, among the trashed pages this connection could see (restore_page). */
export async function resolveTrashedPageRef(ctx: ToolCtx, ref: string): Promise<string> {
  if (FULL_RE.test(ref.trim())) return ref.trim().toLowerCase()
  const { hex, lo, hi } = prefixRange(ref)
  const rows = await runAsConnection(ctx, async () => {
    const ws = await memberWorkspaceIds(ctx.user.id)
    if (!ws.length) return []
    return db
      .select({ id: pages.id, label: pages.title })
      .from(pages)
      .where(and(between(pages.id, lo, hi), isNotNull(pages.deletedAt), visibleTo(ctx.user.id), inArray(pages.workspaceId, ws), liveWorkspace(pages.workspaceId)))
      .orderBy(asc(pages.id))
      .limit(AMBIGUOUS_SHOWN + 1)
  })
  if (rows.length === 1) return rows[0].id
  if (!rows.length) throw new ToolError(`no trashed page you can see has an id starting with "${hex}"; use list_trash for valid ids`)
  throw ambiguous(hex, 'trashed pages', rows)
}

/** A workspace by id prefix, among the workspaces list_workspaces shows this connection. */
export async function resolveWorkspaceRef(ctx: ToolCtx, ref: string): Promise<string> {
  if (FULL_RE.test(ref.trim())) return ref.trim().toLowerCase()
  const { hex } = prefixRange(ref)
  const all = await listWorkspaces(ctx)
  const rows = all.filter((w) => w.id.replace(/-/g, '').startsWith(hex)).map((w) => ({ id: w.id, label: w.name }))
  if (rows.length === 1) return rows[0].id
  if (!rows.length) throw new ToolError(`no workspace of yours has an id starting with "${hex}"; use list_workspaces for valid ids`)
  throw ambiguous(hex, 'workspaces', rows)
}

/** A comment thread by id prefix, among threads on pages this connection can see. */
export async function resolveThreadRef(ctx: ToolCtx, ref: string): Promise<string> {
  if (FULL_RE.test(ref.trim())) return ref.trim().toLowerCase()
  const { hex, lo, hi } = prefixRange(ref)
  const rows = await runAsConnection(ctx, async () => {
    const ws = await memberWorkspaceIds(ctx.user.id)
    if (!ws.length) return []
    return db
      .selectDistinct({ id: comments.threadId, label: pages.title })
      .from(comments)
      .innerJoin(pages, eq(pages.id, comments.pageId))
      .where(
        and(
          between(comments.threadId, lo, hi),
          isNull(pages.deletedAt),
          visibleTo(ctx.user.id),
          inArray(pages.workspaceId, ws),
          liveWorkspace(pages.workspaceId),
        ),
      )
      .orderBy(asc(comments.threadId))
      .limit(AMBIGUOUS_SHOWN + 1)
  })
  if (rows.length === 1) return rows[0].id
  if (!rows.length) throw new ToolError(`no comment thread you can see has an id starting with "${hex}"; use list_comments(pageId) for thread ids`)
  throw ambiguous(hex, 'threads (page titles shown)', rows)
}

async function resolveOne(ctx: ToolCtx, kind: IdKind, v: string, field: string): Promise<string> {
  switch (kind) {
    case 'page':
      return resolvePageRef(ctx, v)
    case 'trashedPage':
      return resolveTrashedPageRef(ctx, v)
    case 'workspace':
      return resolveWorkspaceRef(ctx, v)
    case 'thread':
      return resolveThreadRef(ctx, v)
    case 'full':
      if (!FULL_RE.test(v.trim())) throw new ToolError(`${field}: ${MESSAGES.full}`)
      return v.trim().toLowerCase()
  }
}

async function apply(ctx: ToolCtx, plan: Plan, v: unknown, field: string): Promise<unknown> {
  if (v === undefined || v === null) return v
  switch (plan.t) {
    case 'id':
      return typeof v === 'string' ? resolveOne(ctx, plan.kind, v, field) : v
    case 'union':
      // e.g. 'current' | version id: only values that look like ids are resolved
      return typeof v === 'string' && isIdOrPrefix(v) ? apply(ctx, plan.of, v, field) : v
    case 'array': {
      if (!Array.isArray(v)) return v
      const out: unknown[] = []
      for (const x of v) out.push(await apply(ctx, plan.of, x, field))
      return out
    }
    case 'object': {
      if (typeof v !== 'object') return v
      const out: Record<string, unknown> = { ...(v as Record<string, unknown>) }
      for (const [k, p] of plan.fields) if (k in out) out[k] = await apply(ctx, p, out[k], k)
      return out
    }
  }
}

/** Arguments with every id field resolved to a full id (throws ToolError). Exported for tests. */
export async function resolveArgs(ctx: ToolCtx, plan: [string, Plan][], args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!plan.length || !args) return args
  return (await apply(ctx, { t: 'object', fields: plan }, args, '')) as Record<string, unknown>
}

/**
 * Installs id resolution on `server`: every tool registered afterwards gets its id arguments as full
 * ids. Errors take the shape `wrap` gives them (`Error: …`, isError).
 */
export function resolveIdArgs(server: McpServer, ctx: ToolCtx): void {
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown
  ;(server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) => {
    const plan = planOfShape((config as { inputSchema?: unknown }).inputSchema)
    const handler = cb as (args: Record<string, unknown>, ...rest: unknown[]) => Promise<CallToolResult>
    if (!plan.length) return register(name, config, cb)
    return register(name, config, async (args: Record<string, unknown>, ...rest: unknown[]) => {
      let full: Record<string, unknown>
      try {
        full = await resolveArgs(ctx, plan, args)
      } catch (err) {
        // the shape and the hiding of internal errors that `wrap` gives every handler
        if (!(err instanceof ToolError)) console.error('[inkling] MCP id resolution error', err)
        const msg = err instanceof ToolError ? err.message : 'Internal server error'
        return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] } satisfies CallToolResult
      }
      return handler(full, ...rest)
    })
  }
}

// ---------------------------------------------------------------------------
// workspace inference (docs/adr/1943-*)
// ---------------------------------------------------------------------------

async function listWorkspaces(ctx: ToolCtx): Promise<WorkspaceDTO[]> {
  const res = await call(ctx, 'GET', '/api/workspaces')
  return (res.json() as { workspaces: WorkspaceDTO[] }).workspaces
}

/**
 * The workspace a call is about: the one passed, else the workspace of `pageId` (a page this
 * connection can see), else the only workspace this connection has. With several and no hint the
 * error lists them (short id and name), so no list_workspaces call is needed first.
 */
export async function inferWorkspace(ctx: ToolCtx, workspaceId: string | undefined, pageId?: string | null): Promise<string> {
  if (workspaceId) return workspaceId
  if (pageId) {
    const page = await runAsConnection(ctx, () => findVisiblePage(pageId, ctx.user.id))
    if (!page) throw new ToolError('page not found or not visible to you; use find_context or list_pages to get a valid id')
    return page.workspaceId
  }
  const all = await listWorkspaces(ctx)
  if (all.length === 1) return all[0].id
  if (!all.length) throw new ToolError('you are not a member of any workspace this connection may use')
  const shown = all.map((w) => `${w.id.slice(0, 8)} "${cleanText(w.name).replace(/\s+/g, ' ')}"`).join(', ')
  throw new ToolError(`workspaceId is required: this connection has ${all.length} workspaces: ${shown}. Pass one (8 characters are enough).`)
}
