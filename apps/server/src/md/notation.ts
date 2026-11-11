import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import {
  BUTTON_COLORS,
  buttonActionsJson,
  CALLOUT_TYPES,
  canonicalChartConfig,
  canonicalChartJson,
  chartBlockConfigSchema,
  COLUMN_LIST_TYPE,
  COLUMN_TYPE,
  columnWeight,
  equalWeights,
  MAX_COLUMNS,
  MIN_COLUMNS,
  parseButtonActions,
  parseChartBlockConfig,
  parseHttpUrl,
  pctToWeights,
  weightsToPct,
} from '@inkling/shared'
import type { AnyBlock, Inline, LinkInline, StyledText } from './convert'
import { getServerEditor } from './editor'

/**
 * Markdown notation for the nodes Markdown has no syntax for (docs/adr/1500-*):
 *
 *   callout          `> [!warning] text`                               (Obsidian / GitHub alerts)
 *   mention          `@[Label](user:<id>)` / `@[Title](page:<id>)`      agent reads; exports write `@Label`
 *                    `@[Name · Client](agent:<id>/grant:<id>)` a person's agent connection (docs/adr/1861-*)
 *   block tokens     `<!-- inkling:pageEmbed {"pageId":"…"} -->`        agent reads only, one line each:
 *                    pageEmbed, linkEmbed, pluginBlock, chart, and file / audio blocks (whose plain
 *                    Markdown — a link paragraph, an HTML figure — does not read back as the same block).
 *                    A chart token carries its config object itself (`<!-- inkling:chart {"groupBy":…} -->`,
 *                    docs/adr/1604-*), not the JSON string the block stores.
 *   columns          `<!-- inkling:columns -->` (or `<!-- inkling:columns {"widths":[60,40]} -->`), then
 *                    `<!-- inkling:column -->` before each column's blocks, then `<!-- /inkling:columns -->`
 *                    (docs/adr/2422-*). Written in every mode: a tool that does not know the markers
 *                    shows the columns' blocks one after another. Only top-level markers make columns;
 *                    unpaired, nested or out-of-range ones are dropped and their blocks stay as they are.
 *
 * Three modes. `agent` (read_page, read_pages, section reads, patch_section's echo, conflict bodies)
 * writes every form above so that what an agent sends back can be turned into the same nodes.
 * `plain` (vault sync, templates, history previews, `notation=plain` exports) writes callouts and
 * `@Label`, and leaves embeds and plugin blocks out as before, so it carries no tokens.
 * `file` (the Markdown download, docs/adr/2122-*) is `plain` plus the tokens of charts and inline
 * database views, each followed by a snapshot of its numbers between `<!-- inkling:snapshot -->`
 * and `<!-- /inkling:snapshot -->` (md/fileExport.ts builds those); an import restores the block
 * and drops the snapshot that follows a token or a code fence, so export → import → export is stable.
 * Parsing understands every form in both modes: an agent copying a token into create_page gets the
 * node; a mention chip is only recreated when the caller allows that chip (see `ParseNotationOptions`).
 *
 * Like the math notation (md/math.ts) the nodes never reach BlockNote's Markdown pipeline (which
 * drops HTML comments and link schemes it does not know): on export each becomes an alphanumeric
 * sentinel replaced afterwards, on import the tokens are cut out before parsing and restored after.
 */

export type NotationMode = 'plain' | 'agent' | 'file'

/**
 * Synthetic block of the file export (md/fileExport.ts): its children are written between the two
 * snapshot markers. Never stored; prepareNotationExport turns it into ordinary blocks.
 */
export const SNAPSHOT_BLOCK = 'inklingSnapshot'
export const SNAPSHOT_OPEN = '<!-- inkling:snapshot -->'
export const SNAPSHOT_CLOSE = '<!-- /inkling:snapshot -->'
const SNAPSHOT_OPEN_RE = /^[ \t>]*<!--[ \t]*inkling:snapshot[ \t]*-->[ \t]*$/
const SNAPSHOT_CLOSE_RE = /^[ \t>]*<!--[ \t]*\/inkling:snapshot[ \t]*-->[ \t]*$/

