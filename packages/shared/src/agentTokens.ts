import { z } from 'zod'
import { accessRangeSchema } from './accessTokens'
import type { AccessRangeView } from './accessTokens'
import type { SuggestOnlyDTO } from './taint'

// ---------------------------------------------------------------------------
// Agent connection tokens (docs/adr/2060-* .. 2063-*)
// ---------------------------------------------------------------------------

/**
 * Every agent connection token starts with this. Distinct from personal API tokens (`ink_pat_`, which stay
 * 401 at /mcp, docs/adr/1201-*) and OAuth access tokens (`ink_at_`), so a person, a log scrubber or a secret
 * scanner can tell which credential leaked.
 */
export const AGENT_TOKEN_PREFIX = 'ink_agt_'
/** Expiry choices; there is no "never" (docs/adr/2061-*). */
export const AGENT_TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const
export type AgentTokenExpiryDays = (typeof AGENT_TOKEN_EXPIRY_DAYS)[number]
/** The preselected expiry (docs/adr/2061-*). */
export const AGENT_TOKEN_DEFAULT_EXPIRY_DAYS: AgentTokenExpiryDays = 90
/** The name is the connection's "via" label: the same cap as an OAuth client's display name. */
export const AGENT_TOKEN_NAME_MAX = 60
/** Agent connection tokens one account may hold at once. */
export const AGENT_TOKEN_MAX_PER_USER = 20

export const createAgentTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(AGENT_TOKEN_NAME_MAX),
    expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]),
    /** Same meaning as the OAuth `read` / `write` scopes on the consent screen (docs/adr/0935-*). */
    access: z.enum(['read', 'write']),
    range: accessRangeSchema,
  })
  .strict()
export type CreateAgentTokenInput = z.infer<typeof createAgentTokenSchema>

/** One agent connection token in Settings › Connections. Never carries the token itself. */
export interface AgentTokenDTO {
  /** The connection (grant) id: the key elsewhere is `grant:<id>`. */
  id: string
  /** The name given when it was made; agents' edits read "<person> (via <name>)". */
  name: string
  /** `ink_agt_` + 4 characters, enough to recognise it; the rest is never stored. */
  prefix: string
  access: 'read' | 'write'
  range: AccessRangeView
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  /** Set while the connection is suggest-only after reading flagged content (docs/adr/2042-*). */
  suggestOnly: SuggestOnlyDTO | null
}

/** POST /agent-tokens answer: the only time the token is shown. */
export interface CreatedAgentTokenDTO {
  token: AgentTokenDTO
  secret: string
}
