// MCP connection settings per client (docs/adr/2020-*). Pure functions: the Connections page renders what
// these return, and mcpConfig.test.ts checks every client × auth × profile combination.
//
// Every format below comes from the client's own documentation; the ADR lists the page and the date it was
// checked. A client whose format could not be confirmed is not listed (Windsurf: its MCP page now redirects to
// another product's docs): the generic JSON covers it.

import { AGENT_TOKEN_PREFIX } from '@inkling/shared'

export const MCP_CLIENTS = ['claude-code', 'claude-ai', 'cursor', 'vscode', 'generic'] as const
export type McpClient = (typeof MCP_CLIENTS)[number]

export const MCP_PROFILES = ['full', 'core'] as const
export type McpProfile = (typeof MCP_PROFILES)[number]

export type McpAuth = 'oauth' | 'token'

/**
 * Token sign-in at /mcp with an agent connection token (`ink_agt_`, docs/adr/2060-*): a credential made on the
 * Connections screen that the server treats exactly like an OAuth connection (an agent, with the name given as
 * its "via" label). Personal API tokens (`ink_pat_`) stay 401 at /mcp (docs/adr/1201-*), so the generator never
 * fills one in: the token it fills is the agent connection token just made on the same screen.
 */
export const MCP_TOKEN_AUTH_ENABLED = true

/** Shown in place of the token until an agent connection token was just made on this screen. */
export const TOKEN_PLACEHOLDER = '<YOUR_INKLING_AGENT_TOKEN>'

/** Only an agent connection token may be filled in (a personal API token would be refused at /mcp). */
export function isAgentConnectionToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && token.startsWith(AGENT_TOKEN_PREFIX)
}

/** Server name used in every config (the key the client lists the server under). */
export const SERVER_NAME = 'inkling'

/** `<origin>/mcp`, plus `?profile=core` for the core profile. Full is the server's default and adds nothing. */
export function mcpServerUrl(origin: string, profile: McpProfile): string {
  const base = `${origin.replace(/\/+$/, '')}/mcp`
  return profile === 'core' ? `${base}?profile=core` : base
}

export interface McpConfigInput {
  client: McpClient
  auth: McpAuth
  profile: McpProfile
  origin: string
  /** An agent connection token made on this screen a moment ago; anything else (null, a personal API token) prints the placeholder. */
  token?: string | null
}

export interface McpConfigOutput {
  /** What `text` is: a shell command, a JSON file body, or a URL to paste into the client's form. */
  kind: 'command' | 'json' | 'url'
  /** What to copy. */
  text: string
  /** Where it goes: file paths (one per line) or the client's menu path. Not translated: paths and menu names. */
  where: string[]
  /** claude.ai / Claude Desktop with a token: the value for the `authorization` request header. */
  headerValue?: string
  /** The token in `text` is the placeholder (the person has to replace it). */
  usesPlaceholder: boolean
}

const bearer = (token: string) => `Bearer ${token}`

export function buildMcpConfig(input: McpConfigInput): McpConfigOutput {
  const url = mcpServerUrl(input.origin, input.profile)
  const useToken = input.auth === 'token'
  const token = isAgentConnectionToken(input.token) ? input.token : TOKEN_PLACEHOLDER
  const usesPlaceholder = useToken && token === TOKEN_PLACEHOLDER
  const out = (kind: McpConfigOutput['kind'], text: string, where: string[]): McpConfigOutput => ({
    kind,
    text,
    where,
    usesPlaceholder: kind !== 'url' && usesPlaceholder,
  })
  const json = (v: unknown) => JSON.stringify(v, null, 2)

  switch (input.client) {
    case 'claude-code': {
      const header = useToken ? ` --header ${shellQuote(`Authorization: ${bearer(token)}`)}` : ''
      return out('command', `claude mcp add --transport http ${SERVER_NAME} ${shellQuote(url)}${header}`, [])
    }
    case 'claude-ai':
      // The connector dialog takes the URL; a fixed credential goes under Request headers ("No sign-in"). Claude
      // sends the value exactly as entered, so it carries the "Bearer " itself.
      return {
        ...out('url', url, ['Customize › Connectors › + Add › Add custom connector']),
        ...(useToken ? { headerValue: bearer(token), usesPlaceholder } : {}),
        // Header authentication in that dialog is in beta for some organizations only (docs/adr/2020-*).
      }
    case 'cursor':
      return out(
        'json',
        json({ mcpServers: { [SERVER_NAME]: { url, ...(useToken ? { headers: { Authorization: bearer(token) } } : {}) } } }),
        ['.cursor/mcp.json', '~/.cursor/mcp.json'],
      )
    case 'vscode': {
      // VS Code asks for the token once and keeps it in its secret storage (`inputs`), so the file never holds
      // it; a token created here is still shown separately for pasting into that prompt.
      const server = { type: 'http', url, ...(useToken ? { headers: { Authorization: 'Bearer ${input:inkling-token}' } } : {}) }
      const body = useToken
        ? {
            inputs: [{ type: 'promptString', id: 'inkling-token', description: 'Inkling agent connection token', password: true }],
            servers: { [SERVER_NAME]: server },
          }
        : { servers: { [SERVER_NAME]: server } }
      return { ...out('json', json(body), ['.vscode/mcp.json']), usesPlaceholder: false }
    }
    case 'generic':
      return out(
        'json',
        json({
          mcpServers: {
            [SERVER_NAME]: { type: 'http', url, ...(useToken ? { headers: { Authorization: bearer(token) } } : {}) },
          },
        }),
        [],
      )
  }
}

/** Single-quote for POSIX shells when needed (a URL with `?` would otherwise be a glob in zsh). */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}
