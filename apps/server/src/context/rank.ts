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
  /** The page's wiki-link aliases joined by newlines; they count as part of the title (docs/adr/1701-*). */
  aliases?: string
}

export interface Scored extends Candidate {
  score: number
  /**
   * The chunk says nothing of its own about the query: no query word in its heading path or prose
   * (only in the page title), or almost no prose at all (a line of links). It never takes its page's
   * slot from a sibling that does (docs/adr/1900-*).
   */
  weak?: boolean
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
  /** Estimated tokens of the whole section whose text was cut (only when `truncated`; docs/adr/1902-*). */
  fullTokens?: number
}

// ---------------------------------------------------------------------------
// query terms
// ---------------------------------------------------------------------------

const MAX_TERMS = 8
/**
 * Korean particles and verb endings stripped from query words of 3+ characters when at least two
 * characters remain ("백업을" also searches "백업", "결정된" → "결정", "구성하는" → "구성"). Longest
 * first. Two-character words are never stripped to a prefix: too many nouns end in a particle-like
 * syllable (회의, 평가, 휴가), docs/adr/1210-*; a one-syllable noun + particle gets whole-word forms
 * instead (oneSyllableStem below, docs/adr/1700-*).
 */
const KO_SUFFIXES = [
  '했습니다', '합니다', '입니다', '하려면', '했는지', '이라는',
  '에서', '으로', '에게', '까지', '부터', '하고', '이랑', '했다', '한다', '하는', '하기', '되는', '된다',
  // docs/adr/1700-*: past/question/conditional endings that hid the stem ("결석했을" → 결석)
  '했을', '했나', '했던', '했고', '했어', '해야', '하면', '할까', '하나', '하지', '되나', '됐나', '됐다', '되면',
  '받는', '받은', '처럼', '마다', '보다', '이란', '라는',
  '을', '를', '이', '가', '은', '는', '의', '에', '로', '와', '과', '도', '만', '된', '한', '할',
].sort((a, b) => b.length - a.length)

/**
 * One-syllable nouns with a particle ("팀을", "팀이", "팀으로", docs/adr/1700-*). The particle must
 * fit the noun's last sound (을/은/이 after a final consonant, 를/는/가 after a vowel), so "가을",
 * "마을", "아이", "평가", "국가" are never split. 의, 도, 만, 로, 과/와 are not split off two-character
 * words (회의, 정도, 불만, 도로, 결과). The stem then counts only as a whole word or with a particle
 * (exact forms below), never as a prefix: "휴가" → 휴 does not match 휴식 or 휴일.
 */
const STRIP_AFTER_CONSONANT = ['을', '은', '이', '에', '으로', '에서', '에게', '까지', '부터', '이랑', '처럼', '보다']
const STRIP_AFTER_VOWEL = ['를', '는', '가', '에', '에서', '에게', '까지', '부터', '랑', '처럼', '보다']
const FAMILY_AFTER_CONSONANT = ['을', '은', '이', '의', '에', '도', '만', '과', '으로', '에서', '에게', '까지', '부터', '이랑', '처럼', '보다']
const FAMILY_AFTER_VOWEL = ['를', '는', '가', '의', '에', '도', '만', '와', '로', '에서', '에게', '까지', '부터', '랑', '처럼', '보다']

/** Final consonant index of a Hangul syllable (0 = none), or -1 for any other character. */
function finalConsonant(ch: string): number {
  const c = ch.charCodeAt(0) - 0xac00
  return c >= 0 && c < 11172 ? c % 28 : -1
}

/** "팀을" → { stem: 팀, family: [팀, 팀을, 팀은, 팀이, …] }; null when the word is not one syllable + particle. */
export function oneSyllableStem(word: string): { stem: string; family: string[] } | null {
  const chars = [...word]
  if (chars.length < 2 || chars.length > 4) return null
  const stem = chars[0]
  const fin = finalConsonant(stem)
  if (fin < 0) return null
  const rest = chars.slice(1).join('')
  // ㄹ-final nouns take 로 like vowel-final ones; kept simple: 으로 after any final consonant
  if (!(fin > 0 ? STRIP_AFTER_CONSONANT : STRIP_AFTER_VOWEL).includes(rest)) return null
  return { stem, family: particleFamily(stem) }
}

