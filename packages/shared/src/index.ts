// First import on purpose: ESM evaluates it before the submodules re-exported below build schemas.
import './zodConfig'
import { z } from 'zod'
import type { WorkspaceCapabilities, WorkspaceTwoFactorStatus } from './workspaceAdmin'
import type { WorkspaceAccessRole } from './pageAccess'
import { chartSettingsSchema } from './charts'
import { formSettingsSchema } from './forms'
import { mentionConnectionsSchema } from './teamAgents'
import { filterOpSchema, uniqueIdConfigSchema, viewFilterSchema } from './collectionFields'
import type { WorkspaceListingDTO } from './workspaceListing'
import type { AuthModeLegalDTO, AuthModeLimitsDTO } from './limits'

// ---------------------------------------------------------------------------
// Request schemas (shared by server validation and web form validation)
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(50),
  password: z.string().min(8).max(100),
  // Inkling's own signup key. Required only when the server requires keys
  // (authMode.signupKeyRequired); unrelated to the external auth server used for delegated sign-in.
  signupKey: z.string().trim().min(1).max(200).optional(),
  // One-time first-admin setup code from the server log (/setup?code=…, docs/adr/2160-*). Accepted
  // only while the server has no account; takes the place of a signup key for that one account.
  setupCode: z.string().trim().min(1).max(200).optional(),
  // Restricted mode (0.22, docs/adr/2501-*). Optional and ignored unless the server turned the matching
  // setting on; the route hands them, with the raw body, to the signup hooks (signupHooks.ts).
  // A sign-in ID instead of an email (LOGIN_ID_MODE=username). The rules are checked by the hook.
  loginId: z.string().trim().min(1).max(64).optional(),
  // The ids of the consent items the person ticked (LEGAL_DIR's signup.json) and the document
  // version the screen showed.
  consents: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  legalVersion: z.string().trim().min(1).max(64).optional(),
  // Hidden input that people never see or fill (bots do); any value is passed to the hooks as is.
  website: z.string().max(500).optional(),
})
export type RegisterInput = z.infer<typeof registerSchema>

export const loginSchema = z.object({
  // The email field accepts an email or any string of 3+ characters.
  // In delegated sign-in mode this field carries an external account ID instead of an email,
  // so it is relaxed to let IDs through without breaking existing email users.
  email: z.union([z.email(), z.string().trim().min(3)]),
  password: z.string().min(1),
})
export type LoginInput = z.infer<typeof loginSchema>

/** New password rules: same as signup */
export const newPasswordSchema = z.string().min(8).max(100)

/** Sign-in screen "Reset password": an admin reset code or a (single-use) signup key */
export const resetPasswordSchema = z.object({
  email: z.string().trim().min(3).max(320),
  code: z.string().trim().min(4).max(200),
  newPassword: newPasswordSchema,
})
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>

/** Sign-in screen "Forgot password": the admin queue or (for a verified email) an automatic reset mail */
export const forgotPasswordSchema = z.object({
  email: z.string().trim().min(3).max(320),
  note: z.string().trim().max(300).optional(),
})
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>

/** Settings: change your own password */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: newPasswordSchema,
})
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

/** Confirm an email verification link (/verify?token=) */
export const verifyEmailSchema = z.object({ token: z.string().trim().min(10).max(200) })

/** Resend the verification mail: no body when signed in; email + password when sign-in is blocked */
export const resendVerificationSchema = z
  .object({ email: z.string().trim().min(3).max(320), password: z.string().min(1).max(200) })
  .partial()

/** Admin: mail a just-issued reset code / temporary password */
export const sendCredentialMailSchema = z.object({
  to: z.email(),
  kind: z.enum(['reset-code', 'temp-password']),
  secret: z.string().trim().min(4).max(200),
})
export type SendCredentialMailInput = z.infer<typeof sendCredentialMailSchema>

/** Admin: signup key invite mail */
export const sendInviteMailSchema = z.object({ to: z.email() })

/** Admin: manual IP ban */
export const manualBanSchema = z.object({
  ip: z.string().trim().min(2).max(64),
  minutes: z.number().int().min(1).max(60 * 24 * 30),
  reason: z.string().trim().max(100).optional(),
})
export type ManualBanInput = z.infer<typeof manualBanSchema>

export interface IpBanDTO {
  id: string
  ip: string
  reason: string
  failures: number
  bannedUntil: string
  createdAt: string
  active: boolean
}

export interface IpBansResponseDTO {
  bans: IpBanDTO[]
  /** The requesting admin's own IP (in counter-key form) */
  yourIp: string
  yourIpAllowlisted: boolean
  /** env ALLOWLIST_IPS */
  allowlist: string[]
  policy: {
    windowMinutes: number
    maxFailures: number
    banMinutes: number
    banMaxHours: number
    accountFailures: number
  }
}

// Admin: signup key issuing / admin rights
export const createSignupKeySchema = z.object({
  note: z.string().trim().max(100).optional(),
  maxUses: z.number().int().min(1).max(100).default(1),
  // Empty = no expiry
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})
export type CreateSignupKeyInput = z.infer<typeof createSignupKeySchema>

