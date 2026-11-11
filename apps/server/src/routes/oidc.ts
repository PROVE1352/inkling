import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { isDelegatedEmail, promoteIfNoAdmin, verificationEnforced } from '../accounts'
import {
  createSession,
  getSessionUser,
  getUser,
  hashPassword,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
} from '../auth'
import { db } from '../db/index'
import { oidcLoginStates, userIdentities, users, workspaceMembers, workspaces } from '../db/schema'
import { env } from '../env'
import { AppError, forbidden } from '../errors'
import { assertNotBanned, recordFailure, recordSuccess } from '../guard'
import { generateInviteCodeColumns } from '../helpers'
import { requestLocale } from '../i18n'
import {
  authorizationUrl,
  b64url,
  discover,
  displayNameClaim,
  emailClaim,
  emailVerifiedClaim,
  exchangeCode,
  type IdTokenClaims,
  oidcEnabled,
  OidcError,
  type OidcErrorCode,
  pkcePair,
  safeReturnTo,
  sha256hex,
  showsSecondFactor,
  verifyIdToken,
} from '../oidc'
import { createLoginChallenge, twoFactorEnabled } from '../twoFactor'
import { assertWorkspacesTotalRoom } from '../quota/room'
import { instanceFullError, isInstanceFull } from '../quota/instance'

/**
 * Sign-in with an OpenID Connect provider (docs/adr/1160-*, 1161-*, 1162-*).
 *
 *   GET  /auth/oidc/start?returnTo=/path     302 → provider (sign-in; a plain link on the login screen)
 *   POST /auth/oidc/link { returnTo }        { url } (connect the provider to the signed-in account;
 *                                            a JSON POST so the Origin check of docs/adr/1062-* applies)
 *   GET  /auth/oidc/callback?code&state      302 → returnTo (session cookie set) or
 *                                            /login?oidc_error=CODE, /login?next=…#totp=<challenge>
 *
 * The callback is a GET (the provider redirects the browser), so the Origin check does not cover it.
 * What protects it instead: `state` is single use and bound to the browser that started the sign-in
 * by the `inkling_oidc` cookie (its SHA-256 is stored with the state), the id_token's nonce must match
 * the one stored with that state, and PKCE ties the code to the stored verifier.
 */

export const OIDC_COOKIE = 'inkling_oidc'
const COOKIE_PATH = '/api/auth/oidc'
export const STATE_TTL_MS = 10 * 60_000

// Many people of one office can sign in at nine through one NAT address: looser than password sign-in.
const oidcRateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.code === '23505' || e?.cause?.code === '23505'
}

const disabled = () => new AppError(404, 'OIDC_DISABLED', 'OpenID Connect sign-in is not configured')

/** `path` with `oidc_error=CODE` added to its query (keeps any hash). */
function withError(path: string, code: string): string {
  const u = new URL(path, 'http://inkling.invalid')
  u.searchParams.set('oidc_error', code)
  return u.pathname + u.search + u.hash
}

function loginErrorPath(code: string, returnTo: string): string {
  const q = new URLSearchParams({ oidc_error: code })
  if (returnTo !== '/') q.set('next', returnTo)
  return `/login?${q.toString()}`
}

interface PendingStart {
  url: string
  browserToken: string
}

/** Store a pending sign-in and build the provider URL. */
async function startFlow(returnTo: string, linkUserId: string | null): Promise<PendingStart> {
  const meta = await discover()
  const state = b64url(randomBytes(32))
  const nonce = b64url(randomBytes(32))
  const browserToken = b64url(randomBytes(32))
  const { verifier, challenge } = pkcePair()
  // Expired pending sign-ins of anyone are cleared here (index on expires_at); nothing else needs them.
  await db.delete(oidcLoginStates).where(lt(oidcLoginStates.expiresAt, new Date()))
  await db.insert(oidcLoginStates).values({
    stateHash: sha256hex(state),
    browserHash: sha256hex(browserToken),
    nonce,
    codeVerifier: verifier,
    returnTo,
    linkUserId,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  })
  // Connecting an account asks the provider to sign in again, so the identity that gets linked is
  // the one the person just typed in, not whatever session the provider happened to have.
  const url = authorizationUrl(meta, { state, nonce, challenge, prompt: linkUserId ? 'login' : undefined })
  return { url, browserToken }
}

function setStateCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(OIDC_COOKIE, token, {
    httpOnly: true,
    // Lax, not Strict: the provider sends the browser back with a cross-site top-level GET, and a
    // Strict cookie would be left out of exactly that request.
    sameSite: 'lax',
    path: COOKIE_PATH,
    secure: env.cookieSecure,
    maxAge: STATE_TTL_MS / 1000,
  })
}

