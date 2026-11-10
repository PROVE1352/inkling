import { createHash, randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import { STATE_V2, wholeStateFormat } from '../yState'
import type { PageProperty, PagePropertyType } from '@inkling/shared'
import { parseInternalHref, sectionLinkMarkdown } from '@inkling/shared/sectionLink'
import { blocksToMarkdown } from './convert'
import type { AnyBlock } from './convert'

/**
 * Vault sync (experimental `vault-sync`) — canonical markdown, frontmatter round-trip and
 * revision tokens. See docs/adr/0200-vault-sync-protocol.md and 0201-vault-sync-frontmatter.md.
 *
 * Canonical page markdown = frontmatter (inkling-id, aliases, tags, page properties) + body
 * produced by the same BlockNote serializer as export (attachments stay `/files/<id>`; the CLI
 * maps them to vault paths). `contentHash` is SHA-256 of the normalized canonical text.
 *
 * `revision` is an opaque optimistic-concurrency token:
 *   <sha256(Yjs state vector)[0..20]>-<sha256(delete set)[0..12]>.<sha256(properties+aliases)[0..12]>
 * The state vector changes on every insertion and format change, the delete set on every deletion
 * (a pure deletion leaves the state vector alone, docs/adr/1920-*). Both are
 * readable synchronously from the in-memory Hocuspocus document, so the compare-and-write in the
 * PUT route is atomic with respect to concurrent browser edits — even edits not yet persisted
 * to page_docs by the debounced store. It never changes because of the debounced store itself.
 */

/** Property ids that are UI preferences, not user data — kept on write, never exported. */
const INTERNAL_PROPERTY_IDS = new Set(['fullWidth'])
const RESERVED_KEYS = new Set(['inkling-id', 'updated'])
const MAX_PROPERTIES = 50
// The Korean keys ('날짜' = date, '완료' = done) are legacy frontmatter names that existing vaults
// already use; they must keep mapping to the same property ids, so they stay as literals.
const WELL_KNOWN_IDS: Record<string, { id: string; type: PagePropertyType }> = {
  date: { id: 'date', type: 'date' },
  '날짜': { id: 'date', type: 'date' },
  done: { id: 'done', type: 'checkbox' },
  '완료': { id: 'done', type: 'checkbox' },
}

export type FmValue = string | number | boolean | null | string[]

// ---------------------------------------------------------------------------
// hashing / revisions
// ---------------------------------------------------------------------------

export function normalizeMarkdown(md: string): string {
  let s = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  s = s.trimEnd()
  return s.length ? `${s}\n` : ''
}

export function contentHashOf(md: string): string {
  return createHash('sha256').update(normalizeMarkdown(md), 'utf8').digest('hex')
}

function svHash(sv: Uint8Array): string {
  return createHash('sha256').update(sv).digest('hex').slice(0, 20)
}

/**
 * Metadata half of the revision: frontmatter sources (properties, aliases) plus the current titles
 * of the page's link targets (`linkSig`) — wikilinks export as `[[Current Title]]`, so renaming a
 * target must change the referrer's revision too.
 */
export function metaHash(properties: unknown, aliases: unknown, linkSig = ''): string {
  return createHash('sha256')
    .update(JSON.stringify(properties ?? []))
    .update('\u0000')
    .update(JSON.stringify(aliases ?? []))
    .update('\u0000')
    .update(linkSig)
    .digest('hex')
    .slice(0, 12)
}

/**
 * Hash of a delete set in canonical form: clients ascending, each client's ranges sorted by clock and
 * merged when they touch or overlap. The live document (built from its struct store) and a stored
 * state (read from the update's delete-set section, V1 or V2, before or after GC and struct merging)
 * give the same ranges, so they give the same hash (docs/adr/1920-*).
 */
function dsHash(ds: { clients: Map<number, { clock: number; len: number }[]> }): string {
  const h = createHash('sha256')
  for (const client of [...ds.clients.keys()].sort((a, b) => a - b)) {
    const items = [...(ds.clients.get(client) ?? [])].filter((d) => d.len > 0).sort((a, b) => a.clock - b.clock)
    if (!items.length) continue
    h.update(`${client}:`)
    let start = items[0].clock
    let end = start + items[0].len
    for (let i = 1; i < items.length; i++) {
      const d = items[i]
      if (d.clock <= end) end = Math.max(end, d.clock + d.len)
      else {
        h.update(`${start}+${end - start},`)
        start = d.clock
        end = d.clock + d.len
      }
    }
    h.update(`${start}+${end - start};`)
  }
  return h.digest('hex').slice(0, 12)
}

/**
 * The document half of a revision: `<state vector hash>-<delete set hash>`. The state vector moves
 * on every insertion and format change but not on a deletion; the delete set catches those. Before
 * 0.15.1 the half was the state vector hash alone (20 hex characters, no `-`): such a "legacy" token
 * never matches a current one (isLegacyRevision), so a client holding one re-reads or merges once.
 */
export function revisionFromDoc(doc: Y.Doc, meta: string): string {
  return `${svHash(Y.encodeStateVector(doc))}-${dsHash(Y.createDeleteSetFromStructStore(doc.store))}.${meta}`
}

export function revisionFromState(state: Uint8Array | null, meta: string): string {
  if (!state || !state.length) return revisionFromDoc(new Y.Doc(), meta)
  // One decode gives both halves: the state vector from the structs' clock ranges (a whole-document
  // state holds every client from clock 0), the delete set from the update's last section.
  const { structs, ds } = wholeStateFormat(state) === STATE_V2 ? Y.decodeUpdateV2(state) : Y.decodeUpdate(state)
  const sv = new Map<number, number>()
  for (const s of structs) {
    const end = s.id.clock + s.length
    if (end > (sv.get(s.id.client) ?? 0)) sv.set(s.id.client, end)
  }
  return `${svHash(Y.encodeStateVector(sv))}-${dsHash(ds)}.${meta}`
}

export function splitRevision(rev: string): { doc: string; meta: string } {
  const i = rev.indexOf('.')
  return i < 0 ? { doc: rev, meta: '' } : { doc: rev.slice(0, i), meta: rev.slice(i + 1) }
}

/** A revision issued before 0.15.1: its document half is the state vector hash only. */
export function isLegacyRevision(rev: string): boolean {
  return !splitRevision(rev).doc.includes('-')
}

/** State vector half of a revision's document part (the whole part for a legacy token). */
export function revisionSvPart(rev: string): string {
  const doc = splitRevision(rev).doc
  const i = doc.indexOf('-')
  return i < 0 ? doc : doc.slice(0, i)
}

// ---------------------------------------------------------------------------
// frontmatter rendering (YAML subset)
// ---------------------------------------------------------------------------

const PLAIN_SAFE_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ .,/()+-]*$/u

