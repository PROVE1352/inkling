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
  type DragStartEvent,
} from '@dnd-kit/core'
import type {
  CollectionField,
  CollectionViewDTO,
  MemberDTO,
  RowDTO,
  ViewConfig,
} from '@inkling/shared'
import { fmtMonthYear, useT, weekdayNames } from '../../i18n'
import { applyView } from '../../lib/collection'
import { toISODate, todayISODate } from '../../lib/time'
import { useIsPhone } from '../../lib/useMediaQuery'
import { ChevronRightIcon, PlusIcon } from '../Icons'

// Values are 'YYYY-MM-DD' strings (M3 convention). Build them from local fields (toISODate) to
// avoid UTC drift, and do all matching/comparison on the strings (no toISOString / Date compares).

const MAX_CHIPS = 3
// On phones the 7 columns are squeezed to the screen width, so cells are narrow: 2 chips + "+N".
const MAX_CHIPS_PHONE = 2

type Cell = { date: string; day: number; inMonth: boolean; isToday: boolean }

const CalDnd = createContext<{ activeId: string | null; overDay: string | null }>({
  activeId: null,
  overDay: null,
})

// Row chip inside a day cell: draggable (moves the date), click opens the page.
function Chip({ row, wsId }: { row: RowDTO; wsId: string }) {
  const t = useT()
  const navigate = useNavigate()
  const { activeId } = useContext(CalDnd)
  const { setNodeRef, listeners, attributes } = useDraggable({ id: row.id })
  const dragging = activeId === row.id
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => navigate(`/w/${wsId}/p/${row.id}`)}
      title={row.title || t('common.untitled')}
      className={`cursor-pointer truncate rounded bg-accent-soft px-0.5 py-0.5 text-[10px] leading-tight text-accent hover:opacity-90 sm:px-1.5 sm:text-[11px] ${
        dragging ? 'opacity-40' : ''
      }`}
    >
      {row.title || t('common.untitled')}
    </div>
  )
}

