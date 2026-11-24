import { CALLOUT_TYPES, INLINE_MATH_TYPE, MATH_BLOCK_TYPE, scanInlineMath } from '@inkling/shared'

// Inkling's Markdown notation for math and callouts, applied to Markdown pasted into the editor.
//
// BlockNote's paste turns Markdown text into blocks with its own parser, which knows neither
// `$$…$$` / `$…$` (docs/adr/0996-*) nor `> [!type]` (docs/adr/1500-*): they stayed text and a quote.
// The server reads the same notation on import (apps/server/src/md/math.ts `extractMath`,
// md/notation.ts `calloutFromQuote`); this is the same rule for the browser, without the server's
// Node-only code. Math spans are cut out of the Markdown as alphanumeric sentinels before BlockNote
// parses it (its parser escapes most of LaTeX) and the parsed blocks get the nodes back afterwards.
// `$` detection is the shared pandoc rule (`scanInlineMath` in @inkling/shared), so prices,
// code fences, code spans and link destinations stay text exactly as on the server.
//
// Pure functions on BlockNote block JSON; components/CollabEditor.tsx wires them into the paste
// (lib/paste/pasteMarkdown.ts).

/**
 * Stricter than the shared rule, for paste only: a closing `$` glued to what follows it by a word
 * character, `{` or `(` is a shell or template variable (`$HOME/$USER`, `${A}/${B}`, `$(pwd)/$(id)`),
 * and so is an opening `$` glued to a word character before it. Such text stays as typed: before
 * 0.25 a paste never made math, so the cost of missing `$n$th` is smaller than turning a pasted
 * command into a formula. The server import keeps the shared rule.
 */
function looksLikeShell(text: string, span: { start: number; end: number }): boolean {
  const after = text[span.end]
  const before = span.start > 0 ? text[span.start - 1] : undefined
  return (after !== undefined && /[A-Za-z0-9_{(]/.test(after)) || (before !== undefined && /[A-Za-z0-9_]/.test(before))
}

/** Loose BlockNote block / inline shapes: the parser's output, mutated in place. */
export interface PasteBlock {
  id?: string
  type: string
  props?: Record<string, unknown>
  content?: unknown
  children?: PasteBlock[]
}
type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: Inline[]; props?: Record<string, unknown> }

const CALLOUT_SET = new Set<string>(CALLOUT_TYPES)
const CALLOUT_HINT_RE = new RegExp(`\\[!(${CALLOUT_TYPES.join('|')})\\]`, 'i')

const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})/
const DISPLAY_OPEN_RE = /^([ \t>]*)\$\$[ \t]*$/
const DISPLAY_ONE_LINE_RE = /^([ \t>]*)\$\$(.*\S.*?)\$\$[ \t]*$/

function randomLetters(n: number): string {
  const bytes = new Uint8Array(n)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(97 + (b % 26))
  return s
}

/**
 * Masks code spans, link destinations and autolinks so `$` inside them is never math (as md/math.ts),
 * and, unlike the server, bare URLs: BlockNote's parser links them (GFM autolink literals), and a span
 * cut out of `https://…?$filter=a&$select=b` would leave a broken link around an equation.
 */
