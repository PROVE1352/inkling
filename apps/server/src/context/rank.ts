import { createHash } from 'node:crypto'
import { estimateTokens, isCjkCode, truncateToTokens } from './tokens'

/**
 * Ranking and budget packing for find_context (docs/adr/0927-*, 1210-*, 1211-*). Pure functions:
 * the SQL in retrieve.ts produces at most a few hundred candidate chunks plus the document
 * frequency of every query word; everything here is linear or O(n log k) in that number.
 */

export interface Candidate {
  pageId: string
  workspaceId: string
  title: string
  ord: number
  anchor: string
  headingPath: string
  part: number
  text: string
  tokens: number
  version: string
  updatedAt: Date
}

export interface Scored extends Candidate {
  score: number
}

/** How a section is shown: the shortest anchor suffix unique on its page and the matching heading tail (docs/adr/1212-*). */
export interface SectionLabel {
  short: string
  heading: string
}

export interface FragmentSection {
  anchor: string
  headingPath: string
  version: string
  /** Shortest suffix of `anchor` that is unique on the page; read_page/patch_section accept it. */
  short: string
  /** Last heading(s) of the path — as many as `short` has segments. */
  heading: string
}

export interface Fragment {
  pageId: string
  workspaceId: string
  title: string
  /** Anchor of the first section in the fragment. */
  anchor: string
  headingPath: string
  /** Every section in the fragment (merged neighbours) with its version, in page order. */
  sections: FragmentSection[]
  ords: number[]
  text: string
  tokens: number
  score: number
  truncated: boolean
}

// ---------------------------------------------------------------------------
// query terms
// ---------------------------------------------------------------------------

const MAX_TERMS = 8
/**
 * Korean particles and verb endings stripped from query words of 3+ characters when at least two
 * characters remain ("백업을" also searches "백업", "결정된" → "결정", "구성하는" → "구성"). Longest
 * first. Two-character words are never stripped: too many nouns end in a particle-like syllable
 * (회의, 평가, 휴가), docs/adr/1210-*.
 */
const KO_SUFFIXES = [
  '하려면', '에서', '으로', '에게', '까지', '부터', '하고', '이랑', '했다', '한다', '하는', '하기', '되는', '된다',
  '을', '를', '이', '가', '은', '는', '의', '에', '로', '와', '과', '도', '만', '된', '한', '할',
]

/** English function words: dropped when the query has other terms (they match nearly everything). */
const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i if in is it its my of on or our should so that the their there this to was we what when where which who why will with you your'.split(' '),
)

function isCjkWord(t: string): boolean {
  return t.length > 0 && isCjkCode(t.charCodeAt(0))
}

/** One query word and the forms that count as it (the word first, then a stripped stem). */
export interface TermGroup {
  word: string
  variants: string[]
}

/**
 * Query words as groups: NFKC, lower case, letters/digits only, deduplicated, at most 8 words,
 * 1-character ASCII dropped, English function words dropped when other words exist. A Korean word
 * and its stem are one group: a chunk that has either counts once, and the word's document
 * frequency is that of either form.
 */
