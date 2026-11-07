import { createHash } from 'node:crypto'
import { estimateTokens, isCjkCode, truncateToTokens } from './tokens'

/**
 * Ranking and budget packing for find_context (docs/adr/0927-*). Pure functions: the SQL in
 * retrieve.ts produces at most a few hundred candidate chunks; everything here is linear or
 * O(n log k) in that number.
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
  /** ts_rank of the chunk against the OR-prefix query (0 when matched only by trigram/title). */
  rank: number
}

export interface Scored extends Candidate {
  score: number
}

export interface Fragment {
  pageId: string
  workspaceId: string
  title: string
  /** Anchor of the first section in the fragment. */
  anchor: string
  headingPath: string
  /** Every section in the fragment (merged neighbours) with its version, in page order. */
  sections: { anchor: string; headingPath: string; version: string }[]
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
/** Common Korean particles/endings stripped from query terms ("백업을" also searches "백업"). */
const KO_PARTICLES = ['에서', '으로', '에게', '까지', '부터', '하고', '이랑', '을', '를', '이', '가', '은', '는', '의', '에', '로', '와', '과', '도', '만']

/** English function words: dropped when the query has other terms (they match nearly everything). */
const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i if in is it its my of on or our should so that the their there this to was we what when where which who why will with you your'.split(' '),
)

function isCjkWord(t: string): boolean {
  return t.length > 0 && isCjkCode(t.charCodeAt(0))
}

/** Lower-cased search terms: letters/digits only, deduplicated, at most 8, 1-char ASCII dropped. */
export function queryTerms(q: string): string[] {
  const raw = q
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const out: string[] = []
  const add = (t: string) => {
    if (!out.includes(t)) out.push(t)
  }
  for (const t of raw) {
    if (t.length < 2 && !isCjkWord(t)) continue
    add(t)
    if (isCjkWord(t) && t.length >= 3) {
      const p = KO_PARTICLES.find((x) => t.endsWith(x) && t.length - x.length >= 2)
      if (p) add(t.slice(0, t.length - p.length))
    }
  }
  const content = out.filter((t) => !STOPWORDS.has(t))
  return (content.length ? content : out).slice(0, MAX_TERMS)
}

/** OR-of-prefixes tsquery text. Terms contain only letters/digits (see queryTerms), so quoting is safe. */
export function tsqueryText(terms: string[]): string {
  return terms.map((t) => `'${t}':*`).join(' | ')
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

export interface ScoreInput {
  terms: string[]
  /** Normalised full query (for the phrase bonus). */
  phrase: string
  /**
   * Reference time for the recency bonus. retrieve.ts passes the newest candidate's updatedAt (not
   * the clock) so the same documents always rank the same way (prompt-cache friendly, ADR 0937).
   */
  now: number
}

/**
 * Score in [0, ~1.3]. Term coverage dominates (substring test, so Korean compounds count), title
 * and heading hits are weighted on top, the full-text rank breaks ties, recent pages get a small
 * bonus. Weights were set on the evaluation set in context/evalSet.ts (see ADR 0927 for numbers).
 */
export function scoreCandidate(c: Candidate, input: ScoreInput): number {
  const { terms } = input
  if (terms.length === 0) return 0
  const title = c.title.toLowerCase()
  const heading = c.headingPath.toLowerCase()
  const body = c.text.toLowerCase()
  let any = 0
  let inTitle = 0
  let inHeading = 0
  for (const t of terms) {
    const h = heading.includes(t)
    const ti = title.includes(t)
    if (h || ti || body.includes(t)) any++
    if (ti) inTitle++
    if (h) inHeading++
  }
  const n = terms.length
  let s = 0.5 * (any / n) + 0.2 * (inTitle / n) + 0.2 * (inHeading / n) + 0.1 * Math.min(1, c.rank * 10)
  if (input.phrase.length >= 4 && (body.includes(input.phrase) || heading.includes(input.phrase))) s += 0.15
  const ageDays = Math.max(0, (input.now - c.updatedAt.getTime()) / 86_400_000)
  s += 0.05 * Math.exp(-ageDays / 180)
  if (c.text.trim().length < 20) s *= 0.7 // heading-only chunk: little to read
  return Math.round(s * 1e6) / 1e6
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
/** Fragments below this share of the best score are noise. */
const RELATIVE_FLOOR = 0.6
const ABSOLUTE_FLOOR = 0.2
/** Tiny chunks would win any value/weight ratio; weigh them as at least this many tokens. */
const MIN_WEIGHT = 60
/** Per-fragment header cost in the rendered output (title, path, ids). */
export const HEADER_TOKENS = 30
const MIN_TAIL = 80

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

export interface PackResult {
  fragments: Fragment[]
  usedTokens: number
  /** Relevant chunks that did not fit, best first (pointers for a follow-up read). */
  overflow: Scored[]
}

/**
 * Fractional-knapsack packing: the best chunk first, then by score per token; whole chunks while
 * they fit, the next one cut to the remaining budget around its first hit. Duplicated texts (copied
 * pages) are dropped; neighbouring chunks of one page are merged into one fragment.
 */
export function pack(ranked: Scored[], terms: string[], budget: number): PackResult {
  const sorted = [...ranked].sort(byScore)
  const best = sorted[0]?.score ?? 0
  const floor = Math.max(ABSOLUTE_FLOOR, best * RELATIVE_FLOOR)
  const seen = new Set<string>()
  const pool: Scored[] = []
  for (const c of sorted) {
    if (c.score < floor) break
    const k = textKey(`${c.headingPath}\n${c.text}`)
    if (seen.has(k)) continue
    seen.add(k)
    pool.push(c)
  }
  if (pool.length === 0) return { fragments: [], usedTokens: 0, overflow: [] }

  const ratio = (c: Scored) => c.score / Math.max(MIN_WEIGHT, c.tokens)
  const order = [pool[0], ...pool.slice(1).sort((a, b) => ratio(b) - ratio(a) || byScore(a, b))]

  let left = budget
  const taken: { c: Scored; text: string; truncated: boolean }[] = []
  const overflow: Scored[] = []
  for (const c of order) {
    const cost = c.tokens + HEADER_TOKENS
    if (cost <= left) {
      taken.push({ c, text: c.text, truncated: false })
      left -= cost
    } else if (left - HEADER_TOKENS >= MIN_TAIL) {
      const text = cutAroundHit(c.text, terms, left - HEADER_TOKENS - 2) // 2 = the '… ' markers
      taken.push({ c, text, truncated: true })
      left -= estimateTokens(text) + HEADER_TOKENS
    } else {
      overflow.push(c)
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
      if (cur && c.ord === lastOrd + 1 && !cur.truncated) {
        const newSection = cur.sections[cur.sections.length - 1].anchor !== c.anchor
        if (newSection) cur.sections.push({ anchor: c.anchor, headingPath: c.headingPath, version: c.version })
        const sep = newSection ? `\n\n§${c.anchor} — ${c.headingPath || '(intro)'}\n` : '\n'
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
          sections: [{ anchor: c.anchor, headingPath: c.headingPath, version: c.version }],
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
  return { fragments, usedTokens: budget - left, overflow }
}
