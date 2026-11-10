import * as Y from 'yjs'
import { getServerEditor } from './editor'
import { extractMath, prepareMathExport } from './math'
import { extractNotation, prepareNotationExport } from './notation'
import type { NotationMode, ParseNotationOptions } from './notation'
import { applyStoredState } from '../yState'
import { internalHref, parseInternalHref, sectionLinkMarkdown, wikiSectionCandidates } from '@inkling/shared/sectionLink'

// ---------------------------------------------------------------------------
// Loose structural types — handling BlockNote's generic Block type directly makes inline
// manipulation far too cumbersome, so we define a structural view used only inside the conversion.
// Casts happen only at the editor-method boundary.
// ---------------------------------------------------------------------------

export interface StyledText {
  type: 'text'
  text: string
  styles?: Record<string, unknown>
}
export interface LinkInline {
  type: 'link'
  href: string
  content: StyledText[]
}
export type Inline = StyledText | LinkInline | { type: string; [k: string]: unknown }

interface TableCellObj {
  type: 'tableCell'
  content: Inline[]
  [k: string]: unknown
}
interface TableContent {
  type: 'tableContent'
  rows: { cells: Inline[][] | TableCellObj[] }[]
  [k: string]: unknown
}

export interface AnyBlock {
  id?: string
  type?: string
  props?: Record<string, unknown>
  content?: Inline[] | TableContent | undefined
  children?: AnyBlock[]
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
/**
 * Internal wikilink href: /w/<workspaceId>/p/<pageId>, optionally with a section fragment
 * (`#h=…`, docs/adr/2100-*) → capture = targetPageId. Use parseInternalHref for the section.
 */
const INTERNAL_HREF_RE = new RegExp(`^/w/${UUID}/p/(${UUID})(?:#.*)?$`)
/** Attachment URL: /files/<fileId> → capture = fileId */
const FILE_URL_RE = new RegExp(`^/files/(${UUID})$`)
/** [[title]] */
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g

/** Attachment-like blocks that carry props.url */
const ASSET_BLOCK_TYPES = new Set(['image', 'file', 'video', 'audio'])

// ---------------------------------------------------------------------------
// inline array traversal helpers (paragraphs/headings/lists + table cells, recursive)
// ---------------------------------------------------------------------------

function isTableContent(c: AnyBlock['content']): c is TableContent {
  return !!c && !Array.isArray(c) && (c as TableContent).type === 'tableContent'
}

/** Replace each block's inline array with mapFn's result (table cells included, children recursive). */
export function mapBlockInlines(
  blocks: AnyBlock[],
  mapFn: (inlines: Inline[]) => Inline[],
  /** blocks whose own inlines are left alone (their children are still visited) */
  skip?: (block: AnyBlock) => boolean,
): void {
  for (const b of blocks) {
    const c = skip?.(b) ? undefined : b.content
    if (Array.isArray(c)) {
      b.content = mapFn(c)
    } else if (isTableContent(c)) {
      for (const row of c.rows) {
        const cells = row.cells
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i]
          if (Array.isArray(cell)) {
            ;(row.cells as Inline[][])[i] = mapFn(cell)
          } else if (cell && typeof cell === 'object' && Array.isArray(cell.content)) {
            cell.content = mapFn(cell.content)
          }
        }
      }
    }
    if (Array.isArray(b.children)) mapBlockInlines(b.children, mapFn, skip)
  }
}

/** Visit each block's inline array read-only (for extraction). */
function visitBlockInlines(blocks: AnyBlock[], visit: (inlines: Inline[]) => void): void {
  for (const b of blocks) {
    const c = b.content
    if (Array.isArray(c)) {
      visit(c)
    } else if (isTableContent(c)) {
      for (const row of c.rows) {
        for (const cell of row.cells) {
          if (Array.isArray(cell)) visit(cell)
          else if (cell && typeof cell === 'object' && Array.isArray(cell.content)) visit(cell.content)
        }
      }
    }
    if (Array.isArray(b.children)) visitBlockInlines(b.children, visit)
  }
}

/** Recursively visit attachment blocks that carry props.url (children included). */
export function visitAssetBlocks(blocks: AnyBlock[], visit: (block: AnyBlock) => void): void {
  for (const b of blocks) {
    if (b.type && ASSET_BLOCK_TYPES.has(b.type)) visit(b)
    if (Array.isArray(b.children)) visitAssetBlocks(b.children, visit)
  }
}

