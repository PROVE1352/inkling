import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { connectionKeyOf, runMetered } from '../connectionUsage'
import { estimateTokens } from '../context/tokens'
import type { ToolCtx } from './core'

/**
 * Per-connection usage of MCP tools (docs/adr/1552-*): every tool registered on `server` after this
 * call runs inside a usage frame of the connection (ctx.user.grantId). Counted per call: the
 * returned text as estimated tokens (images and other blocks count 0), isError as an error,
 * latency minus any changes_since wait, find_context cache hits. Nothing of the arguments or the
 * text is kept. A connection without a grant (tests, internal use) is not metered.
 */
export function meterTools(server: McpServer, ctx: ToolCtx): void {
  const key = connectionKeyOf(ctx.user)
  if (!key) return
  const register = server.registerTool.bind(server) as (...a: unknown[]) => unknown
  ;(server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) => {
    const handler = cb as (...a: unknown[]) => Promise<CallToolResult>
    return register(name, config, (...args: unknown[]) => runMetered(key, () => handler(...args), measure))
  }
}

function measure(r: CallToolResult): { tokens: number; error: boolean } {
  let tokens = 0
  for (const c of r.content ?? []) if (c.type === 'text') tokens += estimateTokens(c.text)
  return { tokens, error: r.isError === true }
}
