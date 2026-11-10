import type { Fragment } from './rank'
import { HEADER_FACTS_TOKENS } from './rank'
import type { FindContextResult } from './retrieve'
import { estimateTokens, truncateToTokens } from './tokens'

/**
 * find_context with several queries (docs/adr/1720-* .. 1722-*). Pure functions, no database: the
 * per-query results come from the ordinary retrieval (through its cache, contextCache.ts) and are
 * merged here with Reciprocal Rank Fusion into one answer under ONE token budget.
 *
 *   - Unit of ranking: a section (`pageId#anchor`). A query's ranked list is its fragments in order,
 *     then its "more" pointers; a fragment with several sections gives all of them its rank.
 *   - RRF: score(s) = Σ over lists 1 / (k + rank), k = 60. Ties: first appearance (list, rank), then key.
 *   - Extra ranked lists (semantic candidates, docs/adr/1722-*) join the same sum. They carry no text;
 *     an item with a `fragment` attached becomes a text piece like a lexical fragment.
 *   - Output: each section at most once. Pieces (fragments) are taken in fused order while the shared
 *     budget lasts; a piece whose sections were all shown is dropped, one that overlaps a shown piece
 *     only in part is not printed (its other sections become pointers). Every printed fragment says
 *     which lists found it (`matched`).
 * Same inputs → same output: no clock, no randomness, a total order everywhere.
 */

export const RRF_K = 60
/** Different queries per find_context call (after normalising and removing duplicates). */
export const MAX_QUERIES = 5
/** Pointer lines in "Also relevant", as for one query. */
const MAX_MORE = 5
/** A piece that does not fit is cut only when at least this many tokens are left for its text. */
const MIN_TAIL = 80

/** One item of an extra ranked list; `anchor: null` means the page as a whole. */
export interface ExtraItem {
  pageId: string
  anchor: string | null
  score?: number
  /** Optional facts for a pointer line when no query found the item. */
  title?: string
  tokens?: number
  /** Optional text: when the caller resolved the section, it can be shown like a lexical result. */
  fragment?: Fragment
}

/**
 * An extra ranked list, best first (e.g. semanticCandidates() of context/semantic.ts). `label` is
 * printed in `matched:`; a list built for query n should use label String(n), so `matched` keeps
 * meaning "which phrasings found it".
 */
export interface ExtraList {
  label: string
  items: ExtraItem[]
}

export interface MultiFragment extends Fragment {
  /** Labels of the lists that found any section of this fragment: "1".."5" for queries, then extra labels. */
  matched: string[]
}

export type MoreItem = FindContextResult['more'][number]

export interface MultiFindContextResult extends FindContextResult {
  /** The queries as searched (duplicates removed), numbered 1.. in `matched`. */
  queries: string[]
  fragments: MultiFragment[]
}

export function isMultiResult(r: FindContextResult): r is MultiFindContextResult {
  return Array.isArray((r as Partial<MultiFindContextResult>).queries)
}

// ---------------------------------------------------------------------------
// generic RRF
// ---------------------------------------------------------------------------

/** A ranked list: entries best first, each entry one or more keys sharing that rank. */
export interface RankedList {
  label: string
  entries: string[][]
}

export interface FusedKey {
  key: string
  score: number
  /** Labels of the lists that contain the key, in list order. */
  labels: string[]
  /** First appearance: [list index, rank]. */
  first: [number, number]
}

/** Reciprocal Rank Fusion over `lists`; a key counts once per list (its best rank). */
export function rrf(lists: RankedList[], k = RRF_K): FusedKey[] {
  const out = new Map<string, FusedKey>()
  lists.forEach((list, li) => {
    const seen = new Set<string>()
    list.entries.forEach((keys, i) => {
      const rank = i + 1
      for (const key of keys) {
        if (seen.has(key)) continue
        seen.add(key)
        const cur = out.get(key)
        if (cur) {
          cur.score += 1 / (k + rank)
          cur.labels.push(list.label)
        } else out.set(key, { key, score: 1 / (k + rank), labels: [list.label], first: [li, rank] })
      }
    })
  })
  return [...out.values()].sort(byFused)
}

