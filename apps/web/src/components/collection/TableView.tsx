import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type {
  CollectionField,
  CollectionViewDTO,
  MemberDTO,
  RowDTO,
  ViewConfig,
} from '@inkling/shared'
import { COLUMN_WIDTH } from '@inkling/shared'
import { useT } from '../../i18n'
import { applyView, formatValue, orderedFields } from '../../lib/collection'
import {
  FIELD_MIN,
  TITLE_MIN,
  clampColumnWidth,
  columnTracks,
  columnWidthForKey,
  withColumnWidth,
} from '../../lib/columnWidths'
import { parseClipboardGrid, toHtmlTable, toTsv, viewGrid } from '../../lib/spreadsheet'
import { matchCommand } from '../../lib/shortcuts'
import { scrollParent, useWindowedRows } from '../../lib/useWindowedRows'
import { ConfirmPopover } from '../ConfirmPopover'
import {
  MoreHorizontalIcon,
  PlusIcon,
  TrashIcon,
} from '../Icons'
import { ResizeHandle } from '../ResizeHandle'
import { FieldCell } from './cells/FieldCell'
import { InGridContext } from './gridContext'
import { useCollectionReadOnly } from './readOnlyContext'

type Handlers = {
  wsId: string
  members?: MemberDTO[]
  onCommitProps: (rowId: string, patch: Record<string, unknown>) => void
  onAddOption: (fieldId: string, name: string) => string
  onUpdateTitle: (rowId: string, title: string) => void
  onDeleteRow: (rowId: string) => void
  /** paste a copied spreadsheet range at (display row, table column); col 0 = title */
  onPasteGrid?: (grid: string[][], rows: RowDTO[], cols: CollectionField[], anchorRow: number, anchorCol: number) => void
  refs?: Record<string, import('@inkling/shared').RowRefDTO> | null
}

function TitleCell({
  row,
  wsId,
  onUpdateTitle,
  onDeleteRow,
}: {
  row: RowDTO
  wsId: string
  onUpdateTitle: (rowId: string, title: string) => void
  onDeleteRow: (rowId: string) => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const readOnly = useCollectionReadOnly()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [menuOpen])

  const start = () => {
    setDraft(row.title)
    setEditing(true)
  }
  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== row.title) onUpdateTitle(row.id, next)
  }
  const open = () => navigate(`/w/${wsId}/p/${row.id}`)

  return (
    <div className="group/title flex min-h-[34px] items-center gap-1 border-r border-line px-1.5">
      {/* row menu on the left (read-only: its only edit action, delete, is denied — keep the slot) */}
      {readOnly ? (
        <span className="h-5 w-5 shrink-0" />
      ) : (
        <div ref={menuRef} className="relative shrink-0">
          <ConfirmPopover
            open={confirmOpen}
            onCancel={() => setConfirmOpen(false)}
            onConfirm={() => {
              setConfirmOpen(false)
              onDeleteRow(row.id)
            }}
            message={t('table.deleteRowConfirm')}
          >
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={t('table.rowMenu')}
              data-print-hide
              className="flex h-5 w-5 items-center justify-center rounded text-sub opacity-0 hover:bg-hover hover:text-ink group-hover/title:opacity-100"
            >
              <MoreHorizontalIcon size={14} />
            </button>
          </ConfirmPopover>
          {menuOpen && (
            <div className="absolute left-0 top-full z-40 mt-1 w-28 overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  open()
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
              >
                {t('common.open')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setConfirmOpen(true)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-hover"
              >
                <TrashIcon size={14} /> {t('common.delete')}
              </button>
            </div>
          )}
        </div>
      )}

      {editing ? (
        <input
          autoFocus
          data-cell-input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter that ends a Korean/Japanese syllable is not "save"
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
          }}
          className="min-w-0 flex-1 rounded-sm bg-app px-1 py-0.5 text-sm text-ink outline-none ring-1 ring-inset ring-accent"
        />
      ) : (
        <button
          type="button"
          data-cell-edit
          tabIndex={-1}
          onClick={readOnly ? open : start}
          className="min-w-0 flex-1 truncate py-1 text-left text-sm font-medium text-ink"
          title={row.title || t('common.untitled')}
        >
          {row.title || <span className="text-sub/50">{t('common.untitled')}</span>}
        </button>
      )}

      <button
        type="button"
        tabIndex={-1}
        onClick={open}
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-sub opacity-0 hover:bg-hover hover:text-ink group-hover/title:opacity-100"
        title={t('table.openRowPage')}
      >
        {t('common.open')}
      </button>
    </div>
  )
}

