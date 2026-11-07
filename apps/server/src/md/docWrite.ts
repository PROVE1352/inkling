import * as Y from 'yjs'
import { hocuspocus } from '../collab'
import { blocksToStateBuffer, blocksToXmlFragment } from './convert'
import type { AnyBlock } from './convert'
import { getServerEditor } from './editor'
import { readBlocks } from '../context/sectionPatch'

/**
 * Replace or append blocks in a live doc — the same safe path as snapshot restore.
 *   - Never builds Yjs fragments by hand (only the BlockNote conversion blocksToXmlFragment).
 *   - DirectConnection.transact → live propagation to clients viewing it + store hooks (save, reindex).
 *   - append replaces the doc with the existing blocks (ids kept → comment anchors preserved) followed by the new ones.
 *   - Full convertibility is checked first on a throwaway doc → on failure the live doc is untouched.
 * Returns: the document blocks after the edit (for the caller to reindex right away).
 */
export async function writeBlocksToDoc(
  pageId: string,
  incoming: AnyBlock[],
  mode: 'replace' | 'append',
): Promise<AnyBlock[]> {
  if (mode === 'append') {
    // Append must never rewrite existing blocks: reading them through the server schema and writing
    // them back drops callouts, page embeds and @mentions. Only an empty doc is replaced.
    if (!(await isEffectivelyEmpty(pageId))) {
      if (incoming.length === 0) return readPageBlocks(pageId)
      return appendBlocksToDoc(pageId, incoming)
    }
  }
  let result: AnyBlock[] = []
  const conn = await hocuspocus.openDirectConnection(pageId)
  try {
    await conn.transact((doc) => {
      const frag = doc.getXmlFragment('document')
      let next: AnyBlock[] = incoming
      if (next.length === 0) next = [{ type: 'paragraph', content: [] }]
      // Check full conversion first (throwaway doc) — if this throws, the live doc is untouched.
      blocksToStateBuffer(next)
      // Delete + insert in one Yjs transaction so clients receive a single update
      doc.transact(() => {
        frag.delete(0, frag.length)
        blocksToXmlFragment(next, frag)
      })
      // Read a copy: yDocToBlocks on the live doc deletes nodes the server schema does not know.
      result = readBlocks(doc)
    })
  } finally {
    await conn.disconnect()
  }
  return result
}

function countTop(frag: Y.XmlFragment): number {
  const group = frag.get(0)
  return group instanceof Y.XmlElement && group.nodeName === 'blockGroup' ? group.length : 0
}

/** Append clones of BlockNote-built blockContainers to the end of a Y.Doc's top-level blockGroup. */
function appendContainers(doc: Y.Doc, incoming: AnyBlock[]): void {
  const frag = doc.getXmlFragment('document')
  if (frag.length === 0) {
    // A new doc never edited — nothing to lose, so fill it directly via the BlockNote conversion.
    blocksToXmlFragment(incoming, frag)
    return
  }
  const group = frag.get(0)
  if (!(group instanceof Y.XmlElement) || group.nodeName !== 'blockGroup' || frag.length !== 1) {
    throw new Error('Unexpected document structure; nothing was appended')
  }
  // Deep-clone the Y structure BlockNote built (throwaway doc) and insert it — never assemble nodes by hand.
  const editor = getServerEditor()
  const tmp = editor.blocksToYDoc(
    incoming as unknown as Parameters<typeof editor.blocksToYDoc>[0],
    'document',
  )
  const tmpGroup = tmp.getXmlFragment('document').get(0)
  if (!(tmpGroup instanceof Y.XmlElement) || tmpGroup.nodeName !== 'blockGroup') {
    throw new Error('Failed to convert the blocks to append')
  }
  const clones = tmpGroup.toArray().map((c) => (c as Y.XmlElement).clone())
  group.insert(group.length, clones)
  tmp.destroy()
}

/**
 * Only *append* blocks to the end of a live doc (existing blocks are not rewritten at all).
 *
 * writeBlocksToDoc(append) reads the existing blocks through the server schema and rewrites everything,
 * so callouts, page embeds and @mentions the server schema lacks get lost on the way. Paths that append
 * to the same doc often, like quick task add, use this function: it only inserts clones of the BlockNote
 * conversion at the end of the top-level blockGroup. It is tried on a cloned doc first (block count =
 * existing + appended, existing blocks unchanged) and applied live only if that passes.
 * Returns: the document blocks after the edit (for immediate reindexing).
 */
export async function appendBlocksToDoc(pageId: string, incoming: AnyBlock[]): Promise<AnyBlock[]> {
  if (incoming.length === 0) throw new Error('No blocks to append')
  const editor = getServerEditor()
  const conn = await hocuspocus.openDirectConnection(pageId)
  let result: AnyBlock[] = []
  try {
    const live = conn.document
    if (!live) throw new Error('Could not open the document')
    // 1) Verify on a clone
    const clone = new Y.Doc()
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(live))
    const before = editor.yDocToBlocks(clone, 'document') as unknown as AnyBlock[]
    const topBefore = countTop(clone.getXmlFragment('document'))
    appendContainers(clone, incoming)
    const after = editor.yDocToBlocks(clone, 'document') as unknown as AnyBlock[]
    const topAfter = countTop(clone.getXmlFragment('document'))
    clone.destroy()
    if (topAfter !== topBefore + incoming.length) throw new Error('Append check failed (block count)')
    if (JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) {
      throw new Error('Append check failed (existing content changed)')
    }
    // 2) Apply live (same synchronous section as the check)
    let failure: unknown = null
    await conn.transact((doc) => {
      try {
        doc.transact(() => appendContainers(doc, incoming))
        result = readBlocks(doc)
      } catch (err) {
        failure = err
      }
    })
    if (failure) throw failure
  } finally {
    await conn.disconnect()
  }
  return result
}

/** Blocks of a page, read from a copy of the live doc (never mutates it). */
async function readPageBlocks(pageId: string): Promise<AnyBlock[]> {
  const conn = await hocuspocus.openDirectConnection(pageId)
  try {
    const live = conn.document
    if (!live) throw new Error('Could not open the document')
    return readBlocks(live)
  } finally {
    await conn.disconnect()
  }
}

/** True for a never-edited doc or one holding only a single empty paragraph. */
async function isEffectivelyEmpty(pageId: string): Promise<boolean> {
  const conn = await hocuspocus.openDirectConnection(pageId)
  try {
    const live = conn.document
    if (!live) throw new Error('Could not open the document')
    if (live.getXmlFragment('document').length === 0) return true
    const blocks = readBlocks(live)
    return (
      blocks.length === 1 &&
      blocks[0].type === 'paragraph' &&
      (!Array.isArray(blocks[0].content) || blocks[0].content.length === 0) &&
      (!Array.isArray(blocks[0].children) || blocks[0].children.length === 0)
    )
  } finally {
    await conn.disconnect()
  }
}