function yamlScalar(v: string): string {
  // Quote anything that YAML could read back as another type or that contains syntax chars.
  if (
    v === '' ||
    !PLAIN_SAFE_RE.test(v) ||
    v !== v.trim() ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(v) ||
    /^[-+]?(\d|\.\d)/.test(v)
  ) {
    return JSON.stringify(v)
  }
  return v
}

function yamlKey(k: string): string {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u.test(k) && k === k.trim() ? k : JSON.stringify(k)
}

function renderValue(key: string, v: FmValue): string {
  const k = yamlKey(key)
  if (Array.isArray(v)) {
    if (v.length === 0) return `${k}: []`
    return `${k}:\n${v.map((x) => `  - ${yamlScalar(x)}`).join('\n')}`
  }
  if (v === null || v === undefined) return `${k}:`
  if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${String(v)}`
  // ISO dates stay unquoted so Obsidian shows them as dates
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${k}: ${v}`
  return `${k}: ${yamlScalar(v)}`
}

function propertyValue(p: PageProperty): FmValue {
  const v = p.value
  switch (p.type) {
    case 'checkbox':
      return v === true
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : v == null || v === '' ? null : Number(v)
    case 'tags':
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []
    default:
      return v == null ? null : typeof v === 'string' ? v : String(v)
  }
}

export function renderFrontmatter(pageId: string, properties: unknown, aliases: unknown): string {
  const lines: string[] = [`inkling-id: ${pageId}`]
  const al = Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : []
  if (al.length) lines.push(renderValue('aliases', al))
  const props = Array.isArray(properties) ? (properties as PageProperty[]) : []
  // tags first (Obsidian convention), then the rest in stored order
  const sorted = [
    ...props.filter((p) => isTagsKey(p?.name)),
    ...props.filter((p) => !isTagsKey(p?.name)),
  ]
  const usedKeys = new Set(['inkling-id', 'aliases'])
  for (const p of sorted) {
    if (!p || typeof p.name !== 'string' || INTERNAL_PROPERTY_IDS.has(p.id)) continue
    let key = p.name
    if (usedKeys.has(key.toLowerCase())) continue
    usedKeys.add(key.toLowerCase())
    lines.push(renderValue(key, propertyValue(p)))
  }
  return `---\n${lines.join('\n')}\n---\n`
}

