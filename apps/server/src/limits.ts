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
 *   LIMIT_TRASH_DAYS            integer ≥ 7      cap on the days trashed pages are kept (contract §13)
 *   INSTANCE_NOTICE             ≤ 500 characters an operator notice on the sign-in, sign-up and app screens
 *   INSTANCE_CONTACT            email | https URL a "Contact" link to the operator (≤ 300 characters)
 *   SIGNUP_PER_HOUR             integer ≥ 1      accounts the whole server makes in one hour (contract §14)
 *   OAUTH_UNUSED_CLIENT_HOURS   integer ≥ 1      dynamic OAuth clients never used are deleted this long after registering
 *   OAUTH_UNUSED_CLIENT_MAX     integer ≥ 1      cap on dynamic OAuth clients never used (oldest go first)
 *   LIMIT_WORKSPACES_TOTAL      integer ≥ 1      workspaces on the whole server, deleted-but-restorable included (contract §14)
 *   LIMIT_INSTANCE_STORAGE_MB   number > 0       fuse: database size + upload folder; at it the server is read-only (contract §14)
 *   TRIAL_ACCOUNTS              1 | 0            "Try without an account": one-click trial accounts (docs/adr/2555-*)
 *   TRIAL_LIFETIME_HOURS        integer 1..168   hours a trial account lives (default 24)
 *   TRIAL_MAX_ACCOUNTS          integer ≥ 1      trial accounts at once, expired ones not yet deleted included (default 30)
 *   TRIAL_PER_IP_PER_DAY        integer ≥ 1      trial accounts one address can make in 24 hours (default 3)
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
  /**
   * LIMIT_TRASH_DAYS (integration, docs/adr/2525-*): pages stay in the trash at most this many days,
   * min(workspace setting, this). Absent (not even an undefined key) when unset, so a server without it
   * compares equal to the 0.21.1-shaped settings object.
   */
  trashDays?: number
  /** INSTANCE_NOTICE (docs/adr/2526-*): plain text, line breaks kept. Absent when unset. */
  instanceNotice?: string
  /** INSTANCE_CONTACT (docs/adr/2554-*): the link's href, `mailto:…` or `https://…`. Absent when unset. */
  instanceContact?: string
  /** SIGNUP_PER_HOUR (security fix, docs/adr/2537-*): accounts per hour on the whole server. Absent when unset. */
  signupPerHour?: number
  /** OAUTH_UNUSED_CLIENT_HOURS (docs/adr/2536-*): never-used dynamic clients go after this many hours. Absent when unset. */
  oauthUnusedClientHours?: number
  /** OAUTH_UNUSED_CLIENT_MAX (docs/adr/2536-*): cap on never-used dynamic clients. Absent when unset. */
  oauthUnusedClientMax?: number
  /**
   * LIMIT_WORKSPACES_TOTAL (contract §14): workspaces on the whole server, live and deleted-but-restorable.
   * Absent when unset (like trashDays).
   */
  workspacesTotal?: number
  /**
   * LIMIT_INSTANCE_STORAGE_MB (contract §14): the instance storage fuse (quota/instance.ts), in MB (may be
   * fractional). Absent when unset.
   */
  instanceStorageMb?: number
  /**
   * TRIAL_ACCOUNTS=1 (docs/adr/2555-*): the trial settings, defaults filled in. Absent while off (the
   * other three variables alone do nothing), so a server without it compares equal to the 0.22 object.
   */
  trial?: TrialLimits
  /** Boot warnings for settings that are valid but do nothing as combined. */
  warnings: string[]
}

/** The browser upload cap before 0.22; LIMIT_FILE_MB can only lower it. */
export const FILE_MB_CEILING = 25
/** The version history budget per page before 0.22 (snapshotStore MAX_SNAPSHOTS_PER_PAGE). */
export const VERSIONS_PER_PAGE_CEILING = 50
export const DEFAULT_WORKSPACE_RESTORE_DAYS = 30
export const INSTANCE_LABEL_MAX = 20
/** The shortest trash retention a workspace can choose (TRASH_RETENTION_DAYS.min); the cap cannot go below it. */
export const TRASH_DAYS_MIN = 7
export const INSTANCE_NOTICE_MAX = 500
export const INSTANCE_CONTACT_MAX = 300
export const TRIAL_LIFETIME_HOURS_MAX = 168
export const TRIAL_DEFAULTS = { lifetimeHours: 24, maxAccounts: 30, perIpPerDay: 3 } as const

