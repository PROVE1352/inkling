import type { Locale } from '../i18n'

// "What an agent reads" (docs/adr/2389-*): pure helpers over the answers of the existing REST routes
// GET /pages/:id/outline and GET /context. Token counts are the server's estimates; nothing is
// counted again here.

/** The anchor the server gives the part of a page before its first heading (server context/chunker.ts). */
export const INTRO_ANCHOR = '_intro'

export interface OutlineSectionLike {
  anchor: string
  headingPath: string
  level: number
  tokens: number
  version: string
}

export interface OutlineLike {
  sections: OutlineSectionLike[]
  tokens: number
}

export interface OutlineRow extends OutlineSectionLike {
  /** Share of the page's tokens in whole percent; the rows of a non-empty page add up to 100. */
  pct: number
}

/**
 * Outline rows with each section's share of the page. Percentages are rounded by largest remainder so
 * they add up to 100; an empty page gives 0 everywhere. A section with tokens can round to 0 (the dialog
 * shows it as "<1%").
 */
export function outlineRows(o: OutlineLike): OutlineRow[] {
  const total = o.sections.reduce((n, s) => n + Math.max(0, s.tokens), 0)
  if (total <= 0) return o.sections.map((s) => ({ ...s, pct: 0 }))
  const exact = o.sections.map((s) => (Math.max(0, s.tokens) * 100) / total)
  const pct = exact.map(Math.floor)
  let left = 100 - pct.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    pct[i]++
    left--
  }
  return o.sections.map((s, i) => ({ ...s, pct: pct[i] }))
}

/**
 * The label find_context and read_page use for each anchor of a page (ADR 1212): the shortest run of
 * trailing segments (`parent/child` → `child`) that no other anchor on the page also ends with; read_page
 * accepts it in place of the full anchor. Same rule as the server's `shortAnchors` (context/chunker.ts),
 * counted with one map instead of comparing every pair, for pages with hundreds of sections.
 */
export function shortAnchors(anchors: string[]): Map<string, string> {
  const uniq = [...new Set(anchors)]
  const owners = new Map<string, number>()
  for (const a of uniq) {
    const segs = a.split('/')
    for (let k = 1; k <= segs.length; k++) {
      const suffix = segs.slice(segs.length - k).join('/')
      owners.set(suffix, (owners.get(suffix) ?? 0) + 1)
    }
  }
  const out = new Map<string, string>()
  for (const a of uniq) {
    const segs = a.split('/')
    let short = a
    for (let k = 1; k < segs.length; k++) {
      const suffix = segs.slice(segs.length - k).join('/')
      if (owners.get(suffix) === 1) {
        short = suffix
        break
      }
    }
    out.set(a, short)
  }
  return out
}

export interface ContextFragmentLike {
  pageId: string
  title: string
  anchor: string
  sections: { anchor: string; short?: string }[]
  tokens: number
  /** Cut to fit the budget; `fullTokens` is the uncut size when the server gives it. */
  truncated?: boolean
  fullTokens?: number
}

/** A matching section that did not fit the budget (the server also sends its `short` label). */
export interface MoreLike {
  pageId: string
  title: string
  anchor: string
  tokens: number
  short?: string
}

export interface ContextResultLike {
  fragments: ContextFragmentLike[]
  budget: number
  usedTokens: number
  more?: MoreLike[]
}

export interface ContextRow {
  pageId: string
  title: string
  /** First section of the fragment. */
  anchor: string
  /** Its short label as find_context prints it (`short` of the first section, else the anchor). */
  short: string
  /** Every section the fragment carries (neighbours are merged into one fragment), in page order. */
  anchors: string[]
  tokens: number
  onThisPage: boolean
  /**
   * Cut to fit: `full` is the uncut size of the section that was cut, or null when the server did not say.
   * The server cuts the fragment's last section and gives that section's size (context/rank.ts), so for a
   * fragment of several sections `full` is not comparable to the fragment's tokens (`merged`). Absent when whole.
   */
  cut?: { full: number | null; merged: boolean }
}

export interface ContextSummary {
  rows: ContextRow[]
  used: number
  budget: number
  /** Sections returned, counting each section of a merged fragment. */
  sections: number
}