function isTagsKey(name: unknown): boolean {
  return typeof name === 'string' && (name.toLowerCase() === 'tags' || name.toLowerCase() === 'tag')
}

// ---------------------------------------------------------------------------
// wikilinks: export by CURRENT target title so renames don't orphan links
// ---------------------------------------------------------------------------

// a section fragment (`#h=…`, docs/adr/2100-*) belongs to the link
const INTERNAL_HREF = /^\/w\/[0-9a-fA-F-]{36}\/p\/([0-9a-fA-F-]{36})(?:#.*)?$/

type InlineLike = { type?: string; text?: string; href?: string; content?: InlineLike[]; styles?: unknown }

function mapInlines(blocks: AnyBlock[], fn: (list: InlineLike[]) => InlineLike[]): void {
  for (const b of blocks) {
    const c = b.content as unknown
    if (Array.isArray(c)) {
      b.content = fn(c as InlineLike[]) as AnyBlock['content']
    } else if (c && typeof c === 'object' && (c as { type?: string }).type === 'tableContent') {
      for (const row of (c as { rows: { cells: unknown[] }[] }).rows) {
        row.cells = row.cells.map((cell) => {
          if (Array.isArray(cell)) return fn(cell as InlineLike[])
          if (cell && typeof cell === 'object' && Array.isArray((cell as { content?: unknown }).content)) {
            return { ...(cell as object), content: fn((cell as { content: InlineLike[] }).content) }
          }
          return cell
        })
      }
    }
    if (Array.isArray(b.children)) mapInlines(b.children, fn)
  }
}

/** Target page ids of internal links. */
export function linkTargets(blocks: AnyBlock[]): string[] {
  const ids = new Set<string>()
  mapInlines(structuredClone(blocks), (list) => {
    for (const i of list) {
      const m = i.type === 'link' && typeof i.href === 'string' ? INTERNAL_HREF.exec(i.href) : null
      if (m) ids.add(m[1].toLowerCase())
    }
    return list
  })
  return [...ids]
}

/**
 * Internal links → `[[Current Title]]` (or `[[Current Title|shown text]]` when the visible text
 * differs). The generic exporter writes `[[shown text]]`, which breaks after the target is renamed.
 */
function exportWikiLinks(blocks: AnyBlock[], titleById: Map<string, string>): AnyBlock[] {
  const copy = structuredClone(blocks)
  mapInlines(copy, (list) =>
    list.map((i) => {
      const m = i.type === 'link' && typeof i.href === 'string' ? INTERNAL_HREF.exec(i.href) : null
      if (!m) return i
      const shown = (i.content ?? []).map((c) => c.text ?? '').join('')
      const title = titleById.get(m[1].toLowerCase())
      // a section link: [[Current Title#Heading]] (|shown when the text is not the plain target)
      const section = parseInternalHref(i.href)?.section
      if (section) return { type: 'text', text: sectionLinkMarkdown(section, shown, title), styles: {} }
      const text = !title ? `[[${shown}]]` : !shown || shown === title ? `[[${title}]]` : `[[${title}|${shown}]]`
      return { type: 'text', text, styles: {} }
    }),
  )
  return copy
}

const IMAGE_MD = /!\[[^\]\n]*\]\([^()\s]+(?:\s+"[^"\n]*")?\)/g

/**
 * An image inside a line of text (`see ![chart](a.png) here`, in a paragraph, list item or quote) has
 * no block of its own in the editor: the import dropped it, and the note was then rewritten without
 * it. Such images move onto their own line right after their line (as a child of a list item, inside
 * the quote), where they import as image blocks (docs/adr/2168-*). Code fences and table rows stay.
 */
export function hoistInlineImages(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      out.push(line)
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (f) {
      fence = f[1]
      out.push(line)
      continue
    }
    const images = line.match(IMAGE_MD)
    if (!images || /^\s*\|/.test(line) || /^(?:\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|\s*>\s?)*$/.test(line.replace(IMAGE_MD, ''))) {
      out.push(line) // no image, a table row, or images alone on their line (already blocks)
      continue
    }
    const prefix = /^(\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s?)*)/.exec(line)?.[1] ?? ''
    // the continuation of a list item is indented to its text; a quote keeps its `>` marks
    const cont = prefix.replace(/[-*+]|\d+[.)]|\[[ xX]\]/g, (m) => ' '.repeat(m.length))
    out.push(line.replace(new RegExp(`[ \\t]?${IMAGE_MD.source}`, 'g'), '').replace(/[ \t]+$/, ''))
    for (const img of images) out.push(cont.trimEnd(), `${cont}${img}`)
  }
  return out.join('\n')
}

