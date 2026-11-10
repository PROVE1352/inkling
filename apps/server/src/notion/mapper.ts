import type { AnyBlock } from '../md/convert'
import { parseInternalHref, sectionLinkMarkdown } from '@inkling/shared/sectionLink'

// ---------------------------------------------------------------------------
// Map BlockNote blocks (stateToBlocks output) → Notion blocks (2022-06-28 schema).
//
// Pure conversion layer — knows nothing about DB/disk/network. Image uploads are delegated to the
// `uploadImage` resolver injected by the caller; without a resolver (= dryRun) they fall back to paragraphs.
// Unsupported blocks and image failures are collected as warnings so a person can review them.
// ---------------------------------------------------------------------------

// ── structural inline view (same shape as convert.ts) ──────────────────────
interface StyledText {
  type: 'text'
  text?: string
  styles?: Record<string, unknown>
}
interface LinkInline {
  type: 'link'
  href?: string
  content?: StyledText[]
}
type Inline = StyledText | LinkInline | { type: string; [k: string]: unknown }

interface TableCellObj {
  type: string
  content?: Inline[]
  [k: string]: unknown
}
interface TableContent {
  type: 'tableContent'
  rows: { cells: Inline[][] | TableCellObj[] }[]
  [k: string]: unknown
}

/** A Notion block. `__children` is an internal field never sent to Notion (for deferred nesting). */
export type NotionBlock = Record<string, unknown> & { __children?: NotionBlock[] }

export interface MapOptions {
  /**
   * Uploader for internal attachment (/files/<id>) images. Returning a Notion file_upload id gives an
   * image block; null/throw falls back to a paragraph. Without it (dryRun) always paragraph fallback + warning.
   */
  uploadImage?: (asset: { fileId: string; name: string }) => Promise<string | null>
}

export interface MapResult {
  blocks: NotionBlock[]
  warnings: string[]
}

// ── patterns/constants ─────────────────────────────────────────────────────
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const INTERNAL_HREF_RE = new RegExp(`^/w/${UUID}/p/(${UUID})(?:#.*)?$`) // section links too (docs/adr/2100-*)
const FILE_URL_RE = new RegExp(`^/files/(${UUID})$`)

/** Notion rich_text.text.content is limited to 2000 characters → split. */
const RICH_TEXT_LIMIT = 2000

/** Notion annotation colors (default palette). Only those shared with BlockNote color keys pass. */
const NOTION_COLORS = new Set([
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
])

// ── inline → rich_text ─────────────────────────────────────────────────────

function asInlines(content: AnyBlock['content']): Inline[] {
  return Array.isArray(content) ? (content as Inline[]) : []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** BlockNote styles → Notion annotations (only fields that differ from the defaults are set). */
function toAnnotations(styles: Record<string, unknown> | undefined): Record<string, unknown> {
  const a: Record<string, unknown> = {}
  if (!styles) return a
  if (styles.bold) a.bold = true
  if (styles.italic) a.italic = true
  if (styles.underline) a.underline = true
  if (styles.strike || styles.strikethrough) a.strikethrough = true
  if (styles.code) a.code = true
  const bg = str(styles.backgroundColor)
  const fg = str(styles.textColor)
  if (bg && NOTION_COLORS.has(bg)) a.color = `${bg}_background`
  else if (fg && NOTION_COLORS.has(fg)) a.color = fg
  return a
}

/** Split the content string into 2000-character chunks and build rich_text runs. */
function textRuns(
  content: string,
  annotations: Record<string, unknown>,
  link?: string,
): NotionBlock[] {
  if (content.length === 0) return []
  const runs: NotionBlock[] = []
  for (let i = 0; i < content.length; i += RICH_TEXT_LIMIT) {
    const chunk = content.slice(i, i + RICH_TEXT_LIMIT)
    const textObj: Record<string, unknown> = { content: chunk }
    if (link) textObj.link = { url: link }
    const run: NotionBlock = { type: 'text', text: textObj }
    if (Object.keys(annotations).length > 0) run.annotations = { ...annotations }
    runs.push(run)
  }
  return runs
}

/** Inline array → Notion rich_text array. Internal wikilinks become plain [[title]] text. */
function inlinesToRichText(inlines: Inline[]): NotionBlock[] {
  const out: NotionBlock[] = []
  for (const inl of inlines) {
    if (inl.type === 'text') {
      const t = inl as StyledText
      out.push(...textRuns(str(t.text), toAnnotations(t.styles)))
    } else if (inl.type === 'link') {
      const link = inl as LinkInline
      const href = str(link.href)
      const inner = Array.isArray(link.content) ? link.content : []
      const label = inner.map((c) => str(c.text)).join('')
      if (INTERNAL_HREF_RE.test(href)) {
        // internal wikilink → plain [[title]] text ([[Page#Heading]] for a section link)
        const section = parseInternalHref(href)?.section
        out.push(...textRuns(section ? sectionLinkMarkdown(section, label) : `[[${label || 'Untitled'}]]`, {}))
      } else if (/^https?:/i.test(href)) {
        // external link → keep link + annotations on each segment
        for (const seg of inner) {
          out.push(...textRuns(str(seg.text), toAnnotations(seg.styles), href))
        }
        if (inner.length === 0) out.push(...textRuns(href, {}, href))
      } else {
        // unresolvable link (/files etc.) → plain text without a link
        out.push(...textRuns(label, {}))
      }
    } else {
      // unknown inline → plain text if it has a text field
      const text = str((inl as StyledText).text)
      if (text) out.push(...textRuns(text, {}))
    }
  }
  return out
}

/** Inline → plain text (for code blocks/fallbacks). */
function inlinesToPlain(content: AnyBlock['content']): string {
  const inlines = asInlines(content)
  let s = ''
  for (const inl of inlines) {
    if (inl.type === 'text') s += str((inl as StyledText).text)
    else if (inl.type === 'link') {
      const inner = (inl as LinkInline).content ?? []
      s += inner.map((c) => str(c.text)).join('')
    }
  }
  return s
}

// ── code language mapping (languages Notion 2022-06-28 supports) ───────────
const NOTION_LANGUAGES = new Set([
  'abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#',
  'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran',
  'f#', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java',
  'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript',
  'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mermaid', 'nix',
  'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text', 'powershell',
  'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust', 'sass', 'scala',
  'scheme', 'scss', 'shell', 'sql', 'swift', 'toml', 'typescript', 'vb.net',
  'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml',
])
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', py3: 'python', rb: 'ruby',
  sh: 'shell', zsh: 'shell', console: 'shell', cpp: 'c++', cc: 'c++', cxx: 'c++',
  h: 'c', hpp: 'c++', cs: 'c#', csharp: 'c#', fsharp: 'f#', 'obj-c': 'objective-c',
  objc: 'objective-c', yml: 'yaml', md: 'markdown', dockerfile: 'docker',
  golang: 'go', rs: 'rust', kt: 'kotlin', text: 'plain text', plaintext: 'plain text',
  txt: 'plain text', '': 'plain text',
}

