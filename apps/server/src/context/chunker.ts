import { createHash } from 'node:crypto'
import { scanInjection } from './injectionScan'
import type { AnyBlock } from '../md/convert'
import { estimateTokens, isCjkCode } from './tokens'

/**
 * Splits a BlockNote document into sections at its top-level headings and sections into
 * retrieval chunks (docs/adr/0926-*). Pure: no DB, no editor — used by the section index, the
 * outline/section reads, patch_section and the change feed, so all of them agree on anchors.
 *
 * - Section = a top-level heading block and every top-level block up to the next top-level
 *   heading (any level). Headings nested inside other blocks stay content.
 * - Content before the first heading is the `_intro` section (omitted when empty).
 * - Anchor = slugged heading path joined with '/', e.g. `deploy/rollback`; a repeated path gets
 *   `~2`, `~3`. Slugs keep Unicode letters and digits (Korean stays readable).
 * - A section longer than MAX_CHUNK_TOKENS is split into parts at block boundaries (lines for one
 *   oversized block); parts share the anchor.
 */

/** Bump when chunk text/anchors change shape: the boot backfill then re-indexes every page. */
// 2: page_chunks.suspicious (injection heuristics, docs/adr/0977-*; INJECTION_RULES_VERSION 1).
// 3: no 200 KB text cap, the whole document is indexed up to MAX_CHUNKS_PER_PAGE (docs/adr/1040-*).
export const CHUNKER_VERSION = 3
export const MAX_CHUNK_TOKENS = 600
export const INTRO_ANCHOR = '_intro'
/**
 * Safety bound on index rows per page (≈ 3M estimated tokens). The section index covers the whole
 * document below it; a page at the bound is treated as partially indexed (outline/section reads
 * then decode the document instead of answering from the index, docs/adr/1041-*).
 */
export const MAX_CHUNKS_PER_PAGE = 5_000
/** Separator of heading path titles in `headingPath` strings. */
export const PATH_SEP = ' › '

export interface Section {
  anchor: string
  /** BlockNote id of the heading block; null for `_intro`. */
  blockId: string | null
  headingPath: string[]
  level: number
  /** Top-level block index range [start, end) — the heading block is at `start`. */
  start: number
  end: number
  /** Body as light Markdown, heading line excluded. */
  text: string
  /** Short version id of the section (heading path + body): patch_section's baseVersion. */
  version: string
  /** Sum of the estimates of the section's index parts (so the index and a decode agree, docs/adr/1041-*). */
  tokens: number
}

export interface Chunk {
  ord: number
  anchor: string
  blockId: string | null
  headingPath: string
  level: number
  part: number
  text: string
  grams: string
  tokens: number
  /** Injection-like heuristics matched by this chunk (heading path of part 0 included). */
  suspicious: string[]
  hash: string
  sectionHash: string
}

// ---------------------------------------------------------------------------
// inline / block text
// ---------------------------------------------------------------------------

const INTERNAL_HREF_RE = /^\/w\/[0-9a-f-]{36}\/p\/[0-9a-f-]{36}$/i

interface InlineLike {
  type?: string
  text?: unknown
  href?: unknown
  content?: unknown
  props?: Record<string, unknown>
}

function inlineText(inl: InlineLike): string {
  if (!inl || typeof inl !== 'object') return ''
  if (inl.type === 'link' && Array.isArray(inl.content)) {
    const label = (inl.content as InlineLike[]).map(inlineText).join('')
    const href = typeof inl.href === 'string' ? inl.href : ''
    if (INTERNAL_HREF_RE.test(href)) return `[[${label || 'Untitled'}]]`
    return href && href !== label ? `[${label}](${href})` : label
  }
  if (typeof inl.text === 'string') return inl.text
  return ''
}

export function inlinesText(inlines: unknown): string {
  if (!Array.isArray(inlines)) return ''
  return (inlines as InlineLike[]).map(inlineText).join('')
}

function tableLines(content: unknown): string[] {
  const rows = (content as { rows?: { cells?: unknown[] }[] })?.rows
  if (!Array.isArray(rows)) return []
  const out: string[] = []
  for (const row of rows) {
    const cells = Array.isArray(row?.cells) ? row.cells : []
    const texts = cells.map((cell) =>
      Array.isArray(cell)
        ? inlinesText(cell)
        : inlinesText((cell as { content?: unknown } | null)?.content),
    )
    out.push(`| ${texts.join(' | ')} |`)
  }
  return out
}

