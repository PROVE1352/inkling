import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { SHARE_EXPIRED_CODE, SHARE_PASSWORD_REQUIRED_CODE } from '@inkling/shared'
import { hashPassword, verifyPassword } from './auth'
import { env } from './env'
import { AppError } from './errors'

/**
 * Visitor side of public link expiry and passwords (docs/adr/1170-*, 1171-*).
 *
 * The gate is evaluated on the link's root page (the shared page or the shared folder), before any
 * subtree, body or file work, by every public route: `/api/public/:token`, `…/f/:fileId`,
 * `…/p/:ref` and `…/p/:ref/f/:fileId`, and by the unfurl shell (`/s/…`, shareMeta.ts).
 *
 * Unlock cookie: `v1.<exp seconds>.<HMAC-SHA256 base64url>` over the link's token hash, the
 * stored argon2 password hash and the expiry. Bound to the token hash, so a cookie for one link
 * says nothing about another (and a re-published link has a new token). Bound to the password
 * hash, which gets a new salt on every set, so setting, changing or removing the password ends
 * every visitor's unlock without a version column. The HMAC key comes from APP_SECRET_KEY (HKDF,
 * purpose label) or, without it, from a random per-process key: visitors then unlock again after a
 * restart. Path = `/api/public/<token>` (the only place the browser needs it), httpOnly,
 * SameSite=Lax, Secure as the session cookie.
 */

export interface ShareGate {
  /** SHA-256 of the link token (pages.share_token). */
  tokenHash: string
  expiresAt: Date | null
  passwordHash: string | null
}

export const SHARE_UNLOCK_COOKIE = 'inkling_share'
/** An unlock lasts this long (and never past the link's expiry). */
export const SHARE_UNLOCK_TTL_MS = 12 * 3_600_000
/** Every unlock answer takes at least this long, whatever the outcome (docs/adr/1171-*). */
export const SHARE_UNLOCK_FLOOR_MS = 300

export const shareExpiredError = () => new AppError(410, SHARE_EXPIRED_CODE, 'This link has expired')
export const sharePasswordRequiredError = () =>
  new AppError(401, SHARE_PASSWORD_REQUIRED_CODE, 'This page is protected by a password')
export const sharePasswordInvalidError = () =>
  new AppError(401, 'SHARE_PASSWORD_INVALID', 'Incorrect password')

/** Server clock: the link has passed its expiry. */
export function shareExpired(gate: Pick<ShareGate, 'expiresAt'>, now = Date.now()): boolean {
  return gate.expiresAt !== null && gate.expiresAt.getTime() <= now
}

/** Gated links (expired or with a password) are kept out of search engines. */
export function shareGated(gate: ShareGate, now = Date.now()): boolean {
  return gate.passwordHash !== null || shareExpired(gate, now)
}

export function shareCookiePath(token: string): string {
  return `/api/public/${token}`
}

let processKey: Buffer | null = null
let derivedKey: { material: string; key: Buffer } | null = null

function macKey(): Buffer {
  const material = env.appSecretKey
  if (!material) {
    processKey ??= randomBytes(32)
    return processKey
  }
  if (derivedKey?.material !== material) {
    derivedKey = {
      material,
      key: Buffer.from(hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.alloc(0), 'inkling:share-unlock', 32)),
    }
  }
  return derivedKey.key
}

function mac(gate: ShareGate, exp: number): Buffer {
  return createHmac('sha256', macKey())
    .update(`share-unlock|v1|${gate.tokenHash}|${gate.passwordHash ?? ''}|${exp}`)
    .digest()
}

/** Cookie value for a visitor who just entered the right password. */
export function unlockCookieValue(gate: ShareGate, now = Date.now()): { value: string; expires: Date } {
  let expMs = now + SHARE_UNLOCK_TTL_MS
  if (gate.expiresAt) expMs = Math.min(expMs, gate.expiresAt.getTime())
  const exp = Math.floor(expMs / 1000)
  return { value: `v1.${exp}.${mac(gate, exp).toString('base64url')}`, expires: new Date(exp * 1000) }
}

/** Whether a presented cookie value unlocks this link right now. */
export function verifyUnlockCookie(gate: ShareGate, value: string | undefined, now = Date.now()): boolean {
  if (!value || !gate.passwordHash || value.length > 120) return false
  const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value)
  if (!m) return false
  const exp = Number(m[1])
  if (exp * 1000 <= now) return false
  const given = Buffer.from(m[2], 'base64url')
  const want = mac(gate, exp)
  return given.length === want.length && timingSafeEqual(given, want)
}

export function setUnlockCookie(reply: FastifyReply, token: string, gate: ShareGate): void {
  const { value, expires } = unlockCookieValue(gate)
  reply.setCookie(SHARE_UNLOCK_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: shareCookiePath(token),
    secure: env.cookieSecure,
    expires,
  })
}

/**
 * The gate every public route runs on the link's root page: expired → 410 SHARE_EXPIRED (not a
 * token guess, never counted as a failure); password without a valid unlock cookie → 401
 * SHARE_PASSWORD_REQUIRED. Neither answer carries anything about the page. Links without a
 * password never look at cookies.
 */
export function assertShareOpen(req: FastifyRequest, reply: FastifyReply, gate: ShareGate): void {
  const now = Date.now()
  if (shareGated(gate, now)) reply.header('X-Robots-Tag', 'noindex, nofollow')
  if (shareExpired(gate, now)) {
    reply.header('Cache-Control', 'no-store')
    throw shareExpiredError()
  }
  if (gate.passwordHash && !verifyUnlockCookie(gate, req.cookies?.[SHARE_UNLOCK_COOKIE], now)) {
    reply.header('Cache-Control', 'no-store')
    throw sharePasswordRequiredError()
  }
}

/**
 * Cache-Control for a public file of this link: shared caches may keep files of open links for
 * five minutes (as before), never past the expiry; files of password links stay in the visitor's
 * browser only.
 */
export function publicFileCacheControl(gate: ShareGate, now = Date.now()): string {
  let maxAge = 300
  if (gate.expiresAt) maxAge = Math.max(0, Math.min(maxAge, Math.floor((gate.expiresAt.getTime() - now) / 1000)))
  if (gate.passwordHash) return `private, max-age=${maxAge}`
  return maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store'
}

// ---------------------------------------------------------------------------
// Password check with a fixed cost
// ---------------------------------------------------------------------------

let dummyHash: Promise<string> | null = null

/** Hash used when there is nothing to compare with, so every unlock runs exactly one argon2 verify. */
function dummy(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(18).toString('base64url'))
  return dummyHash
}

/** argon2 verify against the link's hash, or against a dummy hash when it has none (always false). */
export async function checkSharePassword(passwordHash: string | null, password: string): Promise<boolean> {
  const target = passwordHash ?? (await dummy())
  let ok = false
  try {
    ok = await verifyPassword(target, password)
  } catch {
    ok = false
  }
  return ok && passwordHash !== null
}

/** Wait until `startedAt + floorMs`, so the answer time does not tell outcomes apart. */
export async function padResponseTime(startedAt: number, floorMs = SHARE_UNLOCK_FLOOR_MS): Promise<void> {
  const left = startedAt + floorMs - Date.now()
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}

export const hashSharePassword = (password: string): Promise<string> => hashPassword(password)
