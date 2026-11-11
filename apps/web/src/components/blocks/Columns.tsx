// Columns: blocks side by side (docs/adr/2420-* .. 2424-*). Part of the editor chunk.
//
// The `columnList` / `column` nodes come from @inkling/shared (the server and the page-embed viewer
// build the same ones). Here the group gets a node view with the resize handles and the narrow-width
// stacking, and the editor gets the slash items, the side-menu items, the keys and the paste rule.
// Written against @blocknote/core's public API (MPL-2.0); @blocknote/xl-multi-column (GPL-3.0 or
// commercial) is neither used nor copied.
import { BlockNoteSchema, createBlockSpecFromTiptapNode, createExtension } from '@blocknote/core'
import { SideMenuExtension } from '@blocknote/core/extensions'
import {
  BlockColorsItem,
  DragHandleMenu,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
} from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import {
  COLUMN_LIST_TYPE,
  COLUMN_TYPE,
  COLUMNS_STACK_BELOW_PX,
  MAX_COLUMNS,
  columnListPropSchema,
  columnNodes,
  columnPropSchema,
  columnWeight,
  pctToWeights,
  resizePair,
  weightsToPct,
} from '@inkling/shared'
import { t, useT } from '../../i18n'
import { toast } from '../../lib/toast'
import {
  addColumn,
  columnBackspace,
  columnDelete,
  columnOfBlock,
  columnSafeBlockEdits,
  deleteColumn,
  flattenColumnHtml,
  insertColumns,
  selectionInColumn,
  unwrapColumns,
  type ColumnsEditor,
  type PMNode,
} from '../../lib/columns'

// Tiptap's Node class, from a node BlockNote builds (the web package does not depend on @tiptap/core).
type TiptapNode = { extend(config: Record<string, unknown>): TiptapNode }
const NodeClass = (BlockNoteSchema.create().blockSpecs.paragraph.implementation as unknown as { node: { constructor: unknown } }).node
  .constructor as Parameters<typeof columnNodes<TiptapNode>>[0]
const pm = columnNodes<TiptapNode>(NodeClass)

/** The parts of the ProseMirror view the node view writes through. */
interface PMView {
  state: { doc: PMNode; tr: PMTr }
  dispatch(tr: PMTr): void
  editable: boolean
}
interface PMTr {
  setNodeAttribute(pos: number, attr: string, value: unknown): PMTr
}

/**
 * The group's DOM: the columns in a flex row (contentDOM) and, beside it, the handles between them
 * (not editable, outside ProseMirror's content). The group stacks its columns when it is narrower than
 * COLUMNS_STACK_BELOW_PX (a phone, a narrow window, a side peek).
 */