/** One block (and its children) as light Markdown lines. */
function blockLines(b: AnyBlock, indent: string, out: string[]): void {
  const c = b.content
  const props = b.props ?? {}
  const t = Array.isArray(c) ? inlinesText(c) : ''
  switch (b.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(props.level) || 1))
      out.push(`${indent}${'#'.repeat(level)} ${t}`)
      break
    }
    case 'bulletListItem':
      out.push(`${indent}- ${t}`)
      break
    case 'numberedListItem':
      out.push(`${indent}1. ${t}`)
      break
    case 'checkListItem':
      out.push(`${indent}- [${props.checked ? 'x' : ' '}] ${t}`)
      break
    case 'quote':
      out.push(`${indent}> ${t}`)
      break
    case 'codeBlock': {
      const lang = typeof props.language === 'string' && props.language !== 'text' ? props.language : ''
      out.push(`${indent}\`\`\`${lang}`)
      for (const line of t.split('\n')) out.push(`${indent}${line}`)
      out.push(`${indent}\`\`\``)
      break
    }
    case 'table':
      for (const line of tableLines(c)) out.push(`${indent}${line}`)
      break
    case 'image':
    case 'file':
    case 'video':
    case 'audio': {
      const label = String(props.caption || props.name || b.type)
      out.push(`${indent}[${b.type}: ${label}]`)
      break
    }
    default:
      if (t) out.push(`${indent}${t}`)
  }
  if (Array.isArray(b.children)) {
    for (const ch of b.children) blockLines(ch, `${indent}  `, out)
  }
}

/** Blocks as light Markdown (what find_context returns and the change feed diffs). */
export function blocksToLightMarkdown(blocks: AnyBlock[]): string {
  const out: string[] = []
  for (const b of blocks) blockLines(b, '', out)
  // Collapse runs of empty lines (empty paragraphs) to one
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------

export function slugify(s: string): string {
  const slug = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || 'section'
}

function isEmptyBlock(b: AnyBlock): boolean {
  if (b.type !== 'paragraph') return false
  if (Array.isArray(b.children) && b.children.length) return false
  return !inlinesText(b.content).trim()
}

function sectionVersion(path: string[], body: string): string {
  return createHash('sha1').update(path.join(PATH_SEP)).update('\n').update(body).digest('hex').slice(0, 12)
}

/** Top-level sections of a document (see the module comment). */
export function splitSections(blocks: AnyBlock[]): Section[] {
  const sections: Section[] = []
  const stack: { level: number; title: string; slug: string }[] = []
  const seen = new Map<string, number>()
  let cur: { anchor: string; blockId: string | null; path: string[]; level: number; start: number } = {
    anchor: INTRO_ANCHOR,
    blockId: null,
    path: [],
    level: 0,
    start: 0,
  }

  const close = (end: number) => {
    const bodyBlocks = blocks.slice(cur.anchor === INTRO_ANCHOR && cur.blockId === null && cur.level === 0 ? cur.start : cur.start + 1, end)
    if (cur.level === 0 && bodyBlocks.every(isEmptyBlock)) return // empty intro
    const text = blocksToLightMarkdown(bodyBlocks)
    sections.push({
      anchor: cur.anchor,
      blockId: cur.blockId,
      headingPath: cur.path,
      level: cur.level,
      start: cur.start,
      end,
      text,
      version: sectionVersion(cur.path, text),
      tokens: sectionTokens(text),
    })
  }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type !== 'heading') continue
    close(i)
    const level = Math.min(6, Math.max(1, Number(b.props?.level) || 1))
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    const title = inlinesText(b.content).trim()
    stack.push({ level, title, slug: slugify(title) })
    const base = stack.map((s) => s.slug).join('/')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    cur = {
      anchor: n === 1 ? base : `${base}~${n}`,
      blockId: typeof b.id === 'string' ? b.id : null,
      path: stack.map((s) => s.title || 'Untitled'),
      level,
      start: i,
    }
  }
  close(blocks.length)
  return sections
}

// ---------------------------------------------------------------------------
// chunks
// ---------------------------------------------------------------------------