/** Column markers (docs/adr/2422-*). */
export const COLUMNS_CLOSE = '<!-- /inkling:columns -->'
export const COLUMN_MARK = '<!-- inkling:column -->'
const COLUMN_MARK_RE = /^([ \t>]*)<!--[ \t]*(\/?)inkling:(columns|column)(?:[ \t]+(\{.*\}))?[ \t]*-->[ \t]*$/
type ColumnMark = { kind: 'open'; widths: number[] | null } | { kind: 'column' } | { kind: 'close' }

/** `<!-- inkling:columns -->`, with the widths in percent when the columns are not equal (also find_context's text). */
export function columnsOpen(columns: AnyBlock[]): string {
  const weights = columns.map((c) => columnWeight(c.props?.width))
  return equalWeights(weights) ? '<!-- inkling:columns -->' : `<!-- inkling:columns ${commentJson({ widths: weightsToPct(weights) })} -->`
}

function parseColumnMark(m: RegExpExecArray): ColumnMark | null {
  const [, , slash, word, json] = m
  if (word === 'column') return slash || json ? null : { kind: 'column' }
  if (slash) return json ? null : { kind: 'close' }
  if (!json) return { kind: 'open', widths: null }
  try {
    const raw = JSON.parse(json) as { widths?: unknown }
    const w = raw && typeof raw === 'object' && Array.isArray(raw.widths) ? raw.widths : null
    const ok = w && w.length >= MIN_COLUMNS && w.length <= MAX_COLUMNS && w.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100)
    return { kind: 'open', widths: ok ? (w as number[]) : null }
  } catch {
    return { kind: 'open', widths: null }
  }
}

/** Block types written as `<!-- inkling:<type> {props} -->` in agent mode. */
const TOKEN_BLOCKS = new Set(['pageEmbed', 'linkEmbed', 'pluginBlock', 'chart', 'file', 'audio', 'button'])
/** Block types a token may create (images and videos read back from Markdown already). */
const PARSE_TOKEN_BLOCKS = new Set([...TOKEN_BLOCKS, 'image', 'video'])
/** Left out of plain Markdown (nothing to show without the app), as before this notation. */
const PLAIN_DROPPED = new Set(['pageEmbed', 'linkEmbed', 'pluginBlock', 'chart'])
/**
 * Written as tokens in `file` mode too: the exporter leaves only charts and database views
 * (page embeds of a collection) in the blocks by then; page and link embeds became links.
 */
const FILE_TOKEN_BLOCKS = new Set(['chart', 'pageEmbed', 'button'])
/** Plain Markdown shows a button as its label in brackets (docs/adr/2244-*): readable, never its actions. */
const PLAIN_LABELLED = new Set(['button'])

const CALLOUT_SET = new Set<string>(CALLOUT_TYPES)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILE_URL_RE = /^\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Plugin block data limit (Plugin API v0). */
const PLUGIN_DATA_MAX = 16 * 1024

// ---------------------------------------------------------------------------
// sentinels (letters and digits only: remark never escapes or splits them)
// ---------------------------------------------------------------------------

interface Sentinels {
  nonce: string
  next: number
}

function newSentinels(avoid: string): Sentinels {
  let nonce = ''
  do nonce = `Nq${randomBytes(6).toString('hex').replace(/\d/g, (d) => 'ghijklmnop'[Number(d)])}`
  while (avoid.includes(nonce))
  return { nonce, next: 0 }
}

