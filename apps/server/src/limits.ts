import './env'
import { DISABLED_FEATURE_NAMES, isDisabledFeatureName, type DisabledFeatureName } from '@inkling/shared'

/**
 * Restricted mode settings (0.22, docs/adr/2500-*): limits, features turned off, sign-in IDs, sign-up
 * consent, account lifetime. Read once at import, like agentUploads.ts.
 *
 * Inert by default: with none of these variables set (or set to an empty string) every value is
 * "no limit" / off and the server behaves as 0.21.1. A value that cannot be taken as written (not a
 * number, out of range, an unknown feature name) refuses to boot with the reason: these settings
 * guard data and disk, so guessing would be worse than stopping.
 *
 *   LOGIN_ID_MODE               email (default) | username
 *   SIGNUP_MAX_USERS            integer ≥ 1      accounts in total (users rows, admins included)
 *   SIGNUP_PER_IP_PER_DAY       integer ≥ 1      accounts one IP can create in 24 hours
 *   ACCOUNT_LIFETIME_DAYS       integer ≥ 1      accounts created from now on are deleted after N days
 *   ACCOUNT_LIFETIME_DRY_RUN    1 | 0            log what expiry would delete, delete nothing
 *   LIMIT_WORKSPACES_PER_USER   integer ≥ 1      workspaces a person owns (deleted but restorable count)
 *   LIMIT_MEMBERS_PER_WORKSPACE integer ≥ 1      members of a workspace (owner included, guests not)
 *   LIMIT_PAGES_PER_WORKSPACE   integer ≥ 1      page rows of a workspace (trash included)
 *   LIMIT_FILE_MB               number > 0, ≤ 25 one browser upload
 *   LIMIT_WORKSPACE_STORAGE_MB  number > 0       files + page bodies + version history of a workspace
 *   LIMIT_VERSIONS_PER_PAGE     integer 1..50    version history per page (can only lower the 50)
 *   DISABLED_FEATURES           comma list       names from DISABLED_FEATURE_NAMES
 *   WORKSPACE_RESTORE_DAYS      integer ≥ 1      days a deleted workspace can be restored (default 30)
 *   LEGAL_DIR                   path             terms, privacy and sign-up consent texts
 *   INSTANCE_LABEL              ≤ 20 characters  a label every screen shows
 *
 * This module only reads the settings. Enforcing them is done where things are created.
 */

export type LoginIdMode = 'email' | 'username'

export interface Limits {
  loginIdMode: LoginIdMode
  /** null = no limit (the same for every number below). */
  signupMaxUsers: number | null
  signupPerIpPerDay: number | null
  accountLifetimeDays: number | null
  /** ACCOUNT_LIFETIME_DRY_RUN=1 */
  accountLifetimeDryRun: boolean
  workspacesPerUser: number | null
  membersPerWorkspace: number | null
  pagesPerWorkspace: number | null
  /** MB, may be fractional (bytes: mbToBytes). */
  fileMb: number | null
  /** MB, may be fractional (bytes: mbToBytes). */
  workspaceStorageMb: number | null
  versionsPerPage: number | null
  /** Sorted, without duplicates. */
  disabledFeatures: DisabledFeatureName[]
  /** Always a number: 30 when unset. */
  workspaceRestoreDays: number
  legalDir: string | null
  instanceLabel: string | null
  /** Boot warnings for settings that are valid but do nothing as combined. */
  warnings: string[]
}

/** The browser upload cap before 0.22; LIMIT_FILE_MB can only lower it. */
export const FILE_MB_CEILING = 25
/** The version history budget per page before 0.22 (snapshotStore MAX_SNAPSHOTS_PER_PAGE). */
export const VERSIONS_PER_PAGE_CEILING = 50
export const DEFAULT_WORKSPACE_RESTORE_DAYS = 30
export const INSTANCE_LABEL_MAX = 20

const MB = 1024 * 1024
export const mbToBytes = (mb: number): number => Math.floor(mb * MB)

/** A setting that refuses to boot. The message names the variable and the reason. */
export class LimitsConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LimitsConfigError'
  }
}

type Env = Record<string, string | undefined>

function raw(e: Env, name: string): string | null {
  const v = e[name]?.trim()
  return v ? v : null
}

function int(e: Env, name: string, opts: { max?: number } = {}): number | null {
  const v = raw(e, name)
  if (v === null) return null
  if (!/^\d+$/.test(v)) throw new LimitsConfigError(`${name}=${v} is not a whole number ≥ 1`)
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 1) throw new LimitsConfigError(`${name}=${v} is not a whole number ≥ 1`)
  if (opts.max !== undefined && n > opts.max) throw new LimitsConfigError(`${name}=${v} is above ${opts.max}`)
  return n
}

