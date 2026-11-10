/**
 * The tool profile a /mcp URL asks for (docs/adr/2000-*): `?profile=core` or `?profile=full`, none =
 * full. Kept apart from mcpTools/profiles.ts (which needs the MCP SDK) for the OAuth routes.
 */

export type McpProfile = 'core' | 'full'

/**
 * The `profile` query value of an /mcp request: 'core' or 'full'; absent → 'full'; anything else
 * (another word, a repeated parameter) → null, which the route answers with 400.
 */
export function parseProfile(query: unknown): McpProfile | null {
  const v = (query as Record<string, unknown> | null | undefined)?.profile
  if (v === undefined) return 'full'
  if (v === 'core' || v === 'full') return v
  return null
}

/** The /mcp error body for an unknown profile (JSON-RPC shape, like the route's other errors). */
export const PROFILE_ERROR = {
  jsonrpc: '2.0',
  error: { code: -32602, message: 'Unknown profile: use /mcp?profile=core or /mcp?profile=full (no profile = full).' },
  id: null,
} as const

/**
 * The OAuth resource indicator a client may send for a profile URL (RFC 8707): the /mcp URL with
 * only `profile=core|full` as its query counts as `/mcp`. Returns the resource without that query,
 * or the input unchanged.
 */
export function resourceWithoutProfile(resource: string): string {
  const m = /^(.*?)\?profile=(core|full)$/.exec(resource)
  return m ? m[1] : resource
}