function mapLanguage(raw: unknown): string {
  const key = str(raw).trim().toLowerCase()
  if (NOTION_LANGUAGES.has(key)) return key
  const alias = LANGUAGE_ALIASES[key]
  if (alias) return alias
  return 'plain text'
}

// ── helpers ────────────────────────────────────────────────────────────────
function clampLevel(level: unknown): 1 | 2 | 3 {
  const n = typeof level === 'number' ? level : Number(level)
  if (n <= 1) return 1
  if (n >= 3) return 3
  return 2
}

function basename(url: string): string {
  const clean = url.split(/[?#]/)[0]
  const parts = clean.split('/')
  return parts[parts.length - 1] || ''
}

function paragraphFallback(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: textRuns(text, {}) },
  }
}

/** Map child blocks (nested lists etc.) and attach them as __children. */
async function attachChildren(
  nb: NotionBlock,
  block: AnyBlock,
  opts: MapOptions,
  warnings: string[],
  toggleKey?: string,
): Promise<NotionBlock> {
  const kids = Array.isArray(block.children) ? block.children : []
  if (kids.length === 0) return nb
  const mapped = await mapList(kids, opts, warnings)
  if (mapped.length === 0) return nb
  nb.__children = mapped
  // A heading must be toggleable to have children.
  if (toggleKey) {
    const body = nb[toggleKey] as Record<string, unknown>
    body.is_toggleable = true
  }
  return nb
}

// ── block mapping ──────────────────────────────────────────────────────────
async function mapOne(
  block: AnyBlock,
  opts: MapOptions,
  warnings: string[],
): Promise<NotionBlock | null> {
  const type = str(block.type)
  const props = (block.props ?? {}) as Record<string, unknown>
  const richText = (): NotionBlock[] => inlinesToRichText(asInlines(block.content))

  switch (type) {
    case 'paragraph':
      return attachChildren(
        { object: 'block', type: 'paragraph', paragraph: { rich_text: richText() } },
        block, opts, warnings,
      )
    case 'heading': {
      const level = clampLevel(props.level)
      const key = `heading_${level}`
      return attachChildren(
        { object: 'block', type: key, [key]: { rich_text: richText() } },
        block, opts, warnings, key,
      )
    }
    case 'quote':
      return attachChildren(
        { object: 'block', type: 'quote', quote: { rich_text: richText() } },
        block, opts, warnings,
      )
    case 'bulletListItem':
      return attachChildren(
        { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText() } },
        block, opts, warnings,
      )
    case 'numberedListItem':
      return attachChildren(
        { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: richText() } },
        block, opts, warnings,
      )
    case 'checkListItem':
      return attachChildren(
        {
          object: 'block',
          type: 'to_do',
          to_do: { rich_text: richText(), checked: props.checked === true },
        },
        block, opts, warnings,
      )
    case 'codeBlock': {
      const code = inlinesToPlain(block.content)
      return {
        object: 'block',
        type: 'code',
        code: { rich_text: textRuns(code, {}), language: mapLanguage(props.language) },
      }
    }
    case 'table':
      return mapTable(block)
    case 'image':
      return mapImage(props, opts, warnings)
    case 'file':
    case 'video':
    case 'audio': {
      const name = str(props.name) || str(props.caption) || basename(str(props.url)) || type
      warnings.push(`'${type}' attachments can't be mapped to Notion; replaced with a paragraph (${name}).`)
      return paragraphFallback(`[${type}: ${name}]`)
    }
    default: {
      warnings.push(`'${type || 'unknown'}' blocks can't be mapped to Notion; replaced with a paragraph.`)
      const fallback = inlinesToPlain(block.content)
      return paragraphFallback(fallback || `[${type || 'block'}]`)
    }
  }
}

