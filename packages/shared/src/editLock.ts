import { z } from 'zod'
import type { PageAccessLevel } from './pageAccess'

// ---------------------------------------------------------------------------
// Edit lock (docs/adr/0970-*) and agent instruction pages (docs/adr/0975-*)
// ---------------------------------------------------------------------------

/** Maximum explicit editors on one lock. */
export const MAX_LOCK_EDITORS = 50

/**
 * Who among people may edit under a lock: 'editors' = the page owner, workspace owners/admins and
 * the listed editors; 'everyone' = people are not restricted (only the agent rule applies).
 */
export const LOCK_PEOPLE = ['editors', 'everyone'] as const
export type LockPeople = (typeof LOCK_PEOPLE)[number]

/**
 * What agent (MCP / OAuth) requests may do under a lock: 'same' = what their user may do, under the
 * workspace's agent edit policy (docs/adr/1544-*); 'direct' = edit directly whatever the workspace
 * default says; 'auto' = suggestions accepted by this node's rules; 'suggest' = every edit becomes a
 * suggestion a person accepts or rejects (docs/adr/1532-*),
 * 'comment' = comment but not edit, 'read' = neither edit nor comment. Applies to every member's
 * agent, owners and admins included.
 */
export const LOCK_AGENTS = ['same', 'direct', 'auto', 'suggest', 'comment', 'read'] as const
export type LockAgents = (typeof LOCK_AGENTS)[number]

/** PUT /pages/:id/lock */
export const setPageLockSchema = z
  .object({
    /** true = lock this page and its whole subtree, false = remove this page's own lock. */
    locked: z.boolean(),
    /** Default 'editors' when turning a lock on; unchanged when omitted on an existing lock. */
    people: z.enum(LOCK_PEOPLE).optional(),
    /** Default 'same' when turning a lock on; unchanged when omitted on an existing lock. */
    agents: z.enum(LOCK_AGENTS).optional(),
    /** Extra members who may edit (besides the page owner and workspace owners/admins). Replaces the list. */
    editorIds: z.array(z.uuid()).max(MAX_LOCK_EDITORS).optional(),
  })
  .strict()
export type SetPageLockInput = z.infer<typeof setPageLockSchema>

export interface LockPersonDTO {
  id: string
  name: string
}

/** GET /pages/:id/lock — the lock that governs a page (its own, or the nearest locked ancestor's). */
export interface PageLockDTO {
  pageId: string
  /** The page is governed by a lock (its own or an ancestor's). */
  locked: boolean
  /** The page carries its own lock (false when the lock is inherited or there is none). */
  own: boolean
  /** The page whose lock applies (nearest locked ancestor-or-self), or null. */
  lockRoot: { id: string; title: string } | null
  /** Owner (pages.owner_id) of the lock root: edits by default. */
  owner: LockPersonDTO | null
  /** Explicit editors of the lock root. */
  editors: LockPersonDTO[]
  /** People rule of the lock root (null when not locked). */
  people: LockPeople | null
  /** Agent rule of the lock root (null when not locked). */
  agents: LockAgents | null
  /** The caller may edit this page (computed for the caller's kind of request: browser = person, MCP = agent). */
  canEdit: boolean
  /** The caller may comment on this page. */
  canComment: boolean
  /** The caller may turn this page's own lock on/off and change its editors. */
  canManage: boolean
  /**
   * The caller's level from the page's people list (docs/adr/1251-*): `full` for owners/admins,
   * the nearest row on the path, else `edit` for members. canEdit/canComment already include it.
   * Additive: older servers omit it.
   */
  level?: PageAccessLevel
  /** The caller is a guest here (not a member of the workspace). */
  guest?: boolean
  /** Agent-instruction designation of this page, if any. */
  instructions: AgentInstructionDTO | null
}

/** Inclusion modes of an agent instruction page. */
export const AGENT_INSTRUCTION_MODES = ['always', 'match', 'manual'] as const
export type AgentInstructionMode = (typeof AGENT_INSTRUCTION_MODES)[number]

/** Maximum applyTo entries per instruction page. */
export const MAX_APPLY_TO = 20

/**
 * One applyTo entry: `page:<uuid>` (that page and its subtree) or a title-path glob such as
 * `Projects/**` or `Specs/*`. Paths are page titles from the top level joined with `/`.
 */
export const applyToEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((s) => !s.startsWith('page:') || /^page:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s), {
    message: 'page:<id> needs a page id',
  })

/** PUT /pages/:id/agent-instructions */
export const setAgentInstructionSchema = z
  .object({
    mode: z.enum(AGENT_INSTRUCTION_MODES),
    /** Required (non-empty) for mode 'match'; ignored otherwise. */
    applyTo: z.array(applyToEntrySchema).max(MAX_APPLY_TO).optional(),
    /** One line shown in lists (manual instructions are listed by it). */
    description: z.string().trim().max(300).optional(),
    /** Order among instructions of the same rank (lower first). */
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .strict()
export type SetAgentInstructionInput = z.infer<typeof setAgentInstructionSchema>

export interface AgentInstructionDTO {
  pageId: string
  title: string
  mode: AgentInstructionMode
  applyTo: string[]
  description: string
  sortOrder: number
}

/** GET /workspaces/:id/agent-instructions */
export interface AgentInstructionListDTO {
  instructions: AgentInstructionDTO[]
}

// ---------------------------------------------------------------------------
// Injection-like content signals (docs/adr/0977-*): a mitigation signal, never a block.
// ---------------------------------------------------------------------------

/** Rule ids of the deterministic injection heuristics, in output order. */
export const INJECTION_RULES = [
  'hidden-chars',
  'override-phrase',
  'tool-directive',
  'permission-change',
  'encoded-blob',
  'exfil-url',
  'image-exfil',
] as const
export type InjectionRule = (typeof INJECTION_RULES)[number]

/** GET /pages/:id/suspicious — sections whose indexed text matched a heuristic. */
export interface SuspiciousSectionsDTO {
  pageId: string
  sections: { anchor: string; headingPath: string; rules: InjectionRule[] }[]
}