export const setAdminSchema = z.object({ isAdmin: z.boolean() })

export interface SignupKeyUseDTO {
  name: string
  email: string
  createdAt: string
}

export interface SignupKeyDTO {
  /**
   * Identifier for revoke / send-invite: the key's SHA-256 (docs/adr/1110-*). Older servers omit it
   * and identify keys by `key`.
   */
  id?: string
  /**
   * The key itself for copying, or null when it can no longer be shown: used up (a used single-use
   * key is that person's recovery code), or its encrypted copy cannot be opened (docs/adr/1110-*).
   */
  key: string | null
  /** Last four characters of the key, to tell keys apart when `key` is null. */
  keyHint?: string | null
  note: string | null
  maxUses: number
  usedCount: number
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
  createdByName: string | null
  expired: boolean
  exhausted: boolean
  usedBy: SignupKeyUseDTO[]
}

/**
 * Account origin: local = Inkling's own account, delegated = mirror of an external auth server's delegated
 * sign-in, oidc = created by an OpenID Connect sign-in (docs/adr/1161-*). A local account linked to an
 * OIDC identity stays local.
 */
export type UserOrigin = 'local' | 'delegated' | 'oidc'

/** A sign-in method linked to the account (/auth/me `logins`, docs/adr/1161-*). */
export interface LinkedLoginDTO {
  provider: 'oidc'
  /** OIDC_NAME for the configured provider, the issuer's host for an older one */
  name: string
  /** The email the provider reported at the last sign-in (display only) */
  email: string | null
  linkedAt: string
  lastUsedAt: string | null
}

export interface AdminUserDTO {
  id: string
  email: string
  name: string
  origin: UserOrigin
  isAdmin: boolean
  /**
   * Set when the account was created with a signup key: a masked hint ('••••-ABCD'), never the key
   * (the server keeps only its SHA-256, docs/adr/1110-*).
   */
  signupKey: string | null
  /** Whether this user's signup key is single-use (maxUses=1) and can therefore double as a password reset code */
  signupKeyRecovery: boolean
  emailVerifiedAt: string | null
  createdAt: string
  /** Two-step verification is on (docs/adr/1061-*). Optional: older servers omit it. */
  twoFactor?: boolean
  /** ACCOUNT_LIFETIME_DAYS: when the account is deleted (ISO). Only on accounts that have a date. */
  expiresAt?: string
}

/** Admin: password reset request queue */
export interface ResetRequestDTO {
  id: string
  userId: string
  email: string
  name: string
  origin: UserOrigin
  note: string | null
  ip: string | null
  status: 'pending' | 'resolved' | 'dismissed'
  createdAt: string
  resolvedAt: string | null
  resolvedByName: string | null
}

/** GET /api/auth/mode */
export interface AuthModeDTO {
  /** Whether sign-in with an external account ID is possible */
  delegated: boolean
  /** Display name of delegated accounts (DELEGATED_AUTH_NAME, default "External account") */
  delegatedName: string
  /** Mirror email domain of delegated accounts: identifies addresses that never receive real mail */
  delegatedEmailDomain: string
  signupKeyRequired: boolean
  /** SMTP is configured: mail sending and email verification are available */
  mailEnabled: boolean
  /** New users cannot sign in before verifying their email */
  emailVerificationRequired: boolean
  /** Enabled experimental features (env EXPERIMENTAL_FEATURES), e.g. ['plugins'] */
  experimental?: string[]
  /** OpenID Connect sign-in is configured: the button label (OIDC_NAME). Absent on older servers. */
  oidc?: { name: string } | null
  /**
   * The server has no account yet and printed a first-admin setup link to its log (docs/adr/2160-*).
   * Absent on older servers.
   */
  setupPending?: boolean
  // --- Restricted mode (0.22, docs/adr/2500-*): each field only when the operator set it ---
  /** LOGIN_ID_MODE=username: sign-up and sign-in take an ID instead of an email. Absent = email. */
  loginId?: 'username'
  /** SIGNUP_MAX_USERS is reached: sign-up is closed for now. */
  signupFull?: true
  /** SIGNUP_MAX_USERS or SIGNUP_PER_IP_PER_DAY is set: the sign-up form sends the bot-check fields (`website`, `formMs`, docs/adr/2516-*). */
  signupChecks?: true
  /** INSTANCE_LABEL: a label every screen shows (e.g. "Demo"). */
  instanceLabel?: string
  /** ACCOUNT_LIFETIME_DAYS: accounts created from now on are deleted this many days after sign-up. */
  accountLifetimeDays?: number
  /** DISABLED_FEATURES, sorted (names from DISABLED_FEATURE_NAMES). */
  disabledFeatures?: string[]
  /** LEGAL_DIR: terms/privacy and sign-up consent. */
  legal?: AuthModeLegalDTO
  /** The LIMIT_* values that are set. */
  limits?: AuthModeLimitsDTO
  /** WORKSPACE_RESTORE_DAYS when set: days an owner can restore a deleted workspace (absent = 30). */
  workspaceRestoreDays?: number
  /**
   * INSTANCE_NOTICE: the operator's notice, plain text (line breaks kept, no HTML, no links made from
   * it), shown on the sign-in and sign-up screens and above every app screen.
   */
  instanceNotice?: string
}

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(60),
})
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>

