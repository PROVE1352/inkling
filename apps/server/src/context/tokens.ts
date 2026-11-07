/**
 * Token estimate used for every budget in the agent tools (docs/adr/0926-*).
 *
 * No tokenizer dependency: ASCII characters count 1/4 token each (English averages ~4 characters
 * per token), Hangul/CJK characters 1 token each, other non-ASCII characters 1/2. It deliberately
 * errs high for Korean so a budget is not overrun. Reports that quote token numbers use this
 * estimator on both sides of a comparison.
 */
export function estimateTokens(s: string): number {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) ascii++
    else if (isCjkCode(c)) cjk++
    else if (c >= 0xdc00 && c <= 0xdfff) continue // low surrogate: counted with its high half
    else other++
  }
  return Math.ceil(ascii / 4 + cjk + other / 2)
}

/** Hangul syllables/jamo, CJK ideographs, kana. */
export function isCjkCode(c: number): boolean {
  return (
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x3130 && c <= 0x318f) ||
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x4e00 && c <= 0x9fff)
  )
}

/**
 * Cut `s` so that its estimate fits `maxTokens`, at a line or sentence boundary when one is close.
 * Returns the text unchanged when it already fits.
 */
export function truncateToTokens(s: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: s.length > 0 }
  if (estimateTokens(s) <= maxTokens) return { text: s, truncated: false }
  // Binary search on the character count (estimate is monotonic in the prefix length).
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  let cut = lo
  const window = s.slice(Math.max(0, cut - 200), cut)
  const nl = window.lastIndexOf('\n')
  if (nl > 0) cut = cut - window.length + nl
  else {
    const m = /[.!?。]\s[^.!?。]*$/.exec(window)
    if (m) cut = cut - window.length + m.index + 1
  }
  return { text: s.slice(0, cut).trimEnd(), truncated: true }
}
