import { particleFamily } from '../context/rank'

/**
 * Pure parts of the agent search (docs/adr/2183-*, 2184-*): limits, result types, the whole-word
 * pattern and the snippet. No database, so the MCP renderers (mcpTools/compactList.ts) and unit
 * tests can import them.
 */

export const SEARCH_DEFAULT_LIMIT = 10
export const SEARCH_MAX_LIMIT = 50

export type SearchMatch = 'title' | 'heading' | 'body'

export interface AgentSearchHit {
  id: string
  workspaceId: string
  title: string
  kind: string
  scope: string
  updatedAt: string
  match: SearchMatch
  /** Whole word (or the whole title) rather than part of a longer word. */
  exact: boolean
  /** Heading and body matches: the first section that matches (full anchor) … */
  anchor?: string
  /** … its shortest unique suffix on the page, as find_context prints it (docs/adr/1212-*) … */
  shortAnchor?: string
  /** … and its heading path (' › '). */
  headingPath?: string
  /** Body matches: about 60 characters on each side of the first (whole-word first) match. */
  snippet?: string
}

export interface AgentSearchResponse {
  results: AgentSearchHit[]
  /** All matches, shown or not. */
  total: number
  /** Workspaces with matches: count desc, then id. */
  workspaces: { id: string; name: string; matches: number }[]
  limit: number
  /** Archived workspaces left out of a search without workspaceId (docs/adr/2303-*); absent when none. */
  archived?: { id: string; name: string }[]
}

/**
 * Word characters for the whole-word test, written out instead of [[:alnum:]] so the result does
 * not depend on the database's LC_CTYPE (a "C" database classifies every non-ASCII letter as
 * punctuation): ASCII letters, digits and _, Latin-1/Extended letters, Greek, Cyrillic, Hangul
 * jamo and syllables, kana and CJK ideographs. The same class serves the JS snippet search.
 */
const WORD =
  '0-9A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF' +
  '\\u1100-\\u11FF\\u3040-\\u30FF\\u3130-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7A3'
const WORD_RE = new RegExp(`[${WORD}]`, 'u')
/** A second particle after the first ("해커톤에서는", "팀에도", "회의까지만"). */
const SECOND_PARTICLES = ['는', '은', '도', '만']

const isHangulSyllable = (ch: string) => ch >= '가' && ch <= '힣'

/** Characters with a meaning in both POSIX ARE and JS `u` regexes (a hyphen outside [] is literal in both). */
export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

/**
 * The whole-word pattern of `term` (Postgres `~*` and JS with flags 'iu'): no word character right
 * before or after it. A side whose edge is not a word character ("C++", ".md") gets no boundary
 * test. A term ending in a Hangul syllable may be followed by a particle that fits its final sound
 * and then a second short one (해커톤 → 해커톤에서, 해커톤에서는; context/rank.ts particleFamily):
 * Korean writes particles without a space, so the strict rule would make Korean whole-word matches
 * nearly impossible. Verb endings and copulas (해커톤이다) stay partial matches.
 */
export function wholeWordPattern(term: string): string {
  const chars = [...term]
  const first = chars[0] ?? ''
  const last = chars[chars.length - 1] ?? ''
  let suffix = ''
  if (isHangulSyllable(last)) {
    const particles = particleFamily(last)
      .slice(1)
      .map((f) => f.slice(last.length))
      .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    suffix = `(?:${particles.join('|')})?(?:${SECOND_PARTICLES.join('|')})?`
  }
  const before = WORD_RE.test(first) ? `(?<![${WORD}])` : ''
  const after = WORD_RE.test(last) ? `(?![${WORD}])` : ''
  return `${before}${escapeRegex(term)}${suffix}${after}`
}

/**
 * Snippet around the match inside `win`, a window of the page text (`atStart`/`atEnd`: the window
 * begins/ends where the text does). Same shape as the web search's snippets: ±60 characters, cut at
 * spaces where possible, whitespace collapsed, … where text was left out.
 */
export function searchSnippet(win: string, term: string, opts: { exact: boolean; atStart: boolean; atEnd: boolean }): string {
  let idx = -1
  let len = term.length
  if (opts.exact) {
    const m = new RegExp(wholeWordPattern(term), 'iu').exec(win)
    if (m) {
      idx = m.index
      len = m[0].length
    }
  }
  if (idx < 0) idx = win.toLowerCase().indexOf(term.toLowerCase())
  if (idx < 0) {
    idx = 0
    len = 0
  }
  const matchEnd = idx + len
  let start = Math.max(0, idx - 60)
  let end = Math.min(win.length, matchEnd + 60)
  if (start > 0) {
    const sp = win.indexOf(' ', start)
    if (sp >= 0 && sp < idx) start = sp + 1
  }
  if (end < win.length) {
    const sp = win.lastIndexOf(' ', end)
    if (sp > matchEnd) end = sp
  }
  let s = win.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0 || !opts.atStart) s = `…${s}`
  if (end < win.length || !opts.atEnd) s = `${s}…`
  return s
}
