import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance } from 'fastify'
import { anyIdArg } from './idSchema'
import type { AuthUser } from '../auth'
import { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } from '../oauth'
import { cleanStrings, UNTRUSTED_JSON_NOTE, untrustedObject } from './trust'

/**
 * Shared plumbing for the MCP tool modules (mcp.ts and mcpTools/*.ts).
 *
 * Every tool calls the existing /api REST routes through `call()` (app.inject as the token user), so
 * membership and private-page visibility are exactly the web app's. Errors are phrased for an agent:
 * they say what to do next.
 */

export interface ToolCtx {
  app: FastifyInstance
  token: string
  ip: string
  user: AuthUser
  origin: string
  /** False for a read-only token: write tools answer with a clear error (docs/adr/0935-*). */
  canWrite: boolean
  /** Tool profile from the MCP URL (`/mcp?profile=core`); absent = 'full' (docs/adr/2000-*). */
  profile?: 'core' | 'full'
}

export class ToolError extends Error {}

export interface InjectOpts {
  json?: unknown
  payload?: Buffer
  headers?: Record<string, string>
  query?: Record<string, string | string[]>
  /** Statuses returned to the caller instead of thrown (e.g. 409 to show conflict details). */
  passStatuses?: number[]
  /** What a plain 404 means for this call (default: read from the URL, notFoundTarget). */
  target?: NotFoundTarget
}

/**
 * What a 404 NOT_FOUND is about, so the hint names it (docs/adr/1655-*, ADR 0929: say what to do
 * next). Specific error codes (SECTION_NOT_FOUND, TEMPLATE_NOT_FOUND, …) keep their own hints.
 */
export type NotFoundTarget = 'page' | 'workspace' | 'file' | 'comment' | 'row' | 'collection' | 'version' | 'generic'

const NOT_FOUND_HINT: Record<NotFoundTarget, string> = {
  page: 'page not found or not visible to you; use find_context or list_pages to get a valid id',
  workspace: 'workspace not found or you are not a member; use list_workspaces for valid workspace ids',
  file: 'file not found or not visible to you; pass the id or the /files/<id> link exactly as read_page shows it',
  comment: 'comment thread not found or not visible to you; use list_comments(pageId) for thread ids',
  row: 'row not found or not visible to you; use query_rows(collectionId) for row ids',
  collection: 'collection not found or not visible to you (or the id is not a collection); search or list_pages mark collections',
  version: 'page or version not found; use list_versions(pageId) for version ids',
  generic: 'not found or not visible to you; check the id you passed (find_context, list_pages and list_workspaces give valid ones)',
}

