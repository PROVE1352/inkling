// KaTeX rendering for math nodes (docs/adr/0997-math-rendering-katex-safety-and-loading.md).
// Pure: takes the KaTeX module as an argument, so it runs in Node tests without a DOM; the lazy
// loader and the DOM helpers live in ./katex.ts.
import type { KatexOptions } from 'katex'
// the subpath keeps zod and the other shared schemas out of the worker bundle
import { checkLatexSource } from '@inkling/shared/math'

type Katex = { renderToString(latex: string, options?: KatexOptions): string; version?: string }

/**
 * Safety options for every render (https://katex.org/docs/security, /docs/options):
 * - `trust: false`: `\href`, `\url`, `\includegraphics` and `\html*` stay inert (they are also
 *   refused before rendering by `checkLatexSource`);
 * - `throwOnError: false`: invalid input renders as its source and we show the parse message;
 * - `strict: 'warn'`: LaTeX-incompatible input (e.g. Hangul in math mode) only warns in the console;
 * - `maxSize` / `maxExpand`: caps user-given sizes (`\rule{1000em}`) and macro expansion;
 * - a fresh empty `macros` object per call, so nothing defined in one formula reaches the next.
 */
export const KATEX_SAFE_OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: 'warn',
  output: 'htmlAndMathml',
  maxSize: 20,
  maxExpand: 1000,
  errorColor: '#d14343',
} as const satisfies KatexOptions

export type MathRender =
  /** `warning`: KaTeX drew an unsupported command in errorColor; the reason, for showing it small. */
  | { ok: true; html: string; warning?: string }
  | { ok: false; reason: 'blocked'; command: string }
  | { ok: false; reason: 'tooLong'; max: number }
  | { ok: false; reason: 'parse'; message: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" }
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_m, e: string) => ENTITIES[e])

export type MathOutputFormat = 'htmlAndMathml' | 'mathml'

/**
 * Renders `latex`; refused sources and parse errors come back as a reason instead of HTML.
 * `output` 'mathml' exists only for the comparison in docs/PERFORMANCE.md (docs/adr/0998-*).
 */
export function renderLatex(
  katex: Katex,
  latex: string,
  displayMode: boolean,
  output: MathOutputFormat = 'htmlAndMathml',
): MathRender {
  const problem = checkLatexSource(latex)
  if (problem?.code === 'blocked') return { ok: false, reason: 'blocked', command: problem.command }
  if (problem?.code === 'tooLong') return { ok: false, reason: 'tooLong', max: problem.max }
  const options = { ...KATEX_SAFE_OPTIONS, output, displayMode, macros: {} }
  let html: string
  try {
    html = katex.renderToString(latex, options)
  } catch (e) {
    // with throwOnError false only internal errors (e.g. maxExpand) still throw
    return { ok: false, reason: 'parse', message: messageOf(e) }
  }
  // throwOnError: false renders a parse error as the source in `.katex-error`, message in its title
  const err = /class="katex-error"[^>]*?title="([^"]*)"/.exec(html)
  if (err) return { ok: false, reason: 'parse', message: decode(err[1]).replace(/^ParseError: /, '') }
  // …and an unknown command as red text without a message; KaTeX only says why when asked to throw
  if (html.includes(KATEX_SAFE_OPTIONS.errorColor)) {
    try {
      katex.renderToString(latex, { ...options, throwOnError: true, macros: {} })
    } catch (e) {
      return { ok: true, html, warning: messageOf(e) }
    }
  }
  return { ok: true, html }
}

function messageOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/^ParseError: /, '')
}