/**
 * `[[Title|shown]]` / `[[Title#Heading]]` → a page by its title. The whole target is a title first,
 * so a page whose title has a `#` ("C# notes") is found as itself; only when it is not does the part
 * before the first `#` count (the 0.16 reading of `[[Page#Heading]]`; section links are told apart
 * by md/convert.ts resolveSectionLink, which checks the whole title against this fallback). Before
 * 0.17 every target was cut at its first `#`, so a vault edit next to `[[C# notes]]` re-pointed the
 * link to a page "C" or turned it into text.
 */
export function wikiTitleResolver(base: (title: string) => string | null): (raw: string) => string | null {
  return (raw) => {
    const target = raw.split('|')[0].trim()
    if (!target) return null
    const whole = base(target)
    if (whole || !target.includes('#')) return whole
    const title = target.slice(0, target.indexOf('#')).trim()
    return title ? base(title) : null
  }
}

/** After import: a link created from `[[Title|shown]]` shows only `shown`. */
export function fixAliasedLinkText(blocks: AnyBlock[]): void {
  mapInlines(blocks, (list) =>
    list.map((i) => {
      if (i.type !== 'link' || !Array.isArray(i.content)) return i
      return {
        ...i,
        content: i.content.map((c) => {
          const t = c.text ?? ''
          const bar = t.indexOf('|')
          return bar >= 0 ? { ...c, text: t.slice(bar + 1) } : c
        }),
      }
    }),
  )
}

/**
 * Blocks plain Markdown has no form for. The plain notation leaves them out, so a vault note that
 * came back deleted them from the page (docs/adr/2169-*). Vault sync writes them as the
 * one-line block tokens of the agent notation (`<!-- inkling:pageEmbed {…} -->`, md/notation.ts,
 * docs/adr/1500-*), which every import reads back into the same block; Obsidian hides the comment.
 */
const TOKEN_ONLY_BLOCKS = new Set(['pageEmbed', 'linkEmbed', 'pluginBlock', 'chart'])

async function withBlockTokens(blocks: AnyBlock[]): Promise<{ blocks: AnyBlock[]; finish: (md: string) => string }> {
  const tokens = new Map<string, string>()
  const nonce = randomBytes(6).toString('hex')
  const walk = async (list: AnyBlock[]): Promise<AnyBlock[]> => {
    const out: AnyBlock[] = []
    for (const b of list) {
      let x = b
      if (TOKEN_ONLY_BLOCKS.has(b.type ?? '')) {
        const { markdown } = await blocksToMarkdown([{ ...b, children: [] }], { assetMode: 'absolute', notation: 'agent' })
        const token = markdown.trim()
        if (/^<!-- inkling:\w+ .*-->$/.test(token)) {
          const key = `inklingsyncblock${nonce}n${tokens.size}`
          tokens.set(key, token)
          x = { type: 'paragraph', props: {}, content: [{ type: 'text', text: key, styles: {} }], children: b.children ?? [] } as AnyBlock
        }
      }
      if (Array.isArray(x.children) && x.children.length) x = { ...x, children: await walk(x.children) }
      out.push(x)
    }
    return out
  }
  const out = await walk(blocks)
  return {
    blocks: out,
    finish: (md) => {
      let s = md
      for (const [key, token] of tokens) {
        const own = new RegExp(`^([ \\t>]*)${key}[ \\t]*$`, 'm')
        const m = own.exec(s)
        s = m ? s.slice(0, m.index) + m[1] + token + s.slice(m.index + m[0].length) : s.replace(key, () => token)
      }
      return s
    },
  }
}

