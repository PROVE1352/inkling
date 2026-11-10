import * as Y from 'yjs'
import { hocuspocus } from '../collab'
import { blocksToStateBuffer, blocksToXmlFragment } from './convert'
import type { AnyBlock } from './convert'
import { getServerEditor } from './editor'
import { applyDocumentReplace, readBlocks } from '../context/sectionPatch'
import type { EchoIndex } from '../context/sectionPatch'
import type { DocGate } from '../docWriteGate'
import { bumpDocGen } from '../docGen'

type DirectConnection = Awaited<ReturnType<typeof hocuspocus.openDirectConnection>>

/**
 * `conn.transact(fn)`, with `fn` applied inside `gate` when given (docs/adr/1150-*). DirectConnection
 * applies `fn` synchronously when `transact` is called and then awaits the store hooks; the gate's
 * transaction ends right after the apply and the store is awaited outside it, so the gate never
 * holds a pool connection while the store waits for one.
 */
export async function gatedTransact(conn: DirectConnection, fn: (doc: Y.Doc) => void, gate?: DocGate): Promise<void> {
  if (!gate) return conn.transact(fn)
  let stored: Promise<void> | undefined
  try {
    await gate(() => {
      stored = conn.transact(fn)
    })
  } catch (err) {
    // The gate refused (nothing applied), or failed after the apply: settle the store either way.
    await stored?.catch(() => undefined)
    throw err
  }
  await stored
}

/**
 * Replace or append blocks in a live doc — the same safe path as snapshot restore.
 *   - replace of a document that has content is a minimal edit of the whole document
 *     (`applyDocumentReplace`, docs/adr/1500-*): blocks the new content leaves alone keep their
 *     ids, colors, toggles and concurrent typing; `echo` (buildEchoIndex of the blocks the caller
 *     read) lets them be recognized through the lossy Markdown round trip. If that edit does not
 *     validate, the document is rewritten as before.
 *   - Never builds Yjs fragments by hand (only the BlockNote conversion blocksToXmlFragment).
 *   - DirectConnection.transact → live propagation to clients viewing it + store hooks (save, reindex).
 *   - append only inserts the new blocks after the existing ones (existing blocks are never read
 *     back or rewritten, so callouts, embeds and @mentions survive); only an empty doc is replaced.
 *   - Full convertibility is checked first on a throwaway doc → on failure the live doc is untouched.
 * One DirectConnection per call (docs/adr/1042-*): the emptiness check, the edit and the store
 * share it. The store hook indexes the result before this returns.
 */
export async function writeBlocksToDoc(
  pageId: string,
  incoming: AnyBlock[],
  mode: 'replace' | 'append',
  gate?: DocGate,
  echo: EchoIndex | null = null,
): Promise<void> {
  const conn = await hocuspocus.openDirectConnection(pageId)
  // a full rewrite of a non-empty body bumps the generation once it is applied (docs/adr/2201-*)
  let rewrote = false
  try {
    const live = conn.document
    if (!live) throw new Error('Could not open the document')
    // Append must never rewrite existing blocks: reading them through the server schema and writing
    // them back drops callouts, page embeds and @mentions. Only an empty doc is replaced.
    if (mode === 'append' && !isEffectivelyEmpty(live)) {
      if (incoming.length === 0) return
      await appendOnConnection(conn, incoming, false, gate)
      return
    }
    await gatedTransact(conn, (doc) => {
      const frag = doc.getXmlFragment('document')
      let next: AnyBlock[] = incoming
      if (next.length === 0) next = [{ type: 'paragraph', content: [] }]
      // Check full conversion first (throwaway doc) — if this throws, the live doc is untouched.
      blocksToStateBuffer(next)
      if (mode === 'replace' && frag.length > 0) {
        try {
          applyDocumentReplace(doc, next, echo)
          return
        } catch (err) {
          // nothing was written (the edit is validated on a copy first); rewrite as before
          console.warn(`[update_page] minimal replace not applied (${err instanceof Error ? err.message : String(err)}); rewriting the document`)
        }
      }
      // Delete + insert in one Yjs transaction so clients receive a single update
      rewrote = frag.length > 0
      doc.transact(() => {
        frag.delete(0, frag.length)
        blocksToXmlFragment(next, frag)
      })
    }, gate)
  } finally {
    await conn.disconnect()
  }
  if (rewrote) await bumpDocGen(pageId)
}

