import { randomBytes } from 'node:crypto'
import { INLINE_MATH_TYPE, MATH_BLOCK_TYPE, scanInlineMath } from '@inkling/shared'
import type { AnyBlock, Inline, LinkInline, StyledText } from './convert'

/**
 * Markdown notation for math nodes (docs/adr/0996-math-markdown-notation.md):
 *   block  → `$$` line, the LaTeX verbatim, `$$` line
 *   inline → `$latex$`
 *
 * BlockNote's Markdown pipeline (remark) knows neither form and escapes `_`, `*`, `[` and `\`, which
 * is most of LaTeX. So math never goes through it: on export each node becomes an alphanumeric
 * sentinel that remark leaves alone and the LaTeX is put back verbatim afterwards; on import the
 * delimited spans are cut out before parsing and the sentinels turned back into nodes after.
 */

interface Sentinels {
  nonce: string
  next: number
}

function newSentinels(avoid: string): Sentinels {
  let nonce = ''
  do nonce = `Iq${randomBytes(6).toString('hex').replace(/\d/g, (d) => 'ghijklmnop'[Number(d)])}`
  while (avoid.includes(nonce))
  return { nonce, next: 0 }
}

/** `<nonce><kind><n>Q` — letters and digits only, so remark never escapes or splits it. */
function sentinel(s: Sentinels, kind: 'B' | 'I' | 'D'): string {
  return `${s.nonce}${kind}${s.next++}Q`
}

const isCode = (inl: Inline) => inl.type === 'text' && !!(inl as StyledText).styles?.code

function isTableContent(c: AnyBlock['content']): c is Extract<AnyBlock['content'], { type: 'tableContent' }> {
  return !!c && !Array.isArray(c) && (c as { type?: string }).type === 'tableContent'
}

/** Calls `fn` for every inline array (paragraph-like content and table cells), children included. */
function eachInlineArray(
  blocks: AnyBlock[],
  fn: (inlines: Inline[], inTable: boolean) => Inline[],
): void {
  for (const b of blocks) {
    const c = b.content
    // code is verbatim: `$` there is neither math nor escaped
    if (b.type === 'codeBlock') continue
    if (Array.isArray(c)) b.content = fn(c, false)
    else if (isTableContent(c)) {
      for (const row of c.rows) {
        const cells = row.cells as unknown[]
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i]
          if (Array.isArray(cell)) cells[i] = fn(cell as Inline[], true)
          else if (cell && typeof cell === 'object' && Array.isArray((cell as { content?: unknown }).content)) {
            const obj = cell as { content: Inline[] }
            obj.content = fn(obj.content, true)
          }
        }
      }
    }
    if (Array.isArray(b.children)) eachInlineArray(b.children, fn)
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/** Inline LaTeX as one `$…$` span: one line, no surrounding spaces (pandoc's rule needs them gone). */
function inlineSource(latex: string, inTable: boolean): string {
  let src = latex.replace(/\s*\n\s*/g, ' ').trim()
  // A `|` would end a GFM table cell. `\|` and `|` render the same as `\Vert` and `\vert`.
  if (inTable) src = src.replace(/\\\|/g, '\\Vert ').replace(/\|/g, '\\vert ').trim()
  return src ? `$${src}$` : ''
}

/**
 * Whether literal `$` in this run of text must be written as `\$` so that importing the Markdown
 * again does not turn it into math: when the line holds inline math, when it has `$$`, or when the
 * text alone already matches the `$…$` rule. Prices (`$5 and $10`) stay unescaped.
 */
function dollarsNeedEscape(inlines: Inline[]): boolean {
  let text = ''
  for (const inl of inlines) {
    if (inl.type === INLINE_MATH_TYPE) return true
    if (inl.type === 'text' && !isCode(inl)) text += (inl as StyledText).text
    else if (inl.type === 'link') text += ((inl as LinkInline).content ?? []).map((c) => (c.styles?.code ? ' ' : c.text)).join('')
    else text += ' '
  }
  if (!text.includes('$')) return false
  return text.includes('$$') || scanInlineMath(text).length > 0
}

/**
 * Replaces math nodes in `blocks` (a copy, mutated) with sentinels and returns the function that
 * turns BlockNote's Markdown output back into the documented notation.
 */
