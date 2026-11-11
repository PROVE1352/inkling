import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, count, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@inkling/shared'
import type { AuthModeDTO, AuthModeLimitsDTO, SidebarPrefsDTO, UserDTO } from '@inkling/shared'
import {
  DELEGATED_EMAIL_SUFFIX,
  consumeResetCode,
  externalAccountName,
  consumeVerifyToken,
  isDelegatedEmail,
  issueResetCode,
  issueVerifyToken,
  normalizeCode,
  promoteIfNoAdmin,
  promoteIfNoAdminInTx,
  setPassword,
  verificationEnforced,
  withAdminLock,
} from '../accounts'
import { checkSetupCode, closeFirstAdminSetup, setupPending } from '../firstAdminSetup'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionUser,
  getUser,
  hashPassword,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
  verifyPassword,
} from '../auth'
import { db } from '../db/index'
import {
  emailVerifications,
  passwordResetCodes,
  passwordResetRequests,
  signupKeys,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema'
import { env, mailEnabled } from '../env'
import { AppError, conflict, forbidden } from '../errors'
import { assertAccount, assertNotBanned, recordFailure, recordSuccess } from '../guard'
import { generateInviteCodeColumns } from '../helpers'
import { hashSignupKey } from '../secretsAtRest'
import { appOrigin, resetCodeMail, sendMail, verifyMail } from '../mail'
import { enabledExperimentalFeatures } from '../features'
import { z } from 'zod'
import { normalizeLocale, requestLocale, resolveLocale, type Locale } from '../i18n'
import { toSidebarPrefsDTO } from './sidebarPrefs'
import { DEFAULT_WORKSPACE_RESTORE_DAYS, limits, restrictedSignup } from '../limits'
import { runBeforeSignup, runOnSignup, type SignupContext } from '../signupHooks'
import { noteTakenSignup } from '../account/signupGuards'
import { authModeExtraFields, meExtraFields } from '../restrictedExtras'
import { linkedLogins } from './oidc'
import { parseRegisterBody, spendPasswordCheck } from '../account/loginId'
import { oidcEnabled } from '../oidc'
import {
  createLoginChallenge,
  dropChallenge,
  takeChallengeAttempt,
  totpAccountKey,
  twoFactorEnabled,
  verifySecondFactor,
} from '../twoFactor'

/**
 * Account boundary: Inkling and the external auth server (DELEGATED_AUTH_URL) share accounts in
 * ONE direction only.
 *
 *   external account ──(delegated login)──▶ Inkling  : allowed
 *   Inkling account  ─────────────────────▶ external : never
 *
 * Inkling's own accounts (origin='local') are created only with an Inkling signup key, and their
 * passwords are verified only against this server's argon2 hash. That password is never sent to
 * the external auth server by any path. Conversely, accounts created by delegated login
 * (origin='delegated') have no local password (random hash), so password reset/change do not
 * apply to them.
 */

/** Is this a postgres unique-constraint violation (23505)? */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.code === '23505' || e?.cause?.code === '23505'
}

// Auth endpoints get a strict per-IP limit (10/min) against brute force and spam.
const strictRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }
// Public endpoints that trigger mail are stricter still.
const mailRateLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }

/** Outcome of a delegated login */
type DelegatedResult = 'ok' | 'invalid' | 'totp' | 'rate_limited' | 'unavailable'

/**
 * Delegate a login to the external auth server. Contract (see deploy/DEPLOY.md):
 *   POST <DELEGATED_AUTH_URL>/api/auth/login  {"username","password"}
 * - 200 + access_token → ok
 * - 200 + totp_required → totp (TOTP not supported)
 * - 401 → invalid (credentials do not match)
 * - 429 → rate_limited (passed through)
 * - network error / timeout (10 s) / 5xx / anything else → unavailable
 *
 * Returns only success/failure: the access_token from the external server is deliberately
 * discarded. Inkling neither stores nor returns external tokens.
 */
async function delegatedLogin(
  baseUrl: string,
  username: string,
  password: string,
): Promise<DelegatedResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    })
  } catch {
    // network error or timeout (abort)
    return 'unavailable'
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 429) return 'rate_limited'
  if (res.status === 401) return 'invalid'
  if (res.status >= 500) return 'unavailable'
  if (res.status === 200) {
    let data: { access_token?: unknown; totp_required?: unknown }
    try {
      data = (await res.json()) as typeof data
    } catch {
      return 'unavailable'
    }
    if (data.totp_required === true) return 'totp'
    if (typeof data.access_token === 'string' && data.access_token) return 'ok'
    return 'invalid'
  }
  return 'unavailable'
}