class ColumnListView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private bar: HTMLElement
  private node: PMNode
  private ro: ResizeObserver | null = null
  private frame = 0
  private drag: { stop: () => void } | null = null

  constructor(
    node: PMNode,
    private view: PMView,
    private getPos: () => number | undefined,
  ) {
    this.node = node
    this.dom = document.createElement('div')
    this.dom.className = 'bn-block-column-list nd-columns-view'
    this.dom.setAttribute('data-node-type', COLUMN_LIST_TYPE)
    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'nd-columns-row'
    this.bar = document.createElement('div')
    this.bar.className = 'nd-col-handles'
    this.bar.contentEditable = 'false'
    this.bar.setAttribute('data-print-hide', '')
    this.dom.append(this.contentDOM, this.bar)
    this.syncAttrs()
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.schedule())
      this.ro.observe(this.dom)
    }
    this.schedule()
  }

  private syncAttrs() {
    const id = this.node.attrs.id
    if (typeof id === 'string' && id) this.dom.setAttribute('data-id', id)
  }

  private schedule() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.layout()
    })
  }

  private columns(): HTMLElement[] {
    return Array.from(this.contentDOM.children).filter((c): c is HTMLElement => c.getAttribute('data-node-type') === COLUMN_TYPE)
  }

  private layout() {
    const stacked = this.dom.clientWidth > 0 && this.dom.clientWidth < COLUMNS_STACK_BELOW_PX
    this.dom.classList.toggle('nd-columns-stacked', stacked)
    const cols = this.columns()
    const want = stacked || !this.view.editable ? 0 : Math.max(0, cols.length - 1)
    while (this.bar.children.length > want) this.bar.lastElementChild!.remove()
    while (this.bar.children.length < want) {
      const h = document.createElement('div')
      h.className = 'nd-col-handle'
      h.setAttribute('role', 'separator')
      h.setAttribute('aria-orientation', 'vertical')
      h.title = t('columns.resize')
      h.addEventListener('pointerdown', (e) => this.startDrag(e, Array.from(this.bar.children).indexOf(h)))
      h.addEventListener('dblclick', (e) => {
        e.preventDefault()
        this.commit(cols.map(() => 1))
      })
      this.bar.append(h)
    }
    if (!want) return
    const box = this.dom.getBoundingClientRect()
    for (let i = 0; i < want; i++) {
      const left = cols[i].getBoundingClientRect().right
      const right = cols[i + 1].getBoundingClientRect().left
      const h = this.bar.children[i] as HTMLElement
      h.style.left = `${(left + right) / 2 - box.left}px`
    }
  }

  private weights(): number[] {
    const out: number[] = []
    this.node.forEach((c) => out.push(columnWeight(c.attrs.width)))
    return out
  }

  private commit(weights: number[]) {
    const pos = this.getPos()
    if (pos === undefined) return
    const tr = this.view.state.tr
    let at = pos + 1
    let changed = false
    this.node.forEach((col, _o, i) => {
      if (weights[i] !== undefined && columnWeight(col.attrs.width) !== weights[i]) {
        tr.setNodeAttribute(at, 'width', weights[i])
        changed = true
      }
      at += col.nodeSize
    })
    if (changed) this.view.dispatch(tr)
  }

  private startDrag(e: PointerEvent, index: number) {
    if (!this.view.editable || index < 0) return
    e.preventDefault()
    e.stopPropagation()
    const cols = this.columns()
    if (!cols[index + 1]) return
    const a = cols[index].getBoundingClientRect()
    const b = cols[index + 1].getBoundingClientRect()
    const start = weightsToPct(this.weights())
    const pair = start[index] + start[index + 1]
    let next = start
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture?.(e.pointerId)
    this.dom.classList.add('nd-columns-dragging')
    const show = (pct: number[]) => pct.forEach((p, k) => this.dom.style.setProperty(`--nd-cw-${k + 1}`, String(p)))
    show(start)
    const move = (ev: PointerEvent) => {
      const leftPct = ((ev.clientX - a.left) / Math.max(1, b.right - a.left)) * pair
      next = resizePair(start, index, leftPct)
      show(next)
      this.schedule()
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', stop)
      this.dom.classList.remove('nd-columns-dragging')
      for (let k = 1; k <= start.length; k++) this.dom.style.removeProperty(`--nd-cw-${k}`)
      this.drag = null
    }
    const up = () => {
      stop()
      if (next.some((p, k) => p !== start[k])) this.commit(pctToWeights(next))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', stop)
    this.drag = { stop }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== COLUMN_LIST_TYPE) return false
    this.node = node
    this.syncAttrs()
    this.schedule()
    return true
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (m.type === 'selection') return false
    // the handles and the group's own classes/variables are not document content
    return !this.contentDOM.contains(m.target) || m.target === this.contentDOM && m.type === 'attributes'
  }

  stopEvent(e: Event): boolean {
    return this.bar.contains(e.target as Node)
  }

  destroy() {
    this.drag?.stop()
    this.ro?.disconnect()
    if (this.frame) cancelAnimationFrame(this.frame)
  }
}

const columnListNode = pm.columnList.extend({
  addNodeView() {
    return ({ node, getPos, editor }: { node: PMNode; getPos: () => number | undefined; editor: { view: PMView } }) =>
      new ColumnListView(node, editor.view, getPos)
  },
})

export const columnListSpec = createBlockSpecFromTiptapNode(
  { node: columnListNode as never, type: COLUMN_LIST_TYPE, content: 'none' },
  columnListPropSchema,
)
export const columnSpec = createBlockSpecFromTiptapNode({ node: pm.column as never, type: COLUMN_TYPE, content: 'none' }, columnPropSchema)

// ---------------------------------------------------------------------------
// editor wiring
// ---------------------------------------------------------------------------

/**
 * Keys and block edits inside columns (docs/adr/2421-*): Backspace / Delete at a column's edge move the
 * caret instead of moving blocks across columns, and replaceBlocks / removeBlocks on blocks inside a
 * column no longer remove empty columns (lib/columns.ts).
 */