export function queryGroups(q: string): TermGroup[] {
  const raw = q
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const out: TermGroup[] = []
  const seen = new Set<string>()
  for (const t of raw) {
    if (t.length < 2 && !isCjkWord(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    const g: TermGroup = { word: t, variants: [t] }
    if (isCjkWord(t) && t.length >= 3) {
      const p = KO_SUFFIXES.find((x) => t.endsWith(x) && t.length - x.length >= 2)
      if (p) {
        const stem = t.slice(0, t.length - p.length)
        if (!seen.has(stem)) {
          g.variants.push(stem)
          seen.add(stem)
        }
      }
    }
    out.push(g)
  }
  const content = out.filter((g) => !STOPWORDS.has(g.word))
  return (content.length ? content : out).slice(0, MAX_TERMS)
}

/** Every searched form, in query order (for highlighting, cutting and the SQL probes). */
export function queryTerms(q: string): string[] {
  return queryGroups(q).flatMap((g) => g.variants)
}

/** OR-of-prefixes tsquery text. Terms contain only letters/digits (see queryGroups), so quoting is safe. */
export function tsqueryText(terms: string[]): string {
  return terms.map((t) => `'${t}':*`).join(' | ')
}

// ---------------------------------------------------------------------------
// scoring (docs/adr/1210-*)
// ---------------------------------------------------------------------------

/**
 * BM25 parameters: k1 = term-frequency saturation, b = length normalisation, pivot = the length
 * (estimated tokens) at which a chunk is "average". The pivot is a constant instead of the scope's
 * mean chunk length so an edit elsewhere never moves scores (docs/adr/0937-*, 1210-*); 250 ≈ the
 * measured mean chunk length of the benchmark corpus.
 */
export const BM25 = { k1: 1.2, b: 0.75, pivot: 250 }

/**
 * Weight of a word that no chunk in scope contains (df = 0): it cannot tell chunks apart, so it must
 * not dominate the normalisation as an "infinitely rare" word would (a stray "bad" in "roll back a
 * bad deploy" pushed every score under the floor); it still counts a little for title matches.
 */
export const UNSEEN_WEIGHT = 0.5

/**
 * Lucene's BM25 idf: ln(1 + (N − df + 0.5) / (df + 0.5)); always > 0, rare words weigh more.
 * df = 0 → UNSEEN_WEIGHT.
 */
export function idf(n: number, df: number): number {
  if (df <= 0) return UNSEEN_WEIGHT
  return Math.log(1 + (Math.max(n, df) - df + 0.5) / (df + 0.5))
}

/** Score weights (set on the dev questions only, docs/adr/1213-*). They sum to 1 before bonuses. */
export const WEIGHTS = {
  /** idf-weighted share of query words found anywhere (title, heading path, text). */
  coverage: 0.4,
  /** normalised BM25 of the chunk text (heading path included, as in the index). */
  bm25: 0.25,
  /** idf-weighted share of query words in the page title. */
  title: 0.15,
  /** idf-weighted share of query words in the heading path. */
  heading: 0.2,
  /** Share of consecutive query word pairs found next to each other, each pair weighted by its larger idf. */
  adjacent: 0.15,
  /** the whole query as a phrase. */
  phrase: 0.1,
  recency: 0.03,
}

/** Characters allowed between two adjacent query words ("팀 구성", "팀의 구성", "팀구성"). */
const ADJACENT_GAP = 3

export interface ScoreInput {
  groups: TermGroup[]
  /** idf per group (same order). */
  idf: number[]
  /** Normalised full query (for the phrase bonus). */
  phrase: string
  /**
   * Reference time for the recency bonus. retrieve.ts passes the newest candidate's updatedAt (not
   * the clock) so the same documents always rank the same way (prompt-cache friendly, ADR 0937).
   */
  now: number
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)

/**
 * Positions where `v` occurs the way the index matches it: anywhere for Korean/CJK words of 2+
 * characters (bigrams and the trigram probe find compound infixes), at the start of a word
 * otherwise (prefix query on the stored vector; a 1-character Korean word like "팀" too).
 */
export function occurrences(hay: string, v: string): number[] {
  const out: number[] = []
  const infix = isCjkWord(v) && [...v].length >= 2
  for (let i = hay.indexOf(v); i >= 0; i = hay.indexOf(v, i + 1)) {
    if (infix || !isWordChar(hay[i - 1])) out.push(i)
  }
  return out
}

/**
 * Score ≈ [0, 1.3]: idf-weighted coverage, BM25, title/heading hits, adjacency of consecutive query
 * words, phrase and a small recency bonus. Common words ("서울", "해커톤") weigh little, a rare one
 * ("구성") much: a chunk with only the common words no longer outranks one with the rare word.
 */
export function scoreCandidate(c: Candidate, input: ScoreInput): number {
  return scoreParts(c, input).score
}

/** The parts of scoreCandidate, each already in [0, 1] before its weight (for explaining a ranking). */
export function scoreParts(
  c: Candidate,
  input: ScoreInput,
): { score: number; coverage: number; bm25: number; title: number; heading: number; adjacent: number; phrase: boolean } {
  const { groups } = input
  if (groups.length === 0) return { score: 0, coverage: 0, bm25: 0, title: 0, heading: 0, adjacent: 0, phrase: false }
  const title = c.title.toLowerCase()
  const heading = c.headingPath.toLowerCase()
  // The page title is part of every chunk's text for tf (BM25F with all field weights 1).
  const hay = `${title}\n${heading}\n${c.text.toLowerCase()}`
  const w = groups.map((_, i) => input.idf[i] ?? 1)
  const wSum = w.reduce((a, b) => a + b, 0) || 1
  const { k1, b, pivot } = BM25
  const norm = 1 - b + (b * Math.max(1, c.tokens)) / pivot
  let cover = 0
  let bm25 = 0
  let inTitle = 0
  let inHeading = 0
  /** Per group: [start, end) of every occurrence (a stem inside a longer variant's hit is the same one). */
  const spans: [number, number][][] = []
  groups.forEach((g, i) => {
    const hits: [number, number][] = []
    for (const v of g.variants) {
      for (const p of occurrences(hay, v)) if (!hits.some(([a]) => a === p)) hits.push([p, p + v.length])
    }
    spans.push(hits)
    const tf = hits.length
    const ti = g.variants.some((v) => title.includes(v))
    const he = g.variants.some((v) => heading.includes(v))
    if (tf > 0 || ti) cover += w[i]
    if (ti) inTitle += w[i]
    if (he) inHeading += w[i]
    if (tf > 0) bm25 += (w[i] * (tf * (k1 + 1))) / (tf + k1 * norm) / (k1 + 1)
  })
  let adj = 0
  let adjSum = 0
  for (let i = 0; i + 1 < groups.length; i++) {
    // A phrase is at least as rare as its rarer word: weigh the pair by the larger idf.
    const pw = Math.max(w[i], w[i + 1])
    adjSum += pw
    const near = spans[i].some(([, end]) => spans[i + 1].some(([start]) => start >= end && start - end <= ADJACENT_GAP))
    if (near) adj += pw
  }
  const W = WEIGHTS
  const adjShare = adjSum ? adj / adjSum : 0
  const phrase = input.phrase.length >= 4 && hay.includes(input.phrase)
  let s = (W.coverage * cover + W.bm25 * bm25 + W.title * inTitle + W.heading * inHeading) / wSum + W.adjacent * adjShare
  if (phrase) s += W.phrase
  const ageDays = Math.max(0, (input.now - c.updatedAt.getTime()) / 86_400_000)
  s += W.recency * Math.exp(-ageDays / 180)
  if (c.text.trim().length < 20) s *= 0.7 // heading-only chunk: little to read
  return {
    score: Math.round(s * 1e6) / 1e6,
    coverage: cover / wSum,
    bm25: bm25 / wSum,
    title: inTitle / wSum,
    heading: inHeading / wSum,
    adjacent: adjShare,
    phrase,
  }
}

/** Score descending with a total, input-independent tie-break (page id, then position). */
export function byScore(a: { score: number; pageId: string; ord: number }, b: { score: number; pageId: string; ord: number }): number {
  return b.score - a.score || (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0) || a.ord - b.ord
}

// ---------------------------------------------------------------------------
// top-k heap
// ---------------------------------------------------------------------------

/** Keeps the k highest-scoring items (binary min-heap on score): O(n log k). */
export class TopK<T extends { score: number; pageId: string; ord: number }> {
  private heap: T[] = []
  constructor(private readonly k: number) {}

  push(item: T): void {
    const h = this.heap
    if (h.length < this.k) {
      h.push(item)
      this.up(h.length - 1)
    } else if (this.k > 0 && byScore(item, h[0]) < 0) {
      h[0] = item
      this.down(0)
    }
  }

  /** Items, highest score first. */
  sorted(): T[] {
    return [...this.heap].sort(byScore)
  }

  get size(): number {
    return this.heap.length
  }

  private up(i: number): void {
    const h = this.heap
    while (i > 0) {
      const p = (i - 1) >> 1
      if (byScore(h[p], h[i]) >= 0) break // parent is "worse or equal": heap order holds
      ;[h[p], h[i]] = [h[i], h[p]]
      i = p
    }
  }

  private down(i: number): void {
    const h = this.heap
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < h.length && byScore(h[l], h[m]) > 0) m = l
      if (r < h.length && byScore(h[r], h[m]) > 0) m = r
      if (m === i) return
      ;[h[m], h[i]] = [h[i], h[m]]
      i = m
    }
  }
}

