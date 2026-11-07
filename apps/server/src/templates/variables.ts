import type { TemplateInputDTO } from '@inkling/shared'
import { TEMPLATE_MAX_INPUTS } from '@inkling/shared'
import { intlLocale, type Locale } from '../i18n'

/**
 * Template variables (docs/adr/0922-*, docs/TEMPLATES.md).
 *
 *   {{title}} {{date}} {{date:FORMAT}} {{time}} {{time:FORMAT}} {{weekday}} {{author}}
 *   {{workspace}} {{input:Question|default}} {{cursor}}
 *
 * plus a fixed subset of Obsidian Templater tags that are rewritten to the forms above before
 * substitution (docs/adr/0923-*):
 *
 *   <% tp.date.now("FORMAT", offsetDays?) %>  <% tp.file.title %>  <% tp.file.cursor() %>
 *
 * Nothing is ever evaluated: every other `<% … %>` / `<%* … %>` tag and every unknown `{{…}}` stays
 * as literal text. Pure string functions; the Yjs walk that calls them lives in structure.ts.
 */

export interface VarContext {
  /** Root page title ({{title}}). */
  title: string
  author: string
  workspace: string
  locale: Locale
  /** Wall-clock parts of the effective date/time in the creator's zone. */
  now: WallClock
  /** Answers to {{input:…}} prompts (question → answer). */
  inputs: Record<string, string>
}

/** A local date-time without a zone (already converted). month 1-12. */
export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

// ---------------------------------------------------------------------------
// time zone handling
// ---------------------------------------------------------------------------

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Wall-clock parts of `date` in `tz` (undefined → the process zone, i.e. TZ). */
export function wallClock(date: Date, tz?: string): WallClock {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(tz) ? tz : undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts: Record<string, number> = {}
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

/** Replace the date part of a wall clock with an ISO `YYYY-MM-DD` (the gallery's date field). */
export function withIsoDate(w: WallClock, iso: string | undefined): WallClock {
  if (!iso) return w
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return w
  return { ...w, year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

function addDays(w: WallClock, days: number): WallClock {
  if (!days) return w
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days))
  return { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

// ---------------------------------------------------------------------------
// formatting (moment.js token subset, no dependency)
// ---------------------------------------------------------------------------

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** Weekday 0 (Sunday) … 6 of a wall-clock date. */
function weekdayIndex(w: WallClock): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()
}

/** ISO 8601 week number and week-year. */
function isoWeek(w: WallClock): { week: number; year: number } {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return { week, year: d.getUTCFullYear() }
}

function nameOf(w: WallClock, locale: Locale, opts: Intl.DateTimeFormatOptions): string {
  // Noon UTC of that calendar day, formatted in UTC: the name never shifts across a zone line.
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, 12))
  return new Intl.DateTimeFormat(intlLocale(locale), { ...opts, timeZone: 'UTC' }).format(d)
}

function ordinal(n: number, locale: Locale): string {
  if (locale === 'ko') return `${n}일`
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

const TOKEN_RE =
  /\[([^\]]*)\]|YYYY|GGGG|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|WW|W/g

/**
 * Format a wall clock with moment.js-style tokens: YYYY YY MMMM MMM MM M DD D Do dddd ddd dd d
 * HH H hh h mm m ss s A a W WW GGGG and [literal text]. Anything else is copied as is.
 */
export function formatDate(w: WallClock, format: string, locale: Locale): string {
  return format.replace(TOKEN_RE, (tok, literal: string | undefined) => {
    if (literal !== undefined) return literal
    switch (tok) {
      case 'YYYY':
        return pad(w.year, 4)
      case 'YY':
        return pad(w.year % 100)
      case 'GGGG':
        return pad(isoWeek(w).year, 4)
      case 'MMMM':
        return nameOf(w, locale, { month: 'long' })
      case 'MMM':
        return nameOf(w, locale, { month: 'short' })
      case 'MM':
        return pad(w.month)
      case 'M':
        return String(w.month)
      case 'DD':
        return pad(w.day)
      case 'D':
        return String(w.day)
      case 'Do':
        return ordinal(w.day, locale)
      case 'dddd':
        return nameOf(w, locale, { weekday: 'long' })
      case 'ddd':
        return nameOf(w, locale, { weekday: 'short' })
      case 'dd':
        return nameOf(w, locale, { weekday: 'narrow' })
      case 'd':
        return String(weekdayIndex(w))
      case 'HH':
        return pad(w.hour)
      case 'H':
        return String(w.hour)
      case 'hh':
        return pad(w.hour % 12 || 12)
      case 'h':
        return String(w.hour % 12 || 12)
      case 'mm':
        return pad(w.minute)
      case 'm':
        return String(w.minute)
      case 'ss':
        return pad(w.second)
      case 's':
        return String(w.second)
      case 'A':
        return locale === 'ko' ? (w.hour < 12 ? '오전' : '오후') : w.hour < 12 ? 'AM' : 'PM'
      case 'a':
        return locale === 'ko' ? (w.hour < 12 ? '오전' : '오후') : w.hour < 12 ? 'am' : 'pm'
      case 'WW':
        return pad(isoWeek(w).week)
      case 'W':
        return String(isoWeek(w).week)
      default:
        return tok
    }
  })
}

// ---------------------------------------------------------------------------
// Templater compatibility (rewrite only — never evaluated)
// ---------------------------------------------------------------------------