/** A one-syllable noun alone and with each particle that fits its final sound. */
export function particleFamily(stem: string): string[] {
  return [stem, ...(finalConsonant(stem) > 0 ? FAMILY_AFTER_CONSONANT : FAMILY_AFTER_VOWEL).map((p) => stem + p)]
}

/**
 * Head of a split reading: a one-syllable head counts as a whole word, alone or with a particle
 * ("팀 구성", "팀의 구성"), not as a prefix — '팀':* would scan every word starting with 팀 for
 * every three-syllable query word ("해커톤" → 해 + 커톤), which cost ~10 ms per query.
 */
function splitHead(a: string): string[] | null {
  return [...a].length === 1 ? particleFamily(a) : null
}

/** Hangul words of 3–8 syllables can be written with a space ("팀구성" ↔ "팀 구성"). */
const SPLIT_MIN = 3
const SPLIT_MAX = 8

/**
 * Two-word readings of a compound the query writes without a space (docs/adr/1700-*): every split
 * point whose tail has at least two syllables ("팀구성" → 팀+구성; "회의주기" → 회+의주기,
 * 회의+주기). The index matches them as adjacent words, so a wrong split costs little.
 */
export function compoundSplits(word: string): [string, string][] {
  const chars = [...word]
  if (chars.length < SPLIT_MIN || chars.length > SPLIT_MAX || !chars.every((c) => finalConsonant(c) >= 0)) return []
  const out: [string, string][] = []
  for (let i = 1; i + 2 <= chars.length; i++) out.push([chars.slice(0, i).join(''), chars.slice(i).join('')])
  return out
}

/**
 * Light query-side normalisation (docs/adr/1905-*). Each adds a variant to the word's group, so a
 * chunk with either form counts once and the group's df is that of either form.
 *   - enInflection: plural / -ed / -ing of an English query word also searches its stem as a prefix
 *     ("deploys" → deploy:*, "approved" → approv:*, "answering" → answer:*). The note side needs
 *     nothing: the prefix query already finds "deploys" for "deploy".
 *   - koDoubleParticle: a Korean word with two particles is stripped twice ("회의에서는" → 회의에서
 *     → 회의), each time only when two characters remain.
 * Exported (not frozen) so scripts/context-tune.ts can switch them for a dev comparison.
 */
export const QUERY_FORMS = { enInflection: true, koDoubleParticle: true }

/** Stem of an English plural / -ed / -ing form, or null. The stem is searched as a prefix. */
export function englishStem(w: string): string | null {
  if (!/^[a-z]+$/.test(w)) return null
  let stem: string | null = null
  if (w.length >= 5 && w.endsWith('ies')) stem = `${w.slice(0, -3)}y`
  else if (w.length >= 6 && /(?:sses|shes|ches|xes|zes)$/.test(w)) stem = w.slice(0, -2)
  else if (w.length >= 4 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) stem = w.slice(0, -1)
  else if (w.length >= 6 && w.endsWith('ed') && !w.endsWith('eed')) stem = w.slice(0, -2)
  else if (w.length >= 7 && w.endsWith('ing')) stem = w.slice(0, -3)
  if (!stem) return null
  // "planned" → plann → plan, "running" → runn → run; "rolled" keeps its ll
  if (/([b-df-hj-np-tv-z])\1$/.test(stem) && !/(?:ll|ss|ff|zz)$/.test(stem)) stem = stem.slice(0, -1)
  return stem.length >= 3 && stem !== w ? stem : null
}

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
  /** Forms matched as a word prefix (or anywhere, for Korean of 2+ characters). */
  variants: string[]
  /** Forms matched as whole words only: a one-syllable noun and its particles (docs/adr/1700-*). */
  exact?: string[]
  /** Adjacent word pairs that also count: a compound the query writes without a space (docs/adr/1700-*). */
  splits?: [string, string][]
}

