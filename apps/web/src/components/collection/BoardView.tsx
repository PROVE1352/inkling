import { createContext, useContext, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type {
  CollectionField,
  CollectionViewDTO,
  MemberDTO,
  RowDTO,
  ViewConfig,
} from '@inkling/shared'
import { useT } from '../../i18n'
import { applyView, orderedFields } from '../../lib/collection'
import { midOrder } from '../../lib/sortOrder'
import { OPTION_DOT_CLASS } from '../../lib/optionColors'
import { PlusIcon } from '../Icons'
import { FieldValue } from './cells/FieldValue'
import { useCollectionReadOnly } from './readOnlyContext'
import { S } from './strings'

// Cards rendered per column before "Show more" (docs/adr/0709-*). A 10 000-row board rendered
// every card: 51 k DOM nodes and ~5.7 s of long tasks to open the view.
const BOARD_PAGE = 50

const NONE = '__none__'
const colDropId = (key: string) => `col:${key}`

type Column = { key: string; label: string; color?: string; rows: RowDTO[] }

const BoardDnd = createContext<{ activeId: string | null; overCol: string | null }>({
  activeId: null,
  overCol: null,
})

function Card({
  row,
  wsId,
  cardFields,
  members,
}: {
  row: RowDTO
  wsId: string
  cardFields: CollectionField[]
  members?: MemberDTO[]
}) {
  const t = useT()
  const navigate = useNavigate()
  const { activeId } = useContext(BoardDnd)
  const readOnly = useCollectionReadOnly()
  const { setNodeRef, listeners, attributes } = useDraggable({ id: row.id, disabled: readOnly })
  const { setNodeRef: setDrop } = useDroppable({ id: row.id })
  const dragging = activeId === row.id

  const shown = cardFields
    .filter((f) => {
      const v = row.props[f.id]
      return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)
    })
    .slice(0, 2)

  return (
    <div
      ref={(el) => {
        setNodeRef(el)
        setDrop(el)
      }}
      data-card-id={row.id}
      {...listeners}
      {...attributes}
      onClick={() => navigate(`/w/${wsId}/p/${row.id}`)}
      className={`cursor-pointer rounded-md border border-line bg-app p-2 shadow-sm hover:border-sub ${
        dragging ? 'opacity-40' : ''
      }`}
    >
      <div className="truncate text-sm font-medium text-ink">
        {row.title || t('common.untitled')}
      </div>
      {shown.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {shown.map((f) => (
            <div key={f.id} className="min-w-0">
              <FieldValue field={f} value={row.props[f.id]} members={members} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ColumnView({
  col,
  wsId,
  cardFields,
  members,
  onCreate,
}: {
  col: Column
  wsId: string
  cardFields: CollectionField[]
  members?: MemberDTO[]
  onCreate: () => void
}) {
  const t = useT()
  const { overCol } = useContext(BoardDnd)
  const readOnly = useCollectionReadOnly()
  const { setNodeRef } = useDroppable({ id: colDropId(col.key) })
  const active = overCol === col.key
  const [limit, setLimit] = useState(BOARD_PAGE)
  const visible = col.rows.length > limit ? col.rows.slice(0, limit) : col.rows
  const hidden = col.rows.length - visible.length

  return (
    <div className="flex w-64 shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        {col.color ? (
          <span className={`h-2.5 w-2.5 rounded-full ${OPTION_DOT_CLASS[col.color as keyof typeof OPTION_DOT_CLASS]}`} />
        ) : (
          <span className="h-2.5 w-2.5 rounded-full bg-gray-300 dark:bg-gray-600" />
        )}
        <span className="text-sm font-medium text-ink">{col.label}</span>
        <span className="text-xs text-sub">{col.rows.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[60px] flex-1 flex-col gap-2 rounded-md p-1.5 ${
          active ? 'bg-accent-soft' : 'bg-side/40'
        }`}
      >
        {visible.map((row) => (
          <Card
            key={row.id}
            row={row}
            wsId={wsId}
            cardFields={cardFields}
            members={members}
          />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setLimit((l) => l + BOARD_PAGE)}
            className="rounded-md px-1.5 py-1 text-left text-xs text-sub hover:bg-hover hover:text-ink"
          >
            {S.boardShowMore(Math.min(hidden, BOARD_PAGE))}
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            onClick={onCreate}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs text-sub hover:bg-hover hover:text-ink"
          >
            <PlusIcon size={13} /> {t('table.newRow')}
          </button>
        )}
      </div>
    </div>
  )
}

export function BoardView({
  view,
  fields,
  rows,
  members,
  wsId,
  onCommitProps,
  onUpdateConfig,
  onCreateRowInColumn,
  onReorderRow,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  rows: RowDTO[]
  members?: MemberDTO[]
  wsId: string
  onCommitProps: (rowId: string, patch: Record<string, unknown>) => void
  onUpdateConfig: (config: ViewConfig) => void
  onCreateRowInColumn: (optionId: string | null) => void
  onReorderRow: (rowId: string, sortOrder: number) => void
}) {
  const t = useT()
  const readOnly = useCollectionReadOnly()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const sensors = useSensors(
    // Touch needs a long press to drag, so finger scrolling isn't swallowed as a card drag (same rule as AppDnd).
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )

  const groupField = fields.find(
    (f) => f.id === view.config.groupByFieldId && f.type === 'select',
  )

  const cardFields = useMemo(
    () => orderedFields(fields, view.config).filter((f) => f.id !== groupField?.id),
    [fields, view.config, groupField?.id],
  )

  // Apply filters (+ sortOrder order when no sort is configured)
  const ordered = useMemo(() => {
    const base = applyView(rows, fields, view.config)
    return view.config.sorts?.length
      ? base
      : [...base].sort((a, b) => a.sortOrder - b.sortOrder)
  }, [rows, fields, view.config])

  const columns = useMemo<Column[]>(() => {
    if (!groupField) return []
    const optionIds = new Set((groupField.options ?? []).map((o) => o.id))
    const groupOf = (r: RowDTO): string => {
      const v = r.props[groupField.id]
      return typeof v === 'string' && optionIds.has(v) ? v : NONE
    }
    const cols: Column[] = (groupField.options ?? []).map((o) => ({
      key: o.id,
      label: o.name,
      color: o.color,
      rows: [],
    }))
    cols.push({ key: NONE, label: t('board.noGroup'), rows: [] })
    const byKey = new Map(cols.map((c) => [c.key, c]))
    for (const r of ordered) byKey.get(groupOf(r))!.rows.push(r)
    return cols
  }, [groupField, ordered, t])

  // No group field → hint + select-field picker
  if (!groupField) {
    const selectFields = fields.filter((f) => f.type === 'select')
    return (
      <div className="px-4 py-10 text-center">
        <p className="mb-3 text-sm text-sub">
          {t('board.pickGroupPrompt')}
        </p>
        {selectFields.length === 0 ? (
          <p className="text-xs text-sub">{t('board.noSelectFields')}</p>
        ) : (
          <select
            value=""
            disabled={readOnly}
            onChange={(e) =>
              e.target.value &&
              onUpdateConfig({ ...view.config, groupByFieldId: e.target.value })
            }
            className="rounded border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus-visible:border-accent"
          >
            <option value="">{t('board.pickGroupField')}</option>
            {selectFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
    )
  }

  const rowColKey = new Map<string, string>()
  for (const c of columns) for (const r of c.rows) rowColKey.set(r.id, c.key)

  const resolve = (
    e: DragMoveEvent | DragEndEvent,
  ): { colKey: string; beforeId: string | null } | null => {
    const oId = e.over ? String(e.over.id) : null
    if (!oId) return null
    if (oId.startsWith('col:')) return { colKey: oId.slice(4), beforeId: null }
    // Over a card: that card's column + before/after
    const colKey = rowColKey.get(oId)
    if (colKey === undefined) return null
    const el = document.querySelector<HTMLElement>(`[data-card-id="${oId}"]`)
    if (!el) return { colKey, beforeId: oId }
    const rect = el.getBoundingClientRect()
    const ev = e.activatorEvent as PointerEvent
    const baseY = typeof ev?.clientY === 'number' ? ev.clientY : rect.top
    const ptrY = baseY + e.delta.y
    const after = (ptrY - rect.top) / rect.height > 0.5
    const colRows = columns.find((c) => c.key === colKey)!.rows
    const idx = colRows.findIndex((r) => r.id === oId)
    if (!after) return { colKey, beforeId: oId }
    const next = colRows[idx + 1]
    return { colKey, beforeId: next ? next.id : null }
  }

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragMove = (e: DragMoveEvent) => {
    const r = resolve(e)
    setOverCol(r?.colKey ?? null)
  }
  const onDragCancel = () => {
    setActiveId(null)
    setOverCol(null)
  }
  const onDragEnd = (e: DragEndEvent) => {
    const aId = String(e.active.id)
    const r = resolve(e)
    setActiveId(null)
    setOverCol(null)
    if (!r) return
    const targetOption = r.colKey === NONE ? null : r.colKey

    // group change
    const curCol = rowColKey.get(aId)
    const curOption = curCol === NONE ? null : curCol
    if (curOption !== targetOption) {
      onCommitProps(aId, { [groupField.id]: targetOption })
    }

    // compute order (target column without the dragged card)
    const colRows = columns
      .find((c) => c.key === r.colKey)!
      .rows.filter((row) => row.id !== aId)
    let idx = r.beforeId ? colRows.findIndex((row) => row.id === r.beforeId) : colRows.length
    if (idx < 0) idx = colRows.length
    const prev = colRows[idx - 1]?.sortOrder
    const next = colRows[idx]?.sortOrder
    onReorderRow(aId, midOrder(prev, next))
  }

  return (
    <BoardDnd.Provider value={{ activeId, overCol }}>
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="nd-wide-scroll flex gap-3 overflow-x-auto px-1 py-2">
          {columns.map((col) => (
            <ColumnView
              key={col.key}
              col={col}
              wsId={wsId}
              cardFields={cardFields}
              members={members}
              onCreate={() =>
                onCreateRowInColumn(col.key === NONE ? null : col.key)
              }
            />
          ))}
        </div>
      </DndContext>
    </BoardDnd.Provider>
  )
}