export function prepareMathExport(blocks: AnyBlock[]): (markdown: string) => string {
  const s = newSentinels(JSON.stringify(blocks))
  const blockSources = new Map<string, string>()
  const inlineSources = new Map<string, string>()
  let dollar = ''

  const replaceBlocks = (list: AnyBlock[]) => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      if (b.type === MATH_BLOCK_TYPE) {
        const key = sentinel(s, 'B')
        blockSources.set(key, String(b.props?.latex ?? ''))
        list[i] = { ...b, type: 'paragraph', props: {}, content: [{ type: 'text', text: key, styles: {} }] }
      }
      if (Array.isArray(list[i].children)) replaceBlocks(list[i].children!)
    }
  }
  replaceBlocks(blocks)

  eachInlineArray(blocks, (inlines, inTable) => {
    const escape = dollarsNeedEscape(inlines)
    if (escape && !dollar) dollar = sentinel(s, 'D')
    const escText = (t: StyledText): StyledText =>
      escape && !t.styles?.code && t.text.includes('$') ? { ...t, text: t.text.replaceAll('$', dollar) } : t
    return inlines.map((inl) => {
      if (inl.type === INLINE_MATH_TYPE) {
        const key = sentinel(s, 'I')
        const props = (inl as { props?: { latex?: unknown } }).props
        inlineSources.set(key, inlineSource(String(props?.latex ?? ''), inTable))
        return { type: 'text', text: key, styles: {} } as StyledText
      }
      if (inl.type === 'text') return escText(inl as StyledText)
      if (inl.type === 'link') {
        const l = inl as LinkInline
        return { ...l, content: (l.content ?? []).map(escText) } as Inline
      }
      return inl
    })
  })

  if (!blockSources.size && !inlineSources.size && !dollar) return (md) => md

  return (markdown: string) => {
    let md = markdown
    for (const [key, latex] of blockSources) {
      // The sentinel paragraph is its own line; keep its indentation / quote prefix on every line.
      const own = new RegExp(`^([ \\t>]*)${key}[ \\t]*$`, 'm')
      const m = own.exec(md)
      if (m) {
        const prefix = m[1]
        const lines = ['$$', ...latex.split('\n'), '$$'].map((l) => (l ? prefix + l : prefix.trimEnd()))
        md = md.slice(0, m.index) + lines.join('\n') + md.slice(m.index + m[0].length)
      } else {
        md = md.replace(key, () => (latex.trim() ? `$$${latex.replace(/\s*\n\s*/g, ' ').trim()}$$` : ''))
      }
    }
    for (const [key, src] of inlineSources) md = md.replace(key, () => src)
    if (dollar) md = md.replaceAll(dollar, '\\$')
    return md
  }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})/
const DISPLAY_OPEN_RE = /^([ \t>]*)\$\$[ \t]*$/
const DISPLAY_ONE_LINE_RE = /^([ \t>]*)\$\$(.*\S.*?)\$\$[ \t]*$/