/**
 * PATCH /workspaces/:id — name and/or icon (docs/adr/0945-*). icon: a short emoji / text glyph,
 * null clears it. At least one field.
 */
export const renameWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    icon: z.string().trim().min(1).max(16).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.icon !== undefined, { message: 'name or icon required' })

/** DELETE /workspaces/:id — the current workspace name, typed again as confirmation (docs/adr/0910-*). */
export const deleteWorkspaceSchema = z.object({
  name: z.string().max(200),
})
export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceSchema>

/** POST /workspaces/:id/transfer — the member who becomes owner (docs/adr/0911-*). */
export const transferOwnershipSchema = z.object({
  userId: z.uuid(),
})
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>

export const memberRoleSchema = z.enum(['owner', 'admin', 'member'])

export const updateMemberSchema = z.object({
  role: memberRoleSchema,
})

export const createSnapshotSchema = z.object({
  label: z.string().trim().max(60).optional(),
})

export const joinWorkspaceSchema = z.object({
  inviteCode: z.string().trim().min(4).max(20),
})
export type JoinWorkspaceInput = z.infer<typeof joinWorkspaceSchema>

/** Add an existing user to a workspace directly */
export const addMemberSchema = z.object({
  userId: z.uuid(),
})
export type AddMemberInput = z.infer<typeof addMemberSchema>

export const pageKindSchema = z.enum(['doc', 'folder', 'canvas', 'collection'])
export type PageKind = z.infer<typeof pageKindSchema>

export const pageScopeSchema = z.enum(['shared', 'private'])
export type PageScope = z.infer<typeof pageScopeSchema>

export const createPageSchema = z.object({
  workspaceId: z.uuid(),
  parentId: z.uuid().nullish(),
  kind: pageKindSchema.optional(),
  title: z.string().max(300).optional(),
  /** Only meaningful without parentId: the section to create the root page in. Children always inherit the parent's scope */
  scope: pageScopeSchema.optional(),
  /** Create with a date property (id 'date', localized name 'Date'): the global calendar's "New page on this date" */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
export type CreatePageInput = z.infer<typeof createPageSchema>

export const updatePageSchema = z.object({
  title: z.string().max(300).optional(),
  icon: z.string().max(16).nullable().optional(),
  coverUrl: z.string().max(500).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  parentId: z.uuid().nullable().optional(),
  sortOrder: z.number().finite().optional(),
  /** Move to another section: applies to the page and all descendants. 400 if it conflicts with the new parent's scope */
  scope: pageScopeSchema.optional(),
  /** Full width (lifts the body container's max-w), stored as the 'fullWidth' property */
  fullWidth: z.boolean().optional(),
  /**
   * Update one date property (moving an item by dragging in the global calendar). id defaults to
   * 'date'. If no property with that id exists, one is added with the localized name 'Date'.
   * value=null removes it.
   */
  dateProperty: z
    .object({
      id: z.string().min(1).max(40).optional(),
      value: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
    })
    .optional(),
  /** Done mark (checked in the due view), stored as the 'done' checkbox property; false removes it */
  done: z.boolean().optional(),
})
export type UpdatePageInput = z.infer<typeof updatePageSchema>

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface UserDTO {
  id: string
  email: string
  name: string
  isAdmin: boolean
  /** /auth/me only: account origin */
  origin?: UserOrigin
  /** /auth/me only: whether the email is verified (delegated accounts are exempt → true) */
  emailVerified?: boolean
  /** /auth/me only, for admins: number of pending password reset requests */
  pendingResetRequests?: number
  /** /auth/me only: sign-in methods linked to the account (OpenID Connect, docs/adr/1161-*) */
  logins?: LinkedLoginDTO[]
  /** /auth/me only, restricted mode: when the account will be deleted (ISO; ACCOUNT_LIFETIME_DAYS). */
  expiresAt?: string
  /** /auth/me only, restricted mode: the person has not consented to the current documents (LEGAL_DIR). */
  consentRequired?: true
}

/** owner > admin > member (docs/adr/0945-*). */
export type WorkspaceRole = 'owner' | 'admin' | 'member'

export interface WorkspaceDTO {
  id: string
  name: string
  icon: string | null
  /** Owners and admins only ('' for members, and when the invite link is turned off for everyone but owners/admins). */
  inviteCode: string
  /** `guest`: not a member, sees only the pages shared with them (docs/adr/1250-*). */
  role: WorkspaceAccessRole
  /**
   * What the caller may do here, derived on the server from role + workspace settings
   * (docs/adr/0945-*). Additive: older servers omit it.
   */
  can?: WorkspaceCapabilities
  /**
   * The workspace's "require two-step verification" policy as it applies to the caller
   * (docs/adr/1112-*). Additive: older servers omit it.
   */
  twoFactor?: WorkspaceTwoFactorStatus
  /** The caller's own arrangement: group, order, archived (docs/adr/2300-*). Absent when never set. */
  listing?: WorkspaceListingDTO
}

/** A soft-deleted workspace the caller owns and can still restore (GET /workspaces/deleted). */
export interface DeletedWorkspaceDTO {
  id: string
  name: string
  icon: string | null
  deletedAt: string
  /** When housekeeping deletes it for good (deletedAt + 30 days). */
  purgeAt: string
}

/** What a workspace deletion affects — for the confirmation dialog (owner only). */
export interface WorkspaceDeletePreviewDTO {
  pages: number
  files: number
  publicLinks: number
  members: number
  restoreDays: number
}

export interface MemberDTO {
  id: string
  name: string
  email: string
  role: WorkspaceRole
  /** Current status message, null when none or cleared (docs/adr/1845-*). */
  status?: import('./memberStatus').MemberStatusDTO | null
}

/** Member search result (users who are not members yet) */
export interface MemberCandidateDTO {
  id: string
  name: string
  email: string
}

export interface PageMetaDTO {
  id: string
  workspaceId: string
  parentId: string | null
  kind: PageKind
  scope: PageScope
  title: string
  icon: string | null
  coverUrl: string | null
  aliases: string[]
  sortOrder: number
  /** Whether the body container spans the full width (doc pages; derived from the 'fullWidth' property) */
  fullWidth: boolean
  createdAt: string
  updatedAt: string
  /** Only set on trash items */
  deletedAt: string | null
  /** Present (true) only when this page carries its own edit lock; descendants inherit it (docs/adr/0970-*). */
  editLocked?: true
}

export interface FileDTO {
  id: string
  url: string
  name: string
  mime: string
  size: number
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}

// ---------------------------------------------------------------------------
// M13 — page properties · bookmarks · global tags
// ---------------------------------------------------------------------------

export const pagePropertyTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'tags',
  'url',
])
export type PagePropertyType = z.infer<typeof pagePropertyTypeSchema>

