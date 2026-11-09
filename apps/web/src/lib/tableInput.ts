// Typing a table quickly (docs/adr/1642-*). Plain functions, no editor and no DOM, so node:test runs them:
// - parsePipeRow: "| 이름 | 역할 | 마감 |" typed on an empty line, turned into a table by Enter
// - tableSizeFromQuery: "/표 3x4", "/table 3*4" in the slash menu → 3 columns × 4 rows

/** Above this a typed or pasted row is left as text (a long line of pipes is more likely not a table). */
export const MAX_TABLE_COLS = 20
export const MAX_TABLE_ROWS = 50

/**
 * Splits on pipes that are not escaped. `\|` becomes a pipe in the cell; any other backslash stays.
 * Returns the raw pieces between pipes (the caller decides what the outer ones mean).
 */
function splitPipes(line: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** True when the last character is a pipe nobody escaped (an odd run of backslashes escapes it). */
function endsWithBarePipe(s: string): boolean {
  if (!s.endsWith('|')) return false
  let n = 0
  for (let i = s.length - 2; i >= 0 && s[i] === '\\'; i--) n++
  return n % 2 === 0
}

const SEPARATOR_CELL = /^:?-+:?$/

const isSeparatorRow = (cells: readonly string[]) => cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c))
// (A pasted Markdown table needs no parser here: BlockNote's paste reads text/plain as Markdown, GFM tables
// included — docs/adr/1642-*.)

/**
 * The cells of one typed row that starts and ends with a pipe, or null. At least two cells (`|a|` stays
 * text), no line break, and not a separator row (`|---|---|` alone is no header).
 */
export function parsePipeRow(line: string): string[] | null {
  if (line.includes('\n')) return null
  const s = line.trim()
  if (s.length < 3 || !s.startsWith('|') || !endsWithBarePipe(s)) return null
  const cells = splitPipes(s.slice(1, -1)).map((c) => c.trim())
  if (cells.length < 2 || cells.length > MAX_TABLE_COLS) return null
  if (isSeparatorRow(cells)) return null
  return cells
}

/**
 * The size typed after a table word in the slash menu: "표 3x4" → 3 columns, 4 rows. While the size is
 * still being typed ("표 3", "표 3x") `rows` is null, so the menu keeps an item and does not close on
 * "no results". Null when there is no number yet, another word, or a size out of range.
 */
export function tableSizeFromQuery(query: string): { cols: number; rows: number | null } | null {
  const m = /^(?:표|테이블|table)\s*(\d{1,3})\s*(?:[x×*]\s*(\d{0,3}))?$/i.exec(query.trim())
  if (!m) return null
  const cols = Number(m[1])
  const rows = m[2] ? Number(m[2]) : null
  if (cols < 1 || cols > MAX_TABLE_COLS) return null
  if (rows !== null && (rows < 1 || rows > MAX_TABLE_ROWS)) return null
  return { cols, rows }
}

/** An Enter that commits an IME composition (Korean, Japanese…): the text is not final, leave it alone. */
export function isImeEnter(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229
}