/** Space-separated bigrams of CJK runs longer than two characters ("주간회의" → "주간 간회 회의"). */
export function cjkBigrams(text: string): string {
  const grams = new Set<string>()
  let run = ''
  const flush = () => {
    if (run.length > 2) for (let i = 0; i + 2 <= run.length; i++) grams.add(run.slice(i, i + 2))
    run = ''
  }
  for (const ch of text) {
    if (isCjkCode(ch.charCodeAt(0))) run += ch
    else flush()
  }
  flush()
  return [...grams].join(' ')
}

/** Split one section body into ≤ MAX_CHUNK_TOKENS parts at line boundaries (characters for a giant line). */
function splitBody(text: string): string[] {
  if (estimateTokens(text) <= MAX_CHUNK_TOKENS) return [text]
  const parts: string[] = []
  let buf: string[] = []
  let bufTokens = 0
  const push = () => {
    if (buf.length) parts.push(buf.join('\n'))
    buf = []
    bufTokens = 0
  }
  for (const line of text.split('\n')) {
    const lt = estimateTokens(line) + 1
    if (lt > MAX_CHUNK_TOKENS) {
      push()
      // ~4 chars per token for ASCII, 1 for CJK: cut by a conservative character count
      const step = MAX_CHUNK_TOKENS
      for (let i = 0; i < line.length; i += step) parts.push(line.slice(i, i + step))
      continue
    }
    if (bufTokens + lt > MAX_CHUNK_TOKENS) push()
    buf.push(line)
    bufTokens += lt
  }
  push()
  return parts
}

/** Token estimate of a section body as the index stores it: the sum over its parts. */
export function sectionTokens(text: string): number {
  let n = 0
  for (const part of splitBody(text)) n += estimateTokens(part)
  return n
}

function sha1(...parts: (string | number | null)[]): string {
  const h = createHash('sha1')
  for (const p of parts) h.update(String(p ?? '')).update('\u0000')
  return h.digest('base64')
}

export function joinPath(path: string[]): string {
  return path.join(PATH_SEP)
}

/** Sections → index rows (the whole document, bounded only by MAX_CHUNKS_PER_PAGE). */
export function chunkSections(sections: Section[]): Chunk[] {
  const chunks: Chunk[] = []
  for (const s of sections) {
    const headingPath = joinPath(s.headingPath)
    const parts = splitBody(s.text)
    for (let p = 0; p < parts.length; p++) {
      if (chunks.length >= MAX_CHUNKS_PER_PAGE) return chunks
      const text = parts[p]
      const grams = cjkBigrams(`${p === 0 ? headingPath : ''} ${text}`)
      const tokens = estimateTokens(text)
      const suspicious = scanInjection(`${p === 0 ? headingPath : ''}\n${text}`)
      chunks.push({
        ord: chunks.length,
        anchor: s.anchor,
        blockId: s.blockId,
        headingPath,
        level: s.level,
        part: p,
        text,
        grams,
        tokens,
        suspicious,
        hash: sha1(s.anchor, s.blockId, headingPath, s.level, p, text, s.version, suspicious.join(',')),
        sectionHash: s.version,
      })
    }
  }
  return chunks
}

export function chunkBlocks(blocks: AnyBlock[]): Chunk[] {
  return chunkSections(splitSections(blocks))
}

/**
 * Resolve a section reference: exact anchor, anchor without `~n`, heading block id, heading text
 * or heading path ("A › B" / "A > B" / "A/B"), case-insensitive. Returns null when nothing matches.
 */
export function findSection<T extends Pick<Section, 'anchor' | 'blockId' | 'headingPath'>>(sections: T[], ref: string): T | null {
  const r = ref.trim().replace(/^§/, '').replace(/^#/, '')
  if (!r) return null
  const exact = sections.find((s) => s.anchor === r || s.blockId === r)
  if (exact) return exact
  const lower = r.toLowerCase()
  const slugRef = r
    .split(/\s*(?:›|>|\/)\s*/)
    .map(slugify)
    .join('/')
  return (
    sections.find((s) => s.anchor.toLowerCase() === lower) ??
    sections.find((s) => s.anchor === slugRef) ??
    sections.find((s) => joinPath(s.headingPath).toLowerCase() === lower) ??
    sections.find((s) => (s.headingPath[s.headingPath.length - 1] ?? '').toLowerCase() === lower) ??
    sections.find((s) => s.anchor.endsWith(`/${slugRef}`) || s.anchor === slugRef.split('/').pop()) ??
    null
  )
}
