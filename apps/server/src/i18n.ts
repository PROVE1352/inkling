import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { db } from './db'
import { users } from './db/schema'
import { env } from './env'

// Server-side locale helpers (docs/adr/0903-server-locale-mail-templates.md).
// The server only localizes content it generates for people: emails, built-in page templates and
// default titles of pages it creates. API error messages stay English; the web client translates
// them by `code` (docs/adr/0902-*).

export type Locale = 'en' | 'ko'
export const LOCALES: readonly Locale[] = ['en', 'ko']

export function normalizeLocale(v: unknown): Locale | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (s === 'ko' || s.startsWith('ko-') || s.startsWith('ko_')) return 'ko'
  if (s === 'en' || s.startsWith('en-') || s.startsWith('en_')) return 'en'
  return null
}

/** A user's saved locale, else DEFAULT_LOCALE (env, default 'en'). */
export function resolveLocale(userLocale?: string | null): Locale {
  return normalizeLocale(userLocale) ?? env.defaultLocale
}

/** Locale for content created on behalf of `userId` (unknown user → DEFAULT_LOCALE). */
export async function localeOfUser(userId: string | null | undefined): Promise<Locale> {
  if (!userId) return env.defaultLocale
  const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1)
  return resolveLocale(row?.locale)
}

/** First supported language of an Accept-Language header (the web client sends its UI locale). */
export function headerLocale(req: FastifyRequest): Locale | null {
  const raw = req.headers['accept-language']
  if (typeof raw !== 'string') return null
  for (const part of raw.split(',')) {
    const n = normalizeLocale(part.split(';')[0])
    if (n) return n
  }
  return null
}

/**
 * Locale for content created by a request (new page from a template, default titles, template
 * gallery): the user's saved locale → Accept-Language (the web client sends the language it is
 * showing) → DEFAULT_LOCALE.
 */
export async function requestLocale(req: FastifyRequest, userId?: string | null): Promise<Locale> {
  if (userId) {
    const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1)
    const saved = normalizeLocale(row?.locale)
    if (saved) return saved
  }
  return headerLocale(req) ?? env.defaultLocale
}

/** BCP 47 tag for Intl. */
export function intlLocale(locale: Locale): string {
  return locale === 'ko' ? 'ko-KR' : 'en-US'
}

/** Date + time for emails, in the server time zone (TZ, default UTC) with the zone named. */
export function fmtMailDateTime(d: Date, locale: Locale): string {
  return d.toLocaleString(intlLocale(locale), {
    timeZone: process.env.TZ || 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
    timeZoneName: 'short',
  } as Intl.DateTimeFormatOptions)
}
