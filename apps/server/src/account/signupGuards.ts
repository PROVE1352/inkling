import { isIP } from 'node:net'
import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { env } from '../env'
import { AppError } from '../errors'
import { signupIpKey } from '../ipPrefix'
import { limits } from '../limits'
import type { Tx } from '../pageTree'
import type { SignupContext, SignupHook, SignupUser } from '../signupHooks'

/**
 * Sign-up limits (docs/adr/2516-*), registered as one sign-up hook from account/register.ts. Every
 * part does nothing while its setting is unset, so a server without them signs up as in 0.21.1.
 *
 *   SIGNUP_MAX_USERS        before: cheap refusal; on: recount under a lock inside the account's
 *                           transaction (concurrent sign-ups cannot pass the cap). The first admin made
 *                           with the setup code is exempt.
 *   SIGNUP_PER_IP_PER_DAY   on: count signup_events of the IP (signupIpKey: IPv4, or the IPv6 /56, since
 *                           the security fix F6) over 24 h under a per-IP lock, then record this one.
 *                           A sign-up refused because the email or ID is taken is recorded apart
 *                           (`taken:<key>`): after TAKEN_PER_IP_PER_DAY of them the address gets
 *                           SIGNUP_IP_LIMIT for every sign-up (F10: no unbounded probing of IDs).
 *   SIGNUP_PER_HOUR         on: count signup_events of the whole server over the last hour under one
 *                           lock (429 SIGNUP_RATE_LIMIT), then record this one (docs/adr/2537-*).
 *                           Rows only exist while one of the two is set.
 *   bot checks              only while one of the limits above is set: the hidden `website` field must
 *                           be empty and the form must have been on screen for 2 s (`formMs`).
 *   ACCOUNT_LIFETIME_DAYS   on: expires_at = now() + N days, except for admins (user.isAdmin is final).
 */

/** Advisory lock key of the account cap (a different key from the admin lock, always taken after it). */
const SIGNUP_CAP_LOCK = 4_651_202
/** Advisory lock key of SIGNUP_PER_HOUR (taken after the cap lock and the per-IP lock). */
const SIGNUP_RATE_LOCK = 4_651_203
/** "This email or ID is taken" answers one address gets in 24 hours while SIGNUP_PER_IP_PER_DAY is set. */
export const TAKEN_PER_IP_PER_DAY = 10
export const MIN_FORM_MS = 2_000

export const signupChecksOn = () => limits.signupMaxUsers !== null || limits.signupPerIpPerDay !== null || limits.signupPerHour !== undefined

const full = () => new AppError(403, 'SIGNUP_FULL', 'This server is not taking new accounts right now')
const ipLimit = () => new AppError(429, 'SIGNUP_IP_LIMIT', 'Too many accounts were made from this network today. Try again tomorrow.')
/** Hidden field filled, or sent too fast: an error, not a fake success (see the ADR). */
const rateLimit = () => new AppError(429, 'SIGNUP_RATE_LIMIT', 'This server has taken as many new accounts as it allows for now. Try again in an hour.')
const botCheck = () => new AppError(400, 'SIGNUP_CHECK_FAILED', 'Please wait a moment and send the form again')