function byFused(a: { score: number; first: [number, number]; key: string }, b: { score: number; first: [number, number]; key: string }): number {
  return b.score - a.score || a.first[0] - b.first[0] || a.first[1] - b.first[1] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

// ---------------------------------------------------------------------------
// merging find_context results
// ---------------------------------------------------------------------------

const sectionKey = (pageId: string, anchor: string) => `${pageId}#${anchor}`
const PAGE = '\u0000page'

/** Header cost of a merged fragment as renderFindContext prints it (one header per fragment). */
export function multiHeaderTokens(f: Fragment, matched: string[]): number {
  const versions = f.sections.map((s) => `§${s.short ?? s.anchor} v=${s.version}`).join(', ')
  const heading = f.sections[0]?.heading ?? f.headingPath
  const head = `[10] ${f.title || 'Untitled'}${heading ? ` › ${heading}` : ''}\n(page ${f.pageId}; ${versions}; matched: ${matched.join(',')})`
  return estimateTokens(head) + HEADER_FACTS_TOKENS
}

/** "1","2",… first in numeric order, then extra labels in list order. */
function orderLabels(labels: Iterable<string>, listOrder: string[]): string[] {
  const set = new Set(labels)
  return listOrder.filter((l) => set.has(l))
}

export interface FuseOptions {
  /** The queries in order (numbered 1..n); perQuery[i] is the result of queries[i]. */
  queries: string[]
  /** The shared budget (already clamped, as FindContextResult.budget). */
  budget: number
  k?: number
  /** Extra ranked lists (semantic join point, docs/adr/1722-*). */
  extra?: ExtraList[]
}

/**
 * Merge per-query find_context results (and optional extra ranked lists) into one result under one
 * budget. `perQuery[i]` must be the result for `opts.queries[i]` computed with the same budget.
 */
export function fuseContextResults(perQuery: FindContextResult[], opts: FuseOptions): MultiFindContextResult {
  const k = opts.k ?? RRF_K
  const extra = opts.extra ?? []
  const budget = opts.budget
  const lexLabels = perQuery.map((_, i) => String(i + 1))
  const listOrder = [...lexLabels, ...extra.map((e) => e.label).filter((l) => !lexLabels.includes(l))]

  // Section lists: fragments (all sections at the fragment's rank), then the pointers.
  const lists: RankedList[] = perQuery.map((r, i) => ({
    label: lexLabels[i],
    entries: [
      ...r.fragments.map((f) => f.sections.map((s) => sectionKey(f.pageId, s.anchor))),
      ...r.more.map((m) => [sectionKey(m.pageId, m.anchor)]),
    ],
  }))
  // Lexically known sections per page, for page-level extra items.
  const lexical = rrf(lists, k)
  const bestOnPage = new Map<string, string>()
  for (const f of lexical) {
    const pageId = f.key.slice(0, f.key.indexOf('#'))
    if (!bestOnPage.has(pageId)) bestOnPage.set(pageId, f.key)
  }
  for (const e of extra) {
    lists.push({
      label: e.label,
      entries: e.items.map((it) => {
        if (it.fragment) return it.fragment.sections.map((s) => sectionKey(it.fragment!.pageId, s.anchor))
        if (it.anchor !== null) return [sectionKey(it.pageId, it.anchor)]
        // a page as a whole: credit the page's best lexical section, else a page pointer
        return [bestOnPage.get(it.pageId) ?? `${it.pageId}#${PAGE}`]
      }),
    })
  }
  const fused = extra.length ? rrf(lists, k) : lexical
  const byKey = new Map(fused.map((f) => [f.key, f]))

  // Text pieces: every fragment of every query, then extra items that carry a fragment.
  interface Piece {
    f: Fragment
    keys: string[]
    score: number
    first: [number, number]
    key: string
  }
  const pieces: Piece[] = []
  const addPiece = (f: Fragment, li: number, rank: number) => {
    const keys = f.sections.map((s) => sectionKey(f.pageId, s.anchor))
    const score = Math.max(...keys.map((x) => byKey.get(x)?.score ?? 0))
    pieces.push({ f, keys, score, first: [li, rank], key: keys[0] })
  }
  perQuery.forEach((r, li) => r.fragments.forEach((f, i) => addPiece(f, li, i + 1)))
  extra.forEach((e, ei) => e.items.forEach((it, i) => it.fragment && addPiece(it.fragment, perQuery.length + ei, i + 1)))
  pieces.sort(byFused)

  const labelsOf = (keys: string[]) => orderLabels(keys.flatMap((x) => byKey.get(x)?.labels ?? []), listOrder)

  // Info for pointer lines, first source wins (query order, then extra lists).
  const info = new Map<string, MoreItem>()
  const note = (key: string, m: MoreItem) => {
    if (!info.has(key)) info.set(key, m)
  }
  for (const p of pieces) {
    p.f.sections.forEach((s, i) =>
      note(p.keys[i], {
        pageId: p.f.pageId,
        title: p.f.title,
        anchor: s.anchor,
        headingPath: s.headingPath,
        short: s.short ?? s.anchor,
        heading: s.heading ?? s.headingPath,
        tokens: Math.ceil(p.f.tokens / p.f.sections.length),
      }),
    )
  }
  for (const r of perQuery) for (const m of r.more) note(sectionKey(m.pageId, m.anchor), m)
  for (const e of extra) {
    for (const it of e.items) {
      if (it.fragment) continue
      const key = it.anchor !== null ? sectionKey(it.pageId, it.anchor) : (bestOnPage.get(it.pageId) ?? `${it.pageId}#${PAGE}`)
      const anchor = it.anchor ?? ''
      note(key, { pageId: it.pageId, title: it.title ?? '', anchor, headingPath: '', short: anchor, heading: '', tokens: it.tokens ?? 0 })
    }
  }

  // One budget, fused order, each section once.
  let left = budget
  const shown = new Set<string>()
  const fragments: MultiFragment[] = []
  for (const p of pieces) {
    // A piece that overlaps a printed fragment is not printed; its other sections stay pointers.
    if (p.keys.some((x) => shown.has(x))) continue
    const matched = labelsOf(p.keys)
    const head = multiHeaderTokens(p.f, matched)
    let text = p.f.text
    let truncated = p.f.truncated
    if (p.f.tokens + head > left) {
      if (left - head < MIN_TAIL) continue
      text = `${truncateToTokens(p.f.text, left - head - 2).text} …`
      truncated = true
    }
    const tokens = text === p.f.text ? p.f.tokens : estimateTokens(text)
    left -= tokens + head
    for (const x of p.keys) shown.add(x)
    fragments.push({ ...p.f, sections: p.f.sections.map((s) => ({ ...s })), ords: [...p.f.ords], text, tokens, truncated, score: p.score, matched })
  }

  // Pointers: every section some list found that is not shown, best fused first.
  const more: MoreItem[] = []
  for (const f of fused) {
    if (more.length >= MAX_MORE) break
    if (shown.has(f.key)) continue
    const m = info.get(f.key)
    if (m) more.push(m)
  }

  // Title-only pages: union in query order.
  const titleOnly: FindContextResult['titleOnly'] = []
  const titleSeen = new Set<string>()
  for (const r of perQuery) {
    for (const t of r.titleOnly) {
      if (titleSeen.has(t.pageId) || titleOnly.length >= 5) continue
      titleSeen.add(t.pageId)
      titleOnly.push(t)
    }
  }

  return {
    queries: opts.queries,
    fragments,
    more,
    titleOnly,
    budget,
    usedTokens: budget - left,
    candidates: perQuery.reduce((n, r) => n + r.candidates, 0),
  }
}
