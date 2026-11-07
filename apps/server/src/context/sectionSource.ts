import { sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { applyStoredState } from '../yState'
import { db } from '../db/index'
import { adoptIndexedStamp, docIndexIdle, indexedStamp, scheduleDocIndex } from '../docIndexer'
import { liveDoc, liveDocStamp } from '../liveConnections'
import { blocksToMarkdown, stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { readTopRange } from './sectionPatch'
import { chunkBlocks, findSection, joinPath, MAX_CHUNKS_PER_PAGE, PATH_SEP, splitSections } from './chunker'

/**
 * Outline and section reads for read_page(outline|section) and patch_section's echo
 * (docs/adr/1041-*).
 *
 * The section index (page_chunks) already holds every section's anchor, heading path, level, token
 * estimate and version. When it provably reflects the current document, the outline is answered
 * from it with one query and no Yjs decode, and a section read converts only that section's blocks.
 * "Provably" means: the docIndexer's freshness record says the last completed index pass was for
 * the stored state with stamp S (page_docs.updated_at as text), no pass is queued, and the current
 * document is that state — page_docs.updated_at is still S, or the open in-memory document has had
 * no update since it equalled S. Anything else (a live doc with unsaved edits, a pass in flight, a
 * restart, a page at the index row bound) takes the decode path, exactly as before. A decode of an
 * unchanged stored state compares its chunk hashes with page_chunks and, when equal, records the
 * stamp, so the next read is answered from the index.
 */

export interface OutlineSection {
  anchor: string
  blockId: string | null
  headingPath: string[]
  level: number
  tokens: number
  version: string
}

interface IndexedSection extends OutlineSection {
  /** Heading block id of the following section; null when this section runs to the end. */
  nextBlockId: string | null
}

/** Test/bench hook: which path served each read. */
export const sectionSourceStats = { outlineIndex: 0, outlineDecode: 0, sectionIndex: 0, sectionDecode: 0, cacheHits: 0, adopted: 0, reindexed: 0 }

// ---------------------------------------------------------------------------
// section Markdown cache (keyed by the stored state, so an edit never serves old text)
// ---------------------------------------------------------------------------

/** Characters of section Markdown kept across reads (≈ 8 MB of UTF-16). */
const CACHE_CHARS = 4_000_000
const cache = new Map<string, string>()
let cacheChars = 0

function cacheGet(key: string): string | undefined {
  const v = cache.get(key)
  if (v !== undefined) {
    cache.delete(key)
    cache.set(key, v)
  }
  return v
}

function cacheSet(key: string, v: string): void {
  if (v.length > CACHE_CHARS / 4) return
  const old = cache.get(key)
  if (old !== undefined) {
    cache.delete(key)
    cacheChars -= old.length
  }
  cache.set(key, v)
  cacheChars += v.length
  while (cacheChars > CACHE_CHARS) {
    const [k, val] = cache.entries().next().value as [string, string]
    cache.delete(k)
    cacheChars -= val.length
  }
}

/** Introspection for the memory-cache inventory. */
export function sectionCacheSize(): { entries: number; chars: number } {
  return { entries: cache.size, chars: cacheChars }
}

// ---------------------------------------------------------------------------
// index side
// ---------------------------------------------------------------------------

interface ChunkMetaRow {
  anchor: string
  blockId: string | null
  headingPath: string
  level: number
  tokens: number
  version: string
}

/** Stamp of the current document when the section index provably reflects it, else null. */
async function freshStamp(pageId: string): Promise<string | null> {
  const idx = indexedStamp(pageId)
  if (!idx) return null
  const doc = liveDoc(pageId)
  if (doc) return liveDocStamp(doc) === idx ? idx : null
  const rows = (await db.execute(sql`SELECT updated_at::text AS stamp FROM page_docs WHERE page_id = ${pageId}`)) as unknown as { stamp: string }[]
  return rows[0]?.stamp === idx ? idx : null
}

/**
 * Sections rebuilt from the index rows, or null when the rows cannot stand for the document (at
 * the row bound, or a heading path that does not split as the chunker built it).
 */
export function sectionsFromRows(rows: ChunkMetaRow[]): IndexedSection[] | null {
  if (rows.length >= MAX_CHUNKS_PER_PAGE) return null
  const out: IndexedSection[] = []
  const stack: { level: number; path: string[] }[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.anchor === r.anchor) {
      last.tokens += r.tokens
      continue
    }
    // The heading stack of splitSections: the parent is the nearest earlier heading of a lower level.
    let path: string[] = []
    if (r.level > 0) {
      while (stack.length && stack[stack.length - 1].level >= r.level) stack.pop()
      const parent = stack.length ? stack[stack.length - 1].path : []
      const prefix = parent.length ? `${joinPath(parent)}${PATH_SEP}` : ''
      if (!r.headingPath.startsWith(prefix)) return null
      path = [...parent, r.headingPath.slice(prefix.length)]
      stack.push({ level: r.level, path })
      if (r.blockId === null) return null // a heading without id cannot be located in the document
    } else if (out.length) {
      return null // the intro can only come first
    }
    if (last) last.nextBlockId = r.blockId
    out.push({ anchor: r.anchor, blockId: r.blockId, headingPath: path, level: r.level, tokens: r.tokens, version: r.version, nextBlockId: null })
  }
  return out
}

async function indexedSections(pageId: string): Promise<IndexedSection[] | null> {
  const rows = (await db.execute(sql`
    SELECT anchor, block_id AS "blockId", heading_path AS "headingPath", level, token_estimate AS tokens, section_hash AS version
      FROM page_chunks WHERE page_id = ${pageId} ORDER BY ord
  `)) as unknown as ChunkMetaRow[]
  return sectionsFromRows(rows)
}

// ---------------------------------------------------------------------------
// document side
// ---------------------------------------------------------------------------

/**
 * Blocks of the top-level range [heading `fromId`, heading `toId`) read through BlockNote on a
 * throwaway doc holding clones of just those containers (never reads `doc` itself, which may be the
 * live document). null when the ids are missing or not unique at the top level.
 */
export function rangeBlocks(doc: Y.Doc, fromId: string | null, toId: string | null): AnyBlock[] | null {
  const frag = doc.getXmlFragment('document')
  const group = frag.get(0)
  if (frag.length !== 1 || !(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup') return null
  const top = group.toArray()
  const find = (id: string): number => {
    let at = -1
    for (let i = 0; i < top.length; i++) {
      const el = top[i]
      if (el instanceof Y.XmlElement && el.getAttribute('id') === id) {
        if (at >= 0) return -1 // duplicate id: positions are ambiguous
        at = i
      }
    }
    return at
  }
  const from = fromId === null ? 0 : find(fromId)
  const to = toId === null ? top.length : find(toId)
  if (from < 0 || to < 0 || to < from) return null
  return readTopRange(group, from, to)
}

interface Decoded {
  blocks: AnyBlock[]
  /** Stamp of the stored state the decoded document equals, or null (unsaved live edits, no row). */
  stamp: string | null
  state: Uint8Array | null
}

/** Current blocks: the in-memory document if open (page_docs trails it), else the stored state. */
async function decodeCurrent(pageId: string): Promise<Decoded> {
  const doc = liveDoc(pageId)
  if (doc) {
    const stamp = liveDocStamp(doc)
    const state = Y.encodeStateAsUpdate(doc)
    return { blocks: stateToBlocks(state), stamp, state }
  }
  const rows = (await db.execute(sql`SELECT state, updated_at::text AS stamp FROM page_docs WHERE page_id = ${pageId}`)) as unknown as {
    state: Uint8Array
    stamp: string
  }[]
  const row = rows[0]
  return row ? { blocks: stateToBlocks(row.state), stamp: row.stamp, state: row.state } : { blocks: [], stamp: null, state: null }
}

/**
 * After a decode of an unchanged stored state: if page_chunks equals what that state chunks into,
 * record the stamp (later reads use the index); if not, the index is behind (a pass was lost), so
 * schedule one.
 */
async function adopt(pageId: string, d: Decoded): Promise<void> {
  if (!d.stamp || !d.state || !docIndexIdle(pageId) || indexedStamp(pageId) === d.stamp) return
  const want = chunkBlocks(d.blocks)
  const rows = (await db.execute(sql`SELECT hash FROM page_chunks WHERE page_id = ${pageId} ORDER BY ord`)) as unknown as { hash: string }[]
  if (rows.length === want.length && rows.every((r, i) => r.hash === want[i].hash)) {
    adoptIndexedStamp(pageId, d.stamp)
    sectionSourceStats.adopted++
  } else if (docIndexIdle(pageId)) {
    sectionSourceStats.reindexed++
    void scheduleDocIndex(pageId, d.state, false, d.stamp)
  }
}

function outlineOf(s: { anchor: string; blockId: string | null; headingPath: string[]; level: number; tokens: number; version: string }): OutlineSection {
  return { anchor: s.anchor, blockId: s.blockId, headingPath: s.headingPath, level: s.level, tokens: s.tokens, version: s.version }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/** Sections of a document page (outline). */
export async function readOutline(pageId: string): Promise<OutlineSection[]> {
  if (await freshStamp(pageId)) {
    const sections = await indexedSections(pageId)
    if (sections) {
      sectionSourceStats.outlineIndex++
      return sections.map(outlineOf)
    }
  }
  sectionSourceStats.outlineDecode++
  const d = await decodeCurrent(pageId)
  const sections = splitSections(d.blocks)
  await adopt(pageId, d)
  return sections.map(outlineOf)
}

export type SectionBlocks =
  | { found: true; section: OutlineSection; blocks: AnyBlock[]; stamp: string | null }
  | { found: false; sections: OutlineSection[] }

interface Located {
  stamp: string
  sections: IndexedSection[]
  section: IndexedSection | null
}

/** Resolves `ref` against the index when it is fresh; null → use the decode path. */
async function locate(pageId: string, ref: string): Promise<Located | null> {
  const stamp = await freshStamp(pageId)
  if (!stamp) return null
  const sections = await indexedSections(pageId)
  return sections ? { stamp, sections, section: findSection(sections, ref) } : null
}

/** One section's blocks (by anchor, heading text, heading path or heading block id). */
export async function readSectionBlocks(pageId: string, ref: string, located?: Located | null): Promise<SectionBlocks> {
  const loc = located === undefined ? await locate(pageId, ref) : located
  if (loc) {
    if (!loc.section) return { found: false, sections: loc.sections.map(outlineOf) }
    const blocks = await indexedRange(pageId, loc.stamp, loc.section)
    if (blocks) {
      sectionSourceStats.sectionIndex++
      return { found: true, section: outlineOf(loc.section), blocks, stamp: loc.stamp }
    }
  }
  sectionSourceStats.sectionDecode++
  const d = await decodeCurrent(pageId)
  const sections = splitSections(d.blocks)
  await adopt(pageId, d)
  const s = findSection(sections, ref)
  if (!s) return { found: false, sections: sections.map(outlineOf) }
  return { found: true, section: outlineOf(s), blocks: d.blocks.slice(s.start, s.end), stamp: null }
}

/** The section's blocks from the document the index was built from, or null when it moved on. */
async function indexedRange(pageId: string, stamp: string, s: IndexedSection): Promise<AnyBlock[] | null> {
  const doc = liveDoc(pageId)
  if (doc) {
    // Synchronous from the check to the read: no update can slip in between.
    if (liveDocStamp(doc) !== stamp || indexedStamp(pageId) !== stamp) return null
    return rangeBlocks(doc, s.blockId, s.nextBlockId)
  }
  const rows = (await db.execute(sql`SELECT state, updated_at::text AS stamp FROM page_docs WHERE page_id = ${pageId}`)) as unknown as {
    state: Uint8Array
    stamp: string
  }[]
  if (rows[0]?.stamp !== stamp || indexedStamp(pageId) !== stamp) return null
  const tmp = new Y.Doc()
  try {
    applyStoredState(tmp, rows[0].state)
    return rangeBlocks(tmp, s.blockId, s.nextBlockId)
  } finally {
    tmp.destroy()
  }
}

/** One section as Markdown (the read_page section body). */
export async function readSection(
  pageId: string,
  ref: string,
): Promise<{ found: true; section: OutlineSection; markdown: string } | { found: false; sections: OutlineSection[] }> {
  const loc = await locate(pageId, ref)
  if (loc?.section) {
    // Same stored state, same section: no document read at all.
    const hit = cacheGet(`${pageId}\u0000${loc.stamp}\u0000${loc.section.anchor}`)
    if (hit !== undefined && indexedStamp(pageId) === loc.stamp) {
      sectionSourceStats.cacheHits++
      return { found: true, section: outlineOf(loc.section), markdown: hit }
    }
  }
  const r = await readSectionBlocks(pageId, ref, loc)
  if (!r.found) return r
  const { markdown } = await blocksToMarkdown(r.blocks, { assetMode: 'absolute' })
  const md = markdown.trim()
  if (r.stamp) cacheSet(`${pageId}\u0000${r.stamp}\u0000${r.section.anchor}`, md)
  return { found: true, section: r.section, markdown: md }
}