function megabytes(e: Env, name: string, opts: { max?: number } = {}): number | null {
  const v = raw(e, name)
  if (v === null) return null
  // plain decimal only: no exponent, hex or Infinity
  if (!/^\d+(\.\d+)?$/.test(v)) throw new LimitsConfigError(`${name}=${v} is not a number of megabytes > 0`)
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new LimitsConfigError(`${name}=${v} is not a number of megabytes > 0`)
  if (mbToBytes(n) < 1) throw new LimitsConfigError(`${name}=${v} is less than one byte`)
  if (opts.max !== undefined && n > opts.max) throw new LimitsConfigError(`${name}=${v} is above ${opts.max}`)
  return n
}

/** Parse every restricted-mode variable (pure, for tests). Throws LimitsConfigError on a bad value. */
export function parseLimitsEnv(e: Env): Limits {
  const warnings: string[] = []

  const modeRaw = raw(e, 'LOGIN_ID_MODE')
  let loginIdMode: LoginIdMode = 'email'
  if (modeRaw !== null) {
    const m = modeRaw.toLowerCase()
    if (m !== 'email' && m !== 'username') throw new LimitsConfigError(`LOGIN_ID_MODE=${modeRaw} is not email or username`)
    loginIdMode = m
  }

  const dryRaw = raw(e, 'ACCOUNT_LIFETIME_DRY_RUN')
  if (dryRaw !== null && dryRaw !== '1' && dryRaw !== '0') {
    throw new LimitsConfigError(`ACCOUNT_LIFETIME_DRY_RUN=${dryRaw} is not 1 or 0`)
  }
  const accountLifetimeDryRun = dryRaw === '1'

  const disabled = new Set<DisabledFeatureName>()
  const featuresRaw = raw(e, 'DISABLED_FEATURES')
  if (featuresRaw !== null) {
    const unknown: string[] = []
    for (const name of featuresRaw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (isDisabledFeatureName(name)) disabled.add(name)
      else unknown.push(name)
    }
    if (unknown.length > 0) {
      throw new LimitsConfigError(
        `DISABLED_FEATURES has unknown name(s): ${unknown.join(', ')} (known: ${DISABLED_FEATURE_NAMES.join(', ')})`,
      )
    }
  }

  const label = raw(e, 'INSTANCE_LABEL')
  if (label !== null) {
    if ([...label].length > INSTANCE_LABEL_MAX) throw new LimitsConfigError(`INSTANCE_LABEL is longer than ${INSTANCE_LABEL_MAX} characters`)
    // a label is shown as text on every screen: no line breaks or control characters
    if (/\p{Cc}/u.test(label)) throw new LimitsConfigError('INSTANCE_LABEL contains a control character')
  }

  const limits: Limits = {
    loginIdMode,
    signupMaxUsers: int(e, 'SIGNUP_MAX_USERS'),
    signupPerIpPerDay: int(e, 'SIGNUP_PER_IP_PER_DAY'),
    accountLifetimeDays: int(e, 'ACCOUNT_LIFETIME_DAYS'),
    accountLifetimeDryRun,
    workspacesPerUser: int(e, 'LIMIT_WORKSPACES_PER_USER'),
    membersPerWorkspace: int(e, 'LIMIT_MEMBERS_PER_WORKSPACE'),
    pagesPerWorkspace: int(e, 'LIMIT_PAGES_PER_WORKSPACE'),
    fileMb: megabytes(e, 'LIMIT_FILE_MB', { max: FILE_MB_CEILING }),
    workspaceStorageMb: megabytes(e, 'LIMIT_WORKSPACE_STORAGE_MB'),
    versionsPerPage: int(e, 'LIMIT_VERSIONS_PER_PAGE', { max: VERSIONS_PER_PAGE_CEILING }),
    disabledFeatures: [...disabled].sort(),
    workspaceRestoreDays: int(e, 'WORKSPACE_RESTORE_DAYS') ?? DEFAULT_WORKSPACE_RESTORE_DAYS,
    legalDir: raw(e, 'LEGAL_DIR'),
    instanceLabel: label,
    warnings,
  }
  if (accountLifetimeDryRun && limits.accountLifetimeDays === null) {
    warnings.push('ACCOUNT_LIFETIME_DRY_RUN=1 does nothing without ACCOUNT_LIFETIME_DAYS')
  }
  return limits
}