/**
 * Query words as groups: NFKC, lower case, letters/digits only, deduplicated, at most 8 words,
 * 1-character ASCII dropped, English function words dropped when other words exist. A Korean word
 * and its stem are one group: a chunk that has either counts once, and the word's document
 * frequency is that of either form. The group also holds the whole-word forms of a one-syllable
 * noun ("팀을" → 팀, 팀에 …) and the split readings of a compound ("팀구성" → 팀 + 구성), docs/adr/1700-*.
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
    const one = isCjkWord(t) ? oneSyllableStem(t) : null
    // "팀으로" is 팀 + 으로, not 팀으 + 로: a one-syllable stem takes the whole-word path below
    if (!one && isCjkWord(t) && t.length >= 3) {
      const strip = (w: string) => {
        const p = KO_SUFFIXES.find((x) => w.endsWith(x) && w.length - x.length >= 2)
        return p ? w.slice(0, w.length - p.length) : null
      }
      const stem = strip(t)
      if (stem && !seen.has(stem)) {
        g.variants.push(stem)
        seen.add(stem)
      }
      // a second particle ("회의에서는" → 회의에서 → 회의), docs/adr/1905-*
      const again = stem && QUERY_FORMS.koDoubleParticle && stem.length >= 3 ? strip(stem) : null
      if (again && !seen.has(again)) {
        g.variants.push(again)
        seen.add(again)
      }
    }
    const en = QUERY_FORMS.enInflection && !isCjkWord(t) ? englishStem(t) : null
    if (en && !seen.has(en)) {
      g.variants.push(en)
      seen.add(en)
    }
    if (isCjkWord(t)) {
      if (one) g.exact = one.family.filter((f) => f !== t)
      // split the stem when a particle or ending was stripped ("결제개편을" → 결제개편), else the word
      const splits = one ? [] : compoundSplits(g.variants[g.variants.length - 1])
      if (splits.length) g.splits = splits
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

/**
 * tsquery text of one group: its prefixes, its whole-word forms and its split readings as phrases
 * ("'팀구성':* | '팀':* <-> '구성':*", docs/adr/1700-*). Letters/digits only, so quoting is safe.
 */