function sentinel(s: Sentinels, kind: 'B' | 'M'): string {
  return `${s.nonce}${kind}${s.next++}Q`
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function isTableContent(c: AnyBlock['content']): c is Extract<AnyBlock['content'], { type: 'tableContent' }> {
  return !!c && !Array.isArray(c) && (c as { type?: string }).type === 'tableContent'
}

/** Calls `fn` for every inline array (block content and table cells), children included; code blocks are verbatim. */
function eachInlineArray(blocks: AnyBlock[], fn: (inlines: Inline[]) => Inline[]): void {
  for (const b of blocks) {
    const c = b.content
    if (b.type !== 'codeBlock') {
      if (Array.isArray(c)) b.content = fn(c)
      else if (isTableContent(c)) {
        for (const row of c.rows) {
          const cells = row.cells as unknown[]
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i]
            if (Array.isArray(cell)) cells[i] = fn(cell as Inline[])
            else if (cell && typeof cell === 'object' && Array.isArray((cell as { content?: unknown }).content)) {
              const obj = cell as { content: Inline[] }
              obj.content = fn(obj.content)
            }
          }
        }
      }
    }
    if (Array.isArray(b.children)) eachInlineArray(b.children, fn)
  }
}

/** Prop schemas of the server editor's blocks (defaults decide what a token writes). */
type PropSchema = Record<string, { default?: unknown; type?: string; values?: readonly unknown[] }>
let propSchemas: Map<string, PropSchema> | null = null
function propSchemaOf(type: string): PropSchema | null {
  if (!propSchemas) {
    propSchemas = new Map()
    const schema = (getServerEditor().editor as unknown as { schema: { blockSchema: Record<string, { propSchema: PropSchema }> } }).schema
    for (const [name, spec] of Object.entries(schema.blockSchema)) propSchemas.set(name, spec.propSchema ?? {})
  }
  return propSchemas.get(type) ?? null
}

/** Props that differ from their defaults, keys sorted (deterministic output, docs/adr/0937-*). */
function tokenProps(type: string, props: Record<string, unknown>): Record<string, unknown> {
  // chart: the config object itself (canonical), {} while the block is being set up
  if (type === 'chart') {
    const c = parseChartBlockConfig(props.config)
    return c ? (canonicalChartConfig(c) as Record<string, unknown>) : {}
  }
  // button (docs/adr/2244-*): the actions as JSON, not a JSON string inside JSON
  if (type === 'button') {
    const out: Record<string, unknown> = {}
    const actions = parseButtonActions(String(props.actions ?? ''))
    if (actions.length) out.actions = JSON.parse(buttonActionsJson(actions))
    if (props.color && props.color !== 'default') out.color = props.color
    if (props.label) out.label = props.label
    return out
  }
  const schema = propSchemaOf(type) ?? {}
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(props).sort()) {
    const v = props[k]
    if (v === undefined || v === null) continue
    if (schema[k] && schema[k].default === v) continue
    out[k] = v
  }
  return out
}

