import { z } from 'zod'
import type { ChangeRevertInfoDTO } from './revert'

// ---------------------------------------------------------------------------
// Notifications, subscriptions, agent inbox and the activity screen
// (docs/adr/1000-* .. 1006-*)
// ---------------------------------------------------------------------------

/**
 * Subscription level of a page subtree (or of a whole workspace when no page is given).
 *  - all:      direct items (mentions, replies, assignments) + activity (comments, edits) on the subtree
 *  - mentions: direct items only (workspace default)
 *  - nothing:  direct items are kept in the list quietly (no unread badge, no mail, no webhook ping)
 *  - mute:     nothing is recorded, except kinds that pass mute (approval requests addressed to you)
 */
export const NOTIFICATION_LEVELS = ['all', 'mentions', 'nothing', 'mute'] as const
export const notificationLevelSchema = z.enum(NOTIFICATION_LEVELS)
export type NotificationLevel = z.infer<typeof notificationLevelSchema>
export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = 'mentions'

export const EMAIL_DIGEST_MODES = ['off', 'daily', 'weekly'] as const
export const emailDigestSchema = z.enum(EMAIL_DIGEST_MODES)
export type EmailDigestMode = z.infer<typeof emailDigestSchema>

/** One of my subscription rows (Settings → Notifications list). */
export interface SubscriptionDTO {
  workspaceId: string
  workspaceName: string
  /** null = my default for the whole workspace. */
  rootPageId: string | null
  rootTitle: string | null
  level: NotificationLevel
  /** false = this page only ("follow"), true = the page and everything under it. */
  subtree: boolean
  /** "When AI edits here, send me a daily summary." */
  agentDigest: boolean
  updatedAt: string
}

export interface NotificationSettingsDTO {
  /** Mail right away for mentions, replies and assignments (only when the server has mail). */
  emailInstant: boolean
  /** Summary mail of everything not mailed right away (quiet items, activity, AI edit summaries). */
  emailDigest: EmailDigestMode
  /** The server has SMTP configured; otherwise everything stays in the app. */
  mailAvailable: boolean
  /** Follow a comment thread when I start it or reply in it (docs/adr/1412-*). */
  threadAutoFollow: boolean
  /** Notify me about replies in threads I follow (the Threads view lists them either way). */
  threadReplies: boolean
  /** Also show me what is handed or assigned to one of my agent connections (docs/adr/1863-*). Additive. */
  agentHandoffCopy?: boolean
  subscriptions: SubscriptionDTO[]
}

export const updateNotificationSettingsSchema = z
  .object({
    emailInstant: z.boolean().optional(),
    emailDigest: emailDigestSchema.optional(),
    threadAutoFollow: z.boolean().optional(),
    threadReplies: z.boolean().optional(),
    agentHandoffCopy: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'Nothing to change' })
export type UpdateNotificationSettingsInput = z.infer<typeof updateNotificationSettingsSchema>

/** GET /pages/:id/subscription */
export interface PageSubscriptionDTO {
  pageId: string
  /** My own row on this page, if any. */
  own: { level: NotificationLevel; subtree: boolean; agentDigest: boolean } | null
  /** What applies to this page right now (nearest row wins: page, then ancestors with subtree, then workspace). */
  effective: {
    level: NotificationLevel
    source: 'page' | 'ancestor' | 'workspace' | 'default'
    fromPageId: string | null
    fromTitle: string | null
  }
  /** An AI daily summary covers this page (own row or an ancestor's). */
  agentDigest: boolean
  /** I created or own the page: new comment threads reach me unless the level is nothing/mute. */
  implicit: boolean
}

/** PUT /pages/:id/subscription — level null removes my row (inherit again). */
export const setPageSubscriptionSchema = z.object({
  level: notificationLevelSchema.nullable(),
  subtree: z.boolean().optional(),
  agentDigest: z.boolean().optional(),
})
export type SetPageSubscriptionInput = z.infer<typeof setPageSubscriptionSchema>

