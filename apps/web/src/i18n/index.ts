import { useSyncExternalStore } from 'react'
import { en, type MessageKey } from './en'
import { ko } from './ko'

// UI localization (docs/adr/0900-i18n-architecture.md).
//
// - Dictionaries are flat `{ 'namespace.key': 'text' }` objects, one file per area under
//   ./en and ./ko, merged in en.ts / ko.ts. English is the source of truth; a key missing in
//   Korean falls back to English (and warns once in dev builds).
// - `t()` reads a module-level locale, so it works in plain functions as well as in components.
//   The app root is keyed on the locale (main.tsx), so switching language remounts the tree and
//   every `t()` call in render re-runs. Never call `t()` at module top level: the value would be
//   frozen in whatever language was active when the module was first imported.
// - Locale resolution order (docs/adr/0901-locale-resolution.md): the user's saved choice →
//   the server's DEFAULT_LOCALE (/auth/mode) → navigator.languages → 'en'.

export type Locale = 'en' | 'ko'
export const LOCALES: readonly Locale[] = ['en', 'ko']

export type { MessageKey }

/** Plural base keys: `foo` when the dictionary has `foo_one` / `foo_other`. */
type PluralBase = { [K in MessageKey]: K extends `${infer B}_other` ? B : never }[MessageKey]
export type TKey = MessageKey | PluralBase
export type TParams = Record<string, string | number | null | undefined>

const dicts: Record<Locale, Partial<Record<MessageKey, string>>> = { en, ko }

/** Explicit per-user choice (mirrors users.locale on the server once signed in). */
const USER_KEY = 'inkling-locale'
/** Last DEFAULT_LOCALE seen from /auth/mode — lets the first paint use it before the fetch returns. */
const SERVER_KEY = 'inkling-locale-default'

export function normalizeLocale(v: unknown): Locale | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (s === 'ko' || s.startsWith('ko-') || s.startsWith('ko_')) return 'ko'
  if (s === 'en' || s.startsWith('en-') || s.startsWith('en_')) return 'en'
  return null
}

function readStorage(key: string): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem(key))
  } catch {
    return null
  }
}

function writeStorage(key: string, value: Locale | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // storage unavailable (private mode, tests) — the in-memory value still applies
  }
}

function browserLocale(): Locale | null {
  if (typeof navigator === 'undefined') return null
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const l of langs) {
    const n = normalizeLocale(l)
    if (n) return n
  }
  return null
}

let userChoice: Locale | null = readStorage(USER_KEY)
let serverDefault: Locale | null = readStorage(SERVER_KEY)
let current: Locale = resolve()
const listeners = new Set<() => void>()

function resolve(): Locale {
  return userChoice ?? serverDefault ?? browserLocale() ?? 'en'
}

function update(): void {
  const next = resolve()
  if (typeof document !== 'undefined') document.documentElement.lang = next
  if (next === current) return
  current = next
  listeners.forEach((cb) => cb())
}

export function getLocale(): Locale {
  return current
}

/** The explicit choice, or null when following the server/browser default. */
export function getLocaleChoice(): Locale | null {
  return userChoice
}

/** Set (or clear, with null) the explicit choice. Persisting it server-side is the caller's job. */
export function setLocaleChoice(locale: Locale | null): void {
  userChoice = locale
  writeStorage(USER_KEY, locale)
  update()
}

/** DEFAULT_LOCALE from /auth/mode (null when the server does not set one). */
export function setServerDefaultLocale(locale: unknown): void {
  serverDefault = normalizeLocale(locale)
  writeStorage(SERVER_KEY, serverDefault)
  update()
}

/** users.locale from /auth/me. null/undefined means "no preference" — keep the local choice. */
export function adoptUserLocale(locale: unknown): void {
  const n = normalizeLocale(locale)
  if (!n || n === userChoice) return
  setLocaleChoice(n)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}

/** Translation hook: subscribes the component to locale changes and returns `t`. */
export function useT(): typeof t {
  useLocale()
  return t
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const isDev = (() => {
  try {
    return !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV
  } catch {
    return false
  }
})()
const warned = new Set<string>()

function lookup(key: string): string | undefined {
  const own = (dicts[current] as Record<string, string | undefined>)[key]
  if (own !== undefined) return own
  const fallback = (en as Record<string, string | undefined>)[key]
  if (fallback !== undefined && current !== 'en' && isDev && !warned.has(`${current}:${key}`)) {
    warned.add(`${current}:${key}`)
    console.warn(`[i18n] missing "${current}" translation for "${key}"`)
  }
  return fallback
}

const pluralRules = new Map<Locale, Intl.PluralRules>()
function pluralCategory(n: number): string {
  let pr = pluralRules.get(current)
  if (!pr) {
    pr = new Intl.PluralRules(current)
    pluralRules.set(current, pr)
  }
  return pr.select(n)
}

function interpolate(text: string, params?: TParams): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name]
    if (v === undefined || v === null) return m
    return typeof v === 'number' ? fmtNumber(v) : v
  })
}

