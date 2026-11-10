import { GUEST_INVITE_POLICIES } from './pageAccess'
import type { GuestInvitePolicy } from './pageAccess'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Workspace settings, audit log, agent access and document review
// (docs/adr/0945-* .. 0952-*)
// ---------------------------------------------------------------------------

/** Lowest role allowed to do something: owners only / owners + admins / every member. */
export const rolePolicySchema = z.enum(['owners', 'admins', 'members'])
export type RolePolicy = z.infer<typeof rolePolicySchema>

/** What the caller may do in a workspace (WorkspaceDTO.can), computed by the server. */
export interface WorkspaceCapabilities {
  /** Owner or admin: members, sharing, connected agents and audit log screens. */
  manage: boolean
  /** Owner: name/icon, policy settings, webhooks, delete/transfer. */
  editSettings: boolean
  /** May add existing users directly (member-add policy). */
  addMembers: boolean
  /** Sees and may copy the invite link (link enabled and caller is owner/admin). */
  inviteLink: boolean
  /** May download the whole-workspace zip export (export policy). */
  export: boolean
  /** May turn public web links on (owner/admin, and public sharing not disabled). */
  publish: boolean
}

export const TRASH_RETENTION_DAYS = { min: 7, max: 365, default: 30 } as const
export const AUDIT_RETENTION_DAYS = { min: 30, max: 730, default: 90 } as const
export const REVIEW_INTERVAL_DAYS = { min: 7, max: 730 } as const

export interface WorkspaceSettingsDTO {
  inviteLinkEnabled: boolean
  memberAddPolicy: RolePolicy
  exportPolicy: RolePolicy
  publicSharingDisabled: boolean
  trashRetentionDays: number
  auditRetentionDays: number
  /** null = review reminders off. */
  reviewIntervalDays: number | null
  /** New public links expire after this many days unless the publisher picks otherwise; null = none (docs/adr/1172-*). */
  shareDefaultExpiryDays: number | null
  /** New public links need a password and a password cannot be removed (docs/adr/1172-*). */
  sharePasswordRequired: boolean
  /** Who may invite people from outside the workspace to a page (docs/adr/1250-*). Additive. */
  guestInvitePolicy?: GuestInvitePolicy
  /** MCP connections may read page handwriting (read_ink, docs/adr/1510-*). Additive; off by default. */
  agentInkRead?: boolean
  /** Connections that read flagged content write here only as suggestions for a while (docs/adr/2043-*). Additive; on by default. */
  agentTaintDemote?: boolean
  /**
   * Uploads through connections (upload_file, bearer POST /files; docs/adr/2065-*): null = follow the
   * server default, 'on' / 'off' = this workspace's choice. Additive.
   */
  agentUploads?: 'on' | 'off' | null
  /** The server's AGENT_UPLOADS default ('never' = off everywhere, the workspace cannot turn it on). Read-only, additive. */
  agentUploadsServer?: 'on' | 'off' | 'never'
}

/** PATCH /workspaces/:id/settings (owner only). Every field optional; unknown keys are rejected. */
export const updateWorkspaceSettingsSchema = z
  .object({
    inviteLinkEnabled: z.boolean().optional(),
    memberAddPolicy: rolePolicySchema.optional(),
    exportPolicy: rolePolicySchema.optional(),
    publicSharingDisabled: z.boolean().optional(),
    /** With publicSharingDisabled=true: also remove every existing public link, in the same transaction. */
    unpublishExisting: z.boolean().optional(),
    trashRetentionDays: z.number().int().min(TRASH_RETENTION_DAYS.min).max(TRASH_RETENTION_DAYS.max).optional(),
    auditRetentionDays: z.number().int().min(AUDIT_RETENTION_DAYS.min).max(AUDIT_RETENTION_DAYS.max).optional(),
    reviewIntervalDays: z.number().int().min(REVIEW_INTERVAL_DAYS.min).max(REVIEW_INTERVAL_DAYS.max).nullable().optional(),
    shareDefaultExpiryDays: z.number().int().min(1).max(365).nullable().optional(),
    sharePasswordRequired: z.boolean().optional(),
    guestInvitePolicy: z.enum(GUEST_INVITE_POLICIES).optional(),
  })
  .strict()
export type UpdateWorkspaceSettingsInput = z.infer<typeof updateWorkspaceSettingsSchema>

// --- Require two-step verification (docs/adr/1112-*) --------------------------

export const TWO_FACTOR_GRACE_DAYS = { min: 0, max: 30, default: 7 } as const