// ---------------------------------------------------------------------------
// Yjs state ↔ blocks
// ---------------------------------------------------------------------------

/** Blocks of a stored state, V1 or V2 (docs/adr/1101-*). */
export function stateToBlocks(state: Uint8Array): AnyBlock[] {
  const doc = new Y.Doc()
  applyStoredState(doc, state)
  return docToBlocks(doc)
}

/**
 * Blocks of a document read through BlockNote. The read is destructive for nodes the server schema
 * does not know (y-prosemirror deletes them), so only pass a throwaway document, never a live one.
 */
export function docToBlocks(doc: Y.Doc): AnyBlock[] {
  return getServerEditor().yDocToBlocks(doc, 'document') as unknown as AnyBlock[]
}

export function blocksToStateBuffer(blocks: AnyBlock[]): Buffer {
  const editor = getServerEditor()
  const input = blocks as unknown as Parameters<typeof editor.blocksToYDoc>[0]
  const doc = editor.blocksToYDoc(input, 'document')
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

/**
 * Fill an existing Y.XmlFragment with the blocks' content (for restoring a live doc).
 * If the caller empties it with fragment.delete(0, fragment.length) first and then calls this,
 * the change propagates live to open clients. (Call inside DirectConnection.transact.)
 */
export function blocksToXmlFragment(
  blocks: AnyBlock[],
  fragment: Y.XmlFragment,
): void {
  const editor = getServerEditor()
  const input = blocks as unknown as Parameters<typeof editor.blocksToYXmlFragment>[0]
  editor.blocksToYXmlFragment(
    input,
    fragment as unknown as Parameters<typeof editor.blocksToYXmlFragment>[1],
  )
}

/**
 * Replace all inline text in a block tree (table cells and children included, links by display text)
 * with `transform`'s result, in place. Used for template variable substitution ({{date}} etc.).
 * Unchanged inlines are left as they are to avoid needless object creation.
 */
export function substituteInlineText(
  blocks: AnyBlock[],
  transform: (text: string) => string,
): void {
  mapBlockInlines(blocks, (inlines) =>
    inlines.map((inl) => {
      if (inl.type === 'text' && typeof (inl as StyledText).text === 'string') {
        const st = inl as StyledText
        const next = transform(st.text)
        return next === st.text ? inl : { ...st, text: next }
      }
      if (inl.type === 'link' && Array.isArray((inl as LinkInline).content)) {
        const lk = inl as LinkInline
        lk.content = lk.content.map((c) =>
          typeof c.text === 'string' ? { ...c, text: transform(c.text) } : c,
        )
        return lk
      }
      return inl
    }),
  )
}

// ---------------------------------------------------------------------------
// blocks → markdown  (internal links → [[title]], optional relative asset paths)
// ---------------------------------------------------------------------------

export interface BlocksToMarkdownOptions {
  assetMode: 'absolute' | 'relative'
  /** In relative mode, which relative path replaces /files/<id> (the caller knows mime→ext). */
  resolveAssetPath?: (fileId: string) => string
  /**
   * 'agent' writes the round-trip notation for embeds, plugin blocks, file/audio blocks and
   * mentions (MCP reads, patch_section); 'plain' (default) is for people (docs/adr/1500-*).
   */
  notation?: NotationMode
}

export interface BlocksToMarkdownResult {
  markdown: string
  assetIds: string[]
}

export async function blocksToMarkdown(
  blocks: AnyBlock[],
  opts: BlocksToMarkdownOptions,
): Promise<BlocksToMarkdownResult> {
  const copy: AnyBlock[] = structuredClone(blocks)

  // 1) internal link inline → plain text [[title]]; a section link → [[Page#Heading]] or
  //    [[Page#Heading|shown]] (docs/adr/2100-*)
  mapBlockInlines(copy, (inlines) =>
    inlines.map((inl) => {
      if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') {
        const link = inl as LinkInline
        if (INTERNAL_HREF_RE.test(link.href)) {
          const shown = (link.content ?? []).map((c) => c.text ?? '').join('')
          const section = parseInternalHref(link.href)?.section
          const text = section ? sectionLinkMarkdown(section, shown) : `[[${shown || 'Untitled'}]]`
          const styled: StyledText = { type: 'text', text, styles: {} }
          return styled
        }
      }
      return inl
    }),
  )

  // 2) make asset paths relative + collect the fileIds used
  const assetIds: string[] = []
  if (opts.assetMode === 'relative') {
    visitAssetBlocks(copy, (b) => {
      const url = b.props?.url
      if (typeof url === 'string') {
        const m = FILE_URL_RE.exec(url)
        if (m) {
          const fileId = m[1]
          assetIds.push(fileId)
          b.props!.url = opts.resolveAssetPath
            ? opts.resolveAssetPath(fileId)
            : `assets/${fileId}`
        }
      }
    })
  }

  // 3) callouts, mentions, embeds → their notation (md/notation.ts, ADR 1500)
  const finishNotation = prepareNotationExport(copy, opts.notation ?? 'plain')

  // 4) math nodes → `$$…$$` / `$…$`, written around BlockNote's exporter (md/math.ts, ADR 0996)
  const finishMath = prepareMathExport(copy)

  const editor = getServerEditor()
  const input = copy as unknown as Parameters<typeof editor.blocksToMarkdownLossy>[0]
  const markdown = finishNotation(finishMath(await editor.blocksToMarkdownLossy(input)))
  return { markdown, assetIds: [...new Set(assetIds)] }
}