/** Masks code spans, link destinations and autolinks so `$` inside them is never math. */
function maskedSegments(line: string): { text: string; from: number }[] {
  const out: { text: string; from: number }[] = []
  const skip = /(`+)[\s\S]*?\1|\]\([^)\s]*(?:\s+"[^"]*")?\)|<[a-z][a-z0-9+.-]*:[^>\s]*>/gi
  let last = 0
  for (let m = skip.exec(line); m; m = skip.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), from: last })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), from: last })
  return out
}

export interface MathImport {
  /** The Markdown with math replaced by sentinels, for BlockNote's parser. */
  markdown: string
  /** Turns sentinels in the parsed blocks back into math nodes (in place) and returns the blocks. */
  restore(blocks: AnyBlock[]): AnyBlock[]
}

/** Cuts `$$…$$` blocks and `$…$` spans out of `md` (outside fenced code and code spans). */
export function extractMath(md: string): MathImport {
  if (!md.includes('$')) return { markdown: md, restore: (b) => b }
  const s = newSentinels(md)
  const blockSources = new Map<string, string>()
  const inlineSources = new Map<string, string>()
  let dollar = ''

  const lines = md.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE_RE.exec(line)
    if (fence) {
      out.push(line)
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim().replace(/^[>\s]*/, '') === f[1]) fence = null
      continue
    }
    if (f) {
      fence = f[1]
      out.push(line)
      continue
    }
    if (!line.includes('$')) {
      out.push(line)
      continue
    }

    // display math: `$$` alone on a line … `$$` alone on a line (same prefix), or `$$x$$` as the whole line
    const open = DISPLAY_OPEN_RE.exec(line)
    if (open) {
      const prefix = open[1]
      let end = -1
      for (let j = i + 1; j < lines.length; j++) {
        if (FENCE_RE.test(lines[j])) break
        const close = DISPLAY_OPEN_RE.exec(lines[j])
        if (close && close[1].trimEnd() === prefix.trimEnd()) {
          end = j
          break
        }
      }
      if (end > 0) {
        const body = lines
          .slice(i + 1, end)
          .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l.startsWith(prefix.trimEnd()) ? l.slice(prefix.trimEnd().length) : l))
        const key = sentinel(s, 'B')
        blockSources.set(key, body.join('\n'))
        out.push(prefix.trimEnd(), prefix + key, prefix.trimEnd())
        i = end
        continue
      }
    }
    const one = DISPLAY_ONE_LINE_RE.exec(line)
    if (one && !one[2].includes('$$')) {
      const key = sentinel(s, 'B')
      blockSources.set(key, one[2].trim())
      out.push(one[1].trimEnd(), one[1] + key, one[1].trimEnd())
      continue
    }

    // inline math, and `\$` (BlockNote's parser keeps the backslash; CommonMark drops it)
    let next = ''
    let pos = 0
    for (const seg of maskedSegments(line)) {
      next += line.slice(pos, seg.from) // code span / link destination: verbatim
      let p = 0
      for (const span of scanInlineMath(seg.text)) {
        const key = sentinel(s, 'I')
        inlineSources.set(key, span.latex)
        next += unescapeDollars(seg.text.slice(p, span.start)) + key
        p = span.end
      }
      next += unescapeDollars(seg.text.slice(p))
      pos = seg.from + seg.text.length
    }
    out.push(next + line.slice(pos))
  }

  function unescapeDollars(text: string): string {
    if (!text.includes('\\$')) return text
    return text.replace(/\\\\|\\\$/g, (m) => {
      if (m !== '\\$') return m
      dollar ||= sentinel(s, 'D')
      return dollar
    })
  }

  if (!blockSources.size && !inlineSources.size && !dollar) return { markdown: md, restore: (b) => b }
  const any = new RegExp(`${s.nonce}[BI]\\d+Q`, 'g')
  const sourceOf = (key: string) => blockSources.get(key) ?? inlineSources.get(key) ?? ''
  const literal = (key: string) => (blockSources.has(key) ? `$$${sourceOf(key)}$$` : `$${sourceOf(key)}$`)

  const restore = (blocks: AnyBlock[]): AnyBlock[] => {
    const restoreBlocks = (list: AnyBlock[]) => {
      for (let i = 0; i < list.length; i++) {
        const b = list[i]
        const c = b.content
        if (b.type === 'paragraph' && Array.isArray(c) && c.length === 1 && c[0].type === 'text') {
          const text = (c[0] as StyledText).text.trim()
          if (blockSources.has(text)) {
            list[i] = { id: b.id, type: MATH_BLOCK_TYPE, props: { latex: blockSources.get(text)! }, children: b.children ?? [] }
          }
        }
        if (Array.isArray(list[i].children)) restoreBlocks(list[i].children!)
      }
    }
    restoreBlocks(blocks)

    const splitText = (t0: StyledText): Inline[] => {
      const t = dollar && t0.text.includes(dollar) ? { ...t0, text: t0.text.replaceAll(dollar, '$') } : t0
      any.lastIndex = 0
      if (!any.test(t.text)) return [t]
      any.lastIndex = 0
      const parts: Inline[] = []
      let last = 0
      for (let m = any.exec(t.text); m; m = any.exec(t.text)) {
        if (m.index > last) parts.push({ ...t, text: t.text.slice(last, m.index) })
        // inside code a sentinel cannot be a node; give the source back as text
        if (t.styles?.code) parts.push({ ...t, text: literal(m[0]) })
        else parts.push({ type: INLINE_MATH_TYPE, props: { latex: sourceOf(m[0]).replace(/\s*\n\s*/g, ' ') } })
        last = m.index + m[0].length
      }
      if (last < t.text.length) parts.push({ ...t, text: t.text.slice(last) })
      return mergeText(parts)
    }
    eachInlineArray(blocks, (inlines) =>
      inlines.flatMap((inl) => {
        if (inl.type === 'text') return splitText(inl as StyledText)
        if (inl.type === 'link') {
          // link text holds styled text only: math in it comes back as its source
          const l = inl as LinkInline
          const text = (c: StyledText) => {
            const t = c.text.replace(any, literal)
            return dollar ? t.replaceAll(dollar, '$') : t
          }
          return [{ ...l, content: (l.content ?? []).map((c) => ({ ...c, text: text(c) })) } as Inline]
        }
        return [inl]
      }),
    )
    return blocks
  }
  return { markdown: out.join('\n'), restore }
}

/** Joins adjacent text runs with equal styles (a code-span fallback can leave two in a row). */
function mergeText(parts: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.type === 'text' &&
      p.type === 'text' &&
      JSON.stringify((prev as StyledText).styles ?? {}) === JSON.stringify((p as StyledText).styles ?? {})
    ) {
      out[out.length - 1] = { ...(prev as StyledText), text: (prev as StyledText).text + (p as StyledText).text }
    } else if (!(p.type === 'text' && (p as StyledText).text === '')) out.push(p)
  }
  return out
}