/** String equality that compares equal-length values to reduce timing differences */
function safeEqual(a: string, b: string): boolean {
  const ha = Buffer.from(sha256hex(a), 'hex')
  const hb = Buffer.from(sha256hex(b), 'hex')
  return timingSafeEqual(ha, hb)
}
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex')

const setupClosed = () =>
  new AppError(403, 'SETUP_CLOSED', 'This server already has an account; the setup link no longer works. Sign in, or ask an admin for a signup key')

const emailNotVerified = () =>
  new AppError(403, 'EMAIL_NOT_VERIFIED', 'Email verification required. Open the verification link in your inbox.')

/**
 * Consume an Inkling signup key (atomically). true when valid.
 * - expiresAt NULL = never expires
 * - Only rows with usedCount < maxUses are UPDATEd, so concurrent requests cannot overuse it.
 */
export async function consumeSignupKey(key: string): Promise<boolean> {
  const now = new Date()
  const updated = await db
    .update(signupKeys)
    .set({
      usedCount: sql`${signupKeys.usedCount} + 1`,
      lastUsedAt: now,
      // A used-up key is no longer shown in the admin screen: a used single-use key is that
      // person's recovery code (docs/adr/1110-*).
      keyEnc: sql`CASE WHEN ${signupKeys.usedCount} + 1 >= ${signupKeys.maxUses} THEN NULL ELSE ${signupKeys.keyEnc} END`,
    })
    .where(
      and(
        // stored as SHA-256 of the canonical key (docs/adr/1110-*)
        eq(signupKeys.key, hashSignupKey(key)),
        lt(signupKeys.usedCount, signupKeys.maxUses),
        or(isNull(signupKeys.expiresAt), sql`${signupKeys.expiresAt} > now()`),
      ),
    )
    .returning({ key: signupKeys.key })
  return updated.length > 0
}

/** Give back a consumed signup key (when the signup itself failed). */
async function refundSignupKey(key: string): Promise<void> {
  await db
    .update(signupKeys)
    .set({ usedCount: sql`greatest(${signupKeys.usedCount} - 1, 0)` })
    .where(eq(signupKeys.key, hashSignupKey(key)))
}

/** 403 SETUP_REQUIRED: restricted sign-up on a server without an admin (contract §13). */
const setupRequired = () =>
  new AppError(403, 'SETUP_REQUIRED', 'This server has no operator account yet. The operator signs up first with the setup link from the server log.')

/** Whether any admin exists (bare db or the sign-up transaction). */
async function anyAdmin(exec: Pick<typeof db, 'select'>): Promise<boolean> {
  const rows = await exec.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1)
  return rows.length > 0
}

/**
 * The restricted-mode fields of GET /auth/mode (docs/adr/2500-*): each one only when its setting is
 * on, so a server without them answers exactly as 0.21.1 (no key, not even an undefined one).
 * `legal` is filled where LEGAL_DIR is read.
 */
