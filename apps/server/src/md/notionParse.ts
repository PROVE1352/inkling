// Pure helpers for the Notion "Markdown & CSV" export importer (docs/adr/0960-*).
// No database or filesystem access here, so everything is unit tested directly.
import path from 'node:path'
import { inferColumnType, parseBoolean, parseDate, parseNumber } from '@inkling/shared'

// ---------------------------------------------------------------------------
// names: "Title 0123456789abcdef0123456789abcdef.md" → title + hash
// ---------------------------------------------------------------------------

/** NFC, so names zipped on macOS (NFD) match the NFC links Notion writes. */
export function nfc(s: string): string {
  return s.normalize('NFC')
}

const NAME_RE = /^(.*?)(?:\s+|^)([0-9a-f]{32})(_all)?$/i

export interface NotionName {
  /** Display title with the hash removed ('Untitled' when the name was only a hash). */
  title: string
  /** Lower-case 32-hex Notion block id, or null for names without one. */
  hash: string | null
  /** Lower-case extension including the dot ('' for folders). */
  ext: string
  /** `Name <hash>_all.csv` — the full-table variant of a database export. */
  isAll: boolean
}

/** Splits one path segment of a Notion export into title, id hash and extension. */
export function parseNotionName(segment: string, isDir = false): NotionName {
  const seg = nfc(segment)
  const ext = isDir ? '' : path.posix.extname(seg).toLowerCase()
  const stem = ext ? seg.slice(0, -ext.length) : seg
  const m = NAME_RE.exec(stem)
  if (m) {
    const title = m[1].trim()
    return { title: title || 'Untitled', hash: m[2].toLowerCase(), ext, isAll: !!m[3] }
  }
  // `_all` without a hash (some exports) still marks the full-table CSV
  const all = ext === '.csv' && /_all$/i.test(stem)
  const title = (all ? stem.slice(0, -4) : stem).trim()
  return { title: title || 'Untitled', hash: null, ext, isAll: all }
}

/** True when a path segment carries a Notion id hash. */
export function hasNotionHash(segment: string): boolean {
  const ext = path.posix.extname(segment)
  return NAME_RE.test(ext ? segment.slice(0, -ext.length) : segment)
}

/**
 * Heuristic used by the generic /import route: an archive is a Notion export when most of its
 * Markdown/CSV files carry the 32-hex id suffix, or when it only wraps Notion part archives.
 */
export function looksLikeNotionExport(names: string[]): boolean {
  const docs = names.filter((n) => /\.(md|csv)$/i.test(n))
  if (docs.length === 0) {
    const zips = names.filter((n) => /\.zip$/i.test(n))
    return zips.length > 0 && zips.every((n) => isNotionPartArchive(n))
  }
  const hashed = docs.filter((n) => hasNotionHash(n.split('/').pop() ?? '')).length
  return hashed / docs.length >= 0.5
}

/** `Export-<uuid>-Part-1.zip` and similar wrappers Notion uses for large exports. */
export function isNotionPartArchive(name: string): boolean {
  const base = name.split('/').pop() ?? ''
  return /^export-[0-9a-f-]{8,}.*\.zip$/i.test(base) || /-part-\d+\.zip$/i.test(base)
}

