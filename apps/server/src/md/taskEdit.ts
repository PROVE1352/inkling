import * as Y from 'yjs'
import { hocuspocus } from '../collab'
import { getServerEditor } from './editor'
import type { AnyBlock } from './convert'
import { findDateToken, formatDateToken, stripToken, todayYmd } from './taskIndex'

/**
 * Edit one task (checklist block) inside a document on the server — toggle done / replace the date token.
 *
 * Safety rules (same path as snapshot restore and pageContent):
 *   - The live doc is touched only through Hocuspocus DirectConnection.transact → changes reach open
 *     editors in real time, and the store hook saves page_docs and reindexes (including page_tasks).
 *   - No new nodes are built by hand. Only the `checked` attribute of the existing checkListItem, or
 *     the date-token characters inside an existing text node (Y.XmlText), change (other blocks, marks and ids untouched).
 *   - The same edit is first tried on a clone (throwaway Y.Doc) and the result verified via the BlockNote
 *     conversion (block count unchanged + target block's checked/date as expected). If that fails, the live doc is untouched.
 */

export type TaskEdit = { checked?: boolean; due?: string }

export class TaskEditError extends Error {
  constructor(
    message: string,
    public code: 'not_found' | 'no_date' | 'verify_failed',
  ) {
    super(message)
  }
}

/** Find the blockContainer whose id is blockId under a fragment (recursing into child blockGroups). */
function findContainer(node: Y.XmlFragment | Y.XmlElement, blockId: string): Y.XmlElement | null {
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === 'blockContainer' && child.getAttribute('id') === blockId) return child
    const found = findContainer(child, blockId)
    if (found) return found
  }
  return null
}

/** Plain text of a Y.XmlText (marks ignored, embeds become a length-1 placeholder). */
function plainOf(t: Y.XmlText): string {
  let s = ''
  for (const op of t.toDelta() as { insert: unknown }[]) {
    s += typeof op.insert === 'string' ? op.insert : '￼'
  }
  return s
}

/** Marks of the character at offset idx (reused for the inserted text). */
function attrsAt(t: Y.XmlText, idx: number): Record<string, unknown> | undefined {
  let pos = 0
  for (const op of t.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1
    if (idx < pos + len) return op.attributes
    pos += len
  }
  return undefined
}

/** Apply the edit to one Y.Doc. Throws (with nothing changed) when the target or the date token is missing. */
function applyEdit(doc: Y.Doc, blockId: string, edit: TaskEdit, today: string): void {
  const frag = doc.getXmlFragment('document')
  const container = findContainer(frag, blockId)
  const item = container?.toArray().find(
    (c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === 'checkListItem',
  )
  if (!container || !item) throw new TaskEditError('Task block not found', 'not_found')

  // Locate the date token first (failing before any change means no half-applied edit).
  let dateEdit: { text: Y.XmlText; index: number; length: number; next: string } | null = null
  if (edit.due !== undefined) {
    const texts = item.toArray().filter((c): c is Y.XmlText => c instanceof Y.XmlText)
    for (const t of texts) {
      const tok = findDateToken(plainOf(t), today)
      if (tok) {
        dateEdit = { text: t, index: tok.index, length: tok.length, next: formatDateToken(edit.due, tok.style, today) }
        break
      }
    }
    if (!dateEdit) throw new TaskEditError('No date found in this task', 'no_date')
  }

  doc.transact(() => {
    if (edit.checked !== undefined && (item.getAttribute('checked') as unknown) !== edit.checked) {
      item.setAttribute('checked', edit.checked as unknown as string)
    }
    if (dateEdit) {
      const attrs = attrsAt(dateEdit.text, dateEdit.index)
      dateEdit.text.delete(dateEdit.index, dateEdit.length)
      dateEdit.text.insert(dateEdit.index, dateEdit.next, attrs)
    }
  })
}

function countBlocks(blocks: AnyBlock[]): number {
  let n = 0
  for (const b of blocks) {
    n++
    if (Array.isArray(b.children)) n += countBlocks(b.children)
  }
  return n
}

function findBlock(blocks: AnyBlock[], id: string): AnyBlock | null {
  for (const b of blocks) {
    if (b.id === id) return b
    if (Array.isArray(b.children)) {
      const f = findBlock(b.children, id)
      if (f) return f
    }
  }
  return null
}

function blockPlain(b: AnyBlock): string {
  if (!Array.isArray(b.content)) return ''
  return (b.content as { type?: string; text?: unknown; content?: unknown }[])
    .map((i) =>
      i.type === 'link' && Array.isArray(i.content)
        ? (i.content as { text?: unknown }[]).map((x) => (typeof x.text === 'string' ? x.text : '')).join('')
        : typeof i.text === 'string'
          ? i.text
          : '',
    )
    .join('')
}

/** Verify the edit result on a clone. Throws on failure. */
function verifyOnClone(live: Y.Doc, blockId: string, edit: TaskEdit, today: string): void {
  const editor = getServerEditor()
  const clone = new Y.Doc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(live))
  const before = editor.yDocToBlocks(clone, 'document') as unknown as AnyBlock[]
  applyEdit(clone, blockId, edit, today)
  const after = editor.yDocToBlocks(clone, 'document') as unknown as AnyBlock[]
  clone.destroy()

  if (countBlocks(before) !== countBlocks(after)) {
    throw new TaskEditError('Edit check failed (block count changed)', 'verify_failed')
  }
  const b = findBlock(after, blockId)
  if (!b || b.type !== 'checkListItem') throw new TaskEditError('Edit check failed (block lost)', 'verify_failed')
  if (edit.checked !== undefined && (b.props?.checked === true) !== edit.checked) {
    throw new TaskEditError('Edit check failed (done state)', 'verify_failed')
  }
  if (edit.due !== undefined) {
    const tok = findDateToken(blockPlain(b), today)
    if (!tok || tok.date !== edit.due) throw new TaskEditError('Edit check failed (date)', 'verify_failed')
    // Text other than the date must stay the same
    const prev = findBlock(before, blockId)
    const prevTok = prev ? findDateToken(blockPlain(prev), today) : null
    if (!prev || !prevTok || stripToken(blockPlain(prev), prevTok) !== stripToken(blockPlain(b), tok)) {
      throw new TaskEditError('Edit check failed (text changed)', 'verify_failed')
    }
  }
}

/**
 * Edit a task block in the live doc. On success, returns after the store hook has saved and reindexed.
 * (DirectConnection.transact runs storeDocumentHooks immediately after the edit.)
 */
export async function editTaskInDoc(pageId: string, blockId: string, edit: TaskEdit): Promise<void> {
  const today = todayYmd()
  const conn = await hocuspocus.openDirectConnection(pageId)
  try {
    // 1) Verify on a clone of the live doc first — if this throws, the live doc is not changed at all.
    if (!conn.document) throw new TaskEditError('Could not open the document', 'not_found')
    verifyOnClone(conn.document, blockId, edit, today)
    // 2) Same edit on the live doc (synchronous callback — no other update can slip in after the check).
    let failure: unknown = null
    await conn.transact((doc) => {
      try {
        applyEdit(doc, blockId, edit, today)
      } catch (err) {
        // Don't throw out of the transact callback; keep the error and rethrow outside.
        failure = err
      }
    })
    if (failure) throw failure
  } finally {
    await conn.disconnect()
  }
}
