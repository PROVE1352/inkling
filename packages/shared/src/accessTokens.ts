import { z } from 'zod'
import type { SuggestOnlyDTO } from './taint'

// ---------------------------------------------------------------------------
// Connection range and personal API tokens (docs/adr/1200-*, 1201-*, 1203-*)
// ---------------------------------------------------------------------------

/**
 * What one connection (an OAuth grant or a personal API token) may see:
 *   - `all`: every workspace and page the owner can see (the only behaviour before 1200),
 *   - `workspaces`: only these workspaces,
 *   - `subtree`: only this page and the pages below it (by parent), in the page's workspace.
 * The owner's own permissions still apply inside the range; a range never widens anything.
 */
export type AccessRange =
  | { kind: 'all' }
  | { kind: 'workspaces'; workspaceIds: string[] }
  | { kind: 'subtree'; pageId: string }

export const ACCESS_RANGE_MAX_WORKSPACES = 20

export const accessRangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('workspaces'),
    workspaceIds: z.array(z.uuid()).min(1).max(ACCESS_RANGE_MAX_WORKSPACES),
  }),
  z.object({ kind: z.literal('subtree'), pageId: z.uuid() }),
])

/**
 * A range as the settings screens show it: the stored range plus names. `available` is false when
 * a named workspace or the root page is gone or no longer visible to the owner (the connection then
 * sees nothing there; it never falls back to "all").
 */
export type AccessRangeView =
  | { kind: 'all' }
  | { kind: 'workspaces'; workspaces: { id: string; name: string | null }[] }
  | {
      kind: 'subtree'
      page: { id: string; title: string | null; workspaceId: string | null; workspaceName: string | null }
    }

/** Every personal API token starts with this, so a leaked one is recognisable (secret scanning). */
export const API_TOKEN_PREFIX = 'ink_pat_'
/** Expiry choices offered when a token is made; null = no expiry. */
export const API_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const
export const API_TOKEN_NAME_MAX = 60
/** Tokens one account may hold at once. */
export const API_TOKEN_MAX_PER_USER = 50

export const createApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(API_TOKEN_NAME_MAX),
  /** 30 / 90 / 365, or null for a token that does not expire. */
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
  /** Same meaning as the OAuth `read` / `write` scopes (docs/adr/0935-*). */
  access: z.enum(['read', 'write']),
  range: accessRangeSchema,
})
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>

/** PATCH /tokens/:id and PATCH /oauth/grants/:id: change the name (tokens) or the range. */
export const updateApiTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(API_TOKEN_NAME_MAX).optional(),
    range: accessRangeSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.range !== undefined, { message: 'Nothing to change' })

export const updateGrantRangeSchema = z.object({ range: accessRangeSchema })

export interface ApiTokenDTO {
  id: string
  name: string
  /** First characters of the token (`ink_pat_` + 4), enough to recognise it; the rest is never stored. */
  prefix: string
  access: 'read' | 'write'
  range: AccessRangeView
  createdAt: string
  /** null = no expiry */
  expiresAt: string | null
  lastUsedAt: string | null
  /** Client IP of the last use (as the server saw it behind its trusted proxy). */
  lastUsedIp: string | null
  /** Additive (docs/adr/2042-*): set while the token is suggest-only after reading flagged content. */
  suggestOnly?: SuggestOnlyDTO | null
}

/** POST /tokens answer: the only time the raw token is shown. */
export interface CreatedApiTokenDTO {
  token: ApiTokenDTO
  secret: string
}

/** One row of the instance admin's token list for a user (no secrets, no range details). */
export interface AdminApiTokenDTO {
  id: string
  name: string
  prefix: string
  access: 'read' | 'write'
  rangeKind: AccessRange['kind']
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
}