async function userCount(exec: Pick<Tx, 'execute'>): Promise<number> {
  const [r] = (await exec.execute(sql`SELECT count(*)::int AS n FROM users`)) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

async function ipCount(exec: Pick<Tx, 'execute'>, ip: string): Promise<number> {
  const [r] = (await exec.execute(sql`
    SELECT count(*)::int AS n FROM signup_events WHERE ip = ${ip} AND created_at > now() - interval '24 hours'
  `)) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

/** Sign-ups of the whole server in the last hour (taken-ID records are not sign-ups). */
async function hourCount(exec: Pick<Tx, 'execute'>): Promise<number> {
  const [r] = (await exec.execute(sql`
    SELECT count(*)::int AS n FROM signup_events
     WHERE created_at > now() - interval '1 hour' AND ip NOT LIKE 'taken:%'
  `)) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

const takenKey = (ip: string) => `taken:${signupIpKey(ip)}`
/** The taken-ID count is kept while the per-IP limit is on (it needs the real client address too). */
const takenCountOn = () => limits.signupPerIpPerDay !== null

export async function beforeSignup(ctx: SignupContext): Promise<void> {
  if (!signupChecksOn()) return
  noteSignupAddress(ctx.ip, (m) => ctx.req.log.warn(m))
  const raw = (ctx.rawBody && typeof ctx.rawBody === 'object' ? ctx.rawBody : {}) as Record<string, unknown>
  if (!ctx.setupCode) {
    if (typeof raw.website === 'string' && raw.website.trim() !== '') throw botCheck()
    const ms = typeof raw.formMs === 'number' ? raw.formMs : null
    if (ms === null || !Number.isFinite(ms) || ms < MIN_FORM_MS) throw botCheck()
  }
  if (limits.signupMaxUsers !== null && !ctx.setupCode && (await userCount(db)) >= limits.signupMaxUsers) throw full()
  if (limits.signupPerIpPerDay !== null && !ctx.setupCode && (await ipCount(db, signupIpKey(ctx.ip))) >= limits.signupPerIpPerDay) throw ipLimit()
  // before the account insert can answer "taken": a prober learns nothing more once refused
  if (takenCountOn() && !ctx.setupCode && (await ipCount(db, takenKey(ctx.ip))) >= TAKEN_PER_IP_PER_DAY) throw ipLimit()
  if (limits.signupPerHour !== undefined && !ctx.setupCode && (await hourCount(db)) >= limits.signupPerHour) throw rateLimit()
}

export async function onSignup(tx: Tx, user: SignupUser, ctx: SignupContext): Promise<void> {
  if (limits.signupMaxUsers !== null && !ctx.setupCode) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SIGNUP_CAP_LOCK})`)
    // the new row is counted (same transaction); committed rows of other sign-ups too (read committed)
    if ((await userCount(tx)) > limits.signupMaxUsers) throw full()
  }
  const ip = signupIpKey(ctx.ip)
  if (limits.signupPerIpPerDay !== null && !ctx.setupCode) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'signup-ip:' + ip}))`)
    if ((await ipCount(tx, ip)) >= limits.signupPerIpPerDay) throw ipLimit()
  }
  if (limits.signupPerHour !== undefined && !ctx.setupCode) {
    // one lock for the whole server: concurrent sign-ups cannot pass the hourly number
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SIGNUP_RATE_LOCK})`)
    if ((await hourCount(tx)) >= limits.signupPerHour) throw rateLimit()
  }
  if ((limits.signupPerIpPerDay !== null || limits.signupPerHour !== undefined) && !ctx.setupCode) {
    await tx.execute(sql`INSERT INTO signup_events (ip) VALUES (${ip})`)
  }
  if (limits.accountLifetimeDays !== null && !user.isAdmin) {
    await tx.execute(sql`
      UPDATE users SET expires_at = now() + make_interval(days => ${limits.accountLifetimeDays}) WHERE id = ${user.id}
    `)
  }
}

export const signupGuardHook: SignupHook = { before: beforeSignup, on: onSignup }

/**
 * A sign-up refused because the email or sign-in ID is taken (routes/auth.ts, after the account's
 * transaction rolled back): recorded for the address so the answers are limited (F10). Nothing
 * without SIGNUP_PER_IP_PER_DAY, and never for the setup code.
 */
export async function noteTakenSignup(ctx: SignupContext): Promise<void> {
  if (!takenCountOn() || ctx.setupCode) return
  await db.execute(sql`INSERT INTO signup_events (ip) VALUES (${takenKey(ctx.ip)})`)
}

/**
 * Whether every sign-up would look like it comes from one address (docs/adr/2516-*): the per-IP cap
 * needs the client address, which behind a proxy only X-Forwarded-For from a TRUST_PROXY address
 * carries. Returns the boot warning, or null.
 */
export function proxyWarning(): string | null {
  if (limits.signupPerIpPerDay === null) return null
  if (env.trustProxy === false) {
    return '[inkling] SIGNUP_PER_IP_PER_DAY is set but TRUST_PROXY is off: behind a reverse proxy every sign-up has the proxy\'s address and shares one daily count. Set TRUST_PROXY to the proxy\'s address (the default loopback,uniquelocal covers Caddy on the same host or the Docker network).'
  }
  return null
}

let warnedLocal = false

/**
 * At run time: a sign-up whose address is itself a trusted proxy address (loopback or a private
 * range) most likely came through a proxy that did not send X-Forwarded-For. Logged once.
 */
export function noteSignupAddress(ip: string, log: (msg: string) => void): void {
  if (warnedLocal || limits.signupPerIpPerDay === null) return
  const v4 = ip.replace(/^::ffff:/i, '')
  const local = isIP(v4) === 4 ? /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4) : ip === '::1' || /^f[cd]/i.test(ip)
  if (!local) return
  warnedLocal = true
  log(`[inkling] a sign-up came from a local or private address (${signupIpKey(ip)}): if the server sits behind a reverse proxy, the proxy must send X-Forwarded-For and TRUST_PROXY must include its address, or SIGNUP_PER_IP_PER_DAY counts every sign-up as one address`)
}