export const pagePropertySchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  type: pagePropertyTypeSchema,
  value: z.unknown().optional(),
})
export type PageProperty = z.infer<typeof pagePropertySchema>

export const updatePropertiesSchema = z.object({
  properties: z.array(pagePropertySchema).max(50),
})

export interface BookmarkDTO {
  pageId: string
  title: string
  icon: string | null
  kind: PageKind
  workspaceId: string
  sortOrder: number
}

export interface TagCountDTO {
  tag: string
  count: number
}

export interface InvitePreviewDTO {
  name: string
  icon: string | null
  memberCount: number
}

export interface SnapshotDTO {
  id: string
  label: string | null
  createdAt: string
  bytes: number
  /** Who took it (null for autosaves or a deleted user). Additive (docs/adr/0936-*). */
  author?: { id: string; name: string } | null
  /** OAuth client name when an agent (MCP) edit caused it — shown as "(via X)". Additive. */
  viaClient?: string | null
  /**
   * Set on AI step rows: the page right after one agent write (docs/adr/2180-*). `n` numbers the steps
   * of one run (consecutive steps of one client with no other version in between), from 1. Additive.
   */
  step?: SnapshotStepDTO | null
}

export interface SnapshotStepDTO {
  n: number
  /** MCP tool of the write: patch_section, patch_sections, update_page, restore_version. */
  tool: string
  mode?: string
  /** Section anchors written (at most 3; `more` = how many others). Empty = the whole body. */
  sections: string[]
  more?: number
  /** Markdown lines added / removed; absent when not counted (a very large page replaced whole). */
  added?: number
  removed?: number
  /** restore_version: the version brought back. */
  restoredFrom?: string
}

// ---------------------------------------------------------------------------
// M3 — collections (databases)
// ---------------------------------------------------------------------------

export const fieldTypeSchema = z.enum([
  'text',
  'number',
  'select',
  'multiSelect',
  'date',
  'checkbox',
  'person',
  'url',
  'relation',
  'rollup',
  /** computed from other properties of the same row (docs/adr/1823-*); never stored in props */
  'formula',
  // 0.17 (docs/adr/2140-*): stored text like url
  'email',
  'phone',
  // 0.17 automatic values: filled in from the page by the server, never stored in props, never written
  'createdTime',
  'editedTime',
  'createdBy',
  'editedBy',
  /** prefix + a number per collection (TASK-12), handed out once (docs/adr/2140-*) */
  'uniqueId',
])
export type FieldType = z.infer<typeof fieldTypeSchema>

/** select/multiSelect option color: a preset key (mapped to the palette on the web) */
export const selectOptionSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  color: z.enum(['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']),
})
export type SelectOption = z.infer<typeof selectOptionSchema>

/** relation field config — values are stored in row props as string[] of row (page) ids. */
export const relationConfigSchema = z.object({
  /** collection page whose rows can be linked (may be the same collection) */
  targetPageId: z.uuid(),
  /** two-way: the paired field on the target collection mirrors links (server keeps them in sync) */
  twoWay: z.boolean().optional(),
  /** id of the paired relation field on the target collection (set by the server) */
  pairFieldId: z.string().min(1).max(40).optional(),
  /**
   * Sub-items (docs/adr/2144-*): this relation is the collection's "Parent item" field. Only on a
   * one-way relation to the same collection; one per collection; at most one link, never a cycle.
   */
  subItems: z.boolean().optional(),
})
export type RelationConfig = z.infer<typeof relationConfigSchema>

