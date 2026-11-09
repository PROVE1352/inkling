// Typing a table quickly in the page editor (docs/adr/1642-*). Part of the editor chunk (imports BlockNote).
//
// - tableQuickInput(): a BlockNote extension. Enter at the end of a paragraph whose whole text is a pipe
//   row ("| 이름 | 역할 | 마감 |") turns the paragraph into a table: those cells as the header row and one
//   empty row, caret in the first cell of the empty row. One ⌘Z gives the typed text back.
// - insertSizedTable(): an empty table of a given size where the caret is (the "/표 3x4" slash item and
//   the "Insert table" palette command).
//
// Like inklingShortcuts (docs/adr/1406-*) it listens for keydown on the editor's element in the capture
// phase, before ProseMirror's keymaps, and leaves the key alone unless every condition holds.
import { createExtension } from '@blocknote/core'
import type { InklingEditor } from '../components/CollabEditor'
import { isImeEnter, parsePipeRow } from './tableInput'
import { targetKind } from './shortcuts/keys'
import { stopUndoCapture } from './undoCap'

type PMNode = {
  type: { name: string }
  attrs: Record<string, unknown>
  nodeSize: number
  childCount: number
  firstChild: PMNode | null
  child(i: number): PMNode
  descendants(f: (n: PMNode, pos: number) => boolean | void): void
}
type TipTapLike = { commands: { setTextSelection(pos: number): boolean } }

/** Document position inside the text of cell (row, col) of the table block `blockId`, or null. */
function cellTextPos(doc: PMNode, blockId: string, row: number, col: number): number | null {
  let at = -1
  let container: PMNode | null = null
  doc.descendants((n, pos) => {
    if (container) return false
    if (n.type.name === 'blockContainer' && n.attrs.id === blockId) {
      container = n
      at = pos
      return false
    }
    return true
  })
  const table = (container as PMNode | null)?.firstChild
  if (!table || table.type.name !== 'table' || row >= table.childCount) return null
  let pos = at + 2 // into the container, into the table
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize
  const tr = table.child(row)
  if (col >= tr.childCount) return null
  pos += 1 // into the row
  for (let c = 0; c < col; c++) pos += tr.child(c).nodeSize
  return pos + 2 // into the cell, into its paragraph
}

/** Puts the caret in cell (row, col) of a table block. */
export function caretToCell(editor: InklingEditor, blockId: string, row: number, col: number): void {
  const pos = cellTextPos(editor.prosemirrorState.doc as unknown as PMNode, blockId, row, col)
  if (pos === null) return
  ;(editor._tiptapEditor as unknown as TipTapLike).commands.setTextSelection(pos)
}

const tableBlock = (rows: string[][], headerRows = 0) => ({
  type: 'table',
  content: { type: 'tableContent', ...(headerRows ? { headerRows } : {}), rows: rows.map((cells) => ({ cells })) },
})

/** An empty `cols` × `rows` table: replaces the caret's block when it is an empty paragraph, else goes below it. */
export function insertSizedTable(editor: InklingEditor, cols: number, rows: number): boolean {
  if (!editor.isEditable) return false
  const cur = editor.getTextCursorPosition().block
  const empty = cur.type === 'paragraph' && !(cur.content as unknown[] | undefined)?.length && !cur.children.length
  const block = tableBlock(Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')))
  const inserted = empty
    ? editor.replaceBlocks([cur.id], [block as never]).insertedBlocks[0]
    : editor.insertBlocks([block as never], cur.id, 'after')[0]
  if (!inserted) return false
  caretToCell(editor, inserted.id, 0, 0)
  return true
}

type InlineLike = { type: string; text?: string; styles?: Record<string, unknown> }

/**
 * The cells when Enter should turn the caret's paragraph into a table, else null: a paragraph of plain
 * text (no inline code, no links or mentions) that is one pipe row, caret collapsed at its end, no
 * suggestion menu ("/", "@", "[[") open.
 */
function pipeRowAtCaret(editor: InklingEditor): string[] | null {
  const block = editor.getTextCursorPosition().block
  if (block.type !== 'paragraph') return null
  const content = (block.content ?? []) as InlineLike[]
  if (!content.length || content.some((c) => c.type !== 'text' || c.styles?.code)) return null
  const sel = editor.prosemirrorState.selection
  if (!sel.empty || sel.$from.parentOffset !== sel.$from.parent.content.size) return null
  if (document.querySelector('.bn-suggestion-menu')) return null
  return parsePipeRow(content.map((c) => c.text ?? '').join(''))
}

/** Turns the caret's paragraph into a table with `header` as its header row and one empty row. */
function pipeRowToTable(editor: InklingEditor, header: string[]): void {
  const block = editor.getTextCursorPosition().block
  // the conversion is an undo step of its own: one ⌘Z brings the typed row back, nothing more
  stopUndoCapture(editor)
  editor.updateBlock(block, tableBlock([header, header.map(() => '')], 1) as never)
  stopUndoCapture(editor)
  caretToCell(editor, block.id, 1, 0)
}

export function tableQuickInput() {
  return createExtension(({ editor }: { editor: InklingEditor }) => ({
    key: 'inklingTableQuickInput',
    mount: ({ dom, signal }: { dom: HTMLElement; signal: AbortSignal }) => {
      dom.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
          if (e.defaultPrevented || isImeEnter(e) || targetKind(e.target) === 'field') return
          if (!editor.isEditable) return
          let cells: string[] | null = null
          try {
            cells = pipeRowAtCaret(editor)
          } catch {
            return // the caret cannot be resolved (a cell or node selection): not ours
          }
          if (!cells) return
          e.preventDefault()
          e.stopImmediatePropagation()
          pipeRowToTable(editor, cells)
        },
        { capture: true, signal },
      )
    },
  }))()
}
