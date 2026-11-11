/**
 * Restricted mode (0.22, docs/adr/2500-*): names the server and the web app share.
 *
 * Every setting is off unless the operator sets it; with none set the server behaves as 0.21.1.
 */

/**
 * Features an operator can turn off for the whole server with DISABLED_FEATURES (comma list).
 * An unknown name refuses to boot. `GET /api/auth/mode` lists the ones that are off
 * (`disabledFeatures`, sorted) so the web app hides their menus.
 */
export const DISABLED_FEATURE_NAMES = [
  'public-links',
  'public-forms',
  'webhooks',
  'slack',
  'link-preview',
  'web-clipper',
  'ical',
  'notion-import',
  'web-push',
  'password-reset',
  'email-invites',
  'automations-webhooks',
  'oauth-cimd',
  'embeds',
  'member-direct-add',
] as const

export type DisabledFeatureName = (typeof DISABLED_FEATURE_NAMES)[number]

export function isDisabledFeatureName(s: string): s is DisabledFeatureName {
  return (DISABLED_FEATURE_NAMES as readonly string[]).includes(s)
}

/**
 * Error codes of restricted mode, with their HTTP status. Limit errors carry `{ limit, used }`
 * next to code and message (AppError's `details`), and the web app's `errors.<CODE>` text can show
 * them as `{limit}` and `{used}`.
 */
export const RESTRICTED_MODE_ERRORS = {
  SIGNUP_FULL: 403,
  SIGNUP_IP_LIMIT: 429,
  LOGIN_ID_INVALID: 400,
  LOGIN_ID_TAKEN: 409,
  /** 400 on signup (missing item or old version), 403 on any other request before consenting. */
  CONSENT_REQUIRED: 403,
  FEATURE_DISABLED: 404,
  LIMIT_WORKSPACES: 403,
  LIMIT_MEMBERS: 403,
  LIMIT_PAGES: 403,
  LIMIT_STORAGE: 413,
  LIMIT_FILE: 413,
  LAST_ADMIN: 409,
  REAUTH_REQUIRED: 401,
} as const

export type RestrictedModeErrorCode = keyof typeof RESTRICTED_MODE_ERRORS

/** `GET /api/auth/mode` → `limits`: only the limits the operator set. */
export interface AuthModeLimitsDTO {
  workspacesPerUser?: number
  membersPerWorkspace?: number
  pagesPerWorkspace?: number
  fileMb?: number
  workspaceStorageMb?: number
}

/** `GET /api/auth/mode` → `legal`: the document version and which documents exist (LEGAL_DIR). */
export interface AuthModeLegalDTO {
  version: string
  docs: ('terms' | 'privacy')[]
}

/**
 * `GET /api/workspaces/:id/usage` (members): what the workspace uses, and the limits that apply
 * (absent = no limit). Answers even without limits.
 */
export interface WorkspaceUsageDTO {
  members: number
  pages: number
  storageBytes: number
  fileBytes: number
  limits: { members?: number; pages?: number; storageBytes?: number }
}
