/**
 * A small Markdown reader for the operator's terms, privacy policy and sign-up texts (LEGAL_DIR,
 * docs/adr/2519-*). It turns text into a tree that LegalMarkdown.tsx draws as React elements, so nothing in
 * a document is ever handed to the browser as HTML: `<script>` or `<img onerror>` in a file is shown
 * as the characters it is. Kept pure (no DOM) so node tests can check it.
 *
 * What it understands, and nothing more: headings (#–####), paragraphs, bullet and numbered lists,
 * pipe tables, block quotes, horizontal rules, fenced code; inside a line **bold**, *italic*,
 * `code`, [text](url) and bare http(s) addresses and email addresses. Links keep only http:, https:
 * and mailto: targets; any other target (javascript:, data:, relative paths) is shown as plain text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: 'paragraph'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'code'; v: string }
  | { t: 'hr' }

/** The link target if it is one we allow (http, https, mailto), else null. */
export function safeHref(raw: string): string | null {
  const href = raw.trim()
  // no control characters or spaces anywhere (they can hide a scheme from a naive check)
  if (!href || /[\u0000- \u007f]/.test(href)) return null
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  if (scheme === 'http' || scheme === 'https') return /^https?:\/\/[^/?#]+/i.test(href) ? href : null
  if (scheme === 'mailto') return /^mailto:[^@\s]+@[^@\s]+$/i.test(href) ? href : null
  return null
}

const AUTOLINK = /(https?:\/\/[^\s<>()|]+[^\s<>()|.,;:!?'"])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g

function autolink(text: string, out: Inline[]): void {
  let last = 0
  for (const m of text.matchAll(AUTOLINK)) {
    const start = m.index ?? 0
    const url = m[1] ?? `mailto:${m[2]}`
    const href = safeHref(url)
    if (!href) continue
    if (start > last) out.push({ t: 'text', v: text.slice(last, start) })
    out.push({ t: 'link', href, c: [{ t: 'text', v: m[0] }] })
    last = start + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
}

/** Inline markup of one line (or one table cell). */
export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = () => {
    if (buf) autolink(buf, out)
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#|>-]/.test(src[i + 1])) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: 'code', v: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (depth < 4 && src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end), depth + 1) })
        i = end + 2
        continue
      }
    }
    if (depth < 4 && ch === '*' && src[i + 1] !== ' ' && src[i + 1] !== '*') {
      const end = src.indexOf('*', i + 1)
      if (end > i + 1 && src[end - 1] !== ' ') {
        flush()
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end), depth + 1) })
        i = end + 1
        continue
      }
    }
    if (ch === '[') {
      const close = src.indexOf('](', i + 1)
      const end = close >= 0 ? src.indexOf(')', close + 2) : -1
      if (close > i && end > close) {
        flush()
        const label = src.slice(i + 1, close)
        const href = safeHref(src.slice(close + 2, end))
        const inner = depth < 4 ? parseInline(label, depth + 1) : [{ t: 'text' as const, v: label }]
        // an unsafe target keeps its words and loses the link
        if (href) out.push({ t: 'link', href, c: inner.map(unlink) })
        else out.push(...inner)
        i = end + 1
        continue
      }
    }
    buf += ch
    i += 1
  }
  flush()
  return out
}

/** No links inside a link: an inner autolink becomes its text. */
function unlink(n: Inline): Inline {
  if (n.t === 'link') return { t: 'text', v: n.c.map(plainText).join('') }
  if (n.t === 'strong' || n.t === 'em') return { ...n, c: n.c.map(unlink) }
  return n
}

export function plainText(n: Inline): string {
  if (n.t === 'text' || n.t === 'code') return n.v
  return n.c.map(plainText).join('')
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s{0,3}(```|~~~)/
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 1
    } else if (s[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

const isTableRow = (line: string) => line.includes('|')

export function parseMarkdown(src: string, depth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  const blank = (l: string) => l.trim() === ''
  const startsBlock = (l: string, next?: string) =>
    HEADING.test(l) || BULLET.test(l) || ORDERED.test(l) || HR.test(l) || FENCE.test(l) || /^\s{0,3}>/.test(l) || (isTableRow(l) && next !== undefined && TABLE_SEP.test(next))

  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) {
      i += 1
      continue
    }
    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3)
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++])
      i += 1
      blocks.push({ t: 'code', v: body.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      const level = Math.min(h[1].length, 4) as 1 | 2 | 3 | 4
      blocks.push({ t: 'heading', level, c: parseInline(h[2]) })
      i += 1
      continue
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' })
      i += 1
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && !blank(lines[i]) && isTableRow(lines[i])) {
        const cells = splitRow(lines[i++])
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '')))
      }
      blocks.push({ t: 'table', head: head.map((c) => parseInline(c)), rows })
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ t: 'quote', c: depth < 3 ? parseMarkdown(body.join('\n'), depth + 1) : [{ t: 'paragraph', c: parseInline(body.join(' ')) }] })
      continue
    }
    const listRe = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : null
    if (listRe) {
      const items: string[] = []
      while (i < lines.length) {
        const m = listRe.exec(lines[i])
        if (m) {
          items.push(m[1])
          i += 1
        } else if (!blank(lines[i]) && /^\s+\S/.test(lines[i]) && items.length) {
          // a wrapped line of the item above
          items[items.length - 1] += ` ${lines[i].trim()}`
          i += 1
        } else break
      }
      blocks.push({ t: 'list', ordered: listRe === ORDERED, items: items.map((s) => parseInline(s)) })
      continue
    }
    const para: string[] = []
    while (i < lines.length && !blank(lines[i]) && !(para.length > 0 && startsBlock(lines[i], lines[i + 1]))) {
      para.push(lines[i].trim())
      i += 1
    }
    blocks.push({ t: 'paragraph', c: parseInline(para.join(' ')) })
  }
  return blocks
}