export function groupTsquery(g: TermGroup): string {
  return [
    ...g.variants.map((t) => `'${t}':*`),
    ...(g.exact ?? []).map((t) => `'${t}'`),
    ...(g.splits ?? []).map(([a, b]) => {
      const fam = splitHead(a)
      return `(${fam ? `(${fam.map((f) => `'${f}'`).join(' | ')})` : `'${a}':*`} <-> '${b}':*)`
    }),
  ].join(' | ')
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

/** Score weights (set on the dev questions only, docs/adr/1213-*, 1701-*). */
export const WEIGHTS = {
  /** idf-weighted share of query words found anywhere (title, heading path, text). */
  coverage: 0.4,
  /** normalised BM25 of the chunk text (heading path included, as in the index). */
  bm25: 0.25,
  /** idf-weighted share of query words in the page title or one of its aliases (docs/adr/1701-*). */
  title: 0.15,
  /**
   * idf-weighted share of query words in the heading path. 0.2 → 0.3 in 0.14 (docs/adr/1701-*): a
   * section whose heading names the query outranks one that only mentions it; 0.4 overshoots.
   */
  heading: 0.3,
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
const hasExtra = (g: TermGroup) => !!(g.exact?.length || g.splits?.length)

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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every [start, end) where a group occurs the way the index matches it (docs/adr/1700-*): its
 * variants (see occurrences), its whole-word forms, and its split readings as a word starting
 * with the head followed by a word starting with the tail ('팀':* <-> '구성':*).
 */
export function groupSpans(hay: string, g: TermGroup): [number, number][] {
  const hits: [number, number][] = []
  const add = (a: number, b: number) => {
    if (!hits.some(([x]) => x === a)) hits.push([a, b])
  }
  for (const v of g.variants) for (const p of occurrences(hay, v)) add(p, p + v.length)
  const m = matchers(g)
  if (m.exact) {
    // one scan for the stem; the rest of the word must be empty or a particle of the family
    const { stem, forms } = m.exact
    for (let i = hay.indexOf(stem); i >= 0; i = hay.indexOf(stem, i + 1)) {
      if (isWordChar(hay[i - 1])) continue
      let j = i + stem.length
      while (j < hay.length && isWordChar(hay[j])) j++
      if (forms.has(hay.slice(i, j))) add(i, j)
    }
  }
  for (const re of m.splits) for (const x of hay.matchAll(re)) add(x.index!, x.index! + x[0].length)
  return hits.sort((x, y) => x[0] - y[0])
}

/** Compiled forms of a group's exact words and split readings, built once per group (it is scored for every candidate). */
const matcherCache = new WeakMap<TermGroup, { exact: { stem: string; forms: Set<string> } | null; splits: RegExp[] }>()
function matchers(g: TermGroup) {
  let m = matcherCache.get(g)
  if (!m) {
    const ex = g.exact ?? []
    const stem = ex.length ? ex.reduce((a, b) => (b.length < a.length ? b : a)) : ''
    m = {
      exact: ex.length ? { stem, forms: new Set(ex) } : null,
      splits: (g.splits ?? []).map(([a, b]) => {
        const fam = splitHead(a)
        const head = fam ? `(?:${fam.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])` : `${escapeRe(a)}[\\p{L}\\p{N}]*`
        return new RegExp(`(?<![\\p{L}\\p{N}])${head}[^\\p{L}\\p{N}]+${escapeRe(b)}`, 'gu')
      }),
    }
    matcherCache.set(g, m)
  }
  return m
}

// ---------------------------------------------------------------------------
// what a chunk says itself (docs/adr/1900-*, 1901-*)
// ---------------------------------------------------------------------------

/** `](target)` of a Markdown link: the target is an address, not words of the note. */
const MD_LINK_TARGET = /\]\((?:[^()\s]|\([^()\s]*\))+\)/g
/** A bare address (also inside `[embed: …]` and `<…>`). */
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>()[\]|]+/gi
/** Wiki links and whole Markdown links (label included): references to other pages, not prose. */
const LINKS = /\[\[[^\]\n]*\]\]|\[[^\]\n]*\]\((?:[^()\s]|\([^()\s]*\))+\)/g

/**
 * Switches of 0.15.1 (docs/adr/1900-*, 1901-*), exported so scripts/context-tune.ts can compare them
 * on the dev questions:
 *   - stripUrls: the words of link targets and bare URLs do not count for a query word
 *     ("solar-forecast" in a link no longer makes a table about something else match "forecast").
 *   - thinLetters: a chunk whose prose (links removed) has fewer letters/digits than this is scored
 *     like a heading-only chunk (×0.7) and is `weak`.
 *   - representative: a page's slot goes to a section that matches the query in its own heading or
 *     prose before a `weak` one (diversify).
 */
export const SECTION_RULES = { stripUrls: true, thinLetters: 8, representative: true }

/** Chunk text as matched against query words: Markdown link targets and bare URLs removed. */
export function searchText(text: string): string {
  if (!SECTION_RULES.stripUrls || (!text.includes('](') && !/https?:|www\./i.test(text))) return text
  return text.replace(MD_LINK_TARGET, ']').replace(BARE_URL, ' ')
}

const LETTER = /[\p{L}\p{N}]/u