/** The other settings the boot check compares against (env.ts / oidc.ts / mail). */
export interface LimitsBootContext {
  delegated: boolean
  oidc: boolean
  mail: boolean
}

/**
 * Settings that contradict each other (pure, for tests). Throws LimitsConfigError.
 * LOGIN_ID_MODE=username: an ID is no address (no mail can reach it) and "input without @ is a
 * delegated account ID" would read it as one, so delegated sign-in, OIDC and SMTP must be off and
 * password reset (whose fallback is mail or the admin queue by email) must be in DISABLED_FEATURES.
 */
export function assertLimitsCompatible(l: Limits, ctx: LimitsBootContext): void {
  if (l.loginIdMode !== 'username') return
  const conflicts: string[] = []
  if (ctx.delegated) conflicts.push('DELEGATED_AUTH_URL is set')
  if (ctx.oidc) conflicts.push('OIDC sign-in is configured')
  if (ctx.mail) conflicts.push('SMTP mail is configured')
  if (!l.disabledFeatures.includes('password-reset')) conflicts.push('DISABLED_FEATURES does not include password-reset')
  if (conflicts.length > 0) {
    throw new LimitsConfigError(
      `LOGIN_ID_MODE=username needs delegated sign-in, OIDC and mail off and password-reset disabled: ${conflicts.join('; ')}`,
    )
  }
}

/**
 * The boot lines: one for the limits that are on, one for the features that are off (values only,
 * nothing secret). Empty when nothing is set.
 */
export function limitsBootLines(l: Limits): string[] {
  const on: string[] = []
  if (l.loginIdMode === 'username') on.push('sign-in IDs instead of emails')
  if (l.signupMaxUsers !== null) on.push(`${l.signupMaxUsers} accounts in total`)
  if (l.signupPerIpPerDay !== null) on.push(`${l.signupPerIpPerDay} sign-ups per IP per day`)
  if (l.workspacesPerUser !== null) on.push(`${l.workspacesPerUser} owned workspaces per person`)
  if (l.membersPerWorkspace !== null) on.push(`${l.membersPerWorkspace} members per workspace`)
  if (l.pagesPerWorkspace !== null) on.push(`${l.pagesPerWorkspace} pages per workspace`)
  if (l.fileMb !== null) on.push(`${l.fileMb} MB per uploaded file`)
  if (l.workspaceStorageMb !== null) on.push(`${l.workspaceStorageMb} MB of storage per workspace`)
  if (l.versionsPerPage !== null) on.push(`${l.versionsPerPage} versions per page`)
  if (l.workspaceRestoreDays !== DEFAULT_WORKSPACE_RESTORE_DAYS) on.push(`deleted workspaces restorable for ${l.workspaceRestoreDays} days`)
  if (l.legalDir !== null) on.push('sign-up consent (LEGAL_DIR)')
  if (l.instanceLabel !== null) on.push(`instance label "${l.instanceLabel}"`)
  const lines: string[] = []
  if (on.length > 0) lines.push(`restricted mode: ${on.join(', ')}`)
  if (l.disabledFeatures.length > 0) lines.push(`features turned off: ${l.disabledFeatures.join(', ')}`)
  return lines
}

/** The account-lifetime boot line; `existing` = accounts without an expiry date (never affected). */
export function accountLifetimeLine(l: Limits, existing: number): string | null {
  if (l.accountLifetimeDays === null) return null
  const dry = l.accountLifetimeDryRun ? ' (dry run: expired accounts are only logged, nothing is deleted)' : ''
  return `accounts created from now on expire after ${l.accountLifetimeDays} days; ${existing} existing accounts are not affected${dry}`
}

/**
 * The process's settings. A bad value throws here, at import, so the server never starts with a
 * setting it could not read. Mutable only through setLimitsForTests.
 */
export const limits: Limits = parseLimitsEnv(process.env)

/** Tests change settings without restarting; returns the function that puts the old values back. */
export function setLimitsForTests(partial: Partial<Limits>): () => void {
  const before = { ...limits, disabledFeatures: [...limits.disabledFeatures], warnings: [...limits.warnings] }
  Object.assign(limits, partial)
  return () => {
    Object.assign(limits, before)
  }
}

/** A feature the operator turned off with DISABLED_FEATURES. */
export function isFeatureDisabled(name: DisabledFeatureName): boolean {
  return limits.disabledFeatures.length > 0 && limits.disabledFeatures.includes(name)
}

/** Days a deleted workspace stays restorable (WORKSPACE_RESTORE_DAYS, default 30). */
export function workspaceRestoreDays(): number {
  return limits.workspaceRestoreDays
}