// ---------------------------------------------------------------------------
// packing
// ---------------------------------------------------------------------------

export const TOP_K = 40
/** Fragments below `relative` × the best score, or below `absolute`, are noise. */
export const FLOOR = { relative: 0.6, absolute: 0.2 }
/** Tiny chunks would win any value/weight ratio; weigh them as at least this many tokens. */
const MIN_WEIGHT = 60
/**
 * Header cost not visible to pack: `; can: read,comment,edit`, `; edited by … via …`, review notes
 * (added by the MCP layer). The rest of the header is estimated from the actual title, heading,
 * anchor and version (docs/adr/1212-*).
 */
export const HEADER_FACTS_TOKENS = 15
const MIN_TAIL = 80
/**
 * Per-page rule (docs/adr/1211-*): a page's first `pageCap` sections keep their score, each further
 * one is multiplied by `pageDecay` once more (0 would be a hard cap). With the 0.6 relative floor,
 * 1 and 0.7 mean: a page's second section is shown only when it scores ≥ 0.86 × the best result,
 * a third never (0.49 × its score < 0.6 × best) — at most two sections per page.
 */
export const DIVERSITY = { pageCap: 1, pageDecay: 0.7 }

function textKey(t: string): string {
  return createHash('sha1').update(t.replace(/\s+/g, ' ').trim()).digest('base64')
}

