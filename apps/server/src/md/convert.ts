import * as Y from 'yjs'
import { getServerEditor } from './editor'

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
/** Internal wikilink href: /w/<workspaceId>/p/<pageId> → capture = targetPageId */
const INTERNAL_HREF_RE = new RegExp(`^/w/${UUID}/p/(${UUID})$`)
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
): void {
  for (const b of blocks) {
    const c = b.content
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
    if (Array.isArray(b.children)) mapBlockInlines(b.children, mapFn)
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

export function stateToBlocks(state: Uint8Array): AnyBlock[] {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const blocks = getServerEditor().yDocToBlocks(doc, 'document')
  return blocks as unknown as AnyBlock[]
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

  // 1) internal link inline → plain text [[title]]
  mapBlockInlines(copy, (inlines) =>
    inlines.map((inl) => {
      if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') {
        const link = inl as LinkInline
        if (INTERNAL_HREF_RE.test(link.href)) {
          const text =
            (link.content ?? []).map((c) => c.text ?? '').join('') || 'Untitled'
          const styled: StyledText = { type: 'text', text: `[[${text}]]`, styles: {} }
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

  const editor = getServerEditor()
  const input = copy as unknown as Parameters<typeof editor.blocksToMarkdownLossy>[0]
  const markdown = await editor.blocksToMarkdownLossy(input)
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
): Promise<AnyBlock[]> {
  const editor = getServerEditor()
  const blocks = (await editor.tryParseMarkdownToBlocks(md)) as unknown as AnyBlock[]

  // Split [[title]] inside text inlines and replace it with a link/literal
  mapBlockInlines(blocks, (inlines) => expandWikiLinks(inlines, resolveTitle))

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
    const url = resolveTitle(title)
    if (url) {
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
  const input = blocks as unknown as Parameters<typeof editor.blocksToFullHTML>[0]
  return editor.blocksToFullHTML(input)
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
