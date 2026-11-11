// Column edits (docs/adr/2420-*, 2421-*). Part of the editor chunk.
//
// Every change to a group of columns is one ProseMirror transaction written here, never BlockNote's
// replaceBlocks/removeBlocks on blocks inside a column: those run core's fixColumnList, which deletes
// every column that holds only an empty line and dissolves a group left with one column — a group
// made with /2단 lost its empty second column the first time a block in the first one was replaced.
// `columnSafeBlockEdits` routes the editor's own replaceBlocks/removeBlocks through `replaceInColumns`
// for blocks inside a column, so the side menu's Delete, ⌘⇧↑/↓, link pastes and slash inserts keep
// the columns as they are. Nothing tidies a group by itself; Backspace in a group whose columns are all
// empty removes it.
import { blockToNode, nodeToBlock } from '@blocknote/core'
import { COLUMN_LIST_TYPE, COLUMN_TYPE, MAX_COLUMNS, pctToWeights } from '@inkling/shared'

/** The parts of a ProseMirror node used here (no prosemirror-model import in the web package). */
export interface PMNode {
  type: { name: string }
  attrs: Record<string, unknown>
  childCount: number
  nodeSize: number
  content: { size: number }
  isTextblock: boolean
  textContent: string
  firstChild: PMNode | null
  lastChild: PMNode | null
  child(i: number): PMNode
  forEach(f: (n: PMNode, offset: number, index: number) => void): void
  descendants(f: (n: PMNode, pos: number) => boolean | void): void
  resolve(pos: number): ResolvedPos
}
export interface ResolvedPos {
  depth: number
  pos: number
  parent: PMNode
  node(depth?: number): PMNode
  index(depth?: number): number
  before(depth?: number): number
  start(depth?: number): number
}
interface Tr {
  doc: PMNode
  insert(pos: number, content: PMNode | PMNode[]): Tr
  delete(from: number, to: number): Tr
  replaceWith(from: number, to: number, content: PMNode | PMNode[]): Tr
  setNodeAttribute(pos: number, attr: string, value: unknown): Tr
}
interface Block {
  id: string
  type: string
  content?: unknown
  children?: Block[]
}
/** The parts of BlockNote's editor used here. */
export interface ColumnsEditor {
  pmSchema: { nodes: Record<string, { create(attrs?: Record<string, unknown> | null, content?: PMNode | PMNode[]): PMNode }> }
  prosemirrorState: { doc: PMNode; selection: { empty: boolean; from: number; to: number; $from: ResolvedPos } }
  transact<T>(fn: (tr: Tr) => T): T
  setTextCursorPosition(id: string, placement?: 'start' | 'end'): void
  getTextCursorPosition(): { block: Block }
  getBlock(id: string): Block | undefined
  insertBlocks(blocks: unknown[], ref: string, placement: 'before' | 'after'): Block[]
  replaceBlocks(remove: (string | Block)[], insert: unknown[]): { insertedBlocks: Block[]; removedBlocks: Block[] }
  removeBlocks(remove: (string | Block)[]): Block[]
}

// ---------------------------------------------------------------------------
// finding things
// ---------------------------------------------------------------------------

export function findById(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null
  doc.descendants((n, pos) => {
    if (found) return false
    if (n.attrs?.id === id) {
      found = { node: n, pos }
      return false
    }
    return true
  })
  return found
}

/** The nearest column around position `pos` (`pos` inside it), with its group. */
export function columnAt(doc: PMNode, pos: number): { column: PMNode; columnPos: number; list: PMNode; listPos: number; index: number } | null {
  const $p = doc.resolve(pos)
  for (let d = $p.depth; d > 0; d--) {
    if ($p.node(d).type.name !== COLUMN_TYPE) continue
    const list = $p.node(d - 1)
    if (list.type.name !== COLUMN_LIST_TYPE) return null
    return { column: $p.node(d), columnPos: $p.before(d), list, listPos: $p.before(d - 1), index: $p.index(d - 1) }
  }
  return null
}