/** The chunk's own prose: text without wiki links, Markdown links (label included) and addresses. */
export function proseText(text: string): string {
  return text.includes('[') || /https?:|www\./i.test(text) ? text.replace(LINKS, ' ').replace(BARE_URL, ' ') : text
}

/**
 * Letters and digits of the chunk's own prose (text without links, link labels and addresses),
 * counted up to `cap` (scoring only asks "fewer than thinLetters?", so it stops early).
 */
export function proseLetters(text: string, cap = Infinity): number {
  const prose = proseText(text)
  let n = 0
  for (const ch of prose) if (LETTER.test(ch) && ++n >= cap) break
  return n
}

/**
 * Score ≈ [0, 1.4]: idf-weighted coverage, BM25, title/heading hits, adjacency of consecutive query
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
): { score: number; coverage: number; bm25: number; title: number; heading: number; adjacent: number; phrase: boolean; own: number; weak: boolean } {
  const { groups } = input
  if (groups.length === 0) return { score: 0, coverage: 0, bm25: 0, title: 0, heading: 0, adjacent: 0, phrase: false, own: 0, weak: true }
  // Aliases are other names of the page: they count as title (docs/adr/1701-*).
  const title = (c.aliases ? `${c.title}\n${c.aliases}` : c.title).toLowerCase()
  const heading = c.headingPath.toLowerCase()
  // Link targets and bare URLs are not words of the note (docs/adr/1901-*).
  const body = searchText(c.text).toLowerCase()
  // The page title is part of every chunk's text for tf (BM25F with all field weights 1).
  const hay = `${title}\n${heading}\n${body}`
  /**
   * What the chunk says itself (docs/adr/1900-*): its heading path and prose. Without links in the
   * text that is `hay` after the title (offset ownFrom); with links, a separate text without them,
   * so "← [[빗물 센서 2심 판결]]" is not evidence of 빗물 센서.
   */
  const ownFrom = title.length + 1
  const ownHay = c.text.includes('[') ? `${heading}\n${proseText(c.text).toLowerCase()}` : null
  const w = groups.map((_, i) => input.idf[i] ?? 1)
  const wSum = w.reduce((a, b) => a + b, 0) || 1
  const { k1, b, pivot } = BM25
  const norm = 1 - b + (b * Math.max(1, c.tokens)) / pivot
  let cover = 0
  let bm25 = 0
  let inTitle = 0
  let inHeading = 0
  let own = 0
  /** Per group: [start, end) of every occurrence (a stem inside a longer variant's hit is the same one). */
  const spans: [number, number][][] = []
  groups.forEach((g, i) => {
    const hits = groupSpans(hay, g)
    spans.push(hits)
    const tf = hits.length
    const ti = g.variants.some((v) => title.includes(v)) || (hasExtra(g) && groupSpans(title, g).length > 0)
    const he = g.variants.some((v) => heading.includes(v)) || (hasExtra(g) && groupSpans(heading, g).length > 0)
    if (tf > 0 || ti) cover += w[i]
    if (ti) inTitle += w[i]
    if (he) inHeading += w[i]
    if (ownHay === null ? hits.some(([a]) => a >= ownFrom) : groupSpans(ownHay, g).length > 0) own += w[i]
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
  // heading-only chunk, or a line of links (docs/adr/1900-*): little to read
  const thin = c.text.trim().length < 20 || (SECTION_RULES.thinLetters > 0 && proseLetters(c.text, SECTION_RULES.thinLetters) < SECTION_RULES.thinLetters)
  if (thin) s *= 0.7
  return {
    score: Math.round(s * 1e6) / 1e6,
    coverage: cover / wSum,
    bm25: bm25 / wSum,
    title: inTitle / wSum,
    heading: inHeading / wSum,
    adjacent: adjShare,
    phrase,
    own: own / wSum,
    weak: thin || own === 0,
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
/**
 * Header cost not visible to pack: `; can: read,comment,edit`, `; edited by … via …`, review notes
 * (added by the MCP layer). The rest of the header is estimated from the actual title, heading,
 * anchor and version (docs/adr/1212-*).
 */
export const HEADER_FACTS_TOKENS = 15
/**
 * Packing (docs/adr/1902-*): a chunk larger than `largeShare` × budget is cut around its best
 * matching lines to that size even when it would fit, so one long table or log cannot take the
 * whole budget from the shorter sections after it; `minTail` = the least text worth showing for a
 * piece cut to the remaining budget (below it the piece becomes a pointer).
 */
export const PACKING = {
  largeShare: 0.4,
  minTail: 80,
  /**
   * Tiny chunks would win any value/weight ratio; weigh them as at least this many tokens. 60 → 80 in
   * 0.15.1 (docs/adr/1902-*): with 60, fourteen 54-token near-floor notes (ratio 0.508/60) outran the
   * 72-token answer (0.594/72) at a 1,500 budget.
   */
  minWeight: 80,
}
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

/** Query words for cutting: the groups and their weights (idf), or plain forms of weight 1. */
export interface CutTerms {
  groups: TermGroup[]
  weights?: number[]
}

/** Weighted number of different query words on one line (URLs removed, as in scoring). */
function lineWeight(line: string, cut: CutTerms): number {
  const hay = searchText(line).toLowerCase()
  let w = 0
  cut.groups.forEach((g, i) => {
    if (groupSpans(hay, g).length) w += cut.weights?.[i] ?? 1
  })
  return w
}

/**
 * Cut `text` to `maxTokens` around its best matching line (docs/adr/1902-*): the line with the most
 * (idf-weighted) different query words, URLs not counted, first such line on a tie; then up to two
 * lines of context before it and as many lines after it as fit, then earlier lines if room is left.
 * A table keeps its first row (the column names) when the window starts below it. '… ' / ' …' mark
 * the cut ends. Deterministic: a function of the text, the words and the size only.
 */
export function cutAroundHit(text: string, terms: CutTerms | string[], maxTokens: number): string {
  const cut: CutTerms = Array.isArray(terms) ? { groups: terms.map((t) => ({ word: t, variants: [t] })) } : terms
  const lines = text.split('\n')
  let best = 0
  let bestW = 0
  lines.forEach((l, i) => {
    const w = lineWeight(l, cut)
    if (w > bestW) {
      bestW = w
      best = i
    }
  })
  const cost = lines.map((l) => estimateTokens(l) + 1)
  if (cost[best] > maxTokens) {
    // one line longer than the room (a long paragraph): start a little before its first hit
    const line = lines[best]
    const lower = line.toLowerCase()
    const at = Math.min(...cut.groups.map((g) => groupSpans(lower, g)[0]?.[0] ?? Infinity))
    // about a sentence of context before the hit, from a word boundary
    let from = Number.isFinite(at) ? Math.max(0, at - 120) : 0
    if (from > 0) from = Math.max(0, line.lastIndexOf(' ', from) + 1)
    const piece = truncateToTokens(line.slice(from), maxTokens).text
    return `${best > 0 || from > 0 ? '… ' : ''}${piece} …`
  }
  // a table row far below the column names: keep room for them (and the '…' line after them)
  const reserve = best > 2 && lines[0].startsWith('|') && lines[best].startsWith('|') && cost[best] + cost[0] + 2 <= maxTokens ? cost[0] + 2 : 0
  const room = maxTokens - reserve
  let start = best
  let end = best + 1
  let used = cost[best]
  // two lines of context before the hit when they fit, then forward, then backward
  for (let k = 0; k < 2 && start > 0 && used + cost[start - 1] <= room; k++) used += cost[--start]
  while (end < lines.length && used + cost[end] <= room) used += cost[end++]
  while (start > 0 && used + cost[start - 1] <= room) used += cost[--start]
  let window = lines.slice(start, end)
  const tableHead = reserve > 0 && start > 0
  if (tableHead) window = [lines[0], '…', ...window]
  const body = truncateToTokens(window.join('\n'), maxTokens).text
  return `${start > 0 && !tableHead ? '… ' : ''}${body} …`
}

/** The label of a chunk without page context: the full anchor and heading path (pre-1212 output). */
export function fullLabel(c: Pick<Candidate, 'anchor' | 'headingPath'>): SectionLabel {
  return { short: c.anchor, heading: c.headingPath }
}

/** Estimated tokens of a fragment's two header lines as renderFindContext prints them. */
export function headerTokens(c: Pick<Candidate, 'title' | 'pageId' | 'version'>, label: SectionLabel): number {
  // the page id is printed as its 8-character prefix (docs/adr/1906-*)
  const head = `[10] ${c.title || 'Untitled'}${label.heading ? ` › ${label.heading}` : ''}\n(page ${c.pageId.slice(0, 8)}; §${label.short} v=${c.version})`
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
  /** Query words with their weights, for cutting around the best line (else the plain `terms`). */
  cut?: CutTerms
  /** Estimated tokens of a whole section (all its parts), for the `truncated` note; default the chunk's. */
  sectionTokens?: (c: Candidate) => number
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
  // A page's sections in slot order: those that match the query themselves (heading or prose) first,
  // then `weak` ones (title-only or a line of links), each group best first (docs/adr/1900-*). A
  // section is weak only when every part of it in the pool is.
  const strong = new Set(pool.filter((c) => !c.weak).map((c) => `${c.pageId}#${c.anchor}`))
  const slots = new Map<string, string[]>()
  const order = SECTION_RULES.representative ? [...pool.filter((c) => strong.has(`${c.pageId}#${c.anchor}`)), ...pool.filter((c) => !strong.has(`${c.pageId}#${c.anchor}`))] : pool
  for (const c of order) {
    const list = slots.get(c.pageId) ?? []
    if (!list.includes(c.anchor)) list.push(c.anchor)
    slots.set(c.pageId, list)
  }
  const out = pool.map((c) => {
    const extra = slots.get(c.pageId)!.indexOf(c.anchor) + 1 - cap
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

  const ratio = (c: Scored) => c.score / Math.max(PACKING.minWeight, c.tokens)
  const order = [pool[0], ...pool.slice(1).sort((a, b) => ratio(b) - ratio(a) || byScore(a, b))]

  const cutTerms: CutTerms | string[] = opts.cut ?? terms
  // A chunk above this many tokens is cut around its best lines even when it fits (docs/adr/1902-*).
  const large = Math.max(PACKING.minTail, Math.floor(budget * PACKING.largeShare))
  let left = budget
  const taken: { c: Scored; text: string; truncated: boolean }[] = []
  const overflow: Scored[] = []
  for (const c of order) {
    const head = headerTokens(c, label(c))
    let text = c.text
    let tokens = c.tokens
    let truncated = false
    if (tokens > large) {
      text = cutAroundHit(c.text, cutTerms, large - 2) // 2 = the '… ' markers
      tokens = estimateTokens(text)
      truncated = true
    }
    if (tokens + head <= left) {
      taken.push({ c, text, truncated })
      left -= tokens + head
    } else if (left - head >= PACKING.minTail) {
      const cutText = cutAroundHit(c.text, cutTerms, left - head - 2)
      taken.push({ c, text: cutText, truncated: true })
      left -= estimateTokens(cutText) + head
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
        if (t.truncated) cur.fullTokens = opts.sectionTokens?.(c) ?? c.tokens
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
          ...(t.truncated ? { fullTokens: opts.sectionTokens?.(c) ?? c.tokens } : {}),
        }
        fragments.push(cur)
      }
      lastOrd = c.ord
    }
  }
  fragments.sort((a, b) => byScore({ ...a, ord: a.ords[0] }, { ...b, ord: b.ords[0] }))
  return { fragments, usedTokens: budget - left, overflow: [...overflow, ...heldBack].sort(byScore) }
}