/**
 * Translate `key`. `{name}` placeholders are filled from `params` (numbers are locale-formatted).
 * With a numeric `params.count`, `key_one` / `key_other` (Intl.PluralRules categories) are tried
 * before `key` itself. Unknown keys return the key, so a typo is visible on screen.
 */
export function t(key: TKey, params?: TParams): string {
  let text: string | undefined
  const count = params?.count
  if (typeof count === 'number') {
    text = lookup(`${key}_${pluralCategory(count)}`) ?? lookup(`${key}_other`)
  }
  text ??= lookup(key)
  if (text === undefined) {
    if (isDev && !warned.has(`?:${key}`)) {
      warned.add(`?:${key}`)
      console.warn(`[i18n] unknown key "${key}"`)
    }
    return key
  }
  return interpolate(text, params)
}

/** For keys built at runtime (e.g. `errors.${code}`): the translation, or undefined if absent. */
export function tMaybe(key: string, params?: TParams): string | undefined {
  const text = lookup(key)
  return text === undefined ? undefined : interpolate(text, params)
}

// ---------------------------------------------------------------------------
// Formatting (Intl, current locale, browser time zone)
// ---------------------------------------------------------------------------

/** BCP 47 tag used for Intl formatters. */
export function intlLocale(locale: Locale = current): string {
  return locale === 'ko' ? 'ko-KR' : 'en-US'
}

const fmtCache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>()
function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(
  kind: string,
  opts: object | undefined,
  make: (tag: string) => T,
): T {
  const k = `${current}|${kind}|${opts ? JSON.stringify(opts) : ''}`
  let f = fmtCache.get(k) as T | undefined
  if (!f) {
    f = make(intlLocale())
    fmtCache.set(k, f)
  }
  return f
}

export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return cached('n', opts, (tag) => new Intl.NumberFormat(tag, opts)).format(n)
}

function toDate(v: Date | string | number): Date | null {
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Date with Intl options. Default: medium date ("Nov 7, 2026" / "2026. 11. 7."). */
export function fmtDate(
  v: Date | string | number,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const d = toDate(v)
  return d ? cached('d', opts, (tag) => new Intl.DateTimeFormat(tag, opts)).format(d) : ''
}

/** Short date + time ("Nov 7, 2026, 14:05" / "2026. 11. 7. 14:05"). */
export function fmtDateTime(v: Date | string | number): string {
  return fmtDate(v, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

/** Local 'YYYY-MM-DD' (no time zone shift) → Date at local midnight, or null. */
export function parseYmd(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** "3 minutes ago" in the UI locale. Under a minute (or in the future) → "just now". */
export function fmtRelative(v: Date | string | number, now = Date.now()): string {
  const d = toDate(v)
  if (!d) return ''
  const sec = Math.floor((now - d.getTime()) / 1000)
  if (sec < 60) return t('time.justNow')
  const rtf = cached('r', undefined, (tag) => new Intl.RelativeTimeFormat(tag, { numeric: 'always' }))
  const min = Math.floor(sec / 60)
  if (min < 60) return rtf.format(-min, 'minute')
  const hour = Math.floor(min / 60)
  if (hour < 24) return rtf.format(-hour, 'hour')
  const day = Math.floor(hour / 24)
  if (day < 7) return rtf.format(-day, 'day')
  if (day < 30) return rtf.format(-Math.floor(day / 7), 'week')
  if (day < 365) return rtf.format(-Math.floor(day / 30), 'month')
  return rtf.format(-Math.floor(day / 365), 'year')
}

/** Weekday names starting at Sunday, in the current locale ('short' → "Sun"). */
export function weekdayNames(width: 'narrow' | 'short' | 'long' = 'short'): string[] {
  const f = cached('w', { width }, (tag) => new Intl.DateTimeFormat(tag, { weekday: width }))
  // 2023-01-01 was a Sunday
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2023, 0, 1 + i)))
}

/** Month names January..December in the current locale. */
export function monthNames(width: 'short' | 'long' = 'long'): string[] {
  const f = cached('m', { width }, (tag) => new Intl.DateTimeFormat(tag, { month: width }))
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(2023, i, 1)))
}

/** Month and year, e.g. "November 2026". */
export function fmtMonthYear(year: number, monthIndex: number): string {
  return fmtDate(new Date(year, monthIndex, 1), { year: 'numeric', month: 'long' })
}

/** Join a list ("a, b, and c"). */
export function fmtList(items: string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  try {
    return new Intl.ListFormat(intlLocale(), { type }).format(items)
  } catch {
    return items.join(', ')
  }
}