async function restrictedAuthMode(): Promise<Partial<AuthModeDTO>> {
  const out: Partial<AuthModeDTO> = {}
  if (limits.loginIdMode === 'username') out.loginId = 'username'
  if (limits.signupMaxUsers !== null) {
    const [c] = await db.select({ n: count() }).from(users)
    if ((c?.n ?? 0) >= limits.signupMaxUsers) out.signupFull = true
  }
  if (limits.instanceLabel !== null) out.instanceLabel = limits.instanceLabel
  if (limits.accountLifetimeDays !== null) out.accountLifetimeDays = limits.accountLifetimeDays
  if (limits.disabledFeatures.length > 0) out.disabledFeatures = [...limits.disabledFeatures]
  const l: AuthModeLimitsDTO = {}
  if (limits.workspacesPerUser !== null) l.workspacesPerUser = limits.workspacesPerUser
  if (limits.membersPerWorkspace !== null) l.membersPerWorkspace = limits.membersPerWorkspace
  if (limits.pagesPerWorkspace !== null) l.pagesPerWorkspace = limits.pagesPerWorkspace
  if (limits.fileMb !== null) l.fileMb = limits.fileMb
  if (limits.workspaceStorageMb !== null) l.workspaceStorageMb = limits.workspaceStorageMb
  if (limits.trashDays !== undefined) l.trashDays = limits.trashDays
  if (Object.keys(l).length > 0) out.limits = l
  if (limits.workspaceRestoreDays !== DEFAULT_WORKSPACE_RESTORE_DAYS) out.workspaceRestoreDays = limits.workspaceRestoreDays
  if (limits.instanceNotice !== undefined) out.instanceNotice = limits.instanceNotice
  return out
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const log = (msg: string) => app.log.info(msg)

  // Auth mode (no auth needed): the web uses it to switch the sign-in/sign-up screen UI.
  app.get('/auth/mode', async (): Promise<AuthModeDTO & { defaultLocale: Locale | null }> => ({
    delegated: !!env.delegatedAuthUrl,
    delegatedName: env.delegatedAuthName,
    delegatedEmailDomain: env.delegatedEmailDomain,
    signupKeyRequired: env.signupRequireKey,
    mailEnabled,
    emailVerificationRequired: verificationEnforced(),
    experimental: enabledExperimentalFeatures(),
    // OpenID Connect sign-in button (docs/adr/1160-*); the name only, nothing else of the configuration.
    oidc: oidcEnabled() ? { name: env.oidc.name } : null,
    // Extension field (shared DTO unchanged): only when the operator set DEFAULT_LOCALE, so an
    // unset server lets the browser language decide (docs/adr/0901-*).
    defaultLocale: env.defaultLocaleConfigured ? env.defaultLocale : null,
    // No account yet: the sign-in screen points at the setup link in the server log (docs/adr/2160-*).
    setupPending: await setupPending(),
    // Restricted mode (0.22): nothing here unless the operator set it.
    ...(await restrictedAuthMode()),
    // Fields the restricted-mode pieces register (restrictedExtras.ts, docs/adr/2503-*); none = nothing.
    ...(await authModeExtraFields()),
  }))

  /** Send the verification mail (issues the token). Failure is AppError(502). */
  const sendVerification = async (
    u: { id: string; email: string; name: string },
    origin: string,
    locale: Locale,
  ) => {
    const token = await issueVerifyToken(u.id, u.email)
    await sendMail(u.email, verifyMail({ name: u.name, token, origin, locale }), log)
  }

  app.post('/auth/register', strictRateLimit, async (req, reply) => {
    // LOGIN_ID_MODE=username takes `loginId` instead of `email` (account/loginId.ts, docs/adr/2512-*).
    const body = parseRegisterBody(req.body)
    const email = body.email.trim().toLowerCase()

    // Self-signup cannot take the namespace reserved for delegated-account mirrors.
    if (isDelegatedEmail(email)) {
      throw new AppError(400, 'EMAIL_RESERVED', 'This email domain is not allowed')
    }

    // First-admin setup (docs/adr/2160-*): the one-time code from the server log replaces the signup
    // key for the first account only. A wrong code counts as a failed attempt (ban after repeats).
    const setupCode = body.setupCode?.trim() || ''
    if (setupCode) {
      const check = checkSetupCode(setupCode)
      if (check === 'closed') throw setupClosed()
      if (check === 'wrong') {
        await recordFailure(req, 'setup-code')
        throw new AppError(403, 'INVALID_SETUP_CODE', 'The setup code does not match the one in the server log (a restart makes a new one)')
      }
    } else if (restrictedSignup() && !(await anyAdmin(db))) {
      // Restricted sign-up with no admin yet (contract §13, docs/adr/2527-*): only the setup code,
      // refused here before the hooks so nothing is spent and no other error hides this one.
      throw setupRequired()
    }

    // Language of the default workspace name and the verification mail: the browser's
    // (Accept-Language from the web client) or DEFAULT_LOCALE, since the account has no saved one yet.
    const locale = await requestLocale(req)

    // Sign-up hooks (docs/adr/2501-*): refusals before anything is consumed (the signup key below,
    // the password hash, rows). No hook registered = nothing happens here.
    const hookCtx: SignupContext = { rawBody: req.body, body, ip: req.ip, locale, setupCode: !!setupCode, req }
    await runBeforeSignup(hookCtx)

    // Signup key check (Inkling's own keys).
    const signupKey = setupCode ? '' : body.signupKey?.trim() || ''
    if (env.signupRequireKey && !setupCode) {
      if (!signupKey) {
        throw new AppError(400, 'SIGNUP_KEY_REQUIRED', 'Signup key required')
      }
      if (!(await consumeSignupKey(signupKey))) {
        await recordFailure(req, 'signup-key')
        throw new AppError(403, 'INVALID_SIGNUP_KEY', 'Signup key is invalid or expired')
      }
    }

    const passwordHash = await hashPassword(body.password)
    // Only accounts created while verification is enforced are blocked before verifying (not retroactive).
    // The first admin made with the setup code is not: the code already proves who runs the server,
    // and a mail misconfiguration must not lock the only admin out (the mail still goes out).
    const mustVerify = setupCode ? false : verificationEnforced()

    let user: UserDTO
    // The setup account is inserted under the admin advisory lock, after checking in the same
    // transaction that no account exists: two setups racing commit at most one (docs/adr/2160-*).
    const inTx: typeof withAdminLock = setupCode ? withAdminLock : (fn) => db.transaction(fn)
    try {
      user = await inTx(async (tx) => {
        if (setupCode) {
          const any = await tx.select({ id: users.id }).from(users).limit(1)
          if (any.length > 0) throw setupClosed()
        }
        const [u] = await tx
          .insert(users)
          .values({
            email,
            name: body.name,
            passwordHash,
            origin: 'local',
            // Record only a key that was actually consumed and verified (key → signup tracing, basis for single-use-key resets).
            signupKey: env.signupRequireKey && signupKey ? hashSignupKey(signupKey) : null,
            mustVerifyEmail: mustVerify,
            ...(setupCode ? { isAdmin: true } : {}),
          })
          .returning({
            id: users.id,
            email: users.email,
            name: users.name,
            isAdmin: users.isAdmin,
          })

        const wsId = randomUUID()
        const [ws] = await tx
          .insert(workspaces)
          .values({
            id: wsId,
            name: locale === 'ko' ? `${body.name}의 워크스페이스` : `${body.name}'s workspace`,
            ...(await generateInviteCodeColumns(tx, wsId)),
            createdBy: u.id,
          })
          .returning({ id: workspaces.id })

        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: ws.id, userId: u.id, role: 'owner' })

        // New-install bootstrap: with no admin yet, the first user to sign up becomes admin. Decided
        // here, in the account's transaction, so the sign-up hooks below see the final isAdmin
        // (docs/adr/2501-*); the setup-code account is admin already.
        // Restricted sign-up never promotes: with no admin it refuses instead (checked again here, in
        // the account's transaction, after the cheap refusal above; docs/adr/2527-*).
        if (!setupCode && restrictedSignup() && !(await anyAdmin(tx))) throw setupRequired()
        const created = !setupCode && !u.isAdmin && (await promoteIfNoAdminInTx(tx, u.id)) ? { ...u, isAdmin: true } : u

        await runOnSignup(tx, { ...created, workspaceId: ws.id }, hookCtx)
        return created
      })
    } catch (err) {
      // If signup failed, give the key back as unused.
      if (env.signupRequireKey && signupKey) await refundSignupKey(signupKey)
      if (setupCode && err instanceof AppError && err.code === 'SETUP_CLOSED') closeFirstAdminSetup()
      if (isUniqueViolation(err)) {
        // counted per address while SIGNUP_PER_IP_PER_DAY is set (0.22 security fix F10)
        await noteTakenSignup(hookCtx)
        throw limits.loginIdMode === 'username' ? conflict('LOGIN_ID_TAKEN', 'This ID is already taken') : conflict('EMAIL_TAKEN', 'Email already in use')
      }
      throw err
    }
    if (setupCode) closeFirstAdminSetup()

    // Kept as before 0.22 (a no-op once the transaction above promoted or an admin exists).
    if (await promoteIfNoAdmin(user.id)) user = { ...user, isAdmin: true }

    if (mustVerify) {
      // No session before verification: just send the verification mail.
      let mailSent = true
      try {
        await sendVerification(user, appOrigin(req), locale)
      } catch {
        mailSent = false
      }
      return { user, verificationRequired: true, mailSent }
    }

    if (mailEnabled) {
      // Warning-banner mode: send the verification mail in the background (signup succeeds even if it fails).
      void sendVerification(user, appOrigin(req), locale).catch(() => undefined)
    }

    const { token, expiresAt } = await createSession(user.id)
    setSessionCookie(reply, token, expiresAt)
    return { user }
  })

  app.post('/auth/login', strictRateLimit, async (req, reply) => {
    const body = loginSchema.parse(req.body)

    // Same message on every failure so it does not reveal whether the email/ID exists
    const invalid = () =>
      new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password')

    const identifier = body.email.trim()
    // An account with piled-up failures is not locked; only its next attempt is delayed (before the expensive hash check).
    const acct = identifier.toLowerCase()
    assertAccount(acct)
    const fail = async () => {
      await recordFailure(req, 'login', acct)
      return invalid()
    }
    const cols = {
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
    }

    // --- 1) Inkling's own accounts first ---
    // On a match here the password is verified locally only and never falls through to delegation.
    // (Falling through would send an Inkling password to the external auth server, so it must end here.)
    const localEmail = identifier.toLowerCase()
    const local = (
      await db
        .select({
          ...cols,
          passwordHash: users.passwordHash,
          origin: users.origin,
          mustVerifyEmail: users.mustVerifyEmail,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, localEmail))
        .limit(1)
    )[0]

    if (local && local.origin === 'local') {
      // An account with piled-up wrong 2FA codes is delayed here too, before the argon2 check:
      // a correct password must not reset the code counter (docs/adr/1061-*).
      assertAccount(totpAccountKey(acct))
      const ok = await verifyPassword(local.passwordHash, body.password)
      if (!ok) throw await fail()
      // Reveal the verification state only after the password matched (no account-existence leak).
      if (verificationEnforced() && local.mustVerifyEmail && !local.emailVerifiedAt) {
        recordSuccess(req, acct)
        throw emailNotVerified()
      }
      // Two-step verification: no session yet, only a short-lived challenge for POST /auth/login/totp.
      // The IP counter is not reset until the code is right, so wrong codes add up to an IP ban.
      if (await twoFactorEnabled(local.id)) {
        const challenge = await createLoginChallenge(local.id, local.passwordHash)
        return { totpRequired: true as const, challenge }
      }
      recordSuccess(req, acct)
      const isAdmin = local.isAdmin || (await promoteIfNoAdmin(local.id))
      const { token, expiresAt } = await createSession(local.id, {
        expectPasswordHash: local.passwordHash,
      })
      setSessionCookie(reply, token, expiresAt)
      return {
        user: { id: local.id, email: local.email, name: local.name, isAdmin },
      }
    }

    // An account created by OpenID Connect sign-in has no password here, and the typed one must not
    // travel on to the delegated auth server either (docs/adr/1161-*).
    if (local && local.origin === 'oidc') throw await fail()

    // --- 2) Delegate to the external auth server ---
    const delegatedUrl = env.delegatedAuthUrl
    if (!delegatedUrl) {
      // Sign-in IDs: an unknown ID costs the same password hash check as a known one (docs/adr/2512-*).
      if (limits.loginIdMode === 'username') await spendPasswordCheck(body.password)
      throw await fail()
    }

    // Input in mirror-email form (<id>@<delegated domain>) is mapped back to the external ID.
    const username = localEmail.endsWith(DELEGATED_EMAIL_SUFFIX)
      ? identifier.slice(0, -DELEGATED_EMAIL_SUFFIX.length)
      : identifier

    const result = await delegatedLogin(delegatedUrl, username, body.password)
    if (result === 'invalid') throw await fail()
    if (result === 'totp') {
      throw new AppError(401, 'TOTP_UNSUPPORTED', 'TOTP accounts are not supported yet')
    }
    if (result === 'rate_limited') {
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.')
    }
    if (result === 'unavailable') {
      throw new AppError(503, 'AUTH_UPSTREAM_UNAVAILABLE', 'Could not reach the auth server')
    }

    // Success → find-or-create the local user and issue a session as usual.
    // passwordHash is filled with a random argon2 hash so local password login is never possible.
    const email = `${username.toLowerCase()}${DELEGATED_EMAIL_SUFFIX}`
    let row = (await db.select(cols).from(users).where(eq(users.email, email)).limit(1))[0]
    if (!row) {
      const passwordHash = await hashPassword(randomBytes(32).toString('base64url'))
      try {
        row = (
          await db
            .insert(users)
            .values({ email, name: username, passwordHash, origin: 'delegated' })
            .returning(cols)
        )[0]
      } catch (err) {
        // Re-read if a concurrent login already created it
        if (!isUniqueViolation(err)) throw err
        row = (
          await db.select(cols).from(users).where(eq(users.email, email)).limit(1)
        )[0]
      }
    }
    if (!row) throw new AppError(503, 'AUTH_UPSTREAM_UNAVAILABLE', 'Could not reach the auth server')
    recordSuccess(req, acct)

    const isAdmin = row.isAdmin || (await promoteIfNoAdmin(row.id))
    const { token, expiresAt } = await createSession(row.id)
    setSessionCookie(reply, token, expiresAt)
    return {
      user: { id: row.id, email: row.email, name: row.name, isAdmin },
    }
  })

  /**
   * Second sign-in step (docs/adr/1061-*): the challenge from /auth/login + a 6-digit code or a
   * recovery code. Five wrong codes void the challenge; wrong codes also count against the IP
   * (ban) and the account (backoff, not reset by a correct password).
   */
  app.post('/auth/login/totp', strictRateLimit, async (req, reply) => {
    const body = z
      .object({ challenge: z.string().min(1).max(200), code: z.string().trim().min(1).max(40) })
      .parse(req.body)
    const expired = () =>
      new AppError(401, 'TOTP_CHALLENGE_EXPIRED', 'Sign-in timed out. Enter your password again.')
    const attempt = await takeChallengeAttempt(body.challenge)
    if (!attempt) {
      await recordFailure(req, 'totp')
      throw expired()
    }
    const [u] = await db
      .select({ id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, attempt.userId))
      .limit(1)
    if (!u) throw expired()
    const acct = u.email.toLowerCase()
    assertAccount(totpAccountKey(acct))

    const result = await verifySecondFactor(u.id, body.code)
    if (result === 'invalid' || result === 'reused') {
      await recordFailure(req, 'totp', totpAccountKey(acct))
      if (attempt.last) {
        await dropChallenge(body.challenge)
        throw new AppError(401, 'TOTP_CHALLENGE_EXPIRED', 'Too many wrong codes. Enter your password again.')
      }
      throw result === 'reused'
        ? new AppError(401, 'TOTP_CODE_REUSED', 'This code was already used. Wait for the next one.')
        : new AppError(401, 'INVALID_TOTP_CODE', 'Incorrect code')
    }
    await dropChallenge(body.challenge)
    recordSuccess(req, acct)
    recordSuccess(req, totpAccountKey(acct))
    const isAdmin = u.isAdmin || (await promoteIfNoAdmin(u.id))
    // Only while the password verified in step one is still the account's (a reset in between voids it).
    const { token, expiresAt } = await createSession(u.id, { expectPasswordHash: attempt.passwordHash })
    setSessionCookie(reply, token, expiresAt)
    return {
      user: { id: u.id, email: u.email, name: u.name, isAdmin },
      recoveryCodeUsed: result === 'recovery',
    }
  })

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE]
    if (token) await destroySession(token)
    clearSessionCookie(reply)
    return reply.code(204).send()
  })

  app.get('/auth/me', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const [extra] = await db
      .select({
        origin: users.origin,
        emailVerifiedAt: users.emailVerifiedAt,
        locale: users.locale,
        sidebarPrefs: users.sidebarPrefs,
        expiresAt: users.expiresAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    const out: UserDTO & { locale: Locale | null; sidebar: SidebarPrefsDTO; twoFactor: boolean } = {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      origin: extra?.origin ?? 'local',
      // Delegated and OIDC-created accounts are not subject to verification, so report true (hides the banner)
      emailVerified: extra?.origin === 'delegated' || extra?.origin === 'oidc' || !!extra?.emailVerifiedAt,
      // Extension field: saved UI language (null = automatic)
      locale: normalizeLocale(extra?.locale),
      // Extension field: sidebar menu order / hidden menus (docs/adr/1020-*), so the first paint is right
      sidebar: toSidebarPrefsDTO(extra?.sidebarPrefs),
      // Extension field: two-step verification is on (docs/adr/1061-*)
      twoFactor: await twoFactorEnabled(user.id),
      // Linked OpenID Connect sign-ins, for Settings › Account (docs/adr/1161-*)
      logins: await linkedLogins(user.id),
    }
    // Restricted mode (docs/adr/2500-*): when the account will be deleted (ACCOUNT_LIFETIME_DAYS).
    // Only accounts created while the setting was on have a date; the field is absent otherwise.
    if (extra?.expiresAt) out.expiresAt = extra.expiresAt.toISOString()
    // Fields the restricted-mode pieces register (restrictedExtras.ts, docs/adr/2503-*); none = nothing.
    Object.assign(out, await meExtraFields(user))
    // For the badge on the admin entry link: piggybacks on /auth/me instead of separate polling.
    if (user.isAdmin) {
      const [c] = await db
        .select({ n: count() })
        .from(passwordResetRequests)
        .where(eq(passwordResetRequests.status, 'pending'))
      out.pendingResetRequests = c?.n ?? 0
    }
    return { user: out }
  })

  // Save the UI language on the account (null = automatic). Also selects the language of the
  // emails this user receives and of templates/pages the server creates for them.
  app.patch('/auth/me/locale', { preHandler: requireUser }, async (req) => {
    const body = z.object({ locale: z.enum(['en', 'ko'] as const satisfies readonly Locale[]).nullable() }).parse(req.body)
    const user = getUser(req)
    await db.update(users).set({ locale: body.locale }).where(eq(users.id, user.id))
    return { locale: body.locale }
  })

  // -------------------------------------------------------------------------
  // Password reset / change / reset requests
  // -------------------------------------------------------------------------

  /**
   * Sign-in screen "Reset password": email + code + new password.
   * Code: (i) a single-use reset code issued by an admin or the automatic mail, or (ii) the signup
   * key that person signed up with, but only when that key was single-use (maxUses=1), so a
   * shared key cannot change someone else's password.
   * Every failure gets the same message regardless of whether/what kind of account exists.
   */
  app.post('/auth/reset-password', strictRateLimit, async (req) => {
    const body = resetPasswordSchema.parse(req.body)
    const invalid = () =>
      new AppError(400, 'INVALID_RESET', 'Incorrect email or code')
    const email = body.email.trim().toLowerCase()
    const code = normalizeCode(body.code)
    assertAccount(email)
    const fail = async () => {
      await recordFailure(req, 'reset', email)
      return invalid()
    }

    const [u] = await db
      .select({ id: users.id, origin: users.origin, signupKey: users.signupKey })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (!u || u.origin !== 'local') throw await fail()

    let ok = await consumeResetCode(u.id, code)
    // users.signup_key holds the key's SHA-256 (docs/adr/1110-*)
    if (!ok && u.signupKey && safeEqual(u.signupKey, hashSignupKey(code))) {
      const [k] = await db
        .select({ maxUses: signupKeys.maxUses })
        .from(signupKeys)
        .where(eq(signupKeys.key, u.signupKey))
        .limit(1)
      ok = !!k && k.maxUses === 1
    }
    if (!ok) throw await fail()

    recordSuccess(req, email)
    await setPassword(u.id, body.newPassword)
    return { ok: true }
  })

  /**
   * Sign-in screen "Forgot password". The response is always the same (never reveal whether
   * the account exists).
   * - No such account: store nothing.
   * - Local account with a verified email + mail enabled: mail a reset code automatically,
   *   bypassing the admin queue (in the background, so response time reveals nothing), in the
   *   recipient's saved locale. One mail per 5 minutes.
   * - Otherwise (unverified, mail off, delegated account): merge into one pending request in the
   *   admin queue (refreshed at most once a minute).
   */
  app.post('/auth/forgot-password', mailRateLimit, async (req) => {
    const body = forgotPasswordSchema.parse(req.body)
    // The response never distinguishes success from failure, so every submission counts as an
    // attempt; counting only unknown emails would turn the ban state into an account-existence oracle.
    await recordFailure(req, 'forgot')
    const raw = body.email.trim().toLowerCase()
    // Input without '@' is treated as a delegated account ID
    const email = raw.includes('@') ? raw : `${raw}${DELEGATED_EMAIL_SUFFIX}`
    const accepted = { ok: true }

    const [u] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        origin: users.origin,
        emailVerifiedAt: users.emailVerifiedAt,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (!u) return accepted

    if (u.origin === 'local' && mailEnabled && u.emailVerifiedAt) {
      const origin = appOrigin(req)
      void (async () => {
        const recent = await db
          .select({ h: passwordResetCodes.codeHash })
          .from(passwordResetCodes)
          .where(
            and(
              eq(passwordResetCodes.userId, u.id),
              isNull(passwordResetCodes.createdBy),
              gt(passwordResetCodes.createdAt, new Date(Date.now() - 5 * 60_000)),
            ),
          )
          .limit(1)
        if (recent.length > 0) return
        const { code, expiresAt } = await issueResetCode(u.id, null)
        await sendMail(u.email, resetCodeMail({ name: u.name, email: u.email, code, expiresAt, origin, locale: resolveLocale(u.locale) }), log)
      })().catch(() => undefined)
      return accepted
    }

    await db
      .insert(passwordResetRequests)
      .values({ userId: u.id, note: body.note?.trim() || null, ip: req.ip })
      .onConflictDoUpdate({
        target: passwordResetRequests.userId,
        targetWhere: sql`${passwordResetRequests.status} = 'pending'`,
        set: { note: body.note?.trim() || null, ip: req.ip, createdAt: new Date() },
        setWhere: lt(passwordResetRequests.createdAt, new Date(Date.now() - 60_000)),
      })
    return accepted
  })

  /** Settings: change your own password. Keeps the current session and signs out the others. */
  app.post(
    '/auth/change-password',
    { preHandler: requireUser, ...strictRateLimit },
    async (req) => {
      if (req.authVia !== 'cookie') throw forbidden('Can only be changed from a browser sign-in')
      const me = getUser(req)
      const body = changePasswordSchema.parse(req.body)
      const [u] = await db
        .select({ origin: users.origin, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, me.id))
        .limit(1)
      if (!u) throw forbidden()
      if (u.origin !== 'local') {
        throw new AppError(400, 'DELEGATED_ACCOUNT', `${externalAccountName(u.origin)} passwords can't be changed here`)
      }
      assertNotBanned(req)
      assertAccount(me.email)
      if (!(await verifyPassword(u.passwordHash, body.currentPassword))) {
        await recordFailure(req, 'change-password', me.email)
        throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect')
      }
      recordSuccess(req, me.email)
      await setPassword(me.id, body.newPassword, {
        keepSessionToken: req.cookies?.[SESSION_COOKIE],
      })
      return { ok: true }
    },
  )

  // -------------------------------------------------------------------------
  // Email verification
  // -------------------------------------------------------------------------

  /** Confirm a /verify?token= link (no sign-in needed) */
  app.post('/auth/verify-email', strictRateLimit, async (req) => {
    const { token } = verifyEmailSchema.parse(req.body)
    const email = await consumeVerifyToken(token)
    if (!email) {
      await recordFailure(req, 'verify-token')
      throw new AppError(400, 'INVALID_TOKEN', 'Verification link is invalid or expired')
    }
    return { ok: true, email }
  })

  /**
   * Resend the verification mail: for the signed-in account (cookie), or by email + password when
   * sign-in is blocked. One mail per minute.
   */
  app.post('/auth/verify-email/send', mailRateLimit, async (req) => {
    if (!mailEnabled) throw new AppError(501, 'MAIL_DISABLED', 'Mail is not configured')
    const body = resendVerificationSchema.parse(req.body ?? {})

    let userId: string | null = null
    const cookie = req.cookies?.[SESSION_COOKIE]
    if (cookie) userId = (await getSessionUser(cookie))?.id ?? null
    if (!userId) {
      const invalid = () =>
        new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password')
      if (!body.email || !body.password) throw invalid()
      const acct = body.email.trim().toLowerCase()
      assertAccount(acct)
      const [c] = await db
        .select({ id: users.id, passwordHash: users.passwordHash, origin: users.origin })
        .from(users)
        .where(eq(users.email, body.email.trim().toLowerCase()))
        .limit(1)
      if (!c || c.origin !== 'local' || !(await verifyPassword(c.passwordHash, body.password))) {
        await recordFailure(req, 'login', acct)
        throw invalid()
      }
      recordSuccess(req, acct)
      userId = c.id
    }

    const [u] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        origin: users.origin,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!u) throw forbidden()
    if (u.origin !== 'local') {
      throw new AppError(400, 'DELEGATED_ACCOUNT', `${externalAccountName(u.origin)} accounts don't need email verification`)
    }
    if (u.emailVerifiedAt) return { ok: true, alreadyVerified: true }

    const recent = await db
      .select({ h: emailVerifications.tokenHash })
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.userId, u.id),
          gt(emailVerifications.createdAt, new Date(Date.now() - 60_000)),
        ),
      )
      .limit(1)
    if (recent.length > 0) {
      throw new AppError(429, 'RATE_LIMITED', 'Just sent. Try again in a minute.')
    }
    await sendVerification(u, appOrigin(req), await requestLocale(req, u.id))
    return { ok: true }
  })
}
