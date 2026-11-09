// Command palette search (docs/adr/1402-*): plain substrings, Korean initial consonants (ㄱㄹㅍ →
// 그래프) and a half-typed syllable run (사이ㄷ → 사이드바), across the English and Korean names of
// each command, with recent commands first. Pure functions: no DOM, no dictionary lookups.

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const SYLLABLE_FIRST = 0xac00
const SYLLABLE_LAST = 0xd7a3
const isSyllable = (c: number) => c >= SYLLABLE_FIRST && c <= SYLLABLE_LAST
// compatibility jamo consonants ㄱ..ㅎ — what an IME shows for a lone initial
const isJamoConsonant = (ch: string) => CHO.includes(ch)

function choseongOf(ch: string): string {
  const c = ch.charCodeAt(0)
  return isSyllable(c) ? CHO[Math.floor((c - SYLLABLE_FIRST) / 588)] : ch
}

/** Each Hangul syllable replaced by its initial consonant; everything else lowercased. */
export function choseong(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) out += choseongOf(ch)
  return out
}

// One query character against one text character: equal, or a lone consonant against a syllable
// that starts with it.
const charMatch = (q: string, t: string) => q === t || (isJamoConsonant(q) && choseongOf(t) === q)

const isWordStart = (text: string, i: number) => i === 0 || /[\s/()[\]·,.\-_:]/.test(text[i - 1])

/**
 * How well `query` matches `text` (0 = not at all). A run starting the text scores highest, then
 * one starting a word, then one anywhere, then the query's characters in order with gaps.
 */
export function scoreText(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  let best = 0
  for (let i = 0; i + q.length <= t.length; i++) {
    let ok = true
    for (let j = 0; j < q.length; j++) {
      if (!charMatch(q[j], t[i + j])) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const s = i === 0 ? 100 : isWordStart(t, i) ? 80 : 60
    if (s > best) best = s
    if (best === 100) break
  }
  if (best) return best - Math.min(10, t.length / 10)
  // scattered: every query character in order, fewer gaps score higher — from three characters on; two
  // scattered characters (ㅈㅁ) match half the list
  if (q.replace(/\s/g, '').length < 3) return 0
  let ti = 0
  let gaps = 0
  for (let j = 0; j < q.length; j++) {
    if (q[j] === ' ') continue
    let found = false
    while (ti < t.length) {
      if (charMatch(q[j], t[ti++])) {
        found = true
        break
      }
      gaps++
    }
    if (!found) return 0
  }
  return Math.max(1, 30 - gaps)
}

export type Searchable = { id: string; texts: string[] }

/**
 * Items matching every word of the query, best first; ties go to the more recent command. An empty
 * query gives the recent commands (most recent first) and then the rest in their given order.
 */
export function searchCommands<T extends Searchable>(items: readonly T[], query: string, recent: readonly string[]): T[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  const rank = (id: string) => {
    const i = recent.indexOf(id)
    return i < 0 ? Infinity : i
  }
  if (words.length === 0) {
    const byId = new Map(items.map((it) => [it.id, it]))
    const head = recent.map((id) => byId.get(id)).filter((x): x is T => !!x)
    const seen = new Set(head.map((x) => x.id))
    return [...head, ...items.filter((it) => !seen.has(it.id))]
  }
  const scored: { it: T; score: number; order: number }[] = []
  items.forEach((it, order) => {
    let total = 0
    for (const w of words) {
      // the whole query as typed may match better than its words (a label with the space in it)
      const s = Math.max(...it.texts.map((t) => scoreText(t, w)))
      if (s <= 0) return
      total += s
    }
    if (words.length > 1) total += Math.max(0, ...it.texts.map((t) => scoreText(t, query))) / 2
    scored.push({ it, score: total, order })
  })
  scored.sort((a, b) => b.score - a.score || rank(a.it.id) - rank(b.it.id) || a.order - b.order)
  return scored.map((s) => s.it)
}

export const RECENT_MAX = 5

export function pushRecent(list: readonly string[], id: string): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX)
}

// Per device (docs/adr/1402-*): a convenience, not account data. Storage may be unavailable.
const RECENT_KEY = 'inkling:palette-recent'

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function rememberCommand(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(loadRecent(), id)))
  } catch {
    // private mode or blocked storage: the palette simply has no recent list
  }
}