function clearStateCookie(reply: FastifyReply): void {
  reply.clearCookie(OIDC_COOKIE, { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, secure: env.cookieSecure })
}

type AccountRow = {
  id: string
  email: string
  name: string
  isAdmin: boolean
  origin: 'local' | 'delegated' | 'oidc'
  passwordHash: string
  mustVerifyEmail: boolean
  emailVerifiedAt: Date | null
}

const accountCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  isAdmin: users.isAdmin,
  origin: users.origin,
  passwordHash: users.passwordHash,
  mustVerifyEmail: users.mustVerifyEmail,
  emailVerifiedAt: users.emailVerifiedAt,
}

/** OIDC_ALLOWED_DOMAINS applies to every sign-in and link with the provider. */
function assertDomainAllowed(claims: IdTokenClaims): void {
  const domains = env.oidc.allowedDomains
  if (domains.length === 0) return
  const email = emailClaim(claims)
  if (!email) throw new OidcError('OIDC_NO_EMAIL')
  // An unverified address proves nothing about the domain (anyone can type any address at some providers).
  if (!emailVerifiedClaim(claims) && !env.oidc.trustEmail) throw new OidcError('OIDC_EMAIL_UNVERIFIED')
  const domain = email.slice(email.lastIndexOf('@') + 1)
  if (!domains.includes(domain)) throw new OidcError('OIDC_DOMAIN_NOT_ALLOWED', `domain ${domain} not allowed`)
}

async function touchIdentity(issuer: string, subject: string, email: string | null): Promise<void> {
  await db
    .update(userIdentities)
    .set({ email, lastLoginAt: new Date() })
    .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)))
}

/**
 * Identity → account, following docs/adr/1161-*:
 *   1. (iss, sub) already linked → that account.
 *   2. An account with the same email exists → linked only with OIDC_LINK_EXISTING=1, the provider's
 *      email_verified=true, a local account, not an instance admin. Otherwise refused.
 *   3. No such account → created with OIDC_AUTO_CREATE=1 (no signup key), else refused.
 */
async function resolveAccount(req: FastifyRequest, claims: IdTokenClaims): Promise<AccountRow> {
  const issuer = claims.iss
  const subject = claims.sub
  const email = emailClaim(claims)

  const byIdentity = async () =>
    (
      await db
        .select(accountCols)
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)))
        .limit(1)
    )[0] as AccountRow | undefined

  const known = await byIdentity()
  if (known) {
    await touchIdentity(issuer, subject, email)
    return known
  }

  if (!email) throw new OidcError('OIDC_NO_EMAIL')
  const [same] = (await db.select(accountCols).from(users).where(eq(users.email, email)).limit(1)) as AccountRow[]
  if (same) {
    const verified = emailVerifiedClaim(claims) // OIDC_TRUST_EMAIL deliberately does not count here
    if (!env.oidc.linkExisting || !verified || same.origin !== 'local' || same.isAdmin) {
      throw new OidcError(
        'OIDC_EMAIL_TAKEN',
        `email belongs to an account that is not linked (linkExisting=${env.oidc.linkExisting}, verified=${verified}, origin=${same.origin}, admin=${same.isAdmin})`,
      )
    }
    try {
      await db.transaction(async (tx) => {
        await tx.insert(userIdentities).values({ issuer, subject, userId: same.id, email, lastLoginAt: new Date() })
        // The provider vouched for this very address: it counts as verified here too.
        if (!same.emailVerifiedAt) {
          await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, same.id))
        }
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      // Raced with another sign-in of the same identity, or the account already has one of this issuer.
      const again = await byIdentity()
      if (again) return again
      throw new OidcError('OIDC_LINK_CONFLICT', 'account already linked to another identity of this issuer')
    }
    req.log.info(`[oidc] linked identity to existing account ${same.id} by verified email`)
    return { ...same, emailVerifiedAt: same.emailVerifiedAt ?? new Date() }
  }

  if (!env.oidc.autoCreate) throw new OidcError('OIDC_NO_ACCOUNT')
  if (isDelegatedEmail(email)) throw new OidcError('OIDC_EMAIL_TAKEN', 'email in the delegated mirror domain')
  if (!emailVerifiedClaim(claims) && !env.oidc.trustEmail) throw new OidcError('OIDC_EMAIL_UNVERIFIED')
  // LIMIT_INSTANCE_STORAGE_MB (docs/adr/2532-*): a full server makes no new account, here as at sign-up
  if (await isInstanceFull()) throw instanceFullError()

  const name = displayNameClaim(claims, email)
  const locale = await requestLocale(req)
  // No password: a random argon2 hash, so password sign-in is never possible for this account.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'))
  try {
    const created = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email, name, passwordHash, origin: 'oidc', emailVerifiedAt: new Date() })
        .returning(accountCols)
      await tx.insert(userIdentities).values({ issuer, subject, userId: u.id, email, lastLoginAt: new Date() })
      const wsId = randomUUID()
      await tx.insert(workspaces).values({
        id: wsId,
        name: locale === 'ko' ? `${name}의 워크스페이스` : `${name}'s workspace`,
        ...(await generateInviteCodeColumns(tx, wsId)),
        createdBy: u.id,
      })
      await tx.insert(workspaceMembers).values({ workspaceId: wsId, userId: u.id, role: 'owner' })
      await assertWorkspacesTotalRoom(tx, 0, 'signup') // LIMIT_WORKSPACES_TOTAL (docs/adr/2531-*): SIGNUP_FULL
      return u as AccountRow
    })
    req.log.info(`[oidc] created account ${created.id}`)
    return created
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const again = await byIdentity()
    if (again) return again
    throw new OidcError('OIDC_EMAIL_TAKEN', 'email taken concurrently')
  }
}