/** Rows above this count are windowed (fixed 35px rows, single-line cells). */
const WINDOW_THRESHOLD = 150
const ROW_H = 35

type Sel = { r0: number; c0: number; r1: number; c1: number }

function inSel(sel: Sel | null, r: number, c: number): boolean {
  if (!sel) return false
  const [ra, rb] = sel.r0 <= sel.r1 ? [sel.r0, sel.r1] : [sel.r1, sel.r0]
  const [ca, cb] = sel.c0 <= sel.c1 ? [sel.c0, sel.c1] : [sel.c1, sel.c0]
  return r >= ra && r <= rb && c >= ca && c <= cb
}

function TableRow({
  row,
  rowIndex,
  cols,
  gridStyle,
  handlers,
  fixed,
  sel,
  tabCell,
  onCellDown,
}: {
  row: RowDTO
  rowIndex: number
  cols: CollectionField[]
  gridStyle: React.CSSProperties
  handlers: Handlers
  fixed: boolean
  sel: Sel | null
  /** the column whose cell is this row's Tab stop (roving tabindex), or null */
  tabCell: number | null
  onCellDown: (e: React.MouseEvent, r: number, c: number) => void
}) {
  const selCls = (c: number) => (inSel(sel, rowIndex, c) ? 'bg-accent-soft/60 ring-1 ring-inset ring-accent/50' : '')
  // a grid cell (docs/adr/1407-*): one Tab stop for the whole table, the arrows move between cells; the
  // scroll margin keeps a focused cell clear of the sticky header strip
  const cell = (c: number) => ({
    role: 'gridcell',
    'aria-colindex': c + 1,
    'aria-selected': inSel(sel, rowIndex, c),
    'data-cell': `${rowIndex}:${c}`,
    tabIndex: tabCell === c ? 0 : -1,
  })
  const focusCls =
    'scroll-mt-10 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent'
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      className={`grid border-b border-line hover:bg-hover/40 ${
        fixed ? '[&_.flex-wrap]:flex-nowrap [&_.flex-wrap]:overflow-hidden' : ''
      }`}
      style={fixed ? { ...gridStyle, height: ROW_H } : gridStyle}
    >
      <div {...cell(0)} className={`${focusCls} ${selCls(0)}`} onMouseDown={(e) => onCellDown(e, rowIndex, 0)}>
        <TitleCell
          row={row}
          wsId={handlers.wsId}
          onUpdateTitle={handlers.onUpdateTitle}
          onDeleteRow={handlers.onDeleteRow}
        />
      </div>
      {cols.map((f, ci) => (
        <div
          key={f.id}
          {...cell(ci + 1)}
          className={`min-w-0 border-r border-line ${focusCls} ${selCls(ci + 1)}`}
          // Windowed rows are one line high: wrapped values (multi-select chips, long text) are
          // clipped, so expose the full value as a tooltip (docs/adr/0709-*).
          title={
            fixed
              ? formatValue(
                  f,
                  row.props[f.id],
                  (id) => handlers.members?.find((m) => m.id === id)?.name,
                ) || undefined
              : undefined
          }
          onMouseDown={(e) => onCellDown(e, rowIndex, ci + 1)}
        >
          <FieldCell
            field={f}
            value={row.props[f.id]}
            members={handlers.members}
            onCommit={(v) => handlers.onCommitProps(row.id, { [f.id]: v })}
            rowProps={f.type === 'person' ? row.props : undefined}
            onCommitPatch={f.type === 'person' ? (patch) => handlers.onCommitProps(row.id, patch) : undefined}
            onAddOption={
              f.type === 'select' || f.type === 'multiSelect'
                ? (name) => handlers.onAddOption(f.id, name)
                : undefined
            }
          />
        </div>
      ))}
      <div role="presentation" />
    </div>
  )
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