/** Cut `text` to `maxTokens`, starting near the first term hit so the evidence survives. */
function cutAroundHit(text: string, terms: string[], maxTokens: number): string {
  const lower = text.toLowerCase()
  let hit = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (hit < 0 || i < hit)) hit = i
  }
  let start = 0
  if (hit > 0 && estimateTokens(text.slice(0, hit)) > maxTokens / 3) {
    // start a couple of lines before the hit
    let s = text.lastIndexOf('\n', hit)
    for (let i = 0; i < 2 && s > 0; i++) s = text.lastIndexOf('\n', s - 1)
    start = Math.max(0, s + 1)
  }
  const { text: cut } = truncateToTokens(text.slice(start), maxTokens)
  return `${start > 0 ? '… ' : ''}${cut} …`
}

/** The label of a chunk without page context: the full anchor and heading path (pre-1212 output). */
export function fullLabel(c: Pick<Candidate, 'anchor' | 'headingPath'>): SectionLabel {
  return { short: c.anchor, heading: c.headingPath }
}

/** Estimated tokens of a fragment's two header lines as renderFindContext prints them. */
export function headerTokens(c: Pick<Candidate, 'title' | 'pageId' | 'version'>, label: SectionLabel): number {
  const head = `[10] ${c.title || 'Untitled'}${label.heading ? ` › ${label.heading}` : ''}\n(page ${c.pageId}; §${label.short} v=${c.version})`
  return estimateTokens(head) + HEADER_FACTS_TOKENS
}

/** Separator line between merged neighbouring sections of one fragment. */
export function sectionSeparator(label: SectionLabel): string {
  return `\n\n§${label.short} — ${label.heading || '(intro)'}\n`
}

export interface PackOptions {
  /** How a chunk's section is shown (short anchor + heading tail); default the full anchor and path. */
  label?: (c: Candidate) => SectionLabel
  pageCap?: number
  pageDecay?: number
}

export interface PackResult {
  fragments: Fragment[]
  usedTokens: number
  /** Relevant chunks that did not fit or were held back by the per-page rule, best first (pointers). */
  overflow: Scored[]
}

/**
 * Per-page diversification (docs/adr/1211-*): walking the pool best first, a page's first
 * `cap` sections keep their score; each further section of the same page is multiplied by
 * `decay` once more (MMR with "same page" as the similarity). Parts of one section count once.
 * Returns the adjusted copies, re-sorted.
 */
export function diversify(pool: Scored[], cap = DIVERSITY.pageCap, decay = DIVERSITY.pageDecay): Scored[] {
  const seen = new Map<string, string[]>()
  const out = pool.map((c) => {
    const list = seen.get(c.pageId) ?? []
    let k = list.indexOf(c.anchor)
    if (k < 0) {
      list.push(c.anchor)
      seen.set(c.pageId, list)
      k = list.length - 1
    }
    const extra = k + 1 - cap
    return extra > 0 ? { ...c, score: Math.round(c.score * decay ** extra * 1e6) / 1e6 } : c
  })
  return out.sort(byScore)
}