function DayCell({
  cell,
  rows,
  wsId,
  onCreate,
}: {
  cell: Cell
  rows: RowDTO[]
  wsId: string
  onCreate: (date: string) => void
}) {
  const t = useT()
  const { overDay } = useContext(CalDnd)
  const { setNodeRef } = useDroppable({ id: `day:${cell.date}` })
  const active = overDay === cell.date
  const isPhone = useIsPhone()
  const shown = rows.slice(0, isPhone ? MAX_CHIPS_PHONE : MAX_CHIPS)
  const overflow = rows.length - shown.length

  return (
    <div
      ref={setNodeRef}
      className={`group/day flex min-h-[68px] min-w-0 flex-col gap-0.5 border-b border-r border-line p-0.5 sm:min-h-[92px] sm:gap-1 sm:p-1 ${
        cell.inMonth ? '' : 'bg-side/30'
      } ${active ? 'bg-accent-soft' : ''}`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] ${
            cell.isToday
              ? 'bg-accent font-semibold text-white'
              : cell.inMonth
                ? 'text-ink'
                : 'text-sub/60'
          }`}
        >
          {cell.day}
        </span>
        <button
          type="button"
          onClick={() => onCreate(cell.date)}
          aria-label={t('calendarView.newRowOnDate')}
          title={t('calendarView.newRowOnDate')}
          // Touch has no hover, so the button used to be tapped while invisible; keep it faintly visible.
          className="flex h-5 w-5 items-center justify-center rounded text-sub opacity-0 hover:bg-hover hover:text-ink group-hover/day:opacity-100 pointer-coarse:opacity-40"
        >
          <PlusIcon size={13} />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-0.5">
        {shown.map((row) => (
          <Chip key={row.id} row={row} wsId={wsId} />
        ))}
        {overflow > 0 && (
          <span className="px-0.5 text-[10px] text-sub sm:px-1 sm:text-[11px]">+{overflow}</span>
        )}
      </div>
    </div>
  )
}

export function CalendarView({
  view,
  fields,
  rows,
  wsId,
  onCommitProps,
  onUpdateConfig,
  onCreateRowOnDate,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  rows: RowDTO[]
  members?: MemberDTO[]
  wsId: string
  onCommitProps: (rowId: string, patch: Record<string, unknown>) => void
  onUpdateConfig: (config: ViewConfig) => void
  onCreateRowOnDate: (dateFieldId: string, date: string) => void
}) {
  const t = useT()
  // Month on screen (local time). {year, month0}
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overDay, setOverDay] = useState<string | null>(null)
  const sensors = useSensors(
    // Touch needs a long press to drag, so finger scrolling isn't swallowed as a card drag (same rule as AppDnd).
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )

  const dateField = fields.find(
    (f) => f.id === view.config.dateFieldId && f.type === 'date',
  )

  // date → rows (with the filter/sort config applied). Values that aren't 'YYYY-MM-DD' strings are ignored.
  const byDate = useMemo(() => {
    const map = new Map<string, RowDTO[]>()
    if (!dateField) return map
    for (const row of applyView(rows, fields, view.config)) {
      const v = row.props[dateField.id]
      if (typeof v !== 'string' || v === '') continue
      const arr = map.get(v)
      if (arr) arr.push(row)
      else map.set(v, [row])
    }
    return map
  }, [rows, fields, view.config, dateField])

  // Month grid cells (whole weeks). The grid starts on the Sunday of the week containing the 1st.
  const cells = useMemo<Cell[]>(() => {
    const { year, month } = cursor
    const first = new Date(year, month, 1)
    const startOffset = first.getDay() // 0=Sun … 6=Sat
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const total = startOffset + daysInMonth
    const weeks = Math.ceil(total / 7)
    const today = todayISODate()
    const out: Cell[] = []
    for (let i = 0; i < weeks * 7; i++) {
      // Date(year, month, dayNum) normalizes negative/overflowing dayNum in local time, so UTC never gets involved.
      const d = new Date(year, month, 1 - startOffset + i)
      const date = toISODate(d)
      out.push({
        date,
        day: d.getDate(),
        inMonth: d.getMonth() === month,
        isToday: date === today,
      })
    }
    return out
  }, [cursor])

  const goPrev = () =>
    setCursor((c) =>
      c.month === 0 ? { year: c.year - 1, month: 11 } : { ...c, month: c.month - 1 },
    )
  const goNext = () =>
    setCursor((c) =>
      c.month === 11 ? { year: c.year + 1, month: 0 } : { ...c, month: c.month + 1 },
    )
  const goToday = () => {
    const now = new Date()
    setCursor({ year: now.getFullYear(), month: now.getMonth() })
  }

  // ---- no (valid) date field → hint + picker dropdown ----
  if (!dateField) {
    const dateFields = fields.filter((f) => f.type === 'date')
    return (
      <div className="px-4 py-10 text-center">
        <p className="mb-3 text-sm text-sub">
          {t('calendarView.pickDatePrompt')}
        </p>
        {dateFields.length === 0 ? (
          <p className="text-xs text-sub">{t('calendarView.addDateFirst')}</p>
        ) : (
          <select
            value=""
            onChange={(e) =>
              e.target.value &&
              onUpdateConfig({ ...view.config, dateFieldId: e.target.value })
            }
            className="rounded border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus-visible:border-accent"
          >
            <option value="">{t('calendarView.pickDateField')}</option>
            {dateFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
    )
  }

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragCancel = () => {
    setActiveId(null)
    setOverDay(null)
  }
  const onDragEnd = (e: DragEndEvent) => {
    const rowId = String(e.active.id)
    const overId = e.over ? String(e.over.id) : null
    setActiveId(null)
    setOverDay(null)
    if (!overId || !overId.startsWith('day:')) return
    const date = overId.slice(4)
    const cur = rows.find((r) => r.id === rowId)?.props[dateField.id]
    if (cur === date) return // string compare: same date → no-op
    onCommitProps(rowId, { [dateField.id]: date })
  }

  return (
    <div className="mt-2">
      {/* header: navigation + today */}
      <div className="mb-2 flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={goPrev}
          aria-label={t('calendarView.prevMonth')}
          className="flex h-7 w-7 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
        >
          <span className="inline-flex rotate-180">
            <ChevronRightIcon size={16} />
          </span>
        </button>
        <div className="min-w-[92px] text-center text-sm font-medium text-ink">
          {fmtMonthYear(cursor.year, cursor.month)}
        </div>
        <button
          type="button"
          onClick={goNext}
          aria-label={t('calendarView.nextMonth')}
          className="flex h-7 w-7 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
        >
          <ChevronRightIcon size={16} />
        </button>
        <button
          type="button"
          onClick={goToday}
          className="ml-1 rounded-md border border-line px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
        >
          {t('common.today')}
        </button>
      </div>

      <CalDnd.Provider value={{ activeId, overDay }}>
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragOver={(e) => {
            const overId = e.over ? String(e.over.id) : null
            setOverDay(overId?.startsWith('day:') ? overId.slice(4) : null)
          }}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div className="overflow-x-auto">
            {/* Fit the 7 columns to the screen width instead of scrolling horizontally (weekdays used to get cut off on phones/tablets). */}
            <div className="min-w-0">
              {/* weekday header */}
              <div className="grid grid-cols-7 border-l border-t border-line">
                {weekdayNames('short').map((w, i) => (
                  <div
                    key={i}
                    className="border-b border-r border-line bg-side/40 px-1 py-1 text-center text-[11px] font-medium text-sub"
                  >
                    {w}
                  </div>
                ))}
              </div>
              {/* date grid */}
              <div className="grid grid-cols-7 border-l border-line">
                {cells.map((cell) => (
                  <DayCell
                    key={cell.date}
                    cell={cell}
                    rows={byDate.get(cell.date) ?? []}
                    wsId={wsId}
                    onCreate={(date) => onCreateRowOnDate(dateField.id, date)}
                  />
                ))}
              </div>
            </div>
          </div>
        </DndContext>
      </CalDnd.Provider>
    </div>
  )
}