/** One row per fragment find_context returns; `used` is the server's usedTokens as given. */
export function contextSummary(r: ContextResultLike, pageId: string): ContextSummary {
  const rows = r.fragments.map((f) => {
    const anchors = f.sections.length ? f.sections.map((s) => s.anchor) : [f.anchor]
    const short = f.sections[0]?.short || f.anchor
    const row: ContextRow = { pageId: f.pageId, title: f.title, anchor: f.anchor, short, anchors, tokens: f.tokens, onThisPage: f.pageId === pageId }
    if (f.truncated) row.cut = { full: typeof f.fullTokens === 'number' && f.fullTokens > 0 ? f.fullTokens : null, merged: anchors.length > 1 }
    return row
  })
  return {
    rows,
    used: r.usedTokens,
    budget: r.budget,
    sections: rows.reduce((n, row) => n + row.anchors.length, 0),
  }
}

/**
 * Why find_context stopped where it did: `budget` = matching sections were left out (`count` of them,
 * as the server lists them), `cut` = none was left out but one came back cut to fit, `matched` = it
 * returned everything that matched, whole, `none` = nothing matched.
 * (The response's `candidates` is not shown: it counts index rows before merging, per phrasing, so it is
 * not a number of sections a person could check.)
 */
export type StopReason = { kind: 'budget'; count: number; atLeast: boolean } | { kind: 'cut' } | { kind: 'matched' } | { kind: 'none' }

/** The server lists at most this many left-out sections (context/retrieve.ts): a full list means "or more". */
export const MORE_LISTED_MAX = 5

export function stopReason(r: ContextResultLike): StopReason {
  const more = r.more?.length ?? 0
  if (more > 0) return { kind: 'budget', count: more, atLeast: more >= MORE_LISTED_MAX }
  if (r.fragments.length === 0) return { kind: 'none' }
  // nothing left out, but a returned section was cut to fit: the budget was the limit all the same
  return r.fragments.some((f) => f.truncated) ? { kind: 'cut' } : { kind: 'matched' }
}

/** Whether a returned section was cut to fit (the hint to split long sections under more headings). */
export function anyCut(s: ContextSummary): boolean {
  return s.rows.some((r) => !!r.cut)
}

export interface LeftOutRow {
  pageId: string
  title: string
  anchor: string
  short: string
  tokens: number
  onThisPage: boolean
}

/** Rows shown before "N more" in the list of sections that did not fit. */
export const LEFT_OUT_SHOWN = 5

/**
 * The sections that did not fit, first `limit` of them (all when `all`), and how many are folded away.
 * The label is the server's `short`, else the shortest unique suffix among the anchors this answer has
 * for that page (shortAnchors).
 */
export function leftOut(r: ContextResultLike, pageId: string, all = false, limit = LEFT_OUT_SHOWN): { rows: LeftOutRow[]; hidden: number } {
  const more = r.more ?? []
  const perPage = new Map<string, string[]>()
  const add = (p: string, a: string) => perPage.set(p, [...(perPage.get(p) ?? []), a])
  for (const f of r.fragments) for (const s of f.sections.length ? f.sections : [{ anchor: f.anchor }]) add(f.pageId, s.anchor)
  for (const m of more) add(m.pageId, m.anchor)
  const shorts = new Map([...perPage].map(([p, as]) => [p, shortAnchors(as)]))
  const rows = more.map((m) => ({
    pageId: m.pageId,
    title: m.title,
    anchor: m.anchor,
    short: m.short || shorts.get(m.pageId)?.get(m.anchor) || m.anchor,
    tokens: m.tokens,
    onThisPage: m.pageId === pageId,
  }))
  const shown = all ? rows : rows.slice(0, limit)
  return { rows: shown, hidden: rows.length - shown.length }
}

/**
 * The question filled in on the sample page (docs/adr/2389-*). Words from the sample's "AI agents"
 * section, so a word search finds it ("MCP" also finds it in a sample of the other language); kept as
 * constants here, not read from the server's
 * sample text, so a change to the sample shows up in the test.
 */
export function sampleQuestion(locale: Locale): string {
  return locale === 'ko' ? '에이전트를 MCP 클라이언트에 연결하려면?' : 'How do I connect an agent to an MCP client?'
}