export const rollupFnSchema = z.enum([
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'earliest',
  'latest',
  'percentChecked',
  'showUnique',
])
export type RollupFn = z.infer<typeof rollupFnSchema>

/** formula field config — computed (server and web, packages/shared/src/formula.ts), never stored. */
export const formulaConfigSchema = z.object({
  expression: z.string().max(2000),
})
export type FormulaConfig = z.infer<typeof formulaConfigSchema>

/** rollup field config — computed on the server, never stored in props. */
export const rollupConfigSchema = z.object({
  /** relation field (in this collection) to follow */
  relationFieldId: z.string().min(1).max(40),
  /** property of the target rows to aggregate; 'title' = row title */
  targetFieldId: z.string().min(1).max(40),
  fn: rollupFnSchema,
})
export type RollupConfig = z.infer<typeof rollupConfigSchema>

export const collectionFieldSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  type: fieldTypeSchema,
  options: z.array(selectOptionSchema).max(50).optional(),
  /** relation: target collection page + optional two-way pairing (see relationConfigSchema) */
  relation: relationConfigSchema.optional(),
  /** rollup: aggregate a property of the rows linked through a relation field */
  rollup: rollupConfigSchema.optional(),
  /** formula: the expression, as typed (prop("Name") reads a property; docs/adr/1823-*) */
  formula: formulaConfigSchema.optional(),
  /** uniqueId: the prefix shown before the number (docs/adr/2140-*) */
  uniqueId: uniqueIdConfigSchema.optional(),
})
export type CollectionField = z.infer<typeof collectionFieldSchema>

export const updateFieldsSchema = z.object({
  fields: z.array(collectionFieldSchema).max(200),
})

// filterOpSchema / FilterOp: ./collectionFields (the view filter tree lives there, docs/adr/2142-*)

/**
 * Table column widths a view may store (px, docs/adr/1351-*). The minimums are the table's track
 * minimums (docs/adr/1322-*): narrower than that a column would clip its own header.
 */
export const COLUMN_WIDTH = { titleMin: 240, fieldMin: 150, max: 1600 } as const

export const viewConfigSchema = z.object({
  sorts: z
    .array(z.object({ fieldId: z.string(), dir: z.enum(['asc', 'desc']) }))
    .max(5)
    .optional(),
  filters: z
    .array(
      z.object({
        fieldId: z.string(),
        op: filterOpSchema,
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      }),
    )
    .max(10)
    .optional(),
  /**
   * Filter tree with OR groups and NOT (0.17, docs/adr/2142-*). Wins over `filters` when present;
   * a plain AND list is still saved as `filters` so 0.16 clients keep applying it.
   */
  filter: viewFilterSchema.optional(),
  groupByFieldId: z.string().optional(),
  columnOrder: z.array(z.string()).max(200).optional(),
  hiddenFields: z.array(z.string()).max(200).optional(),
  /** table: width of a field's column in px, by field id; a missing field is sized by the pane */
  columnWidths: z
    .record(z.string().min(1).max(40), z.number().int().min(COLUMN_WIDTH.fieldMin).max(COLUMN_WIDTH.max))
    .refine((o) => Object.keys(o).length <= 200, { message: 'Too many column widths' })
    .optional(),
  /** table: width of the title column in px (not a field, so not in columnWidths) */
  titleWidth: z.number().int().min(COLUMN_WIDTH.titleMin).max(COLUMN_WIDTH.max).optional(),
  /** calendar view: which date field places items */
  dateFieldId: z.string().optional(),
  /** gallery: card cover source ('none' | 'cover' = row page cover | 'firstImage' = first uploaded image) */
  cardCover: z.enum(['none', 'cover', 'firstImage']).optional(),
  /** gallery: properties shown on cards (ordered) */
  cardFieldIds: z.array(z.string()).max(200).optional(),
  /** gallery: card size */
  cardSize: z.enum(['sm', 'md', 'lg']).optional(),
  /** timeline: start / end date fields and zoom level */
  startFieldId: z.string().optional(),
  endFieldId: z.string().optional(),
  zoom: z.enum(['day', 'week', 'month']).optional(),
  /** chart view: what to draw (docs/adr/1603-*); the view's own filters choose the rows */
  chart: chartSettingsSchema.optional(),
  /** form view: which properties the form asks for, in order (docs/adr/1820-*) */
  form: formSettingsSchema.optional(),
  /** table: show sub-items as a tree (default) or as flat rows (docs/adr/2144-*) */
  subItems: z.enum(['nested', 'flat']).optional(),
})
export type ViewConfig = z.infer<typeof viewConfigSchema>

export const viewTypeSchema = z.enum(['table', 'board', 'calendar', 'gallery', 'timeline', 'chart', 'form', 'list'])
export type ViewType = z.infer<typeof viewTypeSchema>