/** The target of a REST URL for the 404 hint (the route families the MCP tools call). */
export function notFoundTarget(url: string): NotFoundTarget {
  const path = url.split('?')[0]
  if (/^\/(api\/)?files\//.test(path)) return 'file'
  if (/^\/api\/comments\//.test(path)) return 'comment'
  if (/^\/api\/pages\/[^/]+\/(row|props)$/.test(path)) return 'row'
  if (/^\/api\/pages\/[^/]+\/collection(\/|$)/.test(path)) return 'collection'
  if (/^\/api\/pages\/[^/]+\/snapshots\/[^/]+/.test(path)) return 'version'
  if (/^\/api\/workspaces\/[^/]+/.test(path)) return 'workspace'
  if (/^\/api\/pages\//.test(path)) return 'page'
  // suggestions, later items, …: their own wording, or the generic one
  return 'generic'
}

/** Next-step hints appended to REST errors, keyed by HTTP status. */
const NEXT_STEP: Record<number, string> = {
  401: 'the access token is no longer valid; reconnect the Inkling connector',
  403: 'you are not a member of that workspace or lack permission; use list_workspaces for valid workspace ids',
  409: 'the content changed since you read it; re-read it and retry',
  412: 'the content changed since you read it; re-read it and retry',
  429: 'rate limited; wait a minute before retrying',
  503: 'the server is busy; wait a minute and retry the same call once',
}

/** Next-step hints keyed by error code (take precedence over NEXT_STEP). */
const NEXT_STEP_BY_CODE: Record<string, string> = {
  PAGE_LOCKED:
    'nothing was written; do not retry or work around the lock (moving or copying the page will not help). ' +
    'Tell the user who can edit it, or leave your suggested change with add_comment if that is allowed (see the can: line of read_page)',
  // docs/adr/1200-*: the connection is limited to some workspaces or one subtree
  // docs/adr/1240-*: imports, zip exports and copies share a small concurrency cap
  HEAVY_JOBS_PER_USER: 'the user already has imports, exports or copies running; wait for them to finish before starting another',
  // docs/adr/1251-*: the person's own level on this page tree (view / comment) does not allow it
  PAGE_ACCESS:
    'nothing was written; the user only has view or comment access to this page. Do not retry or copy the page to get around it. ' +
    'Ask a person with full access to change it, or leave the suggestion with add_comment if the can: line allows commenting',
  // docs/adr/1626-*: a suggestion that is no longer open; the message says which state and why
  SUGGESTION_SUPERSEDED: 'nothing to do for this id; list_suggestions(status: "open") shows what is still waiting',
  SUGGESTION_WITHDRAWN: 'nothing to do',
  SUGGESTION_DECIDED: 'nothing to do; the outcome also arrives in inbox as approval_result',
  // a section that is not on the page (the message lists the current anchors; docs/adr/1501-*, 1655-*)
  SECTION_NOT_FOUND: 'the page exists but has no such section; use one of the anchors listed, or read_page(pageId, outline=true)',
  SECTION_AMBIGUOUS: 'use one of the anchors listed',
  TEMPLATE_NOT_FOUND: 'list_templates (page templates) or query_rows(collectionId, describe=true) (row templates) show valid names and ids',
  PAGE_NOT_FOUND: NOT_FOUND_HINT.page,
  // docs/adr/2040-*: the message already says what still works and who lifts it
  CONNECTION_SUGGEST_ONLY: 'until then only suggestions (patch_section, patch_sections, update_page) and comments are accepted',
  OUT_OF_RANGE:
    'this connection may not reach it; do not retry elsewhere to get around it. Work inside the range, or ask the user to widen it in Settings › Connections',
}

/** Call an existing REST route as the token user; 4xx/5xx become a ToolError carrying the server message */
export async function call(
  ctx: ToolCtx,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: InjectOpts = {},
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.token}`,
    [MCP_INTERNAL_HEADER]: MCP_INTERNAL_SECRET,
    ...opts.headers,
  }
  let payload: string | Buffer | undefined = opts.payload
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(opts.json)
  }
  const res = await ctx.app.inject({
    method,
    url,
    query: opts.query,
    headers,
    payload,
    remoteAddress: ctx.ip,
  })
  if (res.statusCode >= 400 && !opts.passStatuses?.includes(res.statusCode)) {
    let message = `Request failed (HTTP ${res.statusCode})`
    let code: string | undefined
    try {
      const body = res.json() as { error?: { message?: string; code?: string } }
      code = body?.error?.code
      if (body?.error?.message) message = `${body.error.message} (${body.error.code ?? res.statusCode})`
    } catch {
      // Body is not JSON: keep the default message
    }
    // Error codes first (more specific than the status), then the status.
    const hint =
      (code && NEXT_STEP_BY_CODE[code]) ||
      (res.statusCode === 404 ? NOT_FOUND_HINT[opts.target ?? notFoundTarget(url)] : NEXT_STEP[res.statusCode])
    if (hint) message = `${message}: ${hint}`
    throw new ToolError(message)
  }
  return res
}

export function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] }
}
export function json(v: unknown): CallToolResult {
  return text(JSON.stringify(v))
}

/**
 * JSON output that carries member-written strings (docs/adr/1525-*): an object keeps its keys and
 * gains a trailing `untrusted` note (and `applies` when instructions apply); a bare array stays
 * byte-for-byte the first text block and the note follows as a second block.
 */
export function jsonUntrusted(v: Record<string, unknown> | unknown[], applies?: string | null): CallToolResult {
  if (Array.isArray(v)) {
    const note = `${applies ? `${applies}\n` : ''}untrusted: ${UNTRUSTED_JSON_NOTE}`
    return { content: [{ type: 'text', text: JSON.stringify(cleanStrings(v)) }, { type: 'text', text: note }] }
  }
  return text(JSON.stringify(untrustedObject(v, applies)))
}

/** Tool handler wrapper: turns ToolError/validation errors into an isError result */
export function wrap<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args)
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : 'Internal server error'
      if (!(err instanceof ToolError)) console.error('[inkling] MCP tool error', err)
      return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] }
    }
  }
}

export const READ_ONLY_MESSAGE =
  "this connection is read-only (scope 'read'); reconnect the Inkling connector and allow write access to edit notes"

/**
 * Wrapper for tools that change data: a read-only token gets a clear error instead of a 403 from
 * the REST layer (which also refuses non-GET requests for read-only tokens, docs/adr/0935-*).
 */
export function wrapWrite<A>(ctx: ToolCtx, fn: (args: A) => Promise<CallToolResult>) {
  return wrap<A>(async (args) => {
    if (!ctx.canWrite) throw new ToolError(READ_ONLY_MESSAGE)
    return fn(args)
  })
}

/**
 * An id argument (docs/adr/1940-*): a plain string in the tool list; full id or 8+ hex prefix,
 * resolved before the handler by the field name's kind (idSchema.ts FIELD_KINDS). Tools that know
 * the kind use `idArg(kind)` instead.
 */
export const uuid = () => anyIdArg()
export { idArg } from './idSchema'

export type { McpServer, CallToolResult }

/** Rough token estimate shared by every budgeted tool output (docs/adr/0926-*). */
export { estimateTokens } from '../context/tokens'