/** Top-level `Export-<uuid>` folder Notion sometimes wraps everything in (no page of its own). */
export function isNotionExportWrapper(segment: string): boolean {
  return /^export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

/** External / app-absolute hrefs are never rewritten. */
export function isExternalHref(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(href)
}

/** Notion page URL (notion.so / *.notion.site) → 32-hex id of the last path segment, else null. */
export function hashFromNotionUrl(href: string): string | null {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  const host = u.hostname.toLowerCase()
  if (!(host === 'notion.so' || host.endsWith('.notion.so') || host.endsWith('.notion.site'))) return null
  const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
  const plain = /([0-9a-f]{32})$/i.exec(last)
  if (plain) return plain[1].toLowerCase()
  const dashed = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(last)
  return dashed ? dashed[1].replace(/-/g, '').toLowerCase() : null
}

/** Percent-decoded href without `#fragment` / `?query`; null when the encoding is malformed. */
export function decodeHref(href: string): string | null {
  const bare = href.replace(/[#?].*$/, '')
  if (!bare) return null
  try {
    return nfc(decodeURIComponent(bare))
  } catch {
    return null
  }
}

/**
 * Candidate archive paths for a relative href written in the file at `fromPath`:
 * relative to that file's folder first, then relative to the archive root.
 * Paths escaping the root (`../` past the top) are dropped.
 */
export function candidatePaths(fromPath: string, decoded: string): string[] {
  const out: string[] = []
  const add = (p: string) => {
    const n = path.posix.normalize(p).replace(/^\.\//, '')
    if (n === '..' || n.startsWith('../') || n.startsWith('/')) return
    const clean = n.replace(/\/+$/, '')
    if (clean && !out.includes(clean)) out.push(clean)
  }
  const dir = path.posix.dirname(fromPath)
  add(dir === '.' ? decoded : `${dir}/${decoded}`)
  add(decoded)
  return out
}

/** Last 32-hex id found in a path (file or folder name), for links whose folders were renamed. */
export function hashInPath(p: string): string | null {
  const segs = p.split('/').filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) {
    const n = parseNotionName(segs[i])
    if (n.hash) return n.hash
  }
  return null
}

// ---------------------------------------------------------------------------
// Markdown pre-processing
// ---------------------------------------------------------------------------

export interface PreprocessStats {
  callouts: number
  equations: number
}

/** Runs `fn` on the parts of `md` outside fenced code blocks. */
function outsideFences(md: string, fn: (chunk: string) => string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let buf: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (buf.length) out.push(fn(buf.join('\n')))
    buf = []
  }
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      out.push(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null
      continue
    }
    if (m) {
      flush()
      fence = m[1]
      out.push(line)
      continue
    }
    buf.push(line)
  }
  flush()
  return out.join('\n')
}

/** Inline `$x$` (pandoc rule: no space inside the delimiters, not followed by a digit) → code span. */
function inlineMath(line: string, stats: PreprocessStats): string {
  // leave existing code spans alone
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/g, (_m, pre: string, body: string) => {
            stats.equations++
            return `${pre}\`$${body}$\``
          }),
    )
    .join('')
}

/**
 * Rewrites Notion-specific Markdown into constructs the BlockNote parser keeps:
 *  - `<aside>` callouts → block quotes (the server schema has no callout block)
 *  - `$$…$$` block equations → ```latex code blocks; inline `$x$` → inline code
 * `<details><summary>` toggles, tables and `- [ ]` checklists already parse natively.
 */
export function preprocessNotionMarkdown(md: string): { md: string; stats: PreprocessStats } {
  const stats: PreprocessStats = { callouts: 0, equations: 0 }
  const text = md.replace(/\r\n?/g, '\n')
  const out = outsideFences(text, (chunk) => {
    let c = chunk.replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/gi, (_m, inner: string) => {
      stats.callouts++
      const lines = inner.split('\n').map((l) => l.replace(/^\s+/, ''))
      return `\n${lines.map((l) => (l ? `> ${l}` : '>')).join('\n')}\n`
    })
    c = c.replace(/(^|\n)[ \t]*\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g, (_m, pre: string, body: string) => {
      stats.equations++
      return `${pre}\`\`\`latex\n${body.trim()}\n\`\`\``
    })
    c = c.replace(/(^|\n)[ \t]*\$\$([^\n$]+)\$\$[ \t]*(?=\n|$)/g, (_m, pre: string, body: string) => {
      stats.equations++
      return `${pre}\`\`\`latex\n${body.trim()}\n\`\`\``
    })
    return c
      .split('\n')
      .map((l) => (l.includes('$') ? inlineMath(l, stats) : l))
      .join('\n')
  })
  return { md: out, stats }
}

