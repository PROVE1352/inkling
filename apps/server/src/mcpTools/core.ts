import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AuthUser } from '../auth'
import { MCP_INTERNAL_HEADER, MCP_INTERNAL_SECRET } from '../oauth'

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
}

export class ToolError extends Error {}

export interface InjectOpts {
  json?: unknown
  payload?: Buffer
  headers?: Record<string, string>
  query?: Record<string, string>
  /** Statuses returned to the caller instead of thrown (e.g. 409 to show conflict details). */
  passStatuses?: number[]
}

/** Next-step hints appended to REST errors, keyed by HTTP status. */
const NEXT_STEP: Record<number, string> = {
  401: 'the access token is no longer valid; reconnect the Inkling connector',
  403: 'you are not a member of that workspace or lack permission; use list_workspaces for valid workspace ids',
  404: 'page/workspace not found or not visible to you; use find_context or list_pages to get a valid id',
  409: 'the content changed since you read it; re-read it and retry',
  412: 'the content changed since you read it; re-read it and retry',
  429: 'rate limited; wait a minute before retrying',
}

/** Next-step hints keyed by error code (take precedence over NEXT_STEP). */
const NEXT_STEP_BY_CODE: Record<string, string> = {
  PAGE_LOCKED:
    'nothing was written; do not retry or work around the lock (moving or copying the page will not help). ' +
    'Tell the user who can edit it, or leave your suggested change with add_comment if that is allowed (see the can: line of read_page)',
  // docs/adr/1200-*: the connection is limited to some workspaces or one subtree
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
    const hint = (code && NEXT_STEP_BY_CODE[code]) || NEXT_STEP[res.statusCode]
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

export const uuid = () => z.uuid()

export type { McpServer, CallToolResult }

/** Rough token estimate shared by every budgeted tool output (docs/adr/0926-*). */
export { estimateTokens } from '../context/tokens'