/** The column that holds block `id` (directly or nested), or null. */
export function columnOfBlock(doc: PMNode, id: string) {
  const f = findById(doc, id)
  return f ? columnAt(doc, f.pos + 1) : null
}

export function selectionInColumn(editor: ColumnsEditor): boolean {
  const { selection, doc } = editor.prosemirrorState
  return !!columnAt(doc, selection.from)
}

function isEmptyParagraphContainer(n: PMNode): boolean {
  return n.type.name === 'blockContainer' && n.childCount === 1 && n.firstChild!.type.name === 'paragraph' && n.firstChild!.content.size === 0
}

/** A column whose only block is an empty line. */
export function isEmptyColumn(col: PMNode): boolean {
  return col.childCount === 1 && isEmptyParagraphContainer(col.firstChild!)
}

function emptyParagraph(editor: ColumnsEditor): PMNode {
  return blockToNode({ type: 'paragraph' } as never, editor.pmSchema as never) as unknown as PMNode
}

function childrenOf(n: PMNode): PMNode[] {
  const out: PMNode[] = []
  n.forEach((c) => out.push(c))
  return out
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * /2단 /3단: an empty group of `n` columns. On an empty line the line becomes the group, otherwise the
 * group goes below the caret's top-level block; the caret goes to the first column. Refused inside a
 * column (no columns in columns). Returns the first column's line id, or null.
 */
export function insertColumns(editor: ColumnsEditor, n: number): string | null {
  if (selectionInColumn(editor)) return null
  const count = Math.max(2, Math.min(MAX_COLUMNS, n))
  const group = { type: COLUMN_LIST_TYPE, children: Array.from({ length: count }, () => ({ type: COLUMN_TYPE, children: [{ type: 'paragraph' }] })) }
  const cur = editor.getTextCursorPosition().block
  const { doc } = editor.prosemirrorState
  const at = findById(doc, cur.id)
  // a nested line (inside a list item, a toggle): the group goes after its top-level block
  const $at = at ? doc.resolve(at.pos) : null
  const top = $at && $at.depth > 1 ? String($at.node(2).attrs.id ?? cur.id) : cur.id
  const empty = top === cur.id && cur.type === 'paragraph' && Array.isArray(cur.content) && cur.content.length === 0 && !cur.children?.length
  const inserted = empty ? editor.replaceBlocks([cur.id], [group]).insertedBlocks[0] : editor.insertBlocks([group], top, 'after')[0]
  const first = inserted?.children?.[0]?.children?.[0]?.id
  if (first) editor.setTextCursorPosition(first, 'start')
  return first ?? null
}

/** A new empty column at the end of the group (at most MAX_COLUMNS); the caret goes into it. */
export function addColumn(editor: ColumnsEditor, listId: string): string | null {
  const para = emptyParagraph(editor)
  const ok = editor.transact((tr) => {
    const f = findById(tr.doc, listId)
    if (!f || f.node.type.name !== COLUMN_LIST_TYPE || f.node.childCount >= MAX_COLUMNS) return false
    tr.insert(f.pos + f.node.nodeSize - 1, editor.pmSchema.nodes[COLUMN_TYPE].create({}, [para]))
    return true
  })
  if (!ok) return null
  const id = String(para.attrs.id)
  editor.setTextCursorPosition(id, 'start')
  return id
}

/**
 * Deletes a column. Its blocks go to the end of the column on its left (the first column's to the
 * start of the next one); an empty column moves nothing. A group left with one column is unwrapped.
 */
export function deleteColumn(editor: ColumnsEditor, columnId: string): void {
  let caret: string | null = null
  editor.transact((tr) => {
    const f = findById(tr.doc, columnId)
    if (!f || f.node.type.name !== COLUMN_TYPE) return
    const $c = tr.doc.resolve(f.pos)
    const list = $c.parent
    const listPos = $c.before()
    const index = $c.index()
    const moved = isEmptyColumn(f.node) ? [] : childrenOf(f.node)
    if (list.childCount <= 2) {
      // what remains is one column: its blocks, then (or before) the moved ones, as top-level blocks
      const other = childrenOf(list.child(index === 0 ? 1 : 0))
      const otherBlocks = other.length === 1 && isEmptyParagraphContainer(other[0]) && moved.length ? [] : other
      const nodes = index === 0 ? [...moved, ...otherBlocks] : [...otherBlocks, ...moved]
      tr.replaceWith(listPos, listPos + list.nodeSize, nodes.length ? nodes : [emptyParagraph(editor)])
      caret = String((moved[0] ?? nodes[0])?.attrs.id ?? '') || null
      return
    }
    const targetIndex = index === 0 ? 1 : index - 1
    let targetPos = listPos + 1
    for (let i = 0; i < targetIndex; i++) targetPos += list.child(i).nodeSize
    const target = list.child(targetIndex)
    // delete first (it is after the target when moving left, before it when moving right)
    tr.delete(f.pos, f.pos + f.node.nodeSize)
    if (index === 0) targetPos -= f.node.nodeSize
    if (moved.length) {
      if (isEmptyColumn(target)) tr.replaceWith(targetPos + 1, targetPos + target.nodeSize - 1, moved)
      else tr.insert(index === 0 ? targetPos + 1 : targetPos + target.nodeSize - 1, moved)
      caret = String(moved[0].attrs.id ?? '') || null
    }
  })
  if (caret) safeCaret(editor, caret, 'start')
}

/** The group's blocks, column after column, as ordinary blocks (empty placeholder lines dropped). */
export function unwrapColumns(editor: ColumnsEditor, listId: string): void {
  let caret: string | null = null
  editor.transact((tr) => {
    const f = findById(tr.doc, listId)
    if (!f || f.node.type.name !== COLUMN_LIST_TYPE) return
    const nodes: PMNode[] = []
    f.node.forEach((col) => {
      if (!isEmptyColumn(col)) col.forEach((b) => nodes.push(b))
    })
    tr.replaceWith(f.pos, f.pos + f.node.nodeSize, nodes.length ? nodes : [emptyParagraph(editor)])
    caret = String((nodes[0] ?? null)?.attrs.id ?? '') || null
  })
  if (caret) safeCaret(editor, caret, 'start')
}

/** Column widths from whole percentages (a resize) — one transaction, one undo step. */
export function setColumnPercents(editor: ColumnsEditor, listId: string, pct: number[]): void {
  const weights = pctToWeights(pct)
  editor.transact((tr) => {
    const f = findById(tr.doc, listId)
    if (!f || f.node.childCount !== weights.length) return
    let pos = f.pos + 1
    f.node.forEach((col, _o, i) => {
      if (Number(col.attrs.width) !== weights[i]) tr.setNodeAttribute(pos, 'width', weights[i])
      pos += col.nodeSize
    })
  })
}

export function equalizeColumns(editor: ColumnsEditor, listId: string): void {
  const f = findById(editor.prosemirrorState.doc, listId)
  if (f) setColumnPercents(editor, listId, Array.from({ length: f.node.childCount }, () => 1))
}

function safeCaret(editor: ColumnsEditor, id: string, placement: 'start' | 'end'): void {
  try {
    editor.setTextCursorPosition(id, placement)
  } catch {
    // a block without inline content (image, table): leave the caret where ProseMirror mapped it
  }
}

// ---------------------------------------------------------------------------
// keys (docs/adr/2421-*)
// ---------------------------------------------------------------------------

/** The caret's block when it is a direct child of a column, with where the caret is in it. */
function caretInColumn(editor: ColumnsEditor) {
  const { selection, doc } = editor.prosemirrorState
  if (!selection.empty) return null
  const $from = selection.$from
  // depth: … column > blockContainer > blockContent(textblock)
  if ($from.depth < 3 || !$from.parent.isTextblock) return null
  const container = $from.node($from.depth - 1)
  const column = $from.node($from.depth - 2)
  if (container.type.name !== 'blockContainer' || column.type.name !== COLUMN_TYPE) return null
  const info = columnAt(doc, $from.pos)
  if (!info) return null
  return {
    info,
    container,
    atStart: $from.pos === $from.start(),
    atEnd: $from.pos === $from.start() + $from.parent.content.size,
    isParagraph: $from.parent.type.name === 'paragraph',
    indexInColumn: $from.index($from.depth - 2),
  }
}

/** The last block with text in `n` (itself included). */
function lastTextBlockId(n: PMNode): string | null {
  let id: string | null = n.type.name === 'blockContainer' && n.firstChild?.isTextblock ? String(n.attrs.id) : null
  n.descendants((c) => {
    if (c.type.name === 'blockContainer' && c.firstChild?.isTextblock) id = String(c.attrs.id)
    return true
  })
  return id
}

/** The first block with text in `n` (itself included). */
function firstTextBlockId(n: PMNode): string | null {
  let id: string | null = n.type.name === 'blockContainer' && n.firstChild?.isTextblock ? String(n.attrs.id) : null
  n.descendants((c) => {
    if (id) return false
    if (c.type.name === 'blockContainer' && c.firstChild?.isTextblock) id = String(c.attrs.id)
    return true
  })
  return id
}

function removeEmptyGroup(editor: ColumnsEditor, listId: string): boolean {
  const para = emptyParagraph(editor)
  editor.transact((tr) => {
    const f = findById(tr.doc, listId)
    if (f) tr.replaceWith(f.pos, f.pos + f.node.nodeSize, para)
  })
  safeCaret(editor, String(para.attrs.id), 'start')
  return true
}

/**
 * Backspace at the start of the first line of a column (before core's handler, which would move the
 * line out of the column and remove every empty column). A group whose columns are all empty goes;
 * otherwise nothing moves: the caret goes to the end of the column on the left (or the block above
 * the group). Other Backspaces (and non-paragraph lines, which core first turns into paragraphs) are
 * left to BlockNote.
 */
export function columnBackspace(editor: ColumnsEditor): boolean {
  const c = caretInColumn(editor)
  if (!c || !c.atStart || !c.isParagraph || c.indexInColumn !== 0) return false
  const { list, listPos, index } = c.info
  let allEmpty = true
  list.forEach((col) => {
    if (!isEmptyColumn(col)) allEmpty = false
  })
  if (allEmpty) return removeEmptyGroup(editor, String(list.attrs.id))
  if (index > 0) {
    const id = lastTextBlockId(list.child(index - 1))
    if (id) safeCaret(editor, id, 'end')
    return true
  }
  const doc = editor.prosemirrorState.doc
  const $l = doc.resolve(listPos)
  const before = $l.index() > 0 ? $l.parent.child($l.index() - 1) : null
  const id = before ? lastTextBlockId(before) : null
  if (id) safeCaret(editor, id, 'end')
  return true
}

/** Delete at the end of a column's last line, or at the end of the line right before a group: the caret moves, nothing else. */
export function columnDelete(editor: ColumnsEditor): boolean {
  const { selection, doc } = editor.prosemirrorState
  const c = caretInColumn(editor)
  if (c) {
    if (!c.atEnd || c.indexInColumn !== c.info.column.childCount - 1) return false
    const { list, listPos, index } = c.info
    let allEmpty = true
    list.forEach((col) => {
      if (!isEmptyColumn(col)) allEmpty = false
    })
    if (allEmpty) return removeEmptyGroup(editor, String(list.attrs.id))
    const next = index + 1 < list.childCount ? list.child(index + 1) : null
    let id = next ? firstTextBlockId(next) : null
    if (!next) {
      const $l = doc.resolve(listPos)
      const after = $l.index() + 1 < $l.parent.childCount ? $l.parent.child($l.index() + 1) : null
      id = after ? firstTextBlockId(after) : null
    }
    if (id) safeCaret(editor, id, 'start')
    return true
  }
  // the line right before a group: core would pull the first column's first block out of it
  if (!selection.empty || !selection.$from.parent.isTextblock) return false
  const $f = selection.$from
  if ($f.pos !== $f.start() + $f.parent.content.size || $f.depth < 2) return false
  const containerDepth = $f.depth - 1
  const $c = doc.resolve($f.before(containerDepth))
  const next = $c.index() + 1 < $c.parent.childCount ? $c.parent.child($c.index() + 1) : null
  if (!next || next.type.name !== COLUMN_LIST_TYPE) return false
  const id = firstTextBlockId(next)
  if (id) safeCaret(editor, id, 'start')
  return true
}

// ---------------------------------------------------------------------------
// replaceBlocks / removeBlocks without core's column cleanup
// ---------------------------------------------------------------------------

const idOf = (b: string | Block) => (typeof b === 'string' ? b : b.id)

/**
 * replaceBlocks for blocks of which at least one is inside a column: the replacements go where the
 * first removed block was, the removed blocks go, and a column that would be left without a block
 * keeps an empty line. No column or group is removed.
 */
export function replaceInColumns(editor: ColumnsEditor, remove: (string | Block)[], insert: unknown[]): { insertedBlocks: Block[]; removedBlocks: Block[] } {
  const ids = remove.map(idOf)
  const removedBlocks = ids.map((id) => editor.getBlock(id)).filter((b): b is Block => !!b)
  const nodes = insert.map((b) => blockToNode(b as never, editor.pmSchema as never) as unknown as PMNode)
  editor.transact((tr) => {
    const first = findById(tr.doc, ids[0])
    if (!first) return
    if (nodes.length) tr.insert(first.pos, nodes)
    for (const id of ids) {
      const f = findById(tr.doc, id)
      if (!f) continue
      const $f = tr.doc.resolve(f.pos)
      if ($f.parent.type.name === COLUMN_TYPE && $f.parent.childCount === 1) tr.replaceWith(f.pos, f.pos + f.node.nodeSize, emptyParagraph(editor))
      else tr.delete(f.pos, f.pos + f.node.nodeSize)
    }
  })
  const schema = editor.pmSchema as never
  return { insertedBlocks: nodes.map((n) => nodeToBlock(n as never, schema) as unknown as Block), removedBlocks }
}

/** Makes the editor's replaceBlocks / removeBlocks column-safe (see the module comment). */
export function columnSafeBlockEdits(editor: ColumnsEditor): void {
  const touches = (remove: (string | Block)[]) => {
    const doc = editor.prosemirrorState.doc
    return remove.some((b) => !!columnOfBlock(doc, idOf(b)) && findById(doc, idOf(b))?.node.type.name === 'blockContainer')
  }
  const replace = editor.replaceBlocks.bind(editor)
  const removeOrig = editor.removeBlocks.bind(editor)
  editor.replaceBlocks = (remove, insert) => (touches(remove) ? replaceInColumns(editor, remove, insert) : replace(remove, insert))
  editor.removeBlocks = (remove) => (touches(remove) ? replaceInColumns(editor, remove, []).removedBlocks : removeOrig(remove))
}

/**
 * Pasted HTML that holds a group, pasted inside a column: the column wrappers are dropped so the
 * blocks arrive one after another (no columns in columns). Null when there is nothing to change.
 */
export function flattenColumnHtml(html: string, parse: (html: string) => Document): string | null {
  if (!/data-node-type="?(columnList|column)/.test(html)) return null
  const doc = parse(html)
  for (const el of Array.from(doc.querySelectorAll('[data-node-type="columnList"], [data-node-type="column"]')).reverse()) {
    el.replaceWith(...Array.from(el.childNodes))
  }
  return doc.body.innerHTML
}

export { MAX_COLUMNS }
