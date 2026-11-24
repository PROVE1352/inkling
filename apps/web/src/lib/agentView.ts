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
 * The part of an anchor to show in a row: the last segment of a nested anchor (`a/b/c` → `…/c`), so the
 * rows under one parent do not all read as the parent once cut to width. The full anchor goes in a title.
 */
export function anchorTail(anchor: string): string {
  const i = anchor.lastIndexOf('/')
  return i < 0 ? anchor : `…/${anchor.slice(i + 1)}`
}

export interface ContextFragmentLike {
  pageId: string
  title: string
  anchor: string
  sections: { anchor: string }[]
  tokens: number
}

export interface ContextResultLike {
  fragments: ContextFragmentLike[]
  budget: number
  usedTokens: number
}

export interface ContextRow {
  pageId: string
  title: string
  /** First section of the fragment. */
  anchor: string
  /** Every section the fragment carries (neighbours are merged into one fragment), in page order. */
  anchors: string[]
  tokens: number
  onThisPage: boolean
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
    return { pageId: f.pageId, title: f.title, anchor: f.anchor, anchors, tokens: f.tokens, onThisPage: f.pageId === pageId }
  })
  return {
    rows,
    used: r.usedTokens,
    budget: r.budget,
    sections: rows.reduce((n, row) => n + row.anchors.length, 0),
  }
}

/**
 * The question filled in on the sample page (decision 4 of the 0.23 plan). Words from the sample's
 * "AI agents" section, so a word search finds it ("MCP" also finds it in a sample of the other language,
 * checked against the 0.23 server); kept as constants here, not read from the server's
 * sample text, so a change to the sample shows up in the test.
 */
export function sampleQuestion(locale: Locale): string {
  return locale === 'ko' ? '에이전트를 MCP 클라이언트에 연결하려면?' : 'How do I connect an agent to an MCP client?'
}