/** Canonical sync markdown for a doc page. */
export async function renderSyncMarkdown(
  page: { id: string; properties: unknown; aliases: unknown },
  blocks: AnyBlock[],
  titleById: Map<string, string> = new Map(),
): Promise<string> {
  const tokened = await withBlockTokens(exportWikiLinks(blocks, titleById))
  const { markdown } = await blocksToMarkdown(tokened.blocks, { assetMode: 'absolute' })
  const body = tokened.finish(markdown).trimEnd()
  return normalizeMarkdown(`${renderFrontmatter(page.id, page.properties, page.aliases)}${body ? `\n${body}\n` : ''}`)
}

// ---------------------------------------------------------------------------
// frontmatter parsing (hand-written YAML subset — no dependency)
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  present: boolean
  data: Map<string, FmValue>
  /** keys whose values could not be represented (nested maps, multi-line scalars) */
  dropped: string[]
  body: string
}

function unquote(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  return s
}

/** Strip a trailing ` # comment` from a plain (unquoted) scalar. */
function stripComment(s: string): string {
  if (s.startsWith('"') || s.startsWith("'")) return s
  const i = s.indexOf(' #')
  return i >= 0 ? s.slice(0, i) : s
}

function scalar(raw: string): FmValue {
  const s = stripComment(raw.trim()).trim()
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return null
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s)
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true'
  if (/^-?\d{1,15}(\.\d{1,15})?$/.test(s)) return Number(s)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((x) => unquote(x)).filter((x) => x !== '')
  }
  return s
}

/** Split a YAML flow sequence body on commas outside quotes. */
function splitFlow(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (const ch of s) {
    if (q) {
      cur += ch
      if (ch === q) q = null
    } else if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
    } else if (ch === ',') {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** `key: value` → { key, rest } using a linear scan (quoted keys allowed). */
function splitKeyValue(line: string): { key: string; rest: string } | null {
  let i = 0
  let key: string
  if (line[0] === '"' || line[0] === "'") {
    const q = line[0]
    i = 1
    while (i < line.length && line[i] !== q) i += line[i] === '\\' && q === '"' ? 2 : 1
    if (i >= line.length) return null
    key = unquote(line.slice(0, i + 1))
    i++
    while (line[i] === ' ' || line[i] === '\t') i++
    if (line[i] !== ':') return null
  } else {
    // first ':' that is followed by whitespace or end of line
    for (;;) {
      i = line.indexOf(':', i)
      if (i < 0) return null
      if (i + 1 >= line.length || line[i + 1] === ' ' || line[i + 1] === '\t') break
      i++
    }
    key = line.slice(0, i).trim()
  }
  if (!key) return null
  return { key: key.trim(), rest: line.slice(i + 1).trim() }
}

export function parseFrontmatter(md: string): ParsedFrontmatter {
  const text = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const empty: ParsedFrontmatter = { present: false, data: new Map(), dropped: [], body: text }
  if (!text.startsWith('---\n')) return empty
  const end = text.indexOf('\n---', 3)
  if (end < 0) return empty
  const after = text.indexOf('\n', end + 4)
  const closingLine = text.slice(end + 1, after < 0 ? undefined : after)
  if (closingLine.trim() !== '---') return empty
  const block = text.slice(4, end)
  const body = after < 0 ? '' : text.slice(after + 1)

  const data = new Map<string, FmValue>()
  const dropped: string[] = []
  const lines = block.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++
      continue
    }
    if (/^\s/.test(line)) {
      // stray indented line (belongs to an unsupported structure) — skip
      i++
      continue
    }
    const kv = splitKeyValue(line)
    if (!kv) {
      i++
      continue
    }
    const key = kv.key
    const rest = kv.rest
    i++
    if (rest.trim() === '' || rest.trim() === '|' || rest.trim() === '>') {
      // block sequence or nested mapping / block scalar
      const items: string[] = []
      let nested = false
      while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i].startsWith('- '))) {
        const l = lines[i].trim()
        if (l.startsWith('- ')) items.push(unquote(stripComment(l.slice(2))))
        else if (l === '-') items.push('')
        else if (l) nested = true
        i++
      }
      if (rest.trim() === '|' || rest.trim() === '>' || (nested && items.length === 0)) {
        dropped.push(key)
        continue
      }
      data.set(key, items.length ? items.filter((x) => x !== '') : null)
      continue
    }
    data.set(key, scalar(rest))
  }
  return { present: true, data, dropped, body }
}