/** PUT /workspaces/:id/notification-level — my default for the workspace. */
export const setWorkspaceNotificationLevelSchema = z.object({
  level: notificationLevelSchema,
  agentDigest: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// Activity screen (people + AI, newest first) and diffs
// ---------------------------------------------------------------------------

export type DiffOpDTO = { t: '=' | '-' | '+'; s: string }

export interface ActivityItemDTO {
  /** page_changes.seq as a string (bigint). */
  seq: string
  pageId: string
  /** null when the page is no longer visible (trashed / made private). */
  pageTitle: string | null
  /** added | modified | removed | moved | renamed | page_added | page_renamed | page_moved | page_trashed | page_restored | page_visibility | page_props */
  kind: string
  anchor: string | null
  headingPath: string
  actor: { id: string; name: string } | null
  /** OAuth client name when an agent made the change ("AI"). */
  via: string | null
  changedAt: string
  /** The change was too large to keep a diff. */
  large: boolean
  /** before/after texts exist, so GET /changes/:seq/diff can show something. */
  hasDiff: boolean
  /** The page was created through an agent connection (pages.created_via). */
  pageCreatedVia: string | null
  /** Revert facts (docs/adr/1623-*). */
  revert?: ChangeRevertInfoDTO
}

export interface ActivityPageDTO {
  items: ActivityItemDTO[]
  /** Pass as `before` for the next (older) page; null at the end. */
  next: string | null
  /** Client names seen in this workspace's log (filter choices), sorted. */
  clients: string[]
}

export const activityQuerySchema = z.object({
  before: z.string().regex(/^\d{1,19}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** any | human (no client) | ai (any client) */
  actor: z.enum(['any', 'human', 'ai']).optional(),
  /** One client name (exact). */
  via: z.string().trim().min(1).max(100).optional(),
  /** One person (the member the change is attributed to). */
  userId: z.uuid().optional(),
  /** Only this page and everything under it. */
  rootId: z.uuid().optional(),
  /** edit = section changes, page = page-level events (created, renamed, moved, trashed, …). */
  kind: z.enum(['any', 'edit', 'page']).optional(),
  /** Only pages created through an agent connection. */
  aiPagesOnly: z.enum(['0', '1']).optional(),
})
export type ActivityQuery = z.infer<typeof activityQuerySchema>

/** GET /changes/:seq/diff */
export interface ChangeDiffDTO {
  seq: string
  pageId: string
  pageTitle: string | null
  kind: string
  headingPath: string
  actor: { id: string; name: string } | null
  via: string | null
  changedAt: string
  before: string | null
  after: string | null
  /** null = too large to diff (show before/after or "large change"). */
  ops: DiffOpDTO[] | null
  large: boolean
}

/** GET /pages/:id/snapshots/:sid/diff?against=current|<snapshot id> */
export interface SnapshotDiffDTO {
  from: { id: string; label: string | null; createdAt: string }
  to: { id: string | 'current'; label: string | null; createdAt: string | null }
  ops: DiffOpDTO[] | null
  large: boolean
}

/** GET /pages/:id/provenance — the "written by AI · last AI edit" badge. */
export interface PageProvenanceDTO {
  /** Client name the page was created through (null = created by a person in the app). */
  createdVia: string | null
  createdByName: string | null
  lastAgentEdit: { at: string; via: string; actorName: string | null } | null
}

// ---------------------------------------------------------------------------
// Agent inbox (MCP inbox / ack)
// ---------------------------------------------------------------------------

/** Kinds an agent inbox can list. source_changed is reserved (no producer yet); approval_result: docs/adr/1534-*. */
export const INBOX_KINDS = ['mention', 'reply', 'comment', 'assigned', 'source_changed', 'approval_result'] as const
export type InboxKind = (typeof INBOX_KINDS)[number]

export const inboxQuerySchema = z.object({
  workspaceId: z.uuid().optional(),
  cursor: z.string().regex(/^\d{1,19}$/).optional(),
  kinds: z
    .string()
    .max(200)
    .optional()
    .transform((s) => (s ? s.split(',').map((k) => k.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(INBOX_KINDS)).optional()),
  budget: z.coerce.number().int().min(200).max(8000).optional(),
})

export const inboxAckSchema = z
  .object({
    ids: z.array(z.string().regex(/^\d{1,19}$/)).max(500).optional(),
    cursor: z.string().regex(/^\d{1,19}$/).optional(),
    /**
     * With `cursor`: the filters of the listing the cursor came from (docs/adr/1922-*). A cursor ack
     * only reaches items that listing could show; without them, the unfiltered inbox.
     */
    workspaceId: z.uuid().optional(),
    kinds: z.array(z.enum(INBOX_KINDS)).max(INBOX_KINDS.length).optional(),
  })
  .refine((d) => (d.ids && d.ids.length > 0) || d.cursor !== undefined, { message: 'ids or cursor is required' })

/** Shown on the consent screen when the app's name equals a member's display name. */
export interface ClientNameNotice {
  /** The member display name it matches. */
  member: string
  /** Workspaces (names) where that member is. */
  workspaces: string[]
  /** true = the connection will be refused in those workspaces; false = a common app name, warning only. */
  blocking: boolean
}
