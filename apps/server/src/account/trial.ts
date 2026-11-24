import { randomBytes, randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TRIAL_EMAIL_SUFFIX, type RegisterInput, type TrialModeDTO, type UserDTO } from '@inkling/shared'
import { createSession, getSessionUser, hashPassword, SESSION_COOKIE, setSessionCookie } from '../auth'
import { db } from '../db/index'
import { users, workspaceMembers, workspaces } from '../db/schema'
import { AppError } from '../errors'
import { generateInviteCodeColumns } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import { activeLegal } from '../legal/consent'
import { limits, TRIAL_DEFAULTS } from '../limits'
import { createSample, onboardingEnabled } from '../onboarding/state'
import type { Tx } from '../pageTree'
import { isInstanceFull } from '../quota/instance'
import { workspacesTotalReached } from '../quota/room'
import type { RequestGate } from '../requestGates'
import { runBeforeSignup, runOnSignup, type SignupContext } from '../signupHooks'
import { deleteAccount, type DeleteAccountResult } from './deletion'

/**
 * Trial accounts (TRIAL_ACCOUNTS, docs/adr/2555-*): "Try without an account" on the sign-in and
 * sign-up screens makes an account, its workspace and the sample page in one click and signs the
 * browser in.
 *
 * What a trial account is:
 *   - users.trial = true, an address in the reserved domain `@trial.invalid` (also with
 *     LOGIN_ID_MODE=username: a sign-in ID has no '@', so no ID can ever equal it), a password hash of
 *     32 random bytes nobody keeps. routes/auth.ts refuses that domain for sign-up, sign-in and password
 *     reset; mail.ts sends nothing to it. Never an admin: refused (SETUP_REQUIRED) while the server
 *     has none, and the trial path never calls the first-account promotion.
 *   - expires_at = now() + TRIAL_LIFETIME_HOURS. expireTrialAccounts (hourly) deletes it once that
 *     passes, whatever ACCOUNT_LIFETIME_DAYS and its dry run say and also after TRIAL_ACCOUNTS is turned
 *     off; createTrialAccount first deletes up to QUICK_RECLAIM expired ones so a seat is not held an
 *     hour.
 *   - its workspace starts with the invite link off, and trialGate refuses it the routes of
 *     TRIAL_RESTRICTED_ROUTES (403 TRIAL_RESTRICTED): joining or bringing people in, anything that
 *     publishes to the web, webhooks and Slack, a second workspace, changing how the account signs in.
 *
 * Limits: TRIAL_MAX_ACCOUNTS counted under a lock in the account's transaction (expired rows not yet
 * deleted included), TRIAL_PER_IP_PER_DAY and the shared SIGNUP_PER_HOUR (account/signupGuards.ts),
 * the bot checks always. Trial accounts do not count toward SIGNUP_MAX_USERS.
 */

/** Advisory lock key of TRIAL_MAX_ACCOUNTS (beside signupGuards' 4_651_202 and 4_651_203). */
const TRIAL_CAP_LOCK = 4_651_204
/** Expired trial accounts a new one deletes first. */
export const QUICK_RECLAIM = 3
/** Trial accounts the hourly job deletes per run. */
export const TRIAL_EXPIRY_BATCH = 50

export function trialOn(): boolean {
  return limits.trial !== undefined
}

function trialHours(): number {
  return limits.trial?.lifetimeHours ?? TRIAL_DEFAULTS.lifetimeHours
}

const trialOff = () => new AppError(404, 'TRIAL_OFF', 'This server has no trial accounts')
const trialFull = () => new AppError(403, 'TRIAL_FULL', 'All trial seats are taken right now. Sign up and you can start at once.')
const needsConsent = () =>
  new AppError(403, 'TRIAL_NEEDS_CONSENT', 'This server asks new accounts to agree to its terms. Sign up instead.')
const setupRequired = () =>
  new AppError(403, 'SETUP_REQUIRED', 'This server has no operator account yet. The operator signs up first with the setup link from the server log.')
const alreadySignedIn = () => new AppError(409, 'ALREADY_SIGNED_IN', 'You are already signed in. Sign out first to try a trial account.')
export const trialRestricted = () => new AppError(403, 'TRIAL_RESTRICTED', "Trial accounts can't do this. Sign up to use it.")

/** `trial-<uuid>@trial.invalid` (users.email; never shown as an address anyone can write to). */
export function trialEmail(): string {
  return `trial-${randomUUID()}${TRIAL_EMAIL_SUFFIX}`
}

