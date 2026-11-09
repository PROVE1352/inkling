import { z } from 'zod'
import type { DiffOpDTO } from './notifications'

// ---------------------------------------------------------------------------
// Suggested section edits and section claims (docs/adr/1530-* .. 1536-*)
// ---------------------------------------------------------------------------

/** What the suggestion would do: patch_section modes, or update_page for the whole body. */
export const SUGGESTION_MODES = ['replace', 'append', 'prepend', 'insert_after', 'delete', 'page_replace', 'page_append'] as const
export type SuggestionMode = (typeof SUGGESTION_MODES)[number]

/** accepted_partial = a person applied some of its hunks (docs/adr/1622-*). */
export const SUGGESTION_STATUSES = ['open', 'accepted', 'accepted_partial', 'rejected', 'superseded', 'withdrawn'] as const
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number]

/**
 * Status filter of GET /pages/:id/suggestions and GET /suggestions (`status=`), and of
 * list_suggestions (docs/adr/1626-*): 'open' (default), 'decided' (accepted, accepted_partial,
 * rejected), 'all', or one status. Both lists use the same filter.
 */
export const SUGGESTION_STATUS_FILTERS = ['open', 'decided', 'all', 'accepted', 'accepted_partial', 'rejected', 'withdrawn', 'superseded'] as const
export type SuggestionStatusFilter = (typeof SUGGESTION_STATUS_FILTERS)[number]

/** Open suggestions per page (the oldest must be decided before more come in). */
export const MAX_OPEN_SUGGESTIONS_PER_PAGE = 100

/** Section claims: default and maximum time-to-live. */
export const CLAIM_TTL_DEFAULT_S = 5 * 60
export const CLAIM_TTL_MAX_S = 30 * 60

export interface SuggestionDTO {
  id: string
  pageId: string
  workspaceId: string
  /** Section anchor when suggested; '' = the whole page body. */
  anchor: string
  /** Heading path when suggested (display; the section may have been renamed since). */
  headingPath: string
  /** Heading block id of the section (null for the intro and the whole page). */
  blockId: string | null
  mode: SuggestionMode
  /** 'asked' = suggest=true; 'lock' = a suggestions-only/auto lock; 'policy' = the workspace's agent edit policy. */
  origin: 'asked' | 'lock' | 'policy'
  status: SuggestionStatus
  markdown: string
  baseVersion: string | null
  author: { id: string; name: string }
  /** OAuth client name of the connection that suggested it. */
  via: string | null
  createdAt: string
  decidedBy: { id: string; name: string } | null
  decidedAt: string | null
  /** Accepted by an auto-accept rule: 'workspace' or 'page:<id>' (docs/adr/1545-*). */
  rule: string | null
  /** Why an auto-accept policy left it for a person. */
  reviewReason: string | null
  /** Grace period: the rule accepts it at this time unless a person decides first. */
  autoAt: string | null
  /** Auto-accepted in the same request: the section after the edit. */
  applied?: { anchor: string; version: string } | null
  /** superseded: the newer suggestion of the same connection for the same section (docs/adr/1626-*). */
  supersededBy?: string | null
  /** accepted_partial: how many of the suggestion's hunks were applied (docs/adr/1622-*). */
  partial?: { applied: number; total: number } | null
  /** Only with ?preview=1 on open suggestions: the section now and with the suggestion applied. */
  preview?: SuggestionPreviewDTO
}

export interface SuggestionPreviewDTO {
  /** The section (or body) still exists. */
  found: boolean
  /** Its anchor now (differs from `anchor` after a heading rename). */
  currentAnchor: string | null
  currentVersion: string | null
  /** The section changed since the agent read it (base version differs): the diff is against now. */
  changed: boolean
  before: string
  after: string
  ops: DiffOpDTO[] | null
  large: boolean
  /**
   * `replace` suggestions: the change in hunks (top-level blocks), each checked against what people
   * changed since the agent read the section (3-way, docs/adr/1621-*). Absent for other modes and
   * when the section is gone or too large to split.
   */
  merge?: SuggestionMergeDTO | null
}

export interface SuggestionMergeDTO {
  /** The section as the agent read it is known (stored at suggestion time, or unchanged since). */
  baseKnown: boolean
  /** Identifies base + current + suggestion; send it back with the chosen hunks. */
  key: string
  hunks: SuggestionHunkDTO[]
}