/** How a workspace's 2FA requirement applies to the caller (WorkspaceDTO.twoFactor). */
export interface WorkspaceTwoFactorStatus {
  /** The workspace requires two-step verification. */
  required: boolean
  /** When the grace period ends (ISO), null when the requirement is off. */
  deadline: string | null
  /**
   * off = not required; ok = the caller satisfies it (2FA on, or a delegated sign-in account);
   * grace = not yet, but still allowed until `deadline`; blocked = workspace API and collaboration
   * answer 403 TWO_FACTOR_REQUIRED until the caller turns 2FA on.
   */
  state: 'off' | 'ok' | 'grace' | 'blocked'
}

/** GET /workspaces/:id/settings → `twoFactor` (members see it read-only). */
export interface TwoFactorPolicyDTO {
  required: boolean
  graceDays: number
  /** When the requirement was turned on (ISO), null when off. */
  requiredAt: string | null
  deadline: string | null
  /** The server can do two-step verification at all (APP_SECRET_KEY set). Off: the switch cannot be turned on. */
  available: boolean
  /** The caller has 2FA on (or signs in through delegated login): needed to turn the requirement on. */
  selfSatisfied: boolean
  /** Owners/admins only: members who have not turned 2FA on yet (first 50), and how many in all. */
  membersWithout?: { count: number; members: { id: string; name: string }[] }
}

/** PUT /workspaces/:id/settings/two-factor (owners and admins). */
export const setTwoFactorPolicySchema = z
  .object({
    required: z.boolean(),
    graceDays: z.number().int().min(TWO_FACTOR_GRACE_DAYS.min).max(TWO_FACTOR_GRACE_DAYS.max).optional(),
  })
  .strict()
export type SetTwoFactorPolicyInput = z.infer<typeof setTwoFactorPolicySchema>

/** PUT /workspaces/:id/settings/agent-ink (owners and admins, docs/adr/1510-*). */
export const setAgentInkSchema = z.object({ enabled: z.boolean() }).strict()
export type SetAgentInkInput = z.infer<typeof setAgentInkSchema>

/** PUT /workspaces/:id/settings/agent-uploads (owners and admins, docs/adr/2065-*). 'default' = follow the server. */
export const setAgentUploadsSchema = z.object({ value: z.enum(['default', 'on', 'off']) }).strict()
export type SetAgentUploadsInput = z.infer<typeof setAgentUploadsSchema>

// --- Audit log --------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'member.added',
  'member.joined',
  'member.removed',
  'member.left',
  'member.role_changed',
  'invite.regenerated',
  'share.published',
  'share.unpublished',
  'share.expiry_changed',
  /** A scheduled link's start was set, moved or removed (docs/adr/1844-*). */
  'share.start_changed',
  'share.password_set',
  'share.password_changed',
  'share.password_removed',
  /** Visitors' Markdown download was turned on / off for a link (docs/adr/2362-*). */
  'share.download_changed',
  /** A form view's public link was turned on / off (docs/adr/1821-*). */
  'form.published',
  'form.unpublished',
  'export.downloaded',
  'workspace.updated',
  'workspace.deleted',
  'workspace.restored',
  'workspace.transferred',
  'agent.blocked',
  'agent.unblocked',
  'settings.updated',
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
  'page.locked',
  'page.unlocked',
  'page.lock_editors_changed',
  'instructions.set',
  'instructions.removed',
  'content.suspicious',
  'page.access_granted',
  'page.access_changed',
  'page.access_removed',
  'page.guest_invited',
  'guests.removed',
  'agent_policy.changed',
  /** A connection was handed flagged content and became suggest-only (docs/adr/2040-*): after.source, after.rules, after.until; never the text. */
  'agent.tainted',
  /** A person lifted a connection's suggest-only state (docs/adr/2042-*): before.sources, after.scope ('workspace' | 'all'). */
  'agent.taint_released',
  /** An agent connection token was made (docs/adr/2063-*): target `grant:<id>` + its name; after.access, after.range, after.expiresAt; never the token. */
  'agent.token_created',
  /** An agent connection token was revoked by its owner (docs/adr/2063-*). */
  'agent.token_revoked',
  /** An agent connection token's range was changed by its owner (docs/adr/2063-*): before.range, after.range (kinds). */
  'agent.token_range_changed',
  /** A person reverted logged changes on a page (docs/adr/1623-*): before.seqs reverted, after.seqs the revert's own edits. */
  'page.changes_reverted',
  /** A page was marked verified (after.expiresAt) or its verification removed (docs/adr/1840-*). */
  'page.verified',
  'page.unverified',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEventDTO {
  /** Monotonic id (bigint as string); also the pagination cursor. */
  id: string
  action: AuditAction
  actor: { id: string | null; name: string }
  /** OAuth client name when done through an agent connection. */
  viaClient: string | null
  target: { type: string; id: string | null; label: string | null } | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  createdAt: string
}