export function TableView({
  view,
  fields,
  rows,
  handlers,
  onUpdateConfig,
  onOpenFields,
  onCreateRow,
  creatingRow,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  rows: RowDTO[]
  handlers: Handlers
  onUpdateConfig: (config: ViewConfig) => void
  onOpenFields: () => void
  onCreateRow: () => void
  creatingRow?: boolean
}) {
  const t = useT()
  const navigate = useNavigate()
  const readOnly = useCollectionReadOnly()
  const cols = useMemo(() => orderedFields(fields, view.config), [fields, view.config])
  const display = useMemo(
    () => applyView(rows, fields, view.config),
    [rows, fields, view.config],
  )

  const sorts = view.config.sorts ?? []
  const sortFor = (fieldId: string) => sorts.find((s) => s.fieldId === fieldId)

  const toggleSort = (fieldId: string) => {
    const cur = sortFor(fieldId)
    let next: ViewConfig['sorts']
    if (!cur) next = [{ fieldId, dir: 'asc' }]
    else if (cur.dir === 'asc') next = [{ fieldId, dir: 'desc' }]
    else next = []
    onUpdateConfig({ ...view.config, sorts: next })
  }

  // Column tracks: a minimum width each, and the space left in a wide pane shared out (fr). The grid's
  // min-width is the sum of those minimums, not its max-content width: with `min-width: max-content`
  // the fr tracks were all sized to the widest cell's one-line text, so one long text value made
  // every column that wide (1,331 px each for a 210-character value). Cells clip (truncate) instead.
  // A column dragged to a width keeps that width (a fixed track), saved on the view (docs/adr/1351-*).
  // Someone who cannot edit the view (read-only) resizes for this screen only: the widths stay local.
  const serverWidths = useMemo(
    () => ({ columnWidths: view.config.columnWidths, titleWidth: view.config.titleWidth }),
    [view.config.columnWidths, view.config.titleWidth],
  )
  const serverWidthsKey = JSON.stringify(serverWidths)
  const [localWidths, setLocalWidths] = useState<typeof serverWidths | null>(null)
  // the view's stored widths changed (saved, another tab, another person) or another view: drop the local copy
  useEffect(() => setLocalWidths(null), [view.id, serverWidthsKey])
  const widths = localWidths ?? serverWidths
  const tracks = useMemo(() => columnTracks(cols, widths), [cols, widths])
  const gridStyle: React.CSSProperties = { gridTemplateColumns: tracks.template }
  const gridMinWidth = `var(--tc-min, ${tracks.minWidth}px)`

  const commitWidth = (fieldId: string | null, width: number | null) => {
    const next = withColumnWidth({ ...view.config, ...widths }, fieldId, width)
    setLocalWidths({ columnWidths: next.columnWidths, titleWidth: next.titleWidth })
    if (!readOnly) onUpdateConfig(next)
  }
  // drag preview: one CSS variable for the track and one for the grid's minimum width, on the root
  // that holds both the header strip and the rows (no re-render per pointer move)
  const previewWidth = (i: number, w: number) => {
    const root = rootRef.current
    if (!root) return
    const base = i === 0 ? (widths.titleWidth ?? TITLE_MIN) : (widths.columnWidths?.[cols[i - 1].id] ?? FIELD_MIN)
    root.style.setProperty(`--tc-${i}`, `${w}px`)
    root.style.setProperty('--tc-min', `${tracks.minWidth - clampColumnWidth(base, i === 0) + w}px`)
  }
  const endPreview = (i: number) => {
    rootRef.current?.style.removeProperty(`--tc-${i}`)
    rootRef.current?.style.removeProperty('--tc-min')
  }
  const headerWidth = (i: number) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-col="${i}"]`)?.getBoundingClientRect().width ??
    (i === 0 ? TITLE_MIN : FIELD_MIN)
  const resizeHandle = (i: number, name: string) => {
    const title = i === 0
    const fieldId = title ? null : cols[i - 1].id
    const stored = title ? widths.titleWidth : widths.columnWidths?.[fieldId!]
    return (
      <ResizeHandle
        label={t('table.resizeColumn', { name })}
        value={stored ?? (title ? TITLE_MIN : FIELD_MIN)}
        min={title ? TITLE_MIN : FIELD_MIN}
        max={COLUMN_WIDTH.max}
        className="absolute inset-y-0 -right-[3px] z-10 w-[6px] cursor-col-resize touch-none outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 active:bg-accent/60"
        startWidth={() => headerWidth(i)}
        clamp={(w) => clampColumnWidth(w, title)}
        onPreview={(w) => previewWidth(i, w)}
        onEnd={() => endPreview(i)}
        onCommit={(w) => commitWidth(fieldId, w)}
        onReset={() => commitWidth(fieldId, null)}
        onKey={(key, shift) => columnWidthForKey(key, headerWidth(i), shift, title)}
      />
    )
  }

  // ---- windowing (large tables) ----
  const listRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({
    count: display.length,
    rowHeight: ROW_H,
    listRef,
    threshold: WINDOW_THRESHOLD,
  })
  const fixed = display.length > WINDOW_THRESHOLD && !win.printing

  // ---- cell range selection + clipboard ----
  const [sel, setSel] = useState<Sel | null>(null)
  const selRef = useRef<Sel | null>(null)
  selRef.current = sel
  const rootRef = useRef<HTMLDivElement>(null)
  const headScrollRef = useRef<HTMLDivElement>(null)
  const bodyScrollRef = useRef<HTMLDivElement>(null)

  // ---- keyboard grid (docs/adr/1407-*) ----
  // `focus` is the cell that has (or last had) the keyboard focus: the grid's one Tab stop. A move asks
  // for DOM focus through `pendingRef`; the effect below gives it once the cell is rendered (a windowed
  // row may first have to be scrolled into the rendered range).
  const [focus, setFocus] = useState<{ r: number; c: number; seq: number } | null>(null)
  const seqRef = useRef(0)
  const pendingRef = useRef<{ seq: number; edit: boolean } | null>(null)
  // the latest requested cell, ahead of the DOM focus while a windowed row is still being rendered: a
  // held arrow key keeps counting from here instead of from the cell that still has the focus
  const focusRef = useRef<{ r: number; c: number } | null>(null)
  const newRowRef = useRef<{ before: Set<string>; until: number } | null>(null)
  const colCount = cols.length + 1

  const onCellDown = useCallback((e: React.MouseEvent, r: number, c: number) => {
    if (e.button !== 0) return
    const cur = selRef.current
    if (e.shiftKey && cur) {
      e.preventDefault()
      setSel({ ...cur, r1: r, c1: c })
    } else setSel({ r0: r, c0: c, r1: r, c1: c })
    // a click moves the Tab stop too, so the arrows go on from here (the click itself keeps its focus)
    focusRef.current = { r, c }
    pendingRef.current = null
    setFocus({ r, c, seq: ++seqRef.current })
  }, [])

  const focusCell = (r: number, c: number, opts: { extend?: boolean; edit?: boolean } = {}) => {
    if (display.length === 0) return
    const rr = Math.max(0, Math.min(display.length - 1, r))
    const cc = Math.max(0, Math.min(colCount - 1, c))
    const seq = ++seqRef.current
    pendingRef.current = { seq, edit: !!opts.edit }
    focusRef.current = { r: rr, c: cc }
    setFocus({ r: rr, c: cc, seq })
    if (opts.extend) {
      const cur = selRef.current
      const anchor = cur ? { r0: cur.r0, c0: cur.c0 } : { r0: focus?.r ?? rr, c0: focus?.c ?? cc }
      setSel({ ...anchor, r1: rr, c1: cc })
    } else setSel({ r0: rr, c0: cc, r1: rr, c1: cc })
  }

  /** Enter/F2: what a click on the cell does (open the editor, the picker, toggle the box, open the row read-only). */
  const startEdit = (el: HTMLElement) => {
    const opener = el.querySelector<HTMLElement>('[data-cell-edit]')
    if (!opener) return
    opener.click()
    // a picker opened (select, person, relation): its list takes the focus unless it focused its own field
    requestAnimationFrame(() => {
      const popup = el.querySelector<HTMLElement>('[data-cell-popup]')
      if (popup && !popup.contains(document.activeElement)) popup.querySelector<HTMLElement>('button, input')?.focus()
    })
  }

  useEffect(() => {
    const p = pendingRef.current
    if (!focus || !p || p.seq !== focus.seq) return
    const root = rootRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>(`[data-cell="${focus.r}:${focus.c}"]`)
    if (!el) {
      // a windowed row outside the rendered range: scroll it to the middle; the range changes and this runs again
      const list = listRef.current
      if (!list) return
      const sc = scrollParent(list)
      const rowTop = list.getBoundingClientRect().top + focus.r * ROW_H
      if (sc instanceof Window) window.scrollBy(0, rowTop - window.innerHeight / 2)
      else sc.scrollTop += rowTop - sc.getBoundingClientRect().top - sc.clientHeight / 2
      return
    }
    pendingRef.current = null
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (p.edit) startEdit(el)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, win.start, win.end])

  // ⌘Enter / Enter on the last row: the new row's title opens for typing once the row arrives
  const newRow = () => {
    newRowRef.current = { before: new Set(display.map((d) => d.id)), until: Date.now() + 15000 }
    onCreateRow()
  }
  useEffect(() => {
    const p = newRowRef.current
    if (!p) return
    if (Date.now() > p.until) {
      newRowRef.current = null
      return
    }
    const i = display.findIndex((d) => !p.before.has(d.id))
    if (i < 0) return
    newRowRef.current = null
    focusCell(i, 0, { edit: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display])

  /** Delete/Backspace: empties every cell in the selection (computed rollups are skipped). */
  const clearCells = (r: number, c: number) => {
    const s = selRef.current ?? { r0: r, c0: c, r1: r, c1: c }
    const [ra, rb] = s.r0 <= s.r1 ? [s.r0, s.r1] : [s.r1, s.r0]
    const [ca, cb] = s.c0 <= s.c1 ? [s.c0, s.c1] : [s.c1, s.c0]
    for (const row of display.slice(ra, rb + 1)) {
      const patch: Record<string, unknown> = {}
      for (let col = ca; col <= cb; col++) {
        if (col === 0) {
          if (row.title) handlers.onUpdateTitle(row.id, '')
          continue
        }
        const f = cols[col - 1]
        if (!f || f.type === 'rollup' || f.type === 'formula') continue
        const empty = f.type === 'checkbox' ? false : null
        if ((row.props[f.id] ?? null) !== empty && row.props[f.id] !== undefined) patch[f.id] = empty
      }
      if (Object.keys(patch).length) handlers.onCommitProps(row.id, patch)
    }
  }

  /** Next / previous cell in reading order (Tab), or null at the ends so Tab can leave the table. */
  const stepCell = (r: number, c: number, dir: 1 | -1): { r: number; c: number } | null => {
    let nc = c + dir
    let nr = r
    if (nc >= colCount) {
      nc = 0
      nr++
    } else if (nc < 0) {
      nc = colCount - 1
      nr--
    }
    return nr < 0 || nr >= display.length ? null : { r: nr, c: nc }
  }

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const el = target.closest<HTMLElement>('[data-cell]')
    if (!el || !rootRef.current?.contains(el)) return
    const ne = e.nativeEvent
    if (ne.isComposing || ne.keyCode === 229) return
    const [cellR, cellC] = (el.dataset.cell ?? '0:0').split(':').map(Number)
    // a move still on its way to the DOM (windowed rows) counts as where the focus is
    const ahead = target === el && pendingRef.current ? focusRef.current : null
    const r = ahead?.r ?? cellR
    const c = ahead?.c ?? cellC
    const m = (id: string) => matchCommand(id, e)

    if (target !== el) {
      // inside a cell: an open text field or a picker. The cell's own handler ran first (React bubbles
      // from the field up to here): Enter saved, Esc cancelled or closed.
      const popup = target.closest<HTMLElement>('[data-cell-popup]')
      const input = target.matches('[data-cell-input]')
      if (e.key === 'Escape') {
        focusCell(r, c)
        return
      }
      if ((input || popup) && (m('table.nextCell') || m('table.prevCell'))) {
        // leaving the field saves it (blur)
        const n = stepCell(r, c, m('table.nextCell') ? 1 : -1)
        if (!n) return
        e.preventDefault()
        focusCell(n.r, n.c)
        return
      }
      if (input && e.key === 'Enter') {
        if (m('table.newRow')) {
          if (!readOnly) newRow()
          return
        }
        if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
        e.preventDefault()
        if (r >= display.length - 1 && !readOnly) newRow()
        else focusCell(r + 1, c)
        return
      }
      if (popup && (e.key === 'Enter' || e.key === ' ')) {
        // a pick that closes the list (select, person) hands the focus back to the cell; a multi-select stays open
        requestAnimationFrame(() => {
          if (!el.querySelector('[data-cell-popup]')) focusCell(r, c)
        })
        return
      }
      if (popup && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const items = [...popup.querySelectorAll<HTMLElement>('button, input')]
        const next = items[items.indexOf(target) + (e.key === 'ArrowDown' ? 1 : -1)]
        if (next) {
          e.preventDefault()
          next.focus()
        }
      }
      return
    }

    const go = (r2: number, c2: number, extend = false) => {
      e.preventDefault()
      focusCell(r2, c2, { extend })
    }
    if (m('table.up')) return go(r - 1, c)
    if (m('table.down')) return go(r + 1, c)
    if (m('table.left')) return go(r, c - 1)
    if (m('table.right')) return go(r, c + 1)
    if (m('table.extendUp')) return go((selRef.current?.r1 ?? r) - 1, selRef.current?.c1 ?? c, true)
    if (m('table.extendDown')) return go((selRef.current?.r1 ?? r) + 1, selRef.current?.c1 ?? c, true)
    if (m('table.extendLeft')) return go(selRef.current?.r1 ?? r, (selRef.current?.c1 ?? c) - 1, true)
    if (m('table.extendRight')) return go(selRef.current?.r1 ?? r, (selRef.current?.c1 ?? c) + 1, true)
    if (m('table.rowStart')) return go(r, 0)
    if (m('table.rowEnd')) return go(r, colCount - 1)
    if (m('table.nextCell') || m('table.prevCell')) {
      const n = stepCell(r, c, m('table.nextCell') ? 1 : -1)
      // at either end Tab leaves the table (no trap)
      if (n) go(n.r, n.c)
      return
    }
    if (m('table.edit')) {
      e.preventDefault()
      if (ahead) focusCell(r, c, { edit: true })
      else startEdit(el)
      return
    }
    if (m('table.toggle')) {
      e.preventDefault()
      const f = c > 0 ? cols[c - 1] : undefined
      const row = display[r]
      if (!readOnly && row && f?.type === 'checkbox') handlers.onCommitProps(row.id, { [f.id]: !row.props[f.id] })
      return
    }
    if (m('table.clear')) {
      if (readOnly) return
      e.preventDefault()
      clearCells(r, c)
      return
    }
    if (m('table.newRow')) {
      if (readOnly) return
      e.preventDefault()
      newRow()
      return
    }
    if (m('table.openRow')) {
      const row = display[r]
      if (!row) return
      e.preventDefault()
      navigate(`/w/${handlers.wsId}/p/${row.id}`)
      return
    }
    if (e.key === 'Escape') setSel(null)
  }

  // the Tab stop: the focused cell while its row is rendered, else the first rendered row's title
  const tabPos =
    focus && focus.r >= win.start && focus.r < Math.min(win.end, display.length)
      ? { r: focus.r, c: Math.min(focus.c, colCount - 1) }
      : { r: win.start, c: 0 }

  useEffect(() => {
    const inside = (t: EventTarget | null) => !!rootRef.current && rootRef.current.contains(t as Node)
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setSel(null)
    }
    const onKey = (e: KeyboardEvent) => {
      // inside the table the grid's own handler decides (Esc in a cell editor keeps the cell selected)
      if (e.key === 'Escape' && !isEditableTarget(e.target) && !inside(e.target)) setSel(null)
    }
    const onCopy = (e: ClipboardEvent) => {
      const s = selRef.current
      if (!s || !e.clipboardData) return
      const multi = s.r0 !== s.r1 || s.c0 !== s.c1
      if (isEditableTarget(e.target) && !multi) return
      if (!multi && (window.getSelection()?.toString() ?? '') !== '') return
      const [ra, rb] = s.r0 <= s.r1 ? [s.r0, s.r1] : [s.r1, s.r0]
      const [ca, cb] = s.c0 <= s.c1 ? [s.c0, s.c1] : [s.c1, s.c0]
      const grid = viewGrid({
        fields: cols,
        rows: display.slice(ra, rb + 1),
        members: handlers.members,
        refs: handlers.refs,
      })
        .slice(1)
        .map((line) => line.slice(ca, cb + 1))
      e.preventDefault()
      e.clipboardData.setData('text/plain', toTsv(grid))
      e.clipboardData.setData('text/html', toHtmlTable(grid))
    }
    const onPaste = (e: ClipboardEvent) => {
      const s = selRef.current
      if (!s || !e.clipboardData || !handlers.onPasteGrid) return
      if (!inside(e.target) && e.target !== document.body) return
      const grid = parseClipboardGrid(e.clipboardData)
      if (!grid || grid.length === 0) return
      const single = grid.length === 1 && grid[0].length === 1
      if (single && isEditableTarget(e.target)) return // normal text paste into an editor
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      const r = Math.min(s.r0, s.r1)
      const c = Math.min(s.c0, s.c1)
      handlers.onPasteGrid(grid, display, cols, r, c)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [cols, display, handlers])

  const visible = display.slice(win.start, win.end)

  return (
    <InGridContext.Provider value={true}>
      <div
        ref={rootRef}
        role="grid"
        aria-label={view.name}
        aria-rowcount={display.length + 1}
        aria-multiselectable="true"
        aria-readonly={readOnly || undefined}
        onKeyDown={onGridKeyDown}
      >
        {/* Header in its own strip: sticky to the page while the rows scroll under it. It cannot sit in
            the rows' horizontal scroller (overflow-x makes that the sticky container, which never scrolls
            vertically), so it clips and follows the rows' scrollLeft instead (docs/adr/1322-*). */}
        <div
          ref={headScrollRef}
          role="rowgroup"
          className="nd-wide-scroll sticky top-0 z-10 overflow-x-hidden bg-app"
          onWheel={(e) => {
            // a sideways trackpad swipe over the header scrolls the rows
            if (bodyScrollRef.current && e.deltaX) bodyScrollRef.current.scrollLeft += e.deltaX
          }}
        >
          <div
            role="row"
            aria-rowindex={1}
            className="grid border-y border-line bg-side/40 text-xs font-medium text-sub"
            style={{ ...gridStyle, minWidth: gridMinWidth }}
          >
            <div
              data-col={0}
              role="columnheader"
              aria-colindex={1}
              className="relative flex min-w-0 items-center border-r border-line px-2.5 py-1.5"
            >
              <span className="truncate">{t('table.title')}</span>
              {resizeHandle(0, t('table.title'))}
            </div>
            {cols.map((f, ci) => {
              const s = sortFor(f.id)
              // Read-only: sorts are saved on the view (a write the lock denies), so the header is static.
              // The resize handle sits next to the sort button (a handle inside a button would be a
              // control inside a control); read-only widths stay on this screen.
              return (
                <div
                  key={f.id}
                  data-col={ci + 1}
                  role="columnheader"
                  aria-colindex={ci + 2}
                  aria-sort={s ? (s.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className="relative flex min-w-0 border-r border-line"
                >
                  {readOnly ? (
                    <div className="flex min-w-0 flex-1 items-center gap-1 px-2.5 py-1.5">
                      <span className="truncate">{f.name}</span>
                      {s && <span className="text-accent">{s.dir === 'asc' ? '↑' : '↓'}</span>}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(f.id)}
                      className="flex min-w-0 flex-1 items-center gap-1 px-2.5 py-1.5 text-left hover:bg-hover"
                      title={t('table.clickToSort')}
                    >
                      <span className="truncate">{f.name}</span>
                      {s && <span className="text-accent">{s.dir === 'asc' ? '↑' : '↓'}</span>}
                    </button>
                  )}
                  {resizeHandle(ci + 1, f.name)}
                </div>
              )
            })}
            {readOnly ? (
              <div role="presentation" />
            ) : (
              <div role="columnheader" className="flex">
                <button
                  type="button"
                  onClick={onOpenFields}
                  aria-label={t('fields.title')}
                  title={t('fields.title')}
                  data-print-hide
                  className="flex w-full items-center justify-center py-1.5 hover:bg-hover hover:text-ink"
                >
                  <PlusIcon size={15} />
                </button>
              </div>
            )}
          </div>
        </div>

        <div
          ref={bodyScrollRef}
          className="nd-wide-scroll overflow-x-auto"
          onScroll={(e) => {
            if (headScrollRef.current) headScrollRef.current.scrollLeft = e.currentTarget.scrollLeft
          }}
        >
          <div style={{ minWidth: gridMinWidth }}>
            {/* rows */}
            <div ref={listRef} role="rowgroup" style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
              {visible.map((row, i) => (
                <TableRow
                  key={row.id}
                  row={row}
                  rowIndex={win.start + i}
                  cols={cols}
                  gridStyle={gridStyle}
                  handlers={handlers}
                  fixed={fixed}
                  sel={sel}
                  tabCell={tabPos.r === win.start + i ? tabPos.c : null}
                  onCellDown={onCellDown}
                />
              ))}
            </div>

            {display.length === 0 && (
              <div className="border-b border-line px-3 py-4 text-sm text-sub">
                {rows.length === 0 ? t('table.noRows') : t('table.noMatches')}
              </div>
            )}

            {/* new row */}
            {!readOnly && (
              <button
                type="button"
                onClick={onCreateRow}
                disabled={creatingRow}
                data-print-hide
                className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-sm text-sub hover:bg-hover hover:text-ink disabled:opacity-60"
              >
                <PlusIcon size={15} /> {t('table.newRow')}
              </button>
            )}
          </div>
        </div>
      </div>
    </InGridContext.Provider>
  )
}
