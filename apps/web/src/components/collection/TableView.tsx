import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type {
  CollectionField,
  CollectionViewDTO,
  MemberDTO,
  RowDTO,
  ViewConfig,
} from '@inkling/shared'
import { useT } from '../../i18n'
import { applyView, formatValue, orderedFields } from '../../lib/collection'
import { parseClipboardGrid, toHtmlTable, toTsv, viewGrid } from '../../lib/spreadsheet'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { ConfirmPopover } from '../ConfirmPopover'
import {
  MoreHorizontalIcon,
  PlusIcon,
  TrashIcon,
} from '../Icons'
import { FieldCell } from './cells/FieldCell'
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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
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
          onClick={readOnly ? open : start}
          className="min-w-0 flex-1 truncate py-1 text-left text-sm font-medium text-ink"
          title={row.title || t('common.untitled')}
        >
          {row.title || <span className="text-sub/50">{t('common.untitled')}</span>}
        </button>
      )}

      <button
        type="button"
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
  onCellDown,
}: {
  row: RowDTO
  rowIndex: number
  cols: CollectionField[]
  gridStyle: React.CSSProperties
  handlers: Handlers
  fixed: boolean
  sel: Sel | null
  onCellDown: (e: React.MouseEvent, r: number, c: number) => void
}) {
  const selCls = (c: number) => (inSel(sel, rowIndex, c) ? 'bg-accent-soft/60 ring-1 ring-inset ring-accent/50' : '')
  return (
    <div
      className={`grid border-b border-line hover:bg-hover/40 ${
        fixed ? '[&_.flex-wrap]:flex-nowrap [&_.flex-wrap]:overflow-hidden' : ''
      }`}
      style={fixed ? { ...gridStyle, height: ROW_H } : gridStyle}
    >
      <div className={selCls(0)} onMouseDown={(e) => onCellDown(e, rowIndex, 0)}>
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
          className={`min-w-0 border-r border-line ${selCls(ci + 1)}`}
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
            onAddOption={
              f.type === 'select' || f.type === 'multiSelect'
                ? (name) => handlers.onAddOption(f.id, name)
                : undefined
            }
          />
        </div>
      ))}
      <div />
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

  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `minmax(200px, 1.6fr) ${cols
      .map(() => 'minmax(150px, 1fr)')
      .join(' ')} 44px`,
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

  const onCellDown = useCallback((e: React.MouseEvent, r: number, c: number) => {
    if (e.button !== 0) return
    const cur = selRef.current
    if (e.shiftKey && cur) {
      e.preventDefault()
      setSel({ ...cur, r1: r, c1: c })
    } else setSel({ r0: r, c0: c, r1: r, c1: c })
  }, [])

  useEffect(() => {
    const inside = (t: EventTarget | null) => !!rootRef.current && rootRef.current.contains(t as Node)
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setSel(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isEditableTarget(e.target)) setSel(null)
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
    <div ref={rootRef} className="overflow-x-auto">
      <div className="min-w-max">
        {/* header */}
        <div
          className="grid border-y border-line bg-side/40 text-xs font-medium text-sub"
          style={gridStyle}
        >
          <div className="flex items-center border-r border-line px-2.5 py-1.5">
            {t('table.title')}
          </div>
          {cols.map((f) => {
            const s = sortFor(f.id)
            // Read-only: sorts are saved on the view (a write the lock denies), so the header is static.
            if (readOnly)
              return (
                <div
                  key={f.id}
                  className="flex items-center gap-1 border-r border-line px-2.5 py-1.5"
                >
                  <span className="truncate">{f.name}</span>
                  {s && <span className="text-accent">{s.dir === 'asc' ? '↑' : '↓'}</span>}
                </div>
              )
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => toggleSort(f.id)}
                className="flex items-center gap-1 border-r border-line px-2.5 py-1.5 text-left hover:bg-hover"
                title={t('table.clickToSort')}
              >
                <span className="truncate">{f.name}</span>
                {s && <span className="text-accent">{s.dir === 'asc' ? '↑' : '↓'}</span>}
              </button>
            )
          })}
          {readOnly ? (
            <div />
          ) : (
            <button
              type="button"
              onClick={onOpenFields}
              aria-label={t('fields.title')}
              title={t('fields.title')}
              data-print-hide
              className="flex items-center justify-center py-1.5 hover:bg-hover hover:text-ink"
            >
              <PlusIcon size={15} />
            </button>
          )}
        </div>

        {/* rows */}
        <div ref={listRef} style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
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
  )
}