export const createViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: viewTypeSchema,
  /** initial config (additive, 0.13: create_view sets it in the same request) */
  config: viewConfigSchema.optional(),
})

export const updateViewSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  config: viewConfigSchema.optional(),
  sortOrder: z.number().finite().optional(),
})

/** Merge row properties: a null value deletes that key */
export const updatePropsSchema = z.object({
  props: z.record(z.string().max(40), z.unknown()),
})

export interface CollectionViewDTO {
  id: string
  name: string
  type: ViewType
  config: ViewConfig
  sortOrder: number
}

export interface CollectionDTO {
  pageId: string
  fields: CollectionField[]
  views: CollectionViewDTO[]
}

export interface RowDTO extends PageMetaDTO {
  props: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// M13 — inline comments · @mentions · notifications
// ---------------------------------------------------------------------------

export const createCommentSchema = z.object({
  blockId: z.string().min(1).max(100),
  body: z.string().trim().min(1).max(4000),
  /** The thread root id for a reply; omit for a new thread */
  threadId: z.uuid().optional(),
  /** User ids @mentioned in the comment body (for notifications) */
  mentionUserIds: z.array(z.uuid()).max(20).optional(),
  /** Members' agent connections the comment is handed to (docs/adr/1863-*): only their inbox gets it. */
  mentionConnections: mentionConnectionsSchema.optional(),
})
export type CreateCommentInput = z.infer<typeof createCommentSchema>

export interface CommentAuthorDTO {
  id: string | null
  name: string
}
export interface CommentDTO {
  id: string
  pageId: string
  blockId: string
  threadId: string
  author: CommentAuthorDTO
  body: string
  resolved: boolean
  createdAt: string
  /** OAuth client name when posted through MCP — shown as "<author> (via X)". Additive (docs/adr/0936-*). */
  viaClient?: string | null
}

export type NotificationType =
  | 'comment'
  | 'comment_mention'
  | 'doc_mention'
  | 'reminder'
  | 'workspace_added'
  /** A workspace webhook was disabled after repeated delivery failures (owners only). */
  | 'webhook_disabled'
  /** A backup run, restore test or remote copy failed (admins only) — docs/BACKUP.md. */
  | 'backup_failed'
  /** An owner deleted a workspace you are a member of (restorable for 30 days) — docs/adr/0910-*. */
  | 'workspace_deleted'
  // --- docs/adr/1000-* ---------------------------------------------------------------
  /** Someone replied in a comment thread you follow (started, replied in, or followed; docs/adr/1412-*). */
  | 'comment_reply'
  /** You were made the owner of a document. */
  | 'page_owner'
  /** You were put in a person cell of a collection row (task assignment). */
  | 'task_assigned'
  /** A page you follow (level "all") changed; repeated edits collapse into one unread item. */
  | 'page_update'
  /** Daily summary of AI edits under a page you asked to watch. */
  | 'agent_digest'
  /** Reserved: an approval request addressed to you (passes mute). */
  | 'approval_request'
  /** Reserved: the decision on an approval you asked for. */
  | 'approval_result'
  /** A page you own grew large while something appended to it: split it or let it split itself (docs/adr/1141-*). */
  | 'large_page'
  /** A reminder you set on an item of your Later list came due (docs/adr/1411-*). */
  | 'later_reminder'
  /** You became the owner of a workspace because its only owner deleted their account (0.22, docs/adr/2517-*). */
  | 'workspace_owner'
export interface NotificationDTO {
  id: string
  type: NotificationType
  pageId: string | null
  pageTitle: string | null
  /** Target workspace of a workspace_added notification */
  workspaceId: string | null
  workspaceName: string | null
  actorName: string | null
  read: boolean
  createdAt: string
  /** OAuth client name when an agent caused it ("Alice via Claude"). Additive (docs/adr/1000-*). */
  via?: string | null
  /** Collapsed repeats (e.g. 3 edits of a followed page). Additive. */
  count?: number
  /** Short plain excerpt (comment text, mentioning line, field name). Additive. */
  excerpt?: string | null
  /** Section anchor or block id inside the page. Additive. */
  anchor?: string | null
  /** Listed without a badge or mail (agent-written mentions, level "nothing"). Additive. */
  quiet?: boolean
  /** Handed to one of my agent connections; I see a copy (docs/adr/1863-*). Client or token name. Additive. */
  forAgent?: string | null
}

// ---------------------------------------------------------------------------
// M15 — public web sharing
// ---------------------------------------------------------------------------

/** Share status response (for the owner) */
export interface ShareStatusDTO {
  shared: boolean
  token: string | null
  /** Folder shares only: number of subpages viewable via the current link (excluding private, trashed and the folder itself) */
  exposedCount?: number
  /** When the link stops working (ISO, server clock), null = never (docs/adr/1170-*). */
  expiresAt?: string | null
  /** The link has expired: it answers "expired" until the expiry is extended or removed. */
  expired?: boolean
  /** When a scheduled link opens (ISO, server clock), null = at once (docs/adr/1844-*). */
  startsAt?: string | null
  /** Before `startsAt`: visitors get the same answer as for a link that does not exist. */
  notStarted?: boolean
  /** Visitors must enter a password (docs/adr/1171-*). The password itself is never returned. */
  hasPassword?: boolean
  /** Visitors may download the page as Markdown (docs/adr/2362-*). Off by default. */
  allowDownload?: boolean
  /**
   * The public page shows its charts as aggregates (docs/adr/2440-*). Off by default; computed as the
   * manager who turned it on (`chartsBy`, their name) while they are a member.
   */
  includeCharts?: boolean
  chartsBy?: string | null
  /**
   * Chart blocks on the page (a folder: its doc pages inside the link), absent when there are none
   * (docs/adr/2440-*, 2444-*):
   * - `total`: every chart block;
   * - `hidden`: those the public page leaves out with the link's current settings (`pending` included);
   * - `pending`: with charts on, those whose source (a database, or a query's text) was not approved when
   *   charts were turned on or last approved — added or changed since; `approveChartSources` publishes
   *   them. 0 while charts are off.
   */
  charts?: { total: number; hidden: number; pending: number }
  /** Workspace rules for new links (docs/adr/1172-*). */
  policy?: import('./shareLinks').SharePolicyDTO
}

/** Public (unauthenticated) page response */
export interface PublicPageDTO {
  title: string
  icon: string | null
  coverUrl: string | null
  /** Safe HTML rendered by the server (image URLs rewritten to public file paths) */
  html: string
  updatedAt: string
  /** The page's own "Full width" setting: the default width of the public view (docs/adr/2360-*). */
  fullWidth?: boolean
  /** The link lets visitors download this page as Markdown (`…/export.md`, docs/adr/2362-*). */
  download?: boolean
  /**
   * Charts of the page, drawn by the viewer (docs/adr/2440-*). Each one's place in `html` is the block
   * whose `data-id` is `anchor` (its title, if any) and `anchor + '-t'` (its table, the fallback).
   */
  charts?: import('./charts').PublicChartDTO[]
}

/**
 * Public folder tree node. `ref` is an opaque identifier (truncated HMAC(shareToken, pageId)); internal page ids are never exposed.
 * doc/collection can be viewed at `/s/<token>/p/<ref>`, folders are for navigation, canvas has no public view.
 */
export interface PublicTreeNodeDTO {
  ref: string
  title: string
  icon: string | null
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  children: PublicTreeNodeDTO[]
}

/** Public (unauthenticated) folder response: `GET /api/public/:token` for a folder token */
export interface PublicFolderDTO {
  kind: 'folder'
  title: string
  icon: string | null
  tree: PublicTreeNodeDTO[]
  updatedAt: string
}

// ---------------------------------------------------------------------------
// M18 — workspace-wide calendar
// ---------------------------------------------------------------------------

/**
 * Common DTO for dated items: the global calendar and the due view get them from the same server module.
 *   row   = date field value of a collection (database) row
 *   page  = a page date property (type='date' in properties)
 *   daily = a daily note titled YYYY-MM-DD
 *   task  = a checklist block with a date inside a document (page_tasks)
 */
export type DateItemKind = 'row' | 'page' | 'daily' | 'task'
export interface DateItemDTO {
  kind: DateItemKind
  pageId: string
  /** Display title; for a task, the checklist text without the date token */
  title: string
  icon: string | null
  date: string /* YYYY-MM-DD */
  done: boolean
  /** row: title of the collection it belongs to */
  collectionTitle?: string
  /** row: id of the date field the date came from · page: date property id */
  fieldId?: string
  /** row: id of the checkbox field used for done (omitted if the collection has none → no checkbox) */
  doneFieldId?: string
  /** task: checklist block id */
  blockId?: string
  /** task/page: the containing page (task) or the parent folder path "Parent / Child" */
  parentPath?: string
  /** task: title of the page containing the task */
  pageTitle?: string
}

export type CalendarEventType = DateItemKind
/** Global calendar response item: DateItemDTO + `type` (= kind) for older clients. */
export interface CalendarEventDTO extends DateItemDTO {
  type: CalendarEventType
}

/** Due view sections */
export type DueSection = 'overdue' | 'today' | 'tomorrow' | 'week' | 'next30' | 'done'
export interface DueItemDTO extends DateItemDTO {
  section: DueSection
}
export interface DueResponseDTO {
  /** Today in server local time, 'YYYY-MM-DD' (basis for the sections) */
  today: string
  items: DueItemDTO[]
  counts: Record<DueSection, number>
}

/** Edit a task inside a document (PATCH /pages/:id/tasks/:blockId) */
export const updateTaskSchema = z
  .object({
    checked: z.boolean().optional(),
    due: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .refine((v) => v.checked !== undefined || v.due !== undefined, {
    message: 'checked or due is required',
  })
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>

/** Quick add task (POST /workspaces/:id/tasks): appended as a checklist item to the workspace's tasks document */
export const quickTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type QuickTaskInput = z.infer<typeof quickTaskSchema>

// M12 page templates: see ./templates (re-exported below)

// ---------------------------------------------------------------------------
// Ink layer (pen annotations), stored separately from the body Yjs document.
// Like PDF annotations it sits on a "fixed sheet of paper", so strokes are not anchored to blocks.
// Coordinates are logical px relative to INK_CANVAS_WIDTH below; on a different screen width the
// whole layer is scaled by the same factor (like zooming a PDF).
// ---------------------------------------------------------------------------

/** Reference width of the ink coordinate system: same as the body column (max-w-4xl = 56rem). */
export const INK_CANVAS_WIDTH = 896

/** Caps on strokes per page / points per stroke (guards request size) */
export const INK_MAX_STROKES = 4000
export const INK_MAX_POINTS_PER_STROKE = 3000

/** Pen: opaque, variable width / highlighter: translucent, fixed width (drawn over text) */
export const inkToolSchema = z.enum(['pen', 'highlighter'])
export type InkTool = z.infer<typeof inkToolSchema>

export const inkStrokeSchema = z.object({
  id: z.string().min(1).max(64),
  /** Defaults to 'pen' (compatibility with old data) */
  tool: inkToolSchema.optional(),
  /** #rrggbb */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Base width (px); the actual width varies within it with pen pressure */
  size: z.number().min(0.5).max(64),
  /** [x, y, pressure, x, y, pressure, ...]: a multiple of 3 */
  points: z
    .array(z.number().finite())
    .min(3)
    .max(INK_MAX_POINTS_PER_STROKE * 3)
    .refine((p) => p.length % 3 === 0, { message: 'points must come in groups of 3 [x, y, pressure]' }),
})
export type InkStroke = z.infer<typeof inkStrokeSchema>

export const saveInkSchema = z.object({
  strokes: z.array(inkStrokeSchema).max(INK_MAX_STROKES),
})
export type SaveInkInput = z.infer<typeof saveInkSchema>

export interface InkDTO {
  pageId: string
  strokes: InkStroke[]
  updatedAt: string | null
}

/** Stroke outline geometry shared by the web ink layer and the server's PNG renderer (docs/adr/1511-*). */
export * from './inkStroke'

// Collection extensions (relations/rollups, batch rows, spreadsheet, sheets sync, iCal)
export * from './collectionExt'
export * from './templates'
export * from './rowTemplates'
export * from './csv'

// Dataview-style query language (Query block + POST /workspaces/:id/query)
export * from './query'

// Embeds, link previews, workspace webhooks
export * from './embeds'
export * from './workspaceAdmin'
export * from './shareLinks'
export * from './largePages'
export * from './pageSplit'
export * from './editLock'
export * from './notifications'
// Later list, reminders and followed threads (docs/adr/1410-* .. 1413-*)
export * from './later'

// Math (KaTeX) node names and the `$…$` rule shared by the editor and the server schema
export * from './math'
// Callout / embed / plugin block / mention configs shared with the server schema (docs/adr/1500-*)
export * from './blocks'
// Columns: the columnList / column nodes and width helpers (docs/adr/2420-*)
export * from './columns'
export * from './docSchema'

// Per-user sidebar menu order / visibility (docs/adr/1020-*)
export * from './sidebar'

// Disjoint sets (union by size + path compression): link islands, import de-duplication (docs/adr/1120-*)
export * from './unionFind'

// Connection range (OAuth grants, API tokens) and personal API tokens (docs/adr/1200-*, 1201-*)
export * from './accessTokens'
// People with access to a page tree and guests (docs/adr/1250-*)
export * from './pageAccess'
// Suggested section edits and section claims (docs/adr/1530-*, 1535-*)
export * from './suggestions'
export * from './revert'
// Chart blocks and chart views: stored format, aggregate shapes, view filters (docs/adr/1600-*)
export * from './charts'
export * from './formula'
// 0.17 field types, view filter tree, sub-items (docs/adr/2140-*, 2142-*, 2144-*)
export * from './collectionFields'
export * from './forms'
// Page verification with an expiry (docs/adr/1840-*)
export * from './verification'
// Member status with an automatic clear time (docs/adr/1845-*)
export * from './memberStatus'
// Slack app per workspace: channel notifications, /inkling search, link unfurls (docs/adr/1800-*)
export * from './slack'
// Team agents: board, hand-offs and assignments to a person's connection (docs/adr/1860-*)
export * from './teamAgents'
// Suggest-only connections after flagged content (docs/adr/2040-*)
export * from './taint'
// Agent connection tokens: hand-made agent connections for /mcp (docs/adr/2060-*)
export * from './agentTokens'
// Web clipper: POST /api/clip and the /clip screen (docs/adr/2260-*)
export * from './clip'
// Web push: settings, devices, subscribe input, payload (docs/adr/2220-*)
export * from './push'
// Buttons and database automations (docs/adr/2240-*)
export * from './automations'
// A person's own workspace list: groups and archived workspaces (docs/adr/2300-*)
export * from './workspaceListing'
// Onboarding: intro, Getting started checklist, sample page (docs/adr/2380-*)
export * from './onboarding'
// Restricted mode (0.22): feature names, error codes, limit DTOs (docs/adr/2500-*)
export * from './limits'