// ---------------------------------------------------------------------------
// frontmatter → page meta
// ---------------------------------------------------------------------------

function newPropertyId(): string {
  return randomBytes(6).toString('base64url')
}

function inferType(v: FmValue): PagePropertyType {
  if (Array.isArray(v)) return 'tags'
  if (typeof v === 'boolean') return 'checkbox'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  if (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v)) return 'url'
  return 'text'
}

function coerce(type: PagePropertyType, v: FmValue): { ok: boolean; value: unknown } {
  if (v === null) return { ok: true, value: undefined }
  switch (type) {
    case 'checkbox':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, value: null }
    case 'number':
      return typeof v === 'number' ? { ok: true, value: v } : { ok: false, value: null }
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)
        ? { ok: true, value: v.slice(0, 10) }
        : { ok: false, value: null }
    case 'tags':
      return Array.isArray(v) ? { ok: true, value: v } : typeof v === 'string' ? { ok: true, value: [v] } : { ok: false, value: null }
    default:
      return Array.isArray(v) ? { ok: false, value: null } : { ok: true, value: String(v) }
  }
}

/**
 * Merges parsed frontmatter into the page's properties/aliases.
 *  - `inkling-id` / `updated` are identity/info keys and ignored.
 *  - `aliases`/`alias` → pages.aliases; `tags`/`tag` → a `tags`-typed property (leading # stripped).
 *  - Existing properties keep their id and type when the value still fits; otherwise the type is
 *    re-inferred. Properties missing from the frontmatter are removed (the file is the source of
 *    truth for user-visible properties); internal ones (fullWidth) are always kept.
 */
export function frontmatterToMeta(
  fm: ParsedFrontmatter,
  existingProps: unknown,
  existingAliases: unknown,
): { properties: PageProperty[]; aliases: string[] } {
  const existing = Array.isArray(existingProps) ? (existingProps as PageProperty[]) : []
  const internal = existing.filter((p) => p && INTERNAL_PROPERTY_IDS.has(p.id))
  if (!fm.present) {
    // no frontmatter block at all → keep meta untouched (plain notes stay plain)
    return {
      properties: existing,
      aliases: Array.isArray(existingAliases) ? (existingAliases as string[]) : [],
    }
  }
  const byName = new Map(existing.map((p) => [p?.name?.toLowerCase?.() ?? '', p]))
  const out: PageProperty[] = []
  let aliases: string[] = []
  const usedIds = new Set(internal.map((p) => p.id))
  for (const [rawKey, value] of fm.data) {
    const key = rawKey.trim()
    const lower = key.toLowerCase()
    if (!key || RESERVED_KEYS.has(lower)) continue
    if (lower === 'aliases' || lower === 'alias') {
      const list = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
      const seen = new Set<string>()
      aliases = list
        .map((a) => a.trim())
        .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
      continue
    }
    let v = value
    if (lower === 'tags' || lower === 'tag') {
      const list = Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/[\s,]+/) : []
      v = list.map((t) => t.replace(/^#/, '').trim()).filter(Boolean)
    }
    const prev = byName.get(lower)
    let type: PagePropertyType = prev?.type ?? (lower === 'tags' || lower === 'tag' ? 'tags' : inferType(v))
    let c = coerce(type, v)
    if (!c.ok) {
      type = inferType(v)
      c = coerce(type, v)
    }
    // `date` / `done` (and the Korean UI names) map onto the ids the calendar and due views
    // write (PATCH /pages/:id { dateProperty, done }), so both paths edit the same property
    const wellKnown = WELL_KNOWN_IDS[lower]
    const preferred =
      !prev && wellKnown && wellKnown.type === type && !usedIds.has(wellKnown.id) ? wellKnown.id : null
    let id = prev && !usedIds.has(prev.id) ? prev.id : (preferred ?? newPropertyId())
    while (usedIds.has(id)) id = newPropertyId()
    usedIds.add(id)
    const prop: PageProperty = { id, name: key.slice(0, 60), type }
    if (c.value !== undefined) prop.value = c.value
    out.push(prop)
    if (out.length >= MAX_PROPERTIES - internal.length) break
  }
  return { properties: [...out, ...internal], aliases }
}
