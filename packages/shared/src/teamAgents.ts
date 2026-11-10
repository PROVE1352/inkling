import { z } from 'zod'
import type { SuggestOnlyDTO } from './taint'

// ---------------------------------------------------------------------------
// Team agents: a person's connection as a target (docs/adr/1860-*)
// ---------------------------------------------------------------------------

/**
 * A connection key, as everywhere else since 0.12 (claims, suggestions, catch_up markers, auto-accept
 * rules): `grant:<uuid>` for an OAuth/MCP connection, `token:<uuid>` for a personal API token.
 */
export type ConnectionKey = `grant:${string}` | `token:${string}`

/**
 * "A person's connection" as a value (docs/adr/1860-*): `<person uuid>/<connection key>`. The person
 * comes first so the value stays meaningful when the connection is gone: it then means the person
 * (revoked, expired, blocked, or the person left the workspace — docs/adr/1863-*).
 */
export type AgentRefString = `${string}/${ConnectionKey}`

export interface AgentRef {
  userId: string
  connection: ConnectionKey
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const CONNECTION_KEY_RE = new RegExp(`^(grant|token):(${UUID})$`, 'i')
export const AGENT_REF_RE = new RegExp(`^(${UUID})/((?:grant|token):${UUID})$`, 'i')

export function isConnectionKey(s: unknown): s is ConnectionKey {
  return typeof s === 'string' && CONNECTION_KEY_RE.test(s)
}

/** Parses `<uuid>/grant:<uuid>` (lower-cased); null for anything else. */
export function parseAgentRef(s: unknown): AgentRef | null {
  if (typeof s !== 'string') return null
  const m = AGENT_REF_RE.exec(s.trim())
  if (!m) return null
  return { userId: m[1].toLowerCase(), connection: m[2].toLowerCase() as ConnectionKey }
}

export function formatAgentRef(r: AgentRef): AgentRefString {
  return `${r.userId}/${r.connection}` as AgentRefString
}

/** Short form for agents (MCP output, docs/adr/1862-*): `g:1a2b3c4d` / `t:1a2b3c4d`. */
export function shortConnection(key: string): string {
  const m = CONNECTION_KEY_RE.exec(key)
  if (!m) return key
  return `${m[1][0].toLowerCase()}:${m[2].slice(0, 8).toLowerCase()}`
}

/**
 * Person cells (docs/adr/1861-*): the cell keeps the person's id where it always was, and the
 * connection sits next to it under `agent:<fieldId>` as an AgentRefString. A 0.14 client reads
 * only the person and ignores the extra key; a ref whose person is not in the cell any more, or
 * whose connection is not live, reads as no agent (the person).
 */
export const AGENT_PROP_PREFIX = 'agent:'

export function agentPropKey(fieldId: string): string {
  return `${AGENT_PROP_PREFIX}${fieldId}`
}

/** The agent ref stored next to a person cell, when it names a person who is in the cell. */
export function agentRefOfCell(props: Record<string, unknown> | null | undefined, fieldId: string): AgentRef | null {
  if (!props) return null
  const ref = parseAgentRef(props[agentPropKey(fieldId)])
  if (!ref) return null
  const v = props[fieldId]
  const people = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return people.some((p) => p.toLowerCase() === ref.userId) ? ref : null
}

/**
 * Mention chips (docs/adr/1861-*): `kind: 'agent'`, `id: <AgentRefString>`, `label: "<person> · <client>"`.
 * The 0.14 editor renders any kind other than 'page' as a person chip showing `@label`.
 */
export const AGENT_MENTION_KIND = 'agent'

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** A live connection of a workspace member (mention and assignee pickers, docs/adr/1862-*). */
export interface WorkspaceConnectionDTO {
  /** AgentRefString: what a chip, a person cell or a comment hand-off stores. */
  ref: string
  key: ConnectionKey
  userId: string
  userName: string
  /** OAuth client name or API token name. */
  client: string
  kind: 'grant' | 'token'
  lastUsedAt: string | null
  /** Additive (docs/adr/2042-*): set while the connection writes here only as suggestions after flagged content. */
  suggestOnly?: SuggestOnlyDTO | null
}

export interface TeamClaimDTO {
  pageId: string
  /** null when the viewer cannot see the page (title and section hidden). */
  pageTitle: string | null
  anchor: string | null
  hidden: boolean
  connection: string
  client: string
  expiresAt: string
  /** Seconds left (from the server clock). */
  ttlSeconds: number
}

export interface TeamSuggestionDTO {
  id: string
  pageId: string
  pageTitle: string | null
  anchor: string | null
  hidden: boolean
  mode: string
  client: string
  createdAt: string
}

/** One agent of a person: activity grouped by client name (page_changes carry the name, docs/adr/1864-*). */
export interface TeamAgentActivityDTO {
  client: string
  /** Live connections of this person with this client name (empty when it is gone). */
  connections: string[]
  edits: number
  created: number
  suggestions: number
  /** Changes of this agent that a person reverted in the window. */
  reverted: number
  /** Most recent pages first, at most 5; hidden ones carry no title. */
  recentPages: { pageId: string; title: string | null; hidden: boolean; at: string }[]
  lastAt: string | null
}

export interface TeamPersonDTO {
  userId: string
  name: string
  agents: TeamAgentActivityDTO[]
  claims: TeamClaimDTO[]
  suggestions: TeamSuggestionDTO[]
}

/** GET /workspaces/:id/team-agents (docs/adr/1862-*). */
export interface TeamAgentsDTO {
  since: string
  now: string
  people: TeamPersonDTO[]
  totals: { claims: number; openSuggestions: number; edits: number; created: number; suggestions: number; reverted: number }
  /** Additive (docs/adr/2042-*): connection key → suggest-only state, for the live connections that are suggest-only here now. */
  suggestOnly?: Record<string, SuggestOnlyDTO>
}

export const teamAgentsQuerySchema = z.object({
  /** Start of "today" in the viewer's time zone (ISO); default the last 24 hours, at most 7 days back. */
  since: z.iso.datetime({ offset: true }).optional(),
})

/** Hand-offs in a comment: connections (`<uuid>/grant:<uuid>` or `grant:<uuid>`) the comment is for. */
export const mentionConnectionsSchema = z.array(z.string().trim().min(1).max(120)).max(10)