function maskedSegments(line: string): { text: string; from: number }[] {
  const out: { text: string; from: number }[] = []
  const skip = /(`+)[\s\S]*?\1|\]\([^)\s]*(?:\s+"[^"]*")?\)|<[a-z][a-z0-9+.-]*:[^>\s]*>|\b(?:https?:\/\/|www\.)[^\s<>]+/gi
  let last = 0
  for (let m = skip.exec(line); m; m = skip.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), from: last })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), from: last })
  return out
}

export interface MarkdownPaste {
  /** The Markdown with math replaced by sentinels, for BlockNote's parser. */
  markdown: string
  /** Turns sentinels back into math nodes and `> [!type]` quotes into callouts (in place); returns the blocks. */
  restore(blocks: PasteBlock[]): PasteBlock[]
}

/**
 * The Markdown to hand BlockNote's parser and the step that fixes its blocks afterwards, or null
 * when the text holds no math and no callout marker (the paste then stays BlockNote's own).
 */
export function prepareMarkdownPaste(md: string): MarkdownPaste | null {
  const hasCallout = md.includes('[!') && CALLOUT_HINT_RE.test(md)
  if (!md.includes('$') && !hasCallout) return null

  const src = newSentinels(md)
  const { sentinel, blockSources, inlineSources, literals } = src

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
        const key = sentinel('B')
        blockSources.set(key, body.join('\n'))
        literals.set(key, ['$$', ...body, '$$'].join('\n'))
        out.push(prefix.trimEnd(), prefix + key, prefix.trimEnd())
        i = end
        continue
      }
    }
    const one = DISPLAY_ONE_LINE_RE.exec(line)
    if (one && !one[2].includes('$$')) {
      const key = sentinel('B')
      blockSources.set(key, one[2].trim())
      literals.set(key, `$$${one[2]}$$`)
      out.push(one[1].trimEnd(), one[1] + key, one[1].trimEnd())
      continue
    }

    // inline math outside code spans and link destinations; `\$` stays as BlockNote reads it
    let nextLine = ''
    let pos = 0
    for (const seg of maskedSegments(line)) {
      nextLine += line.slice(pos, seg.from)
      let p = 0
      for (const span of scanInlineMath(seg.text)) {
        if (looksLikeShell(seg.text, span)) continue
        const key = sentinel('I')
        inlineSources.set(key, span.latex)
        literals.set(key, seg.text.slice(span.start, span.end))
        nextLine += seg.text.slice(p, span.start) + key
        p = span.end
      }
      nextLine += seg.text.slice(p)
      pos = seg.from + seg.text.length
    }
    out.push(nextLine + line.slice(pos))
  }

  if (!blockSources.size && !inlineSources.size && !hasCallout) return null
  const markdown = blockSources.size || inlineSources.size ? out.join('\n') : md
  return { markdown, restore: notationRestore(src, hasCallout) }
}

/** Sentinels for math sources cut out of a text: `<nonce><B|I><n>Q`, letters and digits only. */
export interface Sentinels {
  nonce: string
  sentinel(kind: 'B' | 'I'): string
  /** key → LaTeX source */
  blockSources: Map<string, string>
  inlineSources: Map<string, string>
  /** key → the text it replaced, for a sentinel that ends up where no node can go */
  literals: Map<string, string>
}

/** A sentinel set whose nonce does not occur in `avoid`. */
export function newSentinels(avoid: string): Sentinels {
  let nonce = ''
  do nonce = `Iq${randomLetters(12)}`
  while (avoid.includes(nonce))
  let next = 0
  return {
    nonce,
    sentinel: (kind) => `${nonce}${kind}${next++}Q`,
    blockSources: new Map(),
    inlineSources: new Map(),
    literals: new Map(),
  }
}

/**
 * The step after BlockNote's parser: a paragraph holding only a block sentinel becomes a math block,
 * other sentinels inlineMath (or their source text in code and link text), and with `callouts` a
 * `[!type]` quote becomes a callout. Mutates and returns the blocks.
 */
export function notationRestore(src: Sentinels, callouts: boolean): (blocks: PasteBlock[]) => PasteBlock[] {
  const { nonce, blockSources, inlineSources, literals } = src
  const any = new RegExp(`${nonce}[BI]\\d+Q`, 'g')
  const literal = (key: string) => literals.get(key) ?? key
  const unsentinel = (text: string) => (text.includes(nonce) ? text.replace(any, literal) : text)

  const splitText = (t: Inline): Inline[] => {
    const text = t.text ?? ''
    if (!text.includes(nonce)) return [t]
    // inside code a sentinel cannot be a node; give the source back as text
    if (t.styles?.code) return [{ ...t, text: unsentinel(text) }]
    const parts: Inline[] = []
    let last = 0
    any.lastIndex = 0
    for (let m = any.exec(text); m; m = any.exec(text)) {
      if (m.index > last) parts.push({ ...t, text: text.slice(last, m.index) })
      const src = inlineSources.get(m[0]) ?? blockSources.get(m[0])
      if (src === undefined) parts.push({ ...t, text: m[0] })
      else parts.push({ type: INLINE_MATH_TYPE, props: { latex: src.replace(/\s*\n\s*/g, ' ') } })
      last = m.index + m[0].length
    }
    if (last < text.length) parts.push({ ...t, text: text.slice(last) })
    return mergeText(parts)
  }
  const fixInlines = (inlines: Inline[], code: boolean): Inline[] =>
    inlines.flatMap((inl) => {
      if (inl.type === 'text') return code ? [{ ...inl, text: unsentinel(inl.text ?? '') }] : splitText(inl)
      if (inl.type === 'link' && Array.isArray(inl.content)) {
        // link text holds styled text only: math in it comes back as its source
        return [{ ...inl, content: inl.content.map((c) => ({ ...c, text: unsentinel(c.text ?? '') })) }]
      }
      return [inl]
    })

  const restore = (list: PasteBlock[]): PasteBlock[] => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      const c = b.content
      if (blockSources.size && b.type === 'paragraph' && Array.isArray(c) && c.length === 1 && (c[0] as Inline).type === 'text') {
        const key = String((c[0] as Inline).text ?? '').trim()
        const src = blockSources.get(key)
        if (src !== undefined) {
          list[i] = { id: b.id, type: MATH_BLOCK_TYPE, props: { latex: src }, children: b.children ?? [] }
          if (list[i].children!.length) restore(list[i].children!)
          continue
        }
      }
      if (Array.isArray(c)) b.content = fixInlines(c as Inline[], b.type === 'codeBlock')
      else if (c && typeof c === 'object' && (c as { type?: string }).type === 'tableContent') {
        for (const row of (c as { rows: { cells: unknown[] }[] }).rows ?? []) {
          for (let k = 0; k < row.cells.length; k++) {
            const cell = row.cells[k]
            if (Array.isArray(cell)) row.cells[k] = fixInlines(cell as Inline[], false)
            else if (cell && typeof cell === 'object' && Array.isArray((cell as { content?: unknown }).content)) {
              const obj = cell as { content: Inline[] }
              obj.content = fixInlines(obj.content, false)
            }
          }
        }
      }
      if (callouts && b.type === 'quote' && Array.isArray(b.content)) {
        const callout = calloutFromQuote(b, b.content as Inline[])
        if (callout) list[i] = callout
      }
      if (Array.isArray(list[i].children) && list[i].children!.length) restore(list[i].children!)
    }
    return list
  }
  // Last pass: a sentinel the parser put anywhere else (an autolink's href, an image's alt text in its
  // props, …) gets its source text back, so no sentinel ever reaches the document.
  const leftovers = (v: unknown): unknown => {
    if (typeof v === 'string') return unsentinel(v)
    if (Array.isArray(v)) {
      for (let k = 0; k < v.length; k++) v[k] = leftovers(v[k])
      return v
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k of Object.keys(o)) o[k] = leftovers(o[k])
    }
    return v
  }
  return (blocks) => leftovers(restore(blocks)) as PasteBlock[]
}

/**
 * `> [!type] text` read by BlockNote as a quote → the callout, or null for an ordinary quote. As the
 * server's `calloutFromQuote`, except that a marker alone on its line does not leave the body starting
 * with an empty line.
 */
function calloutFromQuote(b: PasteBlock, content: Inline[]): PasteBlock | null {
  const first = content[0]
  if (!first || first.type !== 'text') return null
  if (first.styles && Object.keys(first.styles).length) return null
  const m = /^\[!([A-Za-z]+)\][ \t]*/.exec(first.text ?? '')
  if (!m || !CALLOUT_SET.has(m[1].toLowerCase())) return null
  let rest = (first.text ?? '').slice(m[0].length)
  if (rest.startsWith('\n')) rest = rest.slice(1)
  const body = rest ? [{ ...first, text: rest }, ...content.slice(1)] : content.slice(1)
  return { id: b.id, type: 'callout', props: { type: m[1].toLowerCase() }, content: body, children: b.children ?? [] }
}

/** Joins adjacent text runs with equal styles and drops empty ones. */
function mergeText(parts: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    if (prev && prev.type === 'text' && p.type === 'text' && JSON.stringify(prev.styles ?? {}) === JSON.stringify(p.styles ?? {})) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (p.text ?? '') }
    } else if (!(p.type === 'text' && p.text === '')) out.push(p)
  }
  return out
}