/** JSON that can sit inside an HTML comment: no `--` (so no `-->`) and no line breaks. */
function commentJson(value: unknown): string {
  return JSON.stringify(value).replace(/--/g, '-\\u002d').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function mentionLabel(label: unknown): string {
  return String(label ?? '')
    .replace(/[[\]\r\n]+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/**
 * Rewrites the notation nodes in `blocks` (a copy, mutated) into blocks BlockNote can export and
 * returns the function that turns its Markdown output into the documented notation.
 */
export function prepareNotationExport(blocks: AnyBlock[], mode: NotationMode): (markdown: string) => string {
  const s = newSentinels(JSON.stringify(blocks))
  const blockTokens = new Map<string, string>()
  const inlineTokens = new Map<string, string>()

  /** A paragraph holding only a sentinel that becomes `text` on a line of its own. */
  const lineBlock = (text: string): AnyBlock => {
    const key = sentinel(s, 'B')
    blockTokens.set(key, text)
    return { type: 'paragraph', props: {}, content: [{ type: 'text', text: key, styles: {} }], children: [] }
  }

  const replaceBlocks = (list: AnyBlock[]): AnyBlock[] => {
    const out: AnyBlock[] = []
    for (const b0 of list) {
      let b = b0
      const type = b.type ?? ''
      if (type === SNAPSHOT_BLOCK) {
        // numbers next to the block they were computed from (file export, docs/adr/2122-*)
        out.push(lineBlock(SNAPSHOT_OPEN), ...replaceBlocks(b.children ?? []), lineBlock(SNAPSHOT_CLOSE))
        continue
      }
      if (type === COLUMN_LIST_TYPE) {
        // columns (docs/adr/2422-*): markers around each column's blocks, in every mode
        const columns = (b.children ?? []).filter((c) => c.type === COLUMN_TYPE)
        if (!columns.length) continue
        out.push(lineBlock(columnsOpen(columns)))
        for (const c of columns) out.push(lineBlock(COLUMN_MARK), ...replaceBlocks(c.children ?? []))
        out.push(lineBlock(COLUMNS_CLOSE))
        continue
      }
      if (type === COLUMN_TYPE) {
        // a column outside a group (never stored that way): its blocks
        out.push(...replaceBlocks(b.children ?? []))
        continue
      }
      if (type === 'callout') {
        // `> [!type] text`: the quote's first text run carries the marker
        const content = Array.isArray(b.content) ? b.content : []
        const ct = String(b.props?.type ?? 'note')
        const marker: StyledText = { type: 'text', text: `[!${CALLOUT_SET.has(ct) ? ct : 'note'}]${content.length ? ' ' : ''}`, styles: {} }
        b = { ...b, type: 'quote', props: {}, content: [marker, ...content] }
      } else if (TOKEN_BLOCKS.has(type)) {
        if (mode === 'agent' || (mode === 'file' && FILE_TOKEN_BLOCKS.has(type))) {
          const key = sentinel(s, 'B')
          blockTokens.set(key, `<!-- inkling:${type} ${commentJson(tokenProps(type, b.props ?? {}))} -->`)
          b = { ...b, type: 'paragraph', props: {}, content: [{ type: 'text', text: key, styles: {} }] }
        } else if (PLAIN_LABELLED.has(type)) {
          const label = String(b.props?.label ?? '').replace(/[[\]\r\n]+/g, ' ').trim()
          out.push({ type: 'paragraph', props: {}, content: [{ type: 'text', text: `[${label || 'Button'}]`, styles: { bold: true } }], children: [] }, ...replaceBlocks(b.children ?? []))
          continue
        } else if (PLAIN_DROPPED.has(type)) {
          // nothing to show outside the app; the children (if any) stay
          out.push(...replaceBlocks(b.children ?? []))
          continue
        }
      }
      if (Array.isArray(b.children) && b.children.length) b = { ...b, children: replaceBlocks(b.children) }
      out.push(b)
    }
    return out
  }
  const replaced = replaceBlocks(blocks)
  blocks.splice(0, blocks.length, ...replaced)

  eachInlineArray(blocks, (inlines) => {
    if (!inlines.some((i) => i.type === 'mention')) return inlines
    return inlines.map((inl) => {
      if (inl.type !== 'mention') return inl
      const p = ((inl as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>
      const label = mentionLabel(p.label)
      if (mode !== 'agent') return { type: 'text', text: `@${label}`, styles: {} } as StyledText
      const key = sentinel(s, 'M')
      inlineTokens.set(key, `@[${label}](${String(p.kind || 'user')}:${String(p.id ?? '')})`)
      return { type: 'text', text: key, styles: {} } as StyledText
    })
  })

  if (!blockTokens.size && !inlineTokens.size) return (md) => md
  return (markdown: string) => {
    let md = markdown
    for (const [key, token] of blockTokens) {
      // the sentinel paragraph is its own line; keep its indentation / quote prefix
      const own = new RegExp(`^([ \\t>]*)${key}[ \\t]*$`, 'm')
      const m = own.exec(md)
      if (m) md = md.slice(0, m.index) + m[1] + token + md.slice(m.index + m[0].length)
      else md = md.replace(key, () => token)
    }
    for (const [key, token] of inlineTokens) md = md.replace(key, () => token)
    return md
  }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

export interface ParseNotationOptions {
  /**
   * Which `@[label](kind:id)` tokens become mention chips: 'all', or the set of `kind:id` keys
   * allowed (patch_section / update_page pass the chips already in the page, so an agent can keep
   * or move a mention but not create a new one — ADR 1002: agents do not write chips). Others, and
   * the default, become the text `@label`.
   */
  mentions?: 'all' | ReadonlySet<string>
}

export interface NotationImport {
  markdown: string
  restore(blocks: AnyBlock[]): AnyBlock[]
}

const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})/
const BLOCK_TOKEN_RE = /^([ \t>]*)<!--[ \t]*inkling:([A-Za-z]+)[ \t]+(\{.*\})[ \t]*-->[ \t]*$/
// `agent:<person uuid>/grant:<uuid>` is a person's connection (docs/adr/1861-*); agents keep, move or delete it like any chip.
const MENTION_TOKEN_RE = /@\[([^[\]\n]*)\]\((user|page|agent):([A-Za-z0-9_-]{1,64}|[0-9a-fA-F-]{36}\/(?:grant|token):[0-9a-fA-F-]{36})\)/g
const CODE_SPAN_RE = /(`+)[\s\S]*?\1/g

/** A token's props, checked against the block's prop schema; null when the token is not usable. */
function tokenBlock(type: string, json: string): AnyBlock | null {
  if (!PARSE_TOKEN_BLOCKS.has(type)) return null
  if (type === 'chart') return chartTokenBlock(json)
  if (type === 'button') return buttonTokenBlock(json)
  const schema = propSchemaOf(type)
  if (!schema) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const props: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const spec = schema[k]
    if (!spec) continue
    const want = spec.type ?? typeof spec.default
    if (want === 'number' && typeof v === 'number' && Number.isFinite(v)) props[k] = v
    else if (want === 'boolean' && typeof v === 'boolean') props[k] = v
    else if (want === 'string' && typeof v === 'string') {
      if (spec.values && !spec.values.includes(v)) continue
      props[k] = v
    }
  }
  // links an agent writes must be ones the app would create itself
  const url = typeof props.url === 'string' ? props.url : ''
  if (type === 'pageEmbed' && !UUID_RE.test(String(props.pageId ?? ''))) return null
  // a database view's view (docs/adr/2120-*): an id, or left out (the collection's first view)
  if (type === 'pageEmbed' && typeof props.viewId === 'string' && props.viewId && !UUID_RE.test(props.viewId)) delete props.viewId
  if (type === 'linkEmbed' && !parseHttpUrl(url)) return null
  if ((type === 'file' || type === 'audio' || type === 'image' || type === 'video') && !(FILE_URL_RE.test(url) || parseHttpUrl(url))) return null
  if (type === 'pluginBlock' && (typeof props.pluginId !== 'string' || !props.pluginId || String(props.data ?? '').length > PLUGIN_DATA_MAX)) return null
  return { type, props, children: [] }
}

/** A button token (docs/adr/2244-*): label, color and the actions the shared schema accepts (others dropped). */
function buttonTokenBlock(json: string): AnyBlock | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as { label?: unknown; color?: unknown; actions?: unknown }
  const props: Record<string, unknown> = {}
  if (typeof r.label === 'string') props.label = r.label.slice(0, 200)
  if (typeof r.color === 'string' && (BUTTON_COLORS as readonly string[]).includes(r.color)) props.color = r.color
  if (Array.isArray(r.actions)) {
    const actions = parseButtonActions(JSON.stringify(r.actions))
    if (actions.length) props.actions = buttonActionsJson(actions)
  }
  return { type: 'button', props, children: [] }
}

/** A chart token: `{}` (being set up) or a config the shared schema accepts; else not a block. */
function chartTokenBlock(json: string): AnyBlock | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (Object.keys(raw).length === 0) return { type: 'chart', props: { config: '' }, children: [] }
  const r = chartBlockConfigSchema.safeParse(raw)
  if (!r.success) return null
  return { type: 'chart', props: { config: canonicalChartJson(r.data) }, children: [] }
}

/** Cuts block tokens and mention tokens out of `md` (outside fenced code and code spans). */
export function extractNotation(md: string, opts: ParseNotationOptions = {}): NotationImport {
  const hasTokens = md.includes('<!--') || md.includes('@[')
  const hasCallout = md.includes('[!')
  if (!hasTokens && !hasCallout) return { markdown: md, restore: (b) => b }
  const s = newSentinels(md)
  const blockSources = new Map<string, AnyBlock>()
  const columnMarks = new Map<string, ColumnMark>()
  const mentionSources = new Map<string, { kind: string; id: string; label: string; literal: string }>()

  let out = md
  if (hasTokens) {
    const lines = md.split('\n')
    const next: string[] = []
    let fence: string | null = null
    // what the last non-blank line was: a snapshot right after a block token or a code fence is
    // that block's numbers (file export, docs/adr/2122-*) and is dropped; anywhere else it stays
    let prevLine: 'token' | 'fence' | 'other' = 'other'
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const f = FENCE_RE.exec(line)
      if (fence) {
        next.push(line)
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim().replace(/^[>\s]*/, '') === f[1]) {
          fence = null
          prevLine = 'fence'
        }
        continue
      }
      if (f) {
        fence = f[1]
        next.push(line)
        prevLine = 'other'
        continue
      }
      if (prevLine !== 'other' && SNAPSHOT_OPEN_RE.test(line)) {
        let end = -1
        for (let j = i + 1; j < lines.length; j++) {
          if (SNAPSHOT_CLOSE_RE.test(lines[j])) {
            end = j
            break
          }
        }
        if (end >= 0) {
          i = end
          prevLine = 'other'
          continue
        }
      }
      const cm = line.includes('inkling:column') ? COLUMN_MARK_RE.exec(line) : null
      const mark = cm && !cm[1] ? parseColumnMark(cm) : null
      if (cm && mark) {
        // a paragraph of its own; only top-level markers (no indent or quote) make columns, the others
        // stay comments, which BlockNote's parser drops
        const key = sentinel(s, 'B')
        columnMarks.set(key, mark)
        next.push(cm[1].trimEnd(), cm[1] + key, cm[1].trimEnd())
        prevLine = 'other'
        continue
      }
      const bt = line.includes('<!--') ? BLOCK_TOKEN_RE.exec(line) : null
      if (bt) {
        const block = tokenBlock(bt[2], bt[3])
        if (block) {
          const key = sentinel(s, 'B')
          blockSources.set(key, block)
          // a blank line on both sides: the sentinel is a paragraph of its own
          next.push(bt[1].trimEnd(), bt[1] + key, bt[1].trimEnd())
          prevLine = 'token'
          continue
        }
      }
      if (line.trim()) prevLine = 'other'
      if (!line.includes('@[')) {
        next.push(line)
        continue
      }
      // mention tokens outside code spans
      let rebuilt = ''
      let last = 0
      CODE_SPAN_RE.lastIndex = 0
      const spans: [number, number][] = []
      for (let m = CODE_SPAN_RE.exec(line); m; m = CODE_SPAN_RE.exec(line)) spans.push([m.index, m.index + m[0].length])
      MENTION_TOKEN_RE.lastIndex = 0
      for (let m = MENTION_TOKEN_RE.exec(line); m; m = MENTION_TOKEN_RE.exec(line)) {
        const at = m.index
        if (spans.some(([a, b]) => at >= a && at < b)) continue
        const key = sentinel(s, 'M')
        mentionSources.set(key, { label: m[1].trim(), kind: m[2], id: m[3], literal: m[0] })
        rebuilt += line.slice(last, at) + key
        last = at + m[0].length
      }
      next.push(rebuilt + line.slice(last))
    }
    out = next.join('\n')
  }

  const allowed = (kind: string, id: string) =>
    opts.mentions === 'all' || (opts.mentions instanceof Set ? opts.mentions.has(`${kind}:${id}`) : false)
  const anyMention = new RegExp(`${s.nonce}M\\d+Q`, 'g')

  const restore = (blocks0: AnyBlock[]): AnyBlock[] => {
    const blocks = columnMarks.size ? groupColumns(blocks0, (b) => markOf(b, columnMarks)) : blocks0
    const restoreBlocks = (list: AnyBlock[]) => {
      for (let i = 0; i < list.length; i++) {
        const b = list[i]
        const c = b.content
        if (blockSources.size && b.type === 'paragraph' && Array.isArray(c) && c.length === 1 && c[0].type === 'text') {
          const src = blockSources.get((c[0] as StyledText).text.trim())
          if (src) list[i] = { ...structuredClone(src), id: b.id, children: b.children ?? [] }
        } else if (b.type === 'quote' && Array.isArray(c)) {
          const callout = calloutFromQuote(b, c)
          if (callout) list[i] = callout
        }
        if (Array.isArray(list[i].children)) restoreBlocks(list[i].children!)
      }
    }
    restoreBlocks(blocks)
    if (!mentionSources.size) return blocks

    const splitText = (t: StyledText): Inline[] => {
      anyMention.lastIndex = 0
      if (!anyMention.test(t.text)) return [t]
      anyMention.lastIndex = 0
      const parts: Inline[] = []
      let last = 0
      for (let m = anyMention.exec(t.text); m; m = anyMention.exec(t.text)) {
        if (m.index > last) parts.push({ ...t, text: t.text.slice(last, m.index) })
        const src = mentionSources.get(m[0])!
        if (t.styles?.code) parts.push({ ...t, text: src.literal })
        else if (allowed(src.kind, src.id)) parts.push({ type: 'mention', props: { kind: src.kind, id: src.id, label: src.label } })
        else parts.push({ ...t, text: `@${src.label}` })
        last = m.index + m[0].length
      }
      if (last < t.text.length) parts.push({ ...t, text: t.text.slice(last) })
      return mergeText(parts)
    }
    const literal = (text: string) => text.replace(anyMention, (k) => mentionSources.get(k)?.literal ?? k)
    eachInlineArray(blocks, (inlines) =>
      inlines.flatMap((inl) => {
        if (inl.type === 'text') return splitText(inl as StyledText)
        if (inl.type === 'link') {
          // link text holds styled text only: a token in it comes back as written
          const l = inl as LinkInline
          return [{ ...l, content: (l.content ?? []).map((x) => ({ ...x, text: literal(x.text) })) } as Inline]
        }
        return [inl]
      }),
    )
    // code blocks are skipped above: give their tokens back verbatim
    const codeBack = (list: AnyBlock[]) => {
      for (const b of list) {
        if (b.type === 'codeBlock' && Array.isArray(b.content)) {
          b.content = b.content.map((x) => (x.type === 'text' ? { ...(x as StyledText), text: literal((x as StyledText).text) } : x))
        }
        if (Array.isArray(b.children)) codeBack(b.children)
      }
    }
    codeBack(blocks)
    return blocks
  }
  return { markdown: out, restore }
}

/** The column marker a sentinel paragraph stands for, if it is one. */
function markOf(b: AnyBlock, marks: Map<string, ColumnMark>): ColumnMark | null {
  const c = b.content
  if (b.type !== 'paragraph' || !Array.isArray(c) || c.length !== 1 || c[0].type !== 'text') return null
  return marks.get((c[0] as StyledText).text.trim()) ?? null
}

/**
 * Top-level column markers → `columnList` blocks (docs/adr/2422-*). A group is an open marker, a
 * column marker right after it, 2–4 columns and a close marker. Anything else loses its markers and
 * keeps its blocks: an open marker with no close, a nested group (all markers from the outer open to
 * its close), stray column or close markers, blocks before the first column, too few or too many
 * columns. Markers below the top level (inside a list item, a quote) are always dropped.
 */
export function groupColumns(list: AnyBlock[], markOf: (b: AnyBlock) => ColumnMark | null): AnyBlock[] {
  const out: AnyBlock[] = []
  const strip = (bs: AnyBlock[]): AnyBlock[] =>
    bs.flatMap((b) => (markOf(b) ? [] : [Array.isArray(b.children) && b.children.length ? { ...b, children: strip(b.children) } : b]))
  for (let i = 0; i < list.length; ) {
    const m = markOf(list[i])
    if (!m) {
      out.push(...strip([list[i]]))
      i++
      continue
    }
    if (m.kind !== 'open') {
      i++
      continue
    }
    // the matching close, counting nested groups
    let depth = 1
    let nested = false
    let end = -1
    for (let j = i + 1; j < list.length; j++) {
      const k = markOf(list[j])?.kind
      if (k === 'open') {
        depth++
        nested = true
      } else if (k === 'close' && --depth === 0) {
        end = j
        break
      }
    }
    if (end < 0) {
      i++ // no close: only this marker goes
      continue
    }
    const inner = list.slice(i + 1, end)
    const columns: AnyBlock[][] = []
    let valid = !nested && inner.length > 0 && markOf(inner[0])?.kind === 'column'
    if (valid) {
      for (const b of inner) {
        if (markOf(b)?.kind === 'column') columns.push([])
        else columns[columns.length - 1].push(...strip([b]))
      }
      valid = columns.length >= MIN_COLUMNS && columns.length <= MAX_COLUMNS
    }
    if (!valid) {
      out.push(...strip(inner))
      i = end + 1
      continue
    }
    const widths = m.widths && m.widths.length === columns.length ? pctToWeights(m.widths) : null
    const equal = !widths || equalWeights(widths)
    out.push({
      type: COLUMN_LIST_TYPE,
      props: {},
      children: columns.map((blocks, k) => ({
        type: COLUMN_TYPE,
        props: equal ? {} : { width: widths![k] },
        children: blocks.length ? blocks : [{ type: 'paragraph', props: {}, content: [], children: [] }],
      })),
    })
    i = end + 1
  }
  return out
}

/** `> [!type] text` read back by BlockNote as a quote → the callout, or null for an ordinary quote. */
function calloutFromQuote(b: AnyBlock, content: Inline[]): AnyBlock | null {
  const first = content[0]
  if (!first || first.type !== 'text') return null
  const t = first as StyledText
  if (t.styles && Object.keys(t.styles).length) return null
  const m = /^\[!([A-Za-z]+)\][ \t]?/.exec(t.text)
  if (!m || !CALLOUT_SET.has(m[1].toLowerCase())) return null
  const rest = t.text.slice(m[0].length)
  const body = rest ? [{ ...t, text: rest }, ...content.slice(1)] : content.slice(1)
  return { id: b.id, type: 'callout', props: { type: m[1].toLowerCase() }, content: body, children: b.children ?? [] }
}

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

/** `kind:id` of every mention chip in a Yjs document (read-only XML walk; safe on the live doc). */
export function mentionKeysInDoc(doc: Y.Doc): Set<string> {
  const out = new Set<string>()
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const c of node.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue
      if (c.nodeName === 'mention') out.add(`${String(c.getAttribute('kind') || 'user')}:${String(c.getAttribute('id') ?? '')}`)
      else walk(c)
    }
  }
  walk(doc.getXmlFragment('document'))
  return out
}