/** "Trial 4F2A" / "체험 4F2A": four hex digits so two trial people in one place can tell themselves apart. */
export function trialName(locale: Locale, tag: string = randomBytes(2).toString('hex').toUpperCase()): string {
  return locale === 'ko' ? `체험 ${tag}` : `Trial ${tag}`
}

/** The sign-up texts have tick boxes: a click cannot agree to them, so trial accounts are off. */
export function trialNeedsConsent(): boolean {
  const b = activeLegal()
  return !!b && b.items.length > 0
}

async function anyAdmin(exec: Pick<Tx, 'execute'>): Promise<boolean> {
  const r = (await exec.execute(sql`SELECT 1 FROM users WHERE is_admin LIMIT 1`)) as unknown as unknown[]
  return r.length > 0
}

async function trialCounts(): Promise<{ total: number; expired: number }> {
  const [r] = (await db.execute(sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE expires_at < now())::int AS expired FROM users WHERE trial
  `)) as unknown as { total: number; expired: number }[]
  return { total: Number(r?.total ?? 0), expired: Number(r?.expired ?? 0) }
}

/**
 * GET /auth/mode `trial` (only while TRIAL_ACCOUNTS=1): whether the button can work now. A seat held by
 * an expired account that the next click deletes first (QUICK_RECLAIM) counts as free.
 */
export async function trialAvailability(): Promise<TrialModeDTO> {
  const hours = trialHours()
  if (!(await anyAdmin(db))) return { available: false, reason: 'setup', hours }
  if (trialNeedsConsent()) return { available: false, reason: 'consent', hours }
  const max = limits.trial?.maxAccounts ?? TRIAL_DEFAULTS.maxAccounts
  const { total, expired } = await trialCounts()
  if (total - Math.min(expired, QUICK_RECLAIM) >= max) return { available: false, reason: 'full', hours }
  if ((await isInstanceFull()) || (await workspacesTotalReached(db))) return { available: false, reason: 'full', hours }
  return { available: true, hours }
}

/**
 * Delete one trial account through the one deletion path (account/deletion.ts). `by: 'self'`, because
 * the `expiry` branch re-checks ACCOUNT_LIFETIME_DAYS under its lock and would keep a trial account
 * while that setting is off. Two callers racing for the same account (the quick reclaim and the hourly
 * job): deleteAccount runs under the admin lock, so the second finds no row and gets USER_NOT_FOUND,
 * answered here as "not deleted".
 */
export async function deleteTrialAccount(userId: string, log: (msg: string) => void = (m) => console.warn(m)): Promise<DeleteAccountResult> {
  try {
    return await deleteAccount(userId, { by: 'self', log })
  } catch (err) {
    if (err instanceof AppError && err.code === 'USER_NOT_FOUND') return { deleted: false, deletedWorkspaces: 0, transferredWorkspaces: 0 }
    throw err
  }
}

async function expiredTrialIds(limit: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT id FROM users WHERE trial AND NOT is_admin AND expires_at < now() ORDER BY expires_at, id LIMIT ${limit}
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/**
 * Hourly (account/register.ts): delete trial accounts whose time is up, oldest first, each on its own
 * (never one an admin made an admin, as the lifetime job never deletes admins)
 * (a failure is logged and the next one still runs). Runs whatever TRIAL_ACCOUNTS, ACCOUNT_LIFETIME_DAYS
 * and ACCOUNT_LIFETIME_DRY_RUN say. Log lines carry user ids and counts only.
 */
export async function expireTrialAccounts(log: (msg: string) => void = (m) => console.warn(m), batch = TRIAL_EXPIRY_BATCH): Promise<number> {
  let n = 0
  for (const id of await expiredTrialIds(batch)) {
    try {
      const r = await deleteTrialAccount(id, log)
      if (!r.deleted) continue
      n++
      log(`[inkling] trial accounts: deleted expired user ${id}`)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      log(`[inkling] trial accounts: deleting user ${id} failed (${typeof code === 'string' ? code : 'error'}); will retry next hour`)
    }
  }
  return n
}

/**
 * Make the account, its workspace (invite link off) and, with onboarding on, the sample page. The
 * caller ran the refusals that need the request (off, signed in, no admin, consent) and
 * runBeforeSignup. Everything up to the membership is one transaction with the sign-up hooks' `on`
 * part; the sample page comes after the commit and a failure there leaves a working account.
 */
export async function createTrialAccount(ctx: SignupContext): Promise<{ user: UserDTO; workspaceId: string; samplePageId: string | null }> {
  const trial = limits.trial
  if (!trial) throw trialOff()
  const log = (m: string) => ctx.req.log.warn(m)
  for (const id of await expiredTrialIds(QUICK_RECLAIM)) {
    try {
      await deleteTrialAccount(id, log)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      log(`[inkling] trial accounts: reclaiming user ${id} failed (${typeof code === 'string' ? code : 'error'})`)
    }
  }
  // a password nobody knows: the random bytes are dropped here
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'))
  const { email, name } = ctx.body
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TRIAL_CAP_LOCK})`)
    // checked again in the transaction: never an account (let alone an admin) on a server without one
    if (!(await anyAdmin(tx))) throw setupRequired()
    const [c] = (await tx.execute(sql`SELECT count(*)::int AS n FROM users WHERE trial`)) as unknown as { n: number }[]
    if (Number(c?.n ?? 0) >= trial.maxAccounts) throw trialFull()
    const [u] = await tx
      .insert(users)
      .values({
        email,
        name,
        passwordHash,
        origin: 'local',
        trial: true,
        expiresAt: sql`now() + make_interval(hours => ${trial.lifetimeHours})`,
      })
      .returning({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin })
    const wsId = randomUUID()
    await tx.insert(workspaces).values({
      id: wsId,
      name: ctx.locale === 'ko' ? `${name}의 워크스페이스` : `${name}'s workspace`,
      ...(await generateInviteCodeColumns(tx, wsId)),
      // nobody joins a trial workspace (docs/adr/2555-*); trialGate keeps it off
      inviteLinkEnabled: false,
      createdBy: u.id,
    })
    await tx.insert(workspaceMembers).values({ workspaceId: wsId, userId: u.id, role: 'owner' })
    await runOnSignup(tx, { ...u, isAdmin: false, workspaceId: wsId }, ctx)
    return { user: { ...u, isAdmin: false }, workspaceId: wsId }
  })
  let samplePageId: string | null = null
  if (onboardingEnabled()) {
    try {
      const r = await createSample({ userId: created.user.id, userName: name, workspaceId: created.workspaceId, role: 'owner', locale: ctx.locale })
      samplePageId = r.pageId
    } catch (err) {
      ctx.req.log.error({ err }, '[inkling] trial accounts: sample page failed')
    }
  }
  return { ...created, samplePageId }
}