export function columnsExtension() {
  return createExtension(({ editor }: { editor: unknown }) => {
    columnSafeBlockEdits(editor as ColumnsEditor)
    return {
      key: 'inklingColumns',
      keyboardShortcuts: {
        Backspace: ({ editor: e }: { editor: unknown }) => columnBackspace(e as ColumnsEditor),
        Delete: ({ editor: e }: { editor: unknown }) => columnDelete(e as ColumnsEditor),
      },
    }
  })()
}

/** Paste inside a column of HTML that holds columns: the blocks without their columns (no nesting). */
export function pasteFlatInColumn(event: ClipboardEvent, editor: unknown): boolean {
  const ed = editor as ColumnsEditor & { pasteHTML(html: string, raw?: boolean): void }
  if (!selectionInColumn(ed)) return false
  const data = event.clipboardData
  const html = data?.getData('blocknote/html') || data?.getData('text/html') || ''
  const flat = html ? flattenColumnHtml(html, (s) => new DOMParser().parseFromString(s, 'text/html')) : null
  if (!flat) return false
  event.preventDefault()
  ed.pasteHTML(flat)
  return true
}

function ColumnsGlyph({ n }: { n: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      {n === 2 ? <path d="M8 2.5v11" /> : <path d="M5.8 2.5v11M10.2 2.5v11" />}
    </svg>
  )
}

/** /2단 /3단 (en /2 columns, /3 columns). Not offered inside a column. */
export function columnsSlashItems(editor: unknown, group: string): DefaultReactSuggestionItem[] {
  const ed = editor as ColumnsEditor & { schema: { blockSchema: Record<string, unknown> } }
  if (!(COLUMN_LIST_TYPE in ed.schema.blockSchema) || selectionInColumn(ed)) return []
  const item = (n: number): DefaultReactSuggestionItem => ({
    title: t(n === 2 ? 'columns.slash2Title' : 'columns.slash3Title'),
    subtext: t('columns.slashSubtext'),
    // search data, not display text: English and Korean in every locale
    aliases: [`${n}col`, `${n}columns`, `${n} columns`, 'columns', 'column', 'side by side', 'layout', `${n}단`, '단', '다단', '컬럼', '나란히'],
    group,
    icon: <ColumnsGlyph n={n} />,
    onItemClick: () => {
      if (!insertColumns(ed, n)) toast({ message: t('columns.nested') })
    },
  })
  return [item(2), item(3)]
}

/** The menu took the focus: give it back so typing goes where the command put the caret. */
function focusEditor(editor: { focus(): void }) {
  window.setTimeout(() => editor.focus(), 0)
}

/** The block menu (⋮⋮) with BlockNote's items, plus the column items for a block inside a column. */
function ColumnsDragHandleMenu() {
  const editor = useBlockNoteEditor<any, any, any>()
  const Components = useComponentsContext()!
  const dict = useDictionary()
  const tr = useT()
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block })
  const ed = editor as unknown as ColumnsEditor
  const col = block ? columnOfBlock(ed.prosemirrorState.doc, block.id) : null
  const listId = col ? String(col.list.attrs.id ?? '') : ''
  const columnId = col ? String(col.column.attrs.id ?? '') : ''
  return (
    <DragHandleMenu>
      <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
      {col && (
        <>
          <Components.Generic.Menu.Divider className="bn-menu-divider" />
          <Components.Generic.Menu.Item
            className="bn-menu-item"
            onClick={() => {
              if (col.list.childCount >= MAX_COLUMNS) toast({ message: tr('columns.max', { n: MAX_COLUMNS }) })
              else addColumn(ed, listId)
              focusEditor(editor)
            }}
          >
            <span data-testid="columns-add">{tr('columns.add')}</span>
          </Components.Generic.Menu.Item>
          <Components.Generic.Menu.Item
            className="bn-menu-item"
            onClick={() => {
              deleteColumn(ed, columnId)
              focusEditor(editor)
            }}
          >
            <span data-testid="columns-delete">{tr('columns.delete')}</span>
          </Components.Generic.Menu.Item>
          <Components.Generic.Menu.Item
            className="bn-menu-item"
            onClick={() => {
              unwrapColumns(ed, listId)
              focusEditor(editor)
            }}
          >
            <span data-testid="columns-unwrap">{tr('columns.unwrap')}</span>
          </Components.Generic.Menu.Item>
        </>
      )}
    </DragHandleMenu>
  )
}

/** BlockNote's side menu with ColumnsDragHandleMenu (BlockNoteView gets sideMenu={false}). */
export function ColumnsSideMenu() {
  return <SideMenuController sideMenu={(props) => <SideMenu {...props} dragHandleMenu={ColumnsDragHandleMenu} />} />
}