function isBlockGroup(x: unknown): x is Y.XmlElement {
  return x instanceof Y.XmlElement && x.nodeName === 'blockGroup'
}

/**
 * Inserts clones of BlockNote-built blockContainers after the last top-level block (never assembles
 * nodes by hand). The new blocks are verified on their own throwaway doc first: BlockNote must build
 * one container per block and be able to read them. Existing blocks are not read: inserting at the
 * end of the top-level group cannot change them (docs/adr/1042-*); count and identity are asserted
 * after the insert.
 * Returns the document blocks after the edit when `readBack` (a full read; only callers that index
 * by themselves need it).
 */
async function appendOnConnection(conn: DirectConnection, incoming: AnyBlock[], readBack: boolean, gate?: DocGate): Promise<AnyBlock[]> {
  const editor = getServerEditor()
  const tmp = editor.blocksToYDoc(incoming as unknown as Parameters<typeof editor.blocksToYDoc>[0], 'document')
  let result: AnyBlock[] = []
  try {
    const tmpGroup = tmp.getXmlFragment('document').get(0)
    if (!isBlockGroup(tmpGroup)) throw new Error('Failed to convert the blocks to append')
    const els = tmpGroup.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === 'blockContainer')
    if (els.length !== incoming.length) throw new Error('Append check failed (block count)')
    // The new blocks must read back through BlockNote (throws on content the server cannot read).
    readBlocks(tmp)
    let failure: unknown = null
    await gatedTransact(conn, (doc) => {
      try {
        const frag = doc.getXmlFragment('document')
        if (frag.length === 0) {
          // A new doc never edited — nothing to lose, so fill it directly via the BlockNote conversion.
          doc.transact(() => blocksToXmlFragment(incoming, frag))
        } else {
          const group = frag.get(0)
          if (!isBlockGroup(group) || frag.length !== 1) throw new Error('Unexpected document structure; nothing was appended')
          const at = group.length
          const clones = els.map((c) => c.clone())
          doc.transact(() => group.insert(at, clones))
          if (group.length !== at + clones.length || clones.some((c, i) => group.get(at + i) !== c)) {
            throw new Error('Append check failed (block count)')
          }
        }
        if (readBack) result = readBlocks(doc)
      } catch (err) {
        failure = err
      }
    }, gate)
    if (failure) throw failure
  } finally {
    tmp.destroy()
  }
  return result
}

/**
 * Only *append* blocks to the end of a live doc (existing blocks are not rewritten at all).
 *
 * writeBlocksToDoc(replace) reads nothing back and rewrites everything, so callouts, page embeds and
 * @mentions the server schema lacks get lost on the way. Paths that append to the same doc often,
 * like quick task add, use this function: it only inserts clones of the BlockNote conversion at the
 * end of the top-level blockGroup, after checking the new blocks on a throwaway doc.
 * Returns: the document blocks after the edit (for immediate reindexing).
 */
export async function appendBlocksToDoc(pageId: string, incoming: AnyBlock[]): Promise<AnyBlock[]> {
  if (incoming.length === 0) throw new Error('No blocks to append')
  const conn = await hocuspocus.openDirectConnection(pageId)
  try {
    if (!conn.document) throw new Error('Could not open the document')
    return await appendOnConnection(conn, incoming, true)
  } finally {
    await conn.disconnect()
  }
}

/**
 * True for a never-edited doc or one holding only a single empty paragraph. A doc with more than
 * one top-level container is never empty, so a large document is not read here.
 */
function isEffectivelyEmpty(live: Y.Doc): boolean {
  const frag = live.getXmlFragment('document')
  if (frag.length === 0) return true
  const group = frag.get(0)
  if (frag.length === 1 && isBlockGroup(group) && group.length > 1) return false
  const blocks = readBlocks(live)
  return (
    blocks.length === 1 &&
    blocks[0].type === 'paragraph' &&
    (!Array.isArray(blocks[0].content) || blocks[0].content.length === 0) &&
    (!Array.isArray(blocks[0].children) || blocks[0].children.length === 0)
  )
}