// ---------------------------------------------------------------------------
// markdown → blocks  ([[title]] → internal link, optional absolute asset paths)
// ---------------------------------------------------------------------------

export type ResolveTitle = (title: string) => string | null
export type ResolveAsset = (relPath: string) => string | null

export async function markdownToBlocks(
  md: string,
  resolveTitle: ResolveTitle,
  resolveAsset?: ResolveAsset,
  notation: ParseNotationOptions = {},
): Promise<AnyBlock[]> {
  const editor = getServerEditor()
  // Block and mention tokens first (their JSON may hold `$`), then math (md/notation.ts, ADR 1500)
  const marks = extractNotation(md, notation)
  // `$$…$$` / `$…$` are cut out before BlockNote's parser sees them (md/math.ts, ADR 0996)
  const math = extractMath(marks.markdown)
  const blocks = marks.restore(math.restore((await editor.tryParseMarkdownToBlocks(math.markdown)) as unknown as AnyBlock[]))

  // Split [[title]] inside text inlines and replace it with a link/literal. Not in code blocks: their
  // text is code (a Mermaid subroutine node is `A[[Name]]`, docs/adr/2104-*) and must come back as written.
  mapBlockInlines(blocks, (inlines) => expandWikiLinks(inlines, resolveTitle), (b) => b.type === 'codeBlock')

  // assets/... relative path → /files/<newId>
  if (resolveAsset) {
    visitAssetBlocks(blocks, (b) => {
      const url = b.props?.url
      if (typeof url === 'string' && !url.startsWith('/files/') && !/^https?:/i.test(url)) {
        const mapped = resolveAsset(url)
        if (mapped) b.props!.url = mapped
      }
    })
  }

  return blocks
}

function expandWikiLinks(inlines: Inline[], resolveTitle: ResolveTitle): Inline[] {
  const out: Inline[] = []
  for (const inl of inlines) {
    if (inl.type === 'text' && typeof (inl as StyledText).text === 'string') {
      const st = inl as StyledText
      if (st.text.includes('[[')) {
        out.push(...splitWiki(st, resolveTitle))
        continue
      }
    }
    out.push(inl)
  }
  return out
}

function splitWiki(textInline: StyledText, resolveTitle: ResolveTitle): Inline[] {
  const { text } = textInline
  const styles = textInline.styles ?? {}
  const parts: Inline[] = []
  let last = 0
  let m: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const before = text.slice(last, m.index)
    if (before) parts.push({ type: 'text', text: before, styles })
    const title = m[1]
    const section = title.includes('#') ? resolveSectionLink(title, resolveTitle) : null
    const url = section ? null : resolveTitle(title)
    if (section) {
      parts.push({ type: 'link', href: section.href, content: [{ type: 'text', text: section.text, styles }] })
    } else if (url) {
      parts.push({ type: 'link', href: url, content: [{ type: 'text', text: title, styles }] })
    } else {
      parts.push({ type: 'text', text: `[[${title}]]`, styles })
    }
    last = m.index + m[0].length
  }
  if (parts.length === 0) return [textInline]
  const rest = text.slice(last)
  if (rest) parts.push({ type: 'text', text: rest, styles })
  return parts
}