/** Connect the identity to the account that started the link from Settings. */
async function linkIdentity(userId: string, claims: IdTokenClaims): Promise<void> {
  const email = emailClaim(claims)
  const [owner] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.issuer, claims.iss), eq(userIdentities.subject, claims.sub)))
    .limit(1)
  if (owner) {
    if (owner.userId !== userId) throw new OidcError('OIDC_ALREADY_LINKED')
    await touchIdentity(claims.iss, claims.sub, email)
    return
  }
  try {
    await db.insert(userIdentities).values({ issuer: claims.iss, subject: claims.sub, userId, email })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    throw new OidcError('OIDC_LINK_CONFLICT', 'account already linked to another identity of this issuer')
  }
}

export async function registerOidcRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/oidc/start', oidcRateLimit, async (req, reply) => {
    if (!oidcEnabled()) throw disabled()
    const returnTo = safeReturnTo((req.query as { returnTo?: unknown } | undefined)?.returnTo)
    let started: PendingStart
    try {
      started = await startFlow(returnTo, null)
    } catch (err) {
      const code = err instanceof OidcError ? err.code : 'OIDC_UNAVAILABLE'
      req.log.warn(`[oidc] start failed: ${err instanceof OidcError ? err.detail : 'internal error'}`)
      return reply.redirect(loginErrorPath(code, returnTo), 302)
    }
    setStateCookie(reply, started.browserToken)
    return reply.redirect(started.url, 302)
  })

  app.post('/auth/oidc/link', { preHandler: requireUser, ...oidcRateLimit }, async (req, reply) => {
    if (!oidcEnabled()) throw disabled()
    if (req.authVia !== 'cookie') throw forbidden('Can only be changed from a browser sign-in')
    const body = z.object({ returnTo: z.string().max(2000).optional() }).parse(req.body ?? {})
    const me = getUser(req)
    // A delegated mirror account signs in at its own service; an identity linked to it could never
    // be used (sign-in refuses delegated accounts), so it is refused here already.
    const [acct] = await db.select({ origin: users.origin }).from(users).where(eq(users.id, me.id)).limit(1)
    if (!acct || acct.origin === 'delegated') {
      throw new AppError(400, 'DELEGATED_ACCOUNT', `${env.delegatedAuthName} accounts cannot connect another sign-in`)
    }
    let started: PendingStart
    try {
      started = await startFlow(safeReturnTo(body.returnTo), me.id)
    } catch (err) {
      if (err instanceof OidcError) throw new AppError(503, err.code, 'Could not reach the sign-in provider')
      throw err
    }
    setStateCookie(reply, started.browserToken)
    return { url: started.url }
  })

  app.get('/auth/oidc/callback', oidcRateLimit, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v.length <= 4096 ? v : '')
    const browserToken = req.cookies?.[OIDC_COOKIE] ?? ''
    clearStateCookie(reply)

    let returnTo = '/'
    let linkUserId: string | null = null
    const fail = (err: unknown) => {
      const code: OidcErrorCode | string =
        err instanceof OidcError ? err.code : err instanceof AppError ? err.code : 'OIDC_UNAVAILABLE'
      const detail = err instanceof OidcError ? err.detail : err instanceof AppError ? err.code : 'internal error'
      req.log.warn(`[oidc] callback refused: ${code} (${detail})`)
      if (!(err instanceof OidcError) && !(err instanceof AppError)) req.log.error(err)
      return reply.redirect(linkUserId ? withError(returnTo, code) : loginErrorPath(code, returnTo), 302)
    }

    try {
      if (!oidcEnabled()) throw new OidcError('OIDC_DISABLED')
      assertNotBanned(req)
      const state = str(q.state)
      if (!state) {
        await recordFailure(req, 'oidc-state')
        throw new OidcError('OIDC_STATE_INVALID', 'no state')
      }
      const [pending] = await db
        .delete(oidcLoginStates)
        .where(and(eq(oidcLoginStates.stateHash, sha256hex(state)), gt(oidcLoginStates.expiresAt, new Date())))
        .returning()
      if (!pending) {
        await recordFailure(req, 'oidc-state')
        throw new OidcError('OIDC_STATE_INVALID', 'unknown or expired state')
      }
      returnTo = safeReturnTo(pending.returnTo)
      linkUserId = pending.linkUserId
      if (!browserToken || sha256hex(browserToken) !== pending.browserHash) {
        await recordFailure(req, 'oidc-state')
        throw new OidcError('OIDC_STATE_INVALID', 'state started in another browser')
      }

      const providerError = str(q.error)
      if (providerError) {
        throw new OidcError(
          providerError === 'access_denied' ? 'OIDC_CANCELLED' : 'OIDC_PROVIDER_ERROR',
          `provider error ${providerError.slice(0, 40)}`,
        )
      }
      const code = str(q.code)
      if (!code) throw new OidcError('OIDC_PROVIDER_ERROR', 'no code')

      const idToken = await exchangeCode(code, pending.codeVerifier)
      const claims = await verifyIdToken(idToken, { nonce: pending.nonce })
      if (env.oidc.requireMfa && !showsSecondFactor(claims)) {
        throw new OidcError('OIDC_MFA_REQUIRED', 'id_token shows no second factor (amr/acr)')
      }
      assertDomainAllowed(claims)

      // --- Connect to the signed-in account (from Settings) ---
      if (pending.linkUserId) {
        const cookie = req.cookies?.[SESSION_COOKIE]
        const current = cookie ? await getSessionUser(cookie) : null
        if (!current || current.id !== pending.linkUserId) {
          throw new OidcError('OIDC_LINK_SESSION', 'link finished in a different session')
        }
        await linkIdentity(current.id, claims)
        req.log.info(`[oidc] identity linked from settings to ${current.id}`)
        return reply.redirect(returnTo, 302)
      }

      // --- Sign in ---
      const account = await resolveAccount(req, claims)
      if (account.origin === 'delegated') throw new OidcError('OIDC_EMAIL_TAKEN', 'delegated account')
      if (
        account.origin === 'local' &&
        verificationEnforced() &&
        account.mustVerifyEmail &&
        !account.emailVerifiedAt
      ) {
        throw new OidcError('EMAIL_NOT_VERIFIED')
      }
      // Inkling's own second step still applies (docs/adr/1162-*): the challenge goes in the URL
      // fragment, which is neither sent to a server nor put in a Referer.
      if (await twoFactorEnabled(account.id)) {
        const challenge = await createLoginChallenge(account.id, account.passwordHash)
        const q2 = returnTo !== '/' ? `?${new URLSearchParams({ next: returnTo }).toString()}` : ''
        return reply.redirect(`/login${q2}#totp=${encodeURIComponent(challenge)}`, 302)
      }
      recordSuccess(req)
      await promoteIfNoAdmin(account.id)
      const { token, expiresAt } = await createSession(account.id)
      setSessionCookie(reply, token, expiresAt)
      return reply.redirect(returnTo, 302)
    } catch (err) {
      return fail(err)
    }
  })
}

/** Linked sign-ins of an account, for /auth/me (Settings › Account). */
export async function linkedLogins(
  userId: string,
): Promise<{ provider: 'oidc'; name: string; email: string | null; linkedAt: string; lastUsedAt: string | null }[]> {
  const rows = await db
    .select({
      issuer: userIdentities.issuer,
      email: userIdentities.email,
      createdAt: userIdentities.createdAt,
      lastLoginAt: userIdentities.lastLoginAt,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(userIdentities.createdAt)
  return rows.map((r) => ({
    provider: 'oidc' as const,
    // The configured button name for the current issuer; the issuer's host for an old one.
    name: r.issuer === env.oidc.issuer ? env.oidc.name : hostOf(r.issuer),
    email: r.email,
    linkedAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
  }))
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