/**
 * Fractional-knapsack packing: the best chunk first, then by score per token; whole chunks while
 * they fit, the next one cut to the remaining budget around its first hit. Duplicated texts (copied
 * pages) are dropped; a page's sections beyond the per-page rule usually fall below the floor and
 * become pointers; neighbouring chunks of one page are merged into one fragment. Each chunk pays its
 * real header (title, heading tail, short anchor, version) against the budget.
 */
export function pack(ranked: Scored[], terms: string[], budget: number, opts: PackOptions = {}): PackResult {
  const label = opts.label ?? fullLabel
  const sorted = [...ranked].sort(byScore)
  const best = sorted[0]?.score ?? 0
  const floor = Math.max(FLOOR.absolute, best * FLOOR.relative)
  const seen = new Set<string>()
  const relevant: Scored[] = []
  for (const c of sorted) {
    if (c.score < floor) break
    const k = textKey(`${c.headingPath}\n${c.text}`)
    if (seen.has(k)) continue
    seen.add(k)
    relevant.push(c)
  }
  if (relevant.length === 0) return { fragments: [], usedTokens: 0, overflow: [] }
  const original = new Map(relevant.map((c) => [`${c.pageId}#${c.ord}`, c]))
  const adjusted = diversify(relevant, opts.pageCap ?? DIVERSITY.pageCap, opts.pageDecay ?? DIVERSITY.pageDecay)
  const pool = adjusted.filter((c) => c.score >= floor)
  const heldBack = adjusted.filter((c) => c.score < floor).map((c) => original.get(`${c.pageId}#${c.ord}`)!)

  const ratio = (c: Scored) => c.score / Math.max(MIN_WEIGHT, c.tokens)
  const order = [pool[0], ...pool.slice(1).sort((a, b) => ratio(b) - ratio(a) || byScore(a, b))]

  let left = budget
  const taken: { c: Scored; text: string; truncated: boolean }[] = []
  const overflow: Scored[] = []
  for (const c of order) {
    const head = headerTokens(c, label(c))
    const cost = c.tokens + head
    if (cost <= left) {
      taken.push({ c, text: c.text, truncated: false })
      left -= cost
    } else if (left - head >= MIN_TAIL) {
      const text = cutAroundHit(c.text, terms, left - head - 2) // 2 = the '… ' markers
      taken.push({ c, text, truncated: true })
      left -= estimateTokens(text) + head
    } else {
      overflow.push(original.get(`${c.pageId}#${c.ord}`)!)
    }
  }

  // Merge neighbours of one page (consecutive ords) into a single fragment.
  const byPage = new Map<string, typeof taken>()
  for (const t of taken) {
    const list = byPage.get(t.c.pageId) ?? []
    list.push(t)
    byPage.set(t.c.pageId, list)
  }
  const fragments: Fragment[] = []
  for (const list of byPage.values()) {
    list.sort((a, b) => a.c.ord - b.c.ord)
    let cur: Fragment | null = null
    let lastOrd = -2
    for (const t of list) {
      const c = t.c
      const l = label(c)
      const section = { anchor: c.anchor, headingPath: c.headingPath, version: c.version, short: l.short, heading: l.heading }
      if (cur && c.ord === lastOrd + 1 && !cur.truncated) {
        const newSection = cur.sections[cur.sections.length - 1].anchor !== c.anchor
        if (newSection) cur.sections.push(section)
        const sep = newSection ? sectionSeparator(l) : '\n'
        cur.text += sep + t.text
        cur.ords.push(c.ord)
        cur.tokens += estimateTokens(sep + t.text)
        cur.score = Math.max(cur.score, c.score)
        cur.truncated = t.truncated
      } else {
        cur = {
          pageId: c.pageId,
          workspaceId: c.workspaceId,
          title: c.title,
          anchor: c.anchor,
          headingPath: c.headingPath,
          sections: [section],
          ords: [c.ord],
          text: t.text,
          tokens: estimateTokens(t.text),
          score: c.score,
          truncated: t.truncated,
        }
        fragments.push(cur)
      }
      lastOrd = c.ord
    }
  }
  fragments.sort((a, b) => byScore({ ...a, ord: a.ords[0] }, { ...b, ord: b.ords[0] }))
  return { fragments, usedTokens: budget - left, overflow: [...overflow, ...heldBack].sort(byScore) }
}