/** Loose comparison key: letters and digits only, case-folded, NFC. */
export function looseKey(s: string): string {
  return nfc(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Notion starts every page with `# <title>`. Returns that title and the body without it when the
 * heading matches the file name (file names are truncated / sanitized, so a prefix match counts).
 */
export function splitLeadingTitle(md: string, fileTitle: string): { title: string | null; body: string } {
  const m = /^﻿?\s*#[ \t]+([^\n]+?)[ \t#]*(?:\n|$)/.exec(md)
  if (!m) return { title: null, body: md }
  const heading = m[1].trim()
  const a = looseKey(heading)
  const b = looseKey(fileTitle)
  const matches = a === b || (b.length >= 8 && a.startsWith(b)) || fileTitle === 'Untitled'
  if (!matches) return { title: null, body: md }
  return { title: heading, body: md.slice(m[0].length) }
}

/**
 * Database row pages repeat their properties as `Key: value` lines right after the title.
 * Drops that leading block when every line's key is a column of the database.
 */
export function stripRowProperties(body: string, columns: string[]): string {
  const keys = new Set(columns.map((c) => looseKey(c)))
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  const start = i
  while (i < lines.length) {
    const m = /^([^:\n]{1,100}):(?:\s(.*))?$/.exec(lines[i])
    if (!m || !keys.has(looseKey(m[1]))) break
    i++
  }
  if (i === start) return body
  return lines.slice(i).join('\n')
}

// ---------------------------------------------------------------------------
// CSV cells
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function ymd(y: number, m: number, d: number): string | null {
  return parseDate(`${y}-${m}-${d}`)
}

/**
 * Notion date cells → YYYY-MM-DD (the time part and the end of a range are dropped):
 * "November 7, 2026", "Nov 7, 2026 3:00 PM", "@November 7, 2026", "7 November 2026",
 * "2026년 11월 7일 오후 3:00", "2026/11/07", "November 7, 2026 → November 9, 2026".
 */
export function parseNotionDate(raw: string): string | null {
  const t = raw.trim().replace(/^@/, '').split(/\s*(?:→|->)\s*/)[0].trim()
  if (!t) return null
  let m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(t)
  if (m) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase() === 'sept' ? 4 : 3)]
    return mon ? ymd(Number(m[3]), mon, Number(m[2])) : null
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(t)
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 3)]
    return mon ? ymd(Number(m[3]), mon, Number(m[1])) : null
  }
  m = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(t)
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))
  const iso = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/.exec(t)
  if (iso) return parseDate(iso[1])
  return parseDate(t)
}

export type NotionColumnType = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'multiSelect' | 'url' | 'email'

const URL_RE = /^https?:\/\/[^\s]+$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_OPTIONS = 50

/** Splits a Notion multi-value cell ("a, b, c"). */
export function splitMulti(cell: string): string[] {
  return cell
    .split(/\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Column type of a Notion CSV column (title column excluded). A type wins only when every
 * non-empty cell parses. Email and person columns stay text (no such field types).
 */
export function inferNotionColumn(values: string[]): NotionColumnType {
  const sample = values.map((v) => v.trim()).filter((v) => v !== '')
  if (sample.length === 0) return 'text'
  if (sample.every((v) => v === 'Yes' || v === 'No')) return 'checkbox'
  if (sample.every((v) => parseBoolean(v) !== null) && sample.some((v) => parseBoolean(v) === true)) {
    if (!sample.every((v) => /^[01]$/.test(v))) return 'checkbox'
  }
  if (sample.every((v) => parseNumber(v) !== null)) return 'number'
  if (sample.every((v) => parseNotionDate(v) !== null)) return 'date'
  if (sample.every((v) => URL_RE.test(v))) return 'url'
  if (sample.every((v) => EMAIL_RE.test(v))) return 'email'
  // multi-select: comma lists of short, re-used tokens
  if (sample.some((v) => v.includes(','))) {
    const tokens = sample.flatMap(splitMulti)
    const distinct = new Set(tokens)
    if (
      tokens.length > 0 &&
      distinct.size <= MAX_OPTIONS &&
      [...distinct].every((x) => x.length <= 40) &&
      distinct.size < tokens.length
    ) {
      return 'multiSelect'
    }
    return 'text'
  }
  return inferColumnType(sample) === 'select' ? 'select' : 'text'
}

/** Relation cell token: "Row title (Folder%20abc/Row%20def.md)" → title + raw href. */
export function parseRelationToken(token: string): { title: string; href: string | null } {
  const m = /^(.*?)\s*\(([^()]+\.md)\)$/i.exec(token.trim())
  if (m) return { title: m[1].trim(), href: m[2] }
  return { title: token.trim(), href: /^https?:\/\//i.test(token.trim()) ? token.trim() : null }
}

/** Relation cells separate links with ", " — but titles inside "(…md)" may contain commas. */
export function splitRelationCell(cell: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of cell) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Sibling title de-duplication: "Notes", "Notes (2)", "Notes (3)" … (case-insensitive). */
export function uniqueTitle(title: string, taken: Set<string>): string {
  let t = title
  let n = 2
  while (taken.has(t.toLowerCase())) t = `${title} (${n++})`
  taken.add(t.toLowerCase())
  return t
}