export interface SuggestionHunkDTO {
  id: number
  /** Overlaps an edit people made since the agent read the section (or the base is unknown). */
  conflict: boolean
  /** People already made exactly this change. */
  same: boolean
  /** Markdown the hunk replaces (as the agent read it). */
  before: string
  /** Markdown it brings in. */
  after: string
  /** Conflicts: what the section holds there now. */
  ours: string | null
  /** First line of the block before the hunk (orientation). */
  context: string | null
}

/** POST /suggestions/:id/accept */
export const acceptSuggestionSchema = z
  .object({
    confirmChanged: z.boolean().optional(),
    /** Apply only these hunks (ids from preview.merge); needs `mergeKey`. */
    hunks: z.array(z.number().int().min(0).max(10_000)).max(10_000).optional(),
    mergeKey: z.string().max(64).optional(),
  })
  .strict()
export type AcceptSuggestionInput = z.infer<typeof acceptSuggestionSchema>

export interface SectionClaimDTO {
  pageId: string
  anchor: string
  blockId: string | null
  /** The connection's client name ("Claude Desktop"), else the person's name. */
  by: string
  userId: string
  /** The claim belongs to the caller's own connection. */
  mine: boolean
  expiresAt: string
}

/** GET /pages/:id/suggestions */
export interface PageSuggestionsDTO {
  suggestions: SuggestionDTO[]
  claims: SectionClaimDTO[]
  /** The caller may accept or reject (edit access as a person, browser or API token). */
  canDecide: boolean
}

// ---------------------------------------------------------------------------
// Agent edit policy and auto-accept rules (docs/adr/1544-*, 1545-*)
// ---------------------------------------------------------------------------

/** direct = agents write (default); auto = suggestions, accepted by rules; review = every edit waits for a person. */
export const AGENT_EDIT_LEVELS = ['direct', 'auto', 'review'] as const
export type AgentEditLevel = (typeof AGENT_EDIT_LEVELS)[number]

export const AUTO_ACCEPT_MODES = ['append', 'insert_after', 'prepend', 'replace', 'delete'] as const
export type AutoAcceptMode = (typeof AUTO_ACCEPT_MODES)[number]
export const DEFAULT_AUTO_ACCEPT_MODES: AutoAcceptMode[] = ['append', 'insert_after', 'prepend']
export const MAX_GRACE_MINUTES = 7 * 24 * 60

export const autoAcceptRulesSchema = z
  .object({
    modes: z.array(z.enum(AUTO_ACCEPT_MODES)).max(AUTO_ACCEPT_MODES.length),
    /** 'grant:<id>' / 'token:<id>'; empty = every connection. */
    connections: z.array(z.string().regex(/^(grant|token):[0-9a-zA-Z_-]{1,100}$/)).max(200),
    maxLines: z.number().int().min(1).max(100_000).nullable(),
    maxChars: z.number().int().min(1).max(10_000_000).nullable(),
    graceMinutes: z.number().int().min(0).max(MAX_GRACE_MINUTES),
  })
  .strict()
export type AutoAcceptRules = z.infer<typeof autoAcceptRulesSchema>

export const DEFAULT_AUTO_ACCEPT_RULES: AutoAcceptRules = {
  modes: DEFAULT_AUTO_ACCEPT_MODES,
  connections: [],
  maxLines: null,
  maxChars: null,
  graceMinutes: 0,
}

/** PUT /workspaces/:id/agent-policy */
export const setAgentPolicySchema = z.object({ level: z.enum(AGENT_EDIT_LEVELS), rules: autoAcceptRulesSchema }).strict()
export type SetAgentPolicyInput = z.infer<typeof setAgentPolicySchema>

/** PUT /pages/:id/agent-rules */
export const setPageAgentRulesSchema = z.object({ rules: autoAcceptRulesSchema }).strict()

export interface AgentPolicyDTO {
  level: AgentEditLevel
  rules: AutoAcceptRules
  /** The caller may change it (workspace: owners/admins; page: who may manage the page's lock). */
  canManage: boolean
  updatedBy: { id: string; name: string } | null
  updatedAt: string | null
}