// ---------------------------------------------------------------------------
// what trial accounts cannot do (docs/adr/2555-*, contract §9.5)
// ---------------------------------------------------------------------------

export type TrialRestrictionKind = 'join' | 'members' | 'public' | 'outbound' | 'workspace' | 'account'

export interface TrialRestrictedRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Fastify route pattern, `/api` included (req.routeOptions.url). */
  url: string
  kind: TrialRestrictionKind
}

/**
 * Every route a trial account is refused, found in the route files and docs/API.md. trial.test.ts
 * fails when a write route of the files or paths that publish, invite, join, send out or change how an
 * account signs in is neither here nor in TRIAL_REVIEWED_ALLOWED (trial.test.ts), and trial.db.test.ts
 * calls each one as a trial account.
 */
export const TRIAL_RESTRICTED_ROUTES: readonly TrialRestrictedRoute[] = [
  // 1. joining someone else's workspace or page
  { method: 'POST', url: '/api/workspaces/join', kind: 'join' },
  { method: 'POST', url: '/api/page-invites/:token/accept', kind: 'join' },
  // 2. bringing people in (the invite link itself: PATCH /settings below)
  { method: 'POST', url: '/api/workspaces/:id/invite/regenerate', kind: 'members' },
  { method: 'POST', url: '/api/workspaces/:id/members', kind: 'members' },
  { method: 'POST', url: '/api/workspaces/:id/transfer', kind: 'members' },
  { method: 'PUT', url: '/api/pages/:id/access', kind: 'members' },
  // 3. publishing to the web: share links (charts on them included), public forms, the iCal feed URL
  { method: 'POST', url: '/api/pages/:id/share', kind: 'public' },
  { method: 'PATCH', url: '/api/pages/:id/share', kind: 'public' },
  { method: 'POST', url: '/api/collection-views/:id/form-link', kind: 'public' },
  { method: 'POST', url: '/api/me/ical', kind: 'public' },
  // 4. requests out of the server to an address the person picks
  { method: 'POST', url: '/api/pages/:id/publish/notion', kind: 'outbound' },
  { method: 'POST', url: '/api/workspaces/:id/webhooks', kind: 'outbound' },
  { method: 'PATCH', url: '/api/webhooks/:id', kind: 'outbound' },
  { method: 'POST', url: '/api/webhooks/:id/test', kind: 'outbound' },
  { method: 'POST', url: '/api/webhooks/:id/secret', kind: 'outbound' },
  { method: 'POST', url: '/api/webhooks/:id/deliveries/:deliveryId/resend', kind: 'outbound' },
  { method: 'PUT', url: '/api/workspaces/:id/slack', kind: 'outbound' },
  { method: 'POST', url: '/api/workspaces/:id/slack/test', kind: 'outbound' },
  { method: 'POST', url: '/api/slack/link/preview', kind: 'outbound' },
  { method: 'POST', url: '/api/slack/link/confirm', kind: 'outbound' },
  // 5. a second workspace
  { method: 'POST', url: '/api/workspaces', kind: 'workspace' },
  // 6. how the account signs in
  { method: 'POST', url: '/api/auth/change-password', kind: 'account' },
  { method: 'POST', url: '/api/auth/oidc/link', kind: 'account' },
  { method: 'POST', url: '/api/auth/2fa/setup', kind: 'account' },
  { method: 'POST', url: '/api/auth/2fa/enable', kind: 'account' },
]

