import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { userConsents } from '../db/schema'
import { AppError } from '../errors'
import { BoundedLru } from '../lru'
import type { Tx } from '../pageTree'
import type { LegalBundle } from './bundle'

/**
 * Consent to the documents of LEGAL_DIR (docs/adr/2519-*): checking what a sign-up or the consent
 * screen sends, writing one user_consents row per ticked item, and "has this person agreed to every
 * required item of the current version", which the request gate asks on every request.
 */

let active: LegalBundle | null = null

/** The bundle loaded from LEGAL_DIR, or null when the server has none (nothing of this piece shows). */
export function activeLegal(): LegalBundle | null {
  return active
}

export function setActiveLegal(b: LegalBundle | null): void {
  active = b
  consentCache.clear()
}

/**
 * Only "agreed" is cached: it cannot turn false while the process runs (the version is fixed until a
 * restart, and consent rows go only with the account). "Not agreed" is read from the database each
 * time, so a consent written by any path counts on the next request. Keyed by version and user.
 */
const consentCache = new BoundedLru<true>(20_000, 10 * 60_000)
const cacheKey = (version: string, userId: string) => `${version}:${userId}`

export function forgetConsent(userId: string): void {
  if (active) consentCache.deletePrefix(cacheKey(active.version, userId))
}

/** Every required item of the current version has a consent row for this person. */
export async function hasConsented(userId: string, bundle: LegalBundle = active!): Promise<boolean> {
  const required = bundle.items.filter((i) => i.required).map((i) => i.id)
  if (required.length === 0) return true
  const key = cacheKey(bundle.version, userId)
  if (consentCache.get(key)) return true
  const rows = await db
    .selectDistinct({ itemId: userConsents.itemId })
    .from(userConsents)
    .where(and(eq(userConsents.userId, userId), eq(userConsents.version, bundle.version), inArray(userConsents.itemId, required)))
  const ok = rows.length === required.length
  if (ok) consentCache.set(key, true)
  return ok
}

export function consentRequired(bundle: LegalBundle, message: string, status: 400 | 403 = 400): AppError {
  return new AppError(status, 'CONSENT_REQUIRED', message, undefined, { version: bundle.version })
}

/**
 * The ticked ids a request sent, checked against the current version: the same version, only known
 * items, every required item. Returns the ids to record (deduplicated, in signup.json order).
 */
export function checkConsents(bundle: LegalBundle, consents: unknown, legalVersion: unknown): string[] {
  if (legalVersion !== bundle.version) {
    throw consentRequired(
      bundle,
      typeof legalVersion === 'string'
        ? 'The terms changed since this page was loaded; read them again and agree to the current version'
        : 'Agree to the terms of this server to continue',
    )
  }
  const ticked = new Set(Array.isArray(consents) ? consents.filter((c): c is string => typeof c === 'string') : [])
  const known = new Set(bundle.items.map((i) => i.id))
  const unknown = [...ticked].filter((id) => !known.has(id))
  if (unknown.length) throw consentRequired(bundle, `Unknown consent item: ${unknown.slice(0, 3).join(', ')}`)
  const missing = bundle.items.filter((i) => i.required && !ticked.has(i.id)).map((i) => i.id)
  if (missing.length) throw consentRequired(bundle, `Required items are not ticked: ${missing.join(', ')}`)
  return bundle.items.filter((i) => ticked.has(i.id)).map((i) => i.id)
}

/** One row per ticked item, in the caller's transaction. */
export async function recordConsents(tx: Tx, userId: string, itemIds: string[], version: string, ip: string | null): Promise<void> {
  if (itemIds.length === 0) return
  await tx.insert(userConsents).values(itemIds.map((itemId) => ({ userId, itemId, version, ip })))
}
