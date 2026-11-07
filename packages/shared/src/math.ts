// Math (KaTeX) nodes shared by the web editor and the server's BlockNote schema
// (docs/adr/0995-math-nodes-in-both-editor-schemas.md).
//
// The web app renders these with KaTeX; the server never renders them, it only has to know the
// node names and attributes so y-prosemirror keeps them when the server reads a document, and so
// Markdown import/export can write them as `$$…$$` / `$…$` (docs/adr/0996-*).
// Both sides must build their specs from these configs: a different name, prop or default makes
// the ProseMirror schemas disagree and the server would drop the node on read.

/** Block type of a display equation (content 'none', one `latex` prop). */
export const MATH_BLOCK_TYPE = 'math' as const
/** Inline content type of an inline equation (atom, one `latex` prop). */
export const INLINE_MATH_TYPE = 'inlineMath' as const
/** The only prop of both nodes: the LaTeX source, never rendered HTML. */
export const MATH_LATEX_PROP = 'latex' as const

export const mathBlockConfig = {
  type: MATH_BLOCK_TYPE,
  propSchema: { latex: { default: '' } },
  content: 'none',
} as const

export const inlineMathConfig = {
  type: INLINE_MATH_TYPE,
  propSchema: { latex: { default: '' } },
  content: 'none',
} as const

/** Longer sources are shown as text with a warning instead of rendered: one huge formula must not block the main thread (docs/adr/0997-*). */
export const MATH_MAX_LATEX = 4_000

/**
 * Commands refused before KaTeX sees the source (docs/adr/0997-*):
 *  - macro definitions (`\def`, `\newcommand`, …): KaTeX scopes them per render, but they are the
 *    tool for expansion bombs and make a formula's meaning depend on hidden text;
 *  - commands that create links, images or raw HTML attributes (`\href`, `\url`,
 *    `\includegraphics`, `\htmlClass`, …). `trust: false` already renders them inert; refusing
 *    them up front gives a clear message instead of red text.
 */
export const MATH_BLOCKED_COMMANDS = [
  'def',
  'gdef',
  'edef',
  'xdef',
  'let',
  'futurelet',
  'global',
  'long',
  'newcommand',
  'renewcommand',
  'providecommand',
  'href',
  'url',
  'includegraphics',
  'htmlClass',
  'htmlId',
  'htmlStyle',
  'htmlData',
] as const

const BLOCKED_RE = new RegExp(`\\\\(${MATH_BLOCKED_COMMANDS.join('|')})(?![A-Za-z])`)

export type MathSourceProblem = { code: 'tooLong'; max: number } | { code: 'blocked'; command: string }

/** Why a LaTeX source must not be rendered, or null when it may go to KaTeX. */
export function checkLatexSource(latex: string): MathSourceProblem | null {
  if (latex.length > MATH_MAX_LATEX) return { code: 'tooLong', max: MATH_MAX_LATEX }
  const m = BLOCKED_RE.exec(latex)
  return m ? { code: 'blocked', command: `\\${m[1]}` } : null
}

export interface InlineMathSpan {
  /** Index of the opening `$`. */
  start: number
  /** Index after the closing `$`. */
  end: number
  /** Source between the delimiters, verbatim. */
  latex: string
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

/**
 * Inline `$…$` spans in one run of Markdown text, by pandoc's `tex_math_dollars` rule, which is what
 * keeps prices from turning into math:
 *  - the opening `$` is followed by a non-space character, the closing `$` is preceded by one;
 *  - the closing `$` is not followed by a digit (`$5 and $10` has no span);
 *  - `\$` is a literal dollar and never a delimiter; a span does not cross a line break.
 * `$$…$$` inside a line counts as an inline span too (its source is trimmed).
 * Code spans are the caller's business: pass only text outside them.
 */
export function scanInlineMath(text: string): InlineMathSpan[] {
  const out: InlineMathSpan[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c !== '$') {
      i++
      continue
    }
    if (text[i + 1] === '$') {
      // `$$…$$` on one line
      const close = findUnescaped(text, '$$', i + 2)
      if (close > 0) {
        const inner = text.slice(i + 2, close)
        if (inner.trim() && !inner.includes('\n')) {
          out.push({ start: i, end: close + 2, latex: inner.trim() })
          i = close + 2
          continue
        }
      }
      i += 2
      continue
    }
    if (isSpace(text[i + 1])) {
      i++
      continue
    }
    let j = i + 1
    while (j < n && text[j] !== '$' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
    if (j >= n || text[j] !== '$') {
      i = j >= n ? n : j
      continue
    }
    if (!isSpace(text[j - 1]) && !isDigit(text[j + 1]) && text[j + 1] !== '$') {
      out.push({ start: i, end: j + 1, latex: text.slice(i + 1, j) })
      i = j + 1
    } else {
      i = j // this `$` may open the next span
    }
  }
  return out
}

function findUnescaped(text: string, needle: string, from: number): number {
  for (let k = from; k <= text.length - needle.length; k++) {
    if (text[k] === '\\') {
      k++
      continue
    }
    if (text[k] === '\n') return -1
    if (text.startsWith(needle, k)) return k
  }
  return -1
}