export interface TrialLimits {
  lifetimeHours: number
  maxAccounts: number
  perIpPerDay: number
}

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

// An address the "Contact" link can carry as mailto: without escaping: a dot-atom local part without
// # % & / ? (a URL would read them), a domain of letters, digits and hyphens with at least one dot.
// No query (?subject=…), no second address.
const CONTACT_EMAIL = /^[A-Za-z0-9!$'*+=^_`{|}~-]+(\.[A-Za-z0-9!$'*+=^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

/**
 * INSTANCE_CONTACT (pure, for tests): the operator's contact as the href of a link. `raw` is the
 * trimmed value or null. Returns null when unset, `mailto:<address>` for an email address (with or
 * without `mailto:`), the URL as written for `https://…`. Anything else throws LimitsConfigError:
 * other schemes (http:, javascript:, …), spaces or control characters, more than 300 characters.
 */
export function parseInstanceContact(raw: string | null): string | null {
  if (raw === null) return null
  if ([...raw].length > INSTANCE_CONTACT_MAX) throw new LimitsConfigError(`INSTANCE_CONTACT is longer than ${INSTANCE_CONTACT_MAX} characters`)
  if (/[\s\p{Cc}]/u.test(raw)) throw new LimitsConfigError('INSTANCE_CONTACT contains a space or a control character')
  if (/^https:\/\//i.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      throw new LimitsConfigError('INSTANCE_CONTACT is not a valid https URL')
    }
    if (u.protocol !== 'https:' || u.hostname === '') throw new LimitsConfigError('INSTANCE_CONTACT is not a valid https URL')
    if (u.username !== '' || u.password !== '') throw new LimitsConfigError('INSTANCE_CONTACT has a user name or password in the URL')
    return raw
  }
  const address = /^mailto:/i.test(raw) ? raw.slice('mailto:'.length) : raw
  if (CONTACT_EMAIL.test(address)) return `mailto:${address}`
  throw new LimitsConfigError('INSTANCE_CONTACT is neither an email address nor an https:// URL')
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

  const trashDays = int(e, 'LIMIT_TRASH_DAYS')
  if (trashDays !== null && trashDays < TRASH_DAYS_MIN) {
    throw new LimitsConfigError(`LIMIT_TRASH_DAYS=${trashDays} is below ${TRASH_DAYS_MIN} (the shortest trash retention a workspace can have)`)
  }

  // A notice may span lines (\n, or \r\n from a file edited on Windows); any other control character
  // (tab, escape, NUL, …) refuses to boot. Shown as text, never as HTML or with links made from it.
  const noticeRaw = raw(e, 'INSTANCE_NOTICE')
  let instanceNotice: string | null = null
  if (noticeRaw !== null) {
    const n = noticeRaw.replace(/\r\n?/g, '\n')
    if ([...n].length > INSTANCE_NOTICE_MAX) throw new LimitsConfigError(`INSTANCE_NOTICE is longer than ${INSTANCE_NOTICE_MAX} characters`)
    if (/[^\P{Cc}\n]/u.test(n)) throw new LimitsConfigError('INSTANCE_NOTICE contains a control character other than a line break')
    instanceNotice = n
  }

  const instanceContact = parseInstanceContact(raw(e, 'INSTANCE_CONTACT'))

  const signupPerHour = int(e, 'SIGNUP_PER_HOUR')
  const oauthUnusedClientHours = int(e, 'OAUTH_UNUSED_CLIENT_HOURS')
  const oauthUnusedClientMax = int(e, 'OAUTH_UNUSED_CLIENT_MAX')
  const workspacesTotal = int(e, 'LIMIT_WORKSPACES_TOTAL')
  const instanceStorageMb = megabytes(e, 'LIMIT_INSTANCE_STORAGE_MB')

  // TRIAL_*: the numbers are checked even while TRIAL_ACCOUNTS is off, so turning it on later cannot
  // be the moment a typo stops the server.
  const trialRaw = raw(e, 'TRIAL_ACCOUNTS')
  if (trialRaw !== null && trialRaw !== '1' && trialRaw !== '0') throw new LimitsConfigError(`TRIAL_ACCOUNTS=${trialRaw} is not 1 or 0`)
  const trialHours = int(e, 'TRIAL_LIFETIME_HOURS', { max: TRIAL_LIFETIME_HOURS_MAX })
  const trialMax = int(e, 'TRIAL_MAX_ACCOUNTS')
  const trialPerIp = int(e, 'TRIAL_PER_IP_PER_DAY')
  const trial: TrialLimits | null =
    trialRaw === '1'
      ? {
          lifetimeHours: trialHours ?? TRIAL_DEFAULTS.lifetimeHours,
          maxAccounts: trialMax ?? TRIAL_DEFAULTS.maxAccounts,
          perIpPerDay: trialPerIp ?? TRIAL_DEFAULTS.perIpPerDay,
        }
      : null

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
    ...(trashDays !== null ? { trashDays } : {}),
    ...(instanceNotice !== null ? { instanceNotice } : {}),
    ...(instanceContact !== null ? { instanceContact } : {}),
    ...(signupPerHour !== null ? { signupPerHour } : {}),
    ...(oauthUnusedClientHours !== null ? { oauthUnusedClientHours } : {}),
    ...(oauthUnusedClientMax !== null ? { oauthUnusedClientMax } : {}),
    ...(workspacesTotal !== null ? { workspacesTotal } : {}),
    ...(instanceStorageMb !== null ? { instanceStorageMb } : {}),
    ...(trial !== null ? { trial } : {}),
    warnings,
  }
  if (accountLifetimeDryRun && limits.accountLifetimeDays === null) {
    warnings.push('ACCOUNT_LIFETIME_DRY_RUN=1 does nothing without ACCOUNT_LIFETIME_DAYS')
  }
  if (trial === null && (trialHours !== null || trialMax !== null || trialPerIp !== null)) {
    warnings.push('TRIAL_LIFETIME_HOURS, TRIAL_MAX_ACCOUNTS and TRIAL_PER_IP_PER_DAY do nothing without TRIAL_ACCOUNTS=1')
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
  if (l.trashDays !== undefined) on.push(`trash kept at most ${l.trashDays} days`)
  if (l.instanceNotice !== undefined) on.push(`instance notice (${[...l.instanceNotice].length} characters)`)
  if (l.instanceContact !== undefined) on.push('contact link')
  if (l.signupPerHour !== undefined) on.push(`${l.signupPerHour} sign-ups per hour`)
  if (l.oauthUnusedClientHours !== undefined) on.push(`unused OAuth clients deleted after ${l.oauthUnusedClientHours} hours`)
  if (l.oauthUnusedClientMax !== undefined) on.push(`at most ${l.oauthUnusedClientMax} unused OAuth clients`)
  if (l.workspacesTotal !== undefined) on.push(`${l.workspacesTotal} workspaces on the server`)
  if (l.instanceStorageMb !== undefined) on.push(`instance storage fuse at ${l.instanceStorageMb} MB`)
  if (l.trial !== undefined) on.push(`trial accounts (${l.trial.maxAccounts} at once, ${l.trial.lifetimeHours} hours each, ${l.trial.perIpPerDay} per IP per day)`)
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
    // the optional settings (trashDays, instanceNotice, …) are absent when unset: drop a key the
    // partial added, so "unset" comes back as no key rather than a stale value
    for (const k of Object.keys(limits) as (keyof Limits)[]) if (!(k in before)) delete limits[k]
    Object.assign(limits, before)
  }
}

/**
 * "Restricted sign-up" (contract §13): any of the settings meant for a server open to strangers. While
 * such a server has no admin, only the setup code signs up (403 SETUP_REQUIRED, docs/adr/2527-*), so
 * the first stranger never becomes its admin.
 */
export function restrictedSignup(): boolean {
  return (
    limits.signupMaxUsers !== null ||
    limits.signupPerIpPerDay !== null ||
    limits.accountLifetimeDays !== null ||
    limits.loginIdMode === 'username'
  )
}

/** LIMIT_TRASH_DAYS applied to a workspace's own trash retention (contract §13, docs/adr/2525-*). */
export function effectiveTrashDays(workspaceDays: number): number {
  const cap = limits.trashDays
  return cap !== undefined && cap < workspaceDays ? cap : workspaceDays
}

/** A feature the operator turned off with DISABLED_FEATURES. */
export function isFeatureDisabled(name: DisabledFeatureName): boolean {
  return limits.disabledFeatures.length > 0 && limits.disabledFeatures.includes(name)
}

/** Days a deleted workspace stays restorable (WORKSPACE_RESTORE_DAYS, default 30). */
export function workspaceRestoreDays(): number {
  return limits.workspaceRestoreDays
}