/**
 * `[[Page#Heading]]` / `[[Page#Heading|shown]]` → a section link (docs/adr/2100-*), or null when the
 * text means something else. The whole text keeps its old meanings first: a page titled exactly so
 * (or by alias / former title) and the subpage a split made from that section (docs/adr/1140-*) stay
 * page links, as before. Otherwise the last `#` whose left part is a page's own title wins, so a
 * title with `#` ("C# notes#Setup") and a heading with `#` ("Guide#Step #2") both work; the
 * resolver's own fallback (`X#Y` → page X) does not count as a title. No block id: the link finds
 * its heading by name (and the change log) until the editor rewrites it.
 */
function resolveSectionLink(inner: string, resolveTitle: ResolveTitle): { href: string; text: string } | null {
  const candidates = wikiSectionCandidates(inner)
  if (!candidates.length) return null
  const bar = inner.indexOf('|')
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
  const before = (s: string) => s.slice(0, s.indexOf('#')).trim()
  const whole = resolveTitle(target)
  const prefix = before(target)
  if (whole && whole !== (prefix ? resolveTitle(prefix) : null)) return null
  for (const c of [...candidates].reverse()) {
    const base = resolveTitle(c.page)
    if (!base) continue
    if (c.page.includes('#')) {
      const pre = before(c.page)
      if (pre && resolveTitle(pre) === base) continue
    }
    const m = INTERNAL_HREF_RE.exec(base)
    const ws = /^\/w\/([^/]+)\//.exec(base)?.[1]
    if (!m || !ws) return null
    return {
      href: internalHref(ws, m[1], { heading: c.heading, page: c.page }),
      text: c.alias ?? `${c.page}#${c.heading}`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// internal link target extraction (for the backlink index)
// ---------------------------------------------------------------------------

export function extractInternalLinks(blocks: AnyBlock[]): string[] {
  const ids = new Set<string>()
  visitBlockInlines(blocks, (inlines) => {
    for (const inl of inlines) {
      if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') {
        const m = INTERNAL_HREF_RE.exec((inl as LinkInline).href)
        if (m) ids.add(m[1])
      }
    }
  })
  return [...ids]
}

/** Most section refs kept per (source, target) pair in page_links.sections. */
export const MAX_LINK_SECTIONS = 20

/**
 * Section links per target page (docs/adr/2101-*): the headings this document links to, for the
 * backlinks panel and check_notes, keyed by lower-case page id. Deduplicated by block id or heading;
 * page links add nothing.
 */
export function extractLinkSections(blocks: AnyBlock[]): Map<string, { h: string; b?: string }[]> {
  const out = new Map<string, { h: string; b?: string }[]>()
  visitBlockInlines(blocks, (inlines) => {
    for (const inl of inlines) {
      if (inl.type !== 'link') continue
      const link = parseInternalHref((inl as LinkInline).href)
      if (!link?.section) continue
      const key = link.pageId.toLowerCase()
      const list = out.get(key) ?? []
      const { heading, blockId } = link.section
      if (list.length >= MAX_LINK_SECTIONS || list.some((x) => (blockId && x.b === blockId) || (!blockId && !x.b && x.h === heading))) continue
      list.push(blockId ? { h: heading, b: blockId } : { h: heading })
      out.set(key, list)
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

/** Remove a leading `---` frontmatter pair (input returned unchanged if there is none). */
export function stripFrontmatter(md: string): string {
  const m = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(md)
  if (m && m.index === 0) return md.slice(m[0].length)
  return md
}

// ---------------------------------------------------------------------------
// public web sharing (M15) — safe conversions for unauthenticated rendering
// ---------------------------------------------------------------------------

/** External link schemes kept clickable on public links (other internal/relative links become text). */
const EXTERNAL_HREF_RE = /^(?:https?:\/\/|mailto:)/i

/**
 * Serialize blocks into a complete HTML string shaped like the editor's output (server render).
 * Used by the public share view to show the body without scripts or an editor.
 */
export async function blocksToFullHTML(blocks: AnyBlock[]): Promise<string> {
  const editor = getServerEditor()
  const input = publicBlocks(structuredClone(blocks)) as unknown as Parameters<typeof editor.blocksToFullHTML>[0]
  return editor.blocksToFullHTML(input)
}

/**
 * Public HTML carries no internal ids (see neutralizeInternalLinksForPublic): page/link embeds and
 * plugin blocks are left out as before the server knew them (their children stay), and mention
 * chips become their `@label` text (docs/adr/1500-*).
 */
function publicBlocks(blocks: AnyBlock[]): AnyBlock[] {
  const out: AnyBlock[] = []
  for (const b of blocks) {
    // chart: public pages get a table from routes/public.ts (only for data inside the link) — never the config
    if (b.type === 'pageEmbed' || b.type === 'linkEmbed' || b.type === 'pluginBlock' || b.type === 'chart') {
      out.push(...publicBlocks(b.children ?? []))
      continue
    }
    out.push({ ...b, children: publicBlocks(b.children ?? []) })
  }
  mapBlockInlines(out, (inlines) =>
    inlines.some((i) => i.type === 'mention')
      ? inlines.map((i) =>
          i.type === 'mention'
            ? ({ type: 'text', text: `@${String((i as { props?: { label?: unknown } }).props?.label ?? '')}`, styles: {} } as StyledText)
            : i,
        )
      : inlines,
  )
  return out
}

/**
 * Replace internal links (<a> pointing at app-relative paths such as wikilinks /w/..., /api/..., /files/...)
 * with plain text holding only the display text, in place. Prevents leaking internal workspace/page ids (security first).
 * Only external http(s)/mailto links stay clickable.
 */
export function neutralizeInternalLinksForPublic(blocks: AnyBlock[]): void {
  mapBlockInlines(blocks, (inlines) =>
    inlines.map((inl) => {
      if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') {
        const link = inl as LinkInline
        if (!EXTERNAL_HREF_RE.test(link.href)) {
          const text = (link.content ?? []).map((c) => c.text ?? '').join('')
          const styled: StyledText = { type: 'text', text, styles: {} }
          return styled
        }
      }
      return inl
    }),
  )
}

/**
 * For folder shares: if an internal wikilink's (/w/<ws>/p/<pageId>) target is inside the shared subtree,
 * rewrite it to the public path returned by `resolve(pageId)` (/s/<token>/p/<ref>); otherwise (or if it
 * cannot be resolved) turn it into text as before, in place. External http(s)/mailto links are left alone.
 */
export function rewriteInternalLinksForPublic(
  blocks: AnyBlock[],
  resolve: (pageId: string) => string | null,
): void {
  mapBlockInlines(blocks, (inlines) =>
    inlines.map((inl) => {
      if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') {
        const link = inl as LinkInline
        if (EXTERNAL_HREF_RE.test(link.href)) return inl
        const m = INTERNAL_HREF_RE.exec(link.href)
        const target = m ? resolve(m[1]) : null
        if (target) return { ...link, href: target } as Inline
        const text = (link.content ?? []).map((c) => c.text ?? '').join('')
        const styled: StyledText = { type: 'text', text, styles: {} }
        return styled
      }
      return inl
    }),
  )
}

/** Extract the fileId from a /files/<uuid> URL (null otherwise). Used for cover/icon rewriting and the file gate. */
export function parseFileUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  const m = FILE_URL_RE.exec(url)
  return m ? m[1] : null
}

/**
 * Rewrite attachment blocks' /files/<id> URLs to public file paths, in place.
 * Returns the set of rewritten fileIds (= the ones the page actually references).
 */
export function rewriteAssetUrlsForPublic(
  blocks: AnyBlock[],
  toPublicUrl: (fileId: string) => string,
): Set<string> {
  const ids = new Set<string>()
  visitAssetBlocks(blocks, (b) => {
    const url = b.props?.url
    if (typeof url === 'string') {
      const m = FILE_URL_RE.exec(url)
      if (m) {
        ids.add(m[1])
        b.props!.url = toPublicUrl(m[1])
      }
    }
  })
  return ids
}

/** Only collect the /files/<id> fileIds attachment blocks reference (no rewrite) — for the public file gate. */
export function collectAssetFileIds(blocks: AnyBlock[]): Set<string> {
  const ids = new Set<string>()
  visitAssetBlocks(blocks, (b) => {
    const url = b.props?.url
    if (typeof url === 'string') {
      const m = FILE_URL_RE.exec(url)
      if (m) ids.add(m[1])
    }
  })
  return ids
}