const TP_DATE_NOW_RE =
  /<%\s*tp\.date\.now\(\s*(?:"([^"\n]*)"|'([^'\n]*)')?\s*(?:,\s*(-?\d{1,4})\s*)?\)\s*%>/g
const TP_TITLE_RE = /<%\s*tp\.file\.title\s*%>/g
const TP_CURSOR_RE = /<%\s*tp\.file\.cursor\(\s*\d*\s*\)\s*%>/g

/** Marker for an offset date (only produced by the Templater rewrite). */
const OFFSET_SEP = '\u0000'

/** Rewrite the supported Templater tags to {{…}} variables; leave every other tag untouched. */
export function rewriteTemplater(s: string): string {
  if (!s.includes('<%')) return s
  return s
    .replace(TP_DATE_NOW_RE, (_m, dq?: string, sq?: string, offset?: string) => {
      const fmt = dq ?? sq ?? 'YYYY-MM-DD'
      const off = offset ? Number(offset) : 0
      return off ? `{{date:${fmt}${OFFSET_SEP}${off}}}` : `{{date:${fmt}}}`
    })
    .replace(TP_TITLE_RE, '{{title}}')
    .replace(TP_CURSOR_RE, '{{cursor}}')
}

// ---------------------------------------------------------------------------
// substitution
// ---------------------------------------------------------------------------

const VAR_RE =
  /\{\{\s*(title|date|time|weekday|author|workspace|cursor|input)(?:\s*:((?:[^}]|\}(?!\}))*))?\s*\}\}/g

/** Whether a string may contain a variable or a Templater tag (cheap pre-check). */
export function hasVariables(s: string): boolean {
  return s.includes('{{') || s.includes('<%')
}

/** Parse the argument of {{input:Question|default}}. */
function parseInput(arg: string): TemplateInputDTO | null {
  const i = arg.indexOf('|')
  const name = (i < 0 ? arg : arg.slice(0, i)).trim()
  if (!name) return null
  return { name: name.slice(0, 200), default: i < 0 ? '' : arg.slice(i + 1).trim() }
}

export interface RenderResult {
  text: string
  /** Index of the first {{cursor}} in `text` (removed from it), if any. */
  cursor?: number
}

/**
 * Substitute variables in one text run. Unknown names, malformed tags and anything not listed
 * stay literally. {{cursor}} is removed; its position is reported (first one only) when
 * `allowCursor` is set, otherwise it just disappears.
 */
export function renderString(input: string, ctx: VarContext, allowCursor = false): RenderResult {
  if (!hasVariables(input)) return { text: input }
  const s = rewriteTemplater(input)
  let out = ''
  let last = 0
  let cursor: number | undefined
  VAR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = VAR_RE.exec(s)) !== null) {
    out += s.slice(last, m.index)
    last = m.index + m[0].length
    const name = m[1]
    const arg = m[2]
    let rep: string | null
    switch (name) {
      case 'title':
        rep = arg === undefined ? ctx.title : null
        break
      case 'author':
        rep = arg === undefined ? ctx.author : null
        break
      case 'workspace':
        rep = arg === undefined ? ctx.workspace : null
        break
      case 'weekday':
        rep = arg === undefined ? formatDate(ctx.now, 'dddd', ctx.locale) : null
        break
      case 'date': {
        if (arg === undefined) {
          rep = formatDate(ctx.now, 'YYYY-MM-DD', ctx.locale)
        } else {
          const [fmt, off] = arg.split(OFFSET_SEP)
          rep = fmt.trim() ? formatDate(addDays(ctx.now, Number(off ?? 0) || 0), fmt, ctx.locale) : null
        }
        break
      }
      case 'time':
        rep = formatDate(ctx.now, arg === undefined || !arg.trim() ? 'HH:mm' : arg, ctx.locale)
        break
      case 'input': {
        const p = arg === undefined ? null : parseInput(arg)
        if (!p) {
          rep = null
          break
        }
        const v = Object.prototype.hasOwnProperty.call(ctx.inputs, p.name) ? ctx.inputs[p.name] : ''
        rep = v.trim() ? v : p.default
        break
      }
      case 'cursor':
        if (arg !== undefined) {
          rep = null
          break
        }
        if (allowCursor && cursor === undefined) cursor = out.length
        rep = ''
        break
      default:
        rep = null
    }
    // Unknown form (e.g. {{title:x}}): keep the original text (offset marker made visible).
    out += rep ?? m[0].replace(OFFSET_SEP, ',')
  }
  out += s.slice(last)
  return cursor === undefined ? { text: out } : { text: out, cursor }
}

/** Collect {{input:…}} prompts (first occurrence wins, at most TEMPLATE_MAX_INPUTS). */
export function collectInputs(texts: Iterable<string>, into: TemplateInputDTO[] = []): TemplateInputDTO[] {
  const seen = new Set(into.map((i) => i.name))
  for (const raw of texts) {
    if (!hasVariables(raw)) continue
    const s = rewriteTemplater(raw)
    VAR_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = VAR_RE.exec(s)) !== null) {
      if (m[1] !== 'input' || m[2] === undefined) continue
      const p = parseInput(m[2])
      if (!p || seen.has(p.name)) continue
      if (into.length >= TEMPLATE_MAX_INPUTS) return into
      seen.add(p.name)
      into.push(p)
    }
  }
  return into
}

/** Whether a text contains {{cursor}} (or the Templater cursor tag). */
export function hasCursor(s: string): boolean {
  return /\{\{\s*cursor\s*\}\}/.test(rewriteTemplater(s))
}