export const auditQuerySchema = z.object({
  /** Exact action, or a group prefix such as 'member' / 'share'. */
  action: z.string().trim().max(40).regex(/^[a-z_.]+$/).optional(),
  actorId: z.uuid().optional(),
  /** Return events with id < cursor (the previous page's nextCursor). */
  cursor: z.string().regex(/^\d{1,19}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export interface AuditPageDTO {
  events: AuditEventDTO[]
  nextCursor: string | null
  retentionDays: number
}

// --- Connected agents -------------------------------------------------------

export interface AgentConnectionDTO {
  grantId: string
  user: { id: string; name: string }
  client: { id: string; name: string }
  /** 'read' = read-only connection, 'write' = may edit (docs/adr/0935-*). */
  access: 'read' | 'write'
  firstUsedAt: string
  lastUsedAt: string
  /** A block rule in this workspace matches this connection. */
  blocked: boolean
  /**
   * Calls of this connection that reached this workspace since the server started (docs/adr/1552-*):
   * numbers only; null when it made none since then.
   */
  usage?: AgentConnectionUsageDTO | null
}

export interface AgentConnectionUsageDTO {
  calls: number
  errors: number
  /** Estimated tokens returned by those calls. */
  tokens: number
  /** Answered from the find_context cache (docs/adr/1550-*). */
  cacheHits: number
  lastUsedAt: string
}

export interface AgentBlockDTO {
  id: string
  user: { id: string; name: string }
  /** null = every agent of that member. */
  client: { id: string; name: string } | null
  createdBy: string | null
  createdAt: string
}

export const blockAgentSchema = z.object({
  userId: z.uuid(),
  /** Omit or null to block every agent connection of that member in this workspace. */
  clientId: z.string().min(1).max(200).nullable().optional(),
})

// --- Public sharing management ---------------------------------------------

export const bulkUnpublishSchema = z.object({
  /** Omit to remove every public link in the workspace. */
  pageIds: z.array(z.uuid()).min(1).max(500).optional(),
})

// --- Document owner, review and review priority (docs/adr/0951-*, 0953-*) ---

/** Review priority facts from the daily batch (page_review_scores). */
export interface ReviewPriorityDTO {
  /** Reads in the last 30 days (web views + agent reads, page totals only). */
  reads30: number
  /** Probability the page is out of date, 1 − exp(−λ·t), rounded to 2 decimals. */
  pStale: number
  /** max(reads30, 0.5) × pStale, rounded to 2 decimals. */
  score: number
  /** Estimated minutes to review, from the body length. */
  estMinutes: number
  /** Changes so often that a review date means nothing (auto-classified or set by hand). */
  living: boolean
  /** Unread for 90 days and unchanged for 180+: a candidate for archiving rather than review. */
  archiveCandidate: boolean
  /** 'YYYY-MM-DD' of the batch these numbers come from. */
  computedOn: string
}

export interface PageReviewDTO {
  pageId: string
  owner: { id: string; name: string } | null
  /** ISO timestamp of the last "Mark reviewed", or null. */
  reviewedAt: string | null
  reviewedBy: { id: string; name: string } | null
  /** Workspace review interval (null = reminders off). */
  intervalDays: number | null
  /** 'YYYY-MM-DD' when the page is expected to cross pStale 0.5; null when reminders are off. */
  dueOn: string | null
  /** pStale ≥ 0.5 and not a living document. */
  stale: boolean
  /** null = automatic, true/false = set by hand. */
  livingOverride: boolean | null
  /** null before the first daily batch that covered this page. */
  priority: ReviewPriorityDTO | null
}

export const setPageOwnerSchema = z.object({
  ownerId: z.uuid().nullable(),
})

/** PUT /pages/:id/living — null = automatic classification. */
export const setLivingSchema = z.object({
  living: z.boolean().nullable(),
})

export interface ReviewDueItemDTO {
  id: string
  title: string
  icon: string | null
  owner: { id: string; name: string } | null
  reviewedAt: string | null
  dueOn: string
  reads30: number
  pStale: number
  score: number
  estMinutes: number
  livingOverride: boolean | null
}

export interface ReviewDueDTO {
  intervalDays: number | null
  today: string
  /** Stale documents by priority score, highest first. */
  items: ReviewDueItemDTO[]
  /** Unread and old: archive rather than review. */
  archive: ReviewDueItemDTO[]
  /** Living documents left out of the list (auto or by hand). */
  living: ReviewDueItemDTO[]
}