/** The one route refused by what it is sent: turning a workspace's invite link on. */
export const TRIAL_INVITE_LINK_ROUTE = { method: 'PATCH', url: '/api/workspaces/:id/settings' } as const

/** The restriction a request falls under, or null (pure, for tests). */
export function trialRestriction(method: string, url: string | undefined, body: unknown): TrialRestrictionKind | null {
  if (!url) return null
  const m = method.toUpperCase()
  const hit = TRIAL_RESTRICTED_ROUTES.find((r) => r.method === m && r.url === url)
  if (hit) return hit.kind
  if (m === TRIAL_INVITE_LINK_ROUTE.method && url === TRIAL_INVITE_LINK_ROUTE.url) {
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    if (b.inviteLinkEnabled === true) return 'members'
  }
  return null
}

async function isTrialUser(userId: string): Promise<boolean> {
  const [r] = await db.select({ trial: users.trial }).from(users).where(eq(users.id, userId)).limit(1)
  return !!r?.trial
}

/**
 * Request gate (requestGates.ts): REST requests only (cookie, API token, and the REST routes MCP
 * tools call through inject). The account is read from the database only when the route is on the
 * list, so the gate costs nothing elsewhere and stays right after TRIAL_ACCOUNTS is turned off, with
 * several app instances, or when an account is deleted. The /mcp door and the collaboration socket
 * reach no listed route.
 */
export const trialGate: RequestGate = async ({ user, req, channel }) => {
  if (channel !== 'http' || !req) return
  if (!trialRestriction(req.method, req.routeOptions?.url, req.body)) return
  if (await isTrialUser(user.id)) throw trialRestricted()
}

/** GET /auth/me `trial` is filled by routes/auth.ts (it reads the row already). */

const trialBody = z.object({
  legalVersion: z.string().max(200).optional(),
  website: z.string().max(500).optional(),
  formMs: z.number().optional(),
})

/** POST /api/auth/trial (registered from account/register.ts on every app). */
export async function registerTrialRoutes(api: FastifyInstance): Promise<void> {
  api.post('/auth/trial', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!trialOn()) throw trialOff()
    // A browser already signed in keeps its session: a trial session never replaces a real one, and a
    // cross-site form cannot swap it (the Origin check refuses those first, csrf.ts).
    const sid = req.cookies?.[SESSION_COOKIE]
    if (sid && (await getSessionUser(sid))) throw alreadySignedIn()
    if (!(await anyAdmin(db))) throw setupRequired()
    if (trialNeedsConsent()) throw needsConsent()
    const parsed = trialBody.parse(req.body ?? {})
    const locale = await requestLocale(req)
    const body: RegisterInput = {
      email: trialEmail(),
      name: trialName(locale),
      password: '',
      consents: [],
      ...(parsed.legalVersion !== undefined ? { legalVersion: parsed.legalVersion } : {}),
    } as RegisterInput
    const ctx: SignupContext = { rawBody: req.body, body, ip: req.ip, locale, setupCode: false, trial: true, req }
    // the sign-up hooks: bot checks, per-address and hourly counts, the server limits, the document
    // version (LEGAL_DIR without tick boxes: the version shown must be the current one)
    await runBeforeSignup(ctx)
    const r = await createTrialAccount(ctx)
    const { token, expiresAt } = await createSession(r.user.id)
    setSessionCookie(reply, token, expiresAt)
    return r
  })
}