function normalizeCells(cells: Inline[][] | TableCellObj[]): Inline[][] {
  return cells.map((cell) => {
    if (Array.isArray(cell)) return cell
    if (cell && typeof cell === 'object' && Array.isArray(cell.content)) return cell.content
    return []
  })
}

function mapTable(block: AnyBlock): NotionBlock | null {
  const content = block.content
  if (!content || Array.isArray(content) || (content as TableContent).type !== 'tableContent') {
    return null
  }
  const tc = content as TableContent
  const rows = tc.rows.map((r) => normalizeCells(r.cells))
  const width = Math.max(1, ...rows.map((r) => r.length))
  const tableRows: NotionBlock[] = rows.map((cells) => {
    const padded: Inline[][] = []
    for (let i = 0; i < width; i++) padded.push(cells[i] ?? [])
    return {
      object: 'block',
      type: 'table_row',
      table_row: { cells: padded.map((c) => inlinesToRichText(c)) },
    }
  })
  return {
    object: 'block',
    type: 'table',
    table: {
      table_width: width,
      has_column_header: false,
      has_row_header: false,
      children: tableRows,
    },
  }
}

async function mapImage(
  props: Record<string, unknown>,
  opts: MapOptions,
  warnings: string[],
): Promise<NotionBlock> {
  const url = str(props.url)
  const name = str(props.name) || str(props.caption) || basename(url) || 'image'

  // External http(s) images are referenced directly as external (no upload needed)
  if (/^https?:/i.test(url)) {
    return { object: 'block', type: 'image', image: { type: 'external', external: { url } } }
  }

  const m = FILE_URL_RE.exec(url)
  const fileId = m ? m[1] : null

  if (fileId && opts.uploadImage) {
    try {
      const uploadId = await opts.uploadImage({ fileId, name })
      if (uploadId) {
        return {
          object: 'block',
          type: 'image',
          image: { type: 'file_upload', file_upload: { id: uploadId } },
        }
      }
      warnings.push(`Image '${name}' failed to upload; replaced with a paragraph.`)
    } catch {
      warnings.push(`An error occurred while uploading image '${name}'; replaced with a paragraph.`)
    }
  } else if (opts.uploadImage) {
    // There is an uploader, but the path is not a /files path, so it cannot be resolved
    warnings.push(`Could not resolve the path of image '${name}'; replaced with a paragraph.`)
  } else {
    // dryRun — skip the upload and fall back
    warnings.push(`Image '${name}' is not uploaded in the preview; shown as a paragraph.`)
  }
  return paragraphFallback(`[Image: ${name}]`)
}

async function mapList(
  blocks: AnyBlock[],
  opts: MapOptions,
  warnings: string[],
): Promise<NotionBlock[]> {
  const out: NotionBlock[] = []
  for (const b of blocks) {
    const nb = await mapOne(b, opts, warnings)
    if (nb) out.push(nb)
  }
  return out
}

/** Top-level entry point — blocks → Notion blocks + warnings. */
export async function blocksToNotion(
  blocks: AnyBlock[],
  opts: MapOptions = {},
): Promise<MapResult> {
  const warnings: string[] = []
  const mapped = await mapList(blocks, opts, warnings)
  return { blocks: mapped, warnings }
}

// ── utils: block count & preview shaping ──────────────────────────────────

/** Total Notion block count including __children and table_row. */
export function countBlocks(blocks: NotionBlock[]): number {
  let n = 0
  for (const b of blocks) {
    n += 1
    const kids = b.__children
    if (Array.isArray(kids)) n += countBlocks(kids)
    const table = b.table as { children?: NotionBlock[] } | undefined
    if (table && Array.isArray(table.children)) n += table.children.length
  }
  return n
}

/** Shape for preview — expose __children as human-readable children. */
export function toPreview(block: NotionBlock): Record<string, unknown> {
  const { __children, ...rest } = block
  const clone: Record<string, unknown> = { ...rest }
  if (Array.isArray(__children)) clone.children = __children.map(toPreview)
  return clone
}

/**
 * Wire payload to send to Notion — a shallow copy without __children.
 * (Nested children are appended separately by the publisher.)
 */
export function toWire(block: NotionBlock): Record<string, unknown> {
  const { __children: _omit, ...rest } = block
  void _omit
  return rest
}
