import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { CalendarEventDTO, DateItemKind } from '@inkling/shared'
import { useCalendar, useCreatePage, useQuickTask } from '../api'
import { useLayout } from '../components/AppLayout'
import { DayPopover } from '../components/DayPopover'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import {
  CalendarDayIcon,
  CalendarIcon,
  CalendarWeekIcon,
  CheckIcon,
  CheckSquareIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FileTextIcon,
  MenuIcon,
  PlusIcon,
} from '../components/Icons'
import { useDailyNote } from '../lib/dailyNote'
import {
  KIND_CHIP,
  KIND_DOT,
  KIND_LABEL,
  canReschedule,
  itemHref,
  itemKey,
  itemSource,
  useDateItemActions,
} from '../lib/dateItems'
import { newPageTarget } from '../lib/newPage'
import { getPrefs, setCalendarPref, usePrefs } from '../lib/prefs'
import { toISODate, todayISODate } from '../lib/time'
import { toast } from '../lib/toast'
import { useIsPhone } from '../lib/useMediaQuery'
import { fmtDate, fmtMonthYear, intlLocale, useT, weekdayNames } from '../i18n'

// Global calendar — collection rows (every date field) · page date properties · daily notes · tasks inside documents,
// all on one calendar. Month/week views, kind filters, click an empty day → task/new page/daily, drag a chip → reschedule.
// Values are matched and compared only as local 'YYYY-MM-DD' strings (M9/M17 convention; avoids UTC shifts).

// Week starts on Sunday (index 0), as before; weekday names come from Intl via weekdayNames().
const KINDS: DateItemKind[] = ['row', 'page', 'daily', 'task']

const MAX_CHIPS = 3
// On phones 7 cells must fit in 412px, so cells are narrow — 2 chips + "+N"; the full list is in the agenda below.
const MAX_CHIPS_PHONE = 2

type Cell = { date: string; day: number; inMonth: boolean; isToday: boolean }

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function addDays(ymd: string, n: number): string {
  const d = parseYmd(ymd)
  return toISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}

/** Week label, e.g. "Nov 1 – 7, 2026" (Intl range formatting, current locale). */
function fmtWeekRange(s: Date, e: Date): string {
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
  try {
    return new Intl.DateTimeFormat(intlLocale(), opts).formatRange(s, e)
  } catch {
    return `${fmtDate(s, opts)} – ${fmtDate(e, opts)}`
  }
}

const DnDState = createContext<{ activeKey: string | null; overDay: string | null }>({
  activeKey: null,
  overDay: null,
})

// Prevents the click from the same pointer right after a drag from opening the chip.
let lastDragEndAt = 0

function KindIcon({ kind, size = 12 }: { kind: DateItemKind; size?: number }) {
  if (kind === 'task') return <CheckSquareIcon size={size} />
  if (kind === 'daily') return <CalendarDayIcon size={size} />
  if (kind === 'row') return <DatabaseIcon size={size} />
  return <FileTextIcon size={size} />
}

// Item chip — colored by kind, done items struck through and dimmed; everything except daily notes can be dragged to another date.
// Don't add separate onMouseDown/onTouchStart to the element that spreads dnd-kit listeners (it would override the sensor handlers).
function ItemChip({
  item,
  wsId,
  compact,
}: {
  item: CalendarEventDTO
  wsId: string
  compact: boolean
}) {
  const navigate = useNavigate()
  const t = useT()
  const { activeKey } = useContext(DnDState)
  const key = itemKey(item)
  const draggable = canReschedule(item)
  const { setNodeRef, listeners, attributes } = useDraggable({
    id: key,
    data: { item },
    disabled: !draggable,
  })
  const label = item.title || t('common.untitled')
  const tip = `${label} · ${KIND_LABEL[item.kind]} · ${itemSource(item)}${
    draggable ? '' : ` ${t('calendar.notDraggable')}`
  }`
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...(draggable ? { ...attributes, ...listeners } : {})}
      data-chip
      data-kind={item.kind}
      data-done={item.done ? '1' : undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (Date.now() - lastDragEndAt < 250) return
        navigate(itemHref(wsId, item))
      }}
      title={tip}
      className={`flex w-full min-w-0 items-center gap-1 rounded px-0.5 py-0.5 text-left leading-tight transition-opacity hover:opacity-90 sm:px-1.5 ${
        compact ? 'text-[10px] sm:text-[11px]' : 'text-xs'
      } ${KIND_CHIP[item.kind]} ${item.done ? 'opacity-50' : ''} ${
        activeKey === key ? 'opacity-30' : ''
      } ${draggable ? 'touch-manipulation' : ''}`}
    >
      <span className={`shrink-0 leading-none ${compact ? 'max-sm:hidden' : ''}`}>
        {item.kind === 'task' ? (
          item.done ? (
            <CheckIcon size={12} />
          ) : (
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] border border-current" />
          )
        ) : item.icon ? (
          item.icon
        ) : (
          <KindIcon kind={item.kind} />
        )}
      </span>
      <span
        className={`min-w-0 flex-1 ${compact ? 'truncate' : 'line-clamp-2 break-words'} ${
          item.done ? 'line-through' : ''
        }`}
      >
        {label}
      </span>
    </button>
  )
}

// Shared by droppable day cells — clicking an empty area opens the popover.
function useDayDrop(date: string) {
  const { overDay } = useContext(DnDState)
  const { setNodeRef } = useDroppable({ id: `day:${date}` })
  return { setNodeRef, over: overDay === date }
}

function isEmptyAreaClick(e: React.MouseEvent): boolean {
  return !(e.target as HTMLElement).closest('[data-chip],button,a,input')
}

function MonthCell({
  cell,
  items,
  wsId,
  onOpenDay,
  onMore,
}: {
  cell: Cell
  items: CalendarEventDTO[]
  wsId: string
  onOpenDay: (date: string, el: HTMLElement) => void
  onMore: (date: string) => void
}) {
  const isPhone = useIsPhone()
  const t = useT()
  const { setNodeRef, over } = useDayDrop(cell.date)
  const shown = items.slice(0, isPhone ? MAX_CHIPS_PHONE : MAX_CHIPS)
  const overflow = items.length - shown.length
  return (
    <div
      ref={setNodeRef}
      data-day={cell.date}
      onClick={(e) => {
        if (isEmptyAreaClick(e)) onOpenDay(cell.date, e.currentTarget)
      }}
      className={`group/day flex min-h-[68px] min-w-0 cursor-pointer flex-col gap-0.5 border-b border-r border-line p-0.5 sm:min-h-[96px] sm:gap-1 sm:p-1 ${
        cell.inMonth ? '' : 'bg-side/30'
      } ${over ? 'bg-accent-soft' : ''}`}
    >
      <div className="flex items-center justify-between">
        {/* Day number = button that opens the popover from the keyboard (task/new page/daily) */}
        <button
          type="button"
          onClick={(e) => onOpenDay(cell.date, e.currentTarget.parentElement!.parentElement!)}
          aria-label={t('calendar.dayButton', { date: fmtDate(parseYmd(cell.date), { dateStyle: 'full' }) })}
          className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] hover:bg-hover ${
            cell.isToday
              ? 'bg-accent font-semibold text-white hover:bg-accent'
              : cell.inMonth
                ? 'text-ink'
                : 'text-sub/60'
          }`}
        >
          {cell.day}
        </button>
        <PlusIcon
          size={13}
          className="text-sub opacity-0 group-hover/day:opacity-100 max-sm:hidden"
          aria-hidden
        />
      </div>
      <div className="flex min-h-0 flex-col gap-0.5">
        {shown.map((it) => (
          <ItemChip key={itemKey(it)} item={it} wsId={wsId} compact />
        ))}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => onMore(cell.date)}
            title={t('calendar.showWeek')}
            className="self-start rounded px-0.5 text-[10px] text-sub hover:bg-hover hover:text-ink sm:px-1 sm:text-[11px]"
          >
            +{overflow}
          </button>
        )}
      </div>
    </div>
  )
}

// One day in week view (desktop/tablet: vertical column · phone: one row per date) — the list is never truncated.
function WeekDay({
  date,
  items,
  wsId,
  stacked,
  onOpenDay,
}: {
  date: string
  items: CalendarEventDTO[]
  wsId: string
  stacked: boolean
  onOpenDay: (date: string, el: HTMLElement) => void
}) {
  const t = useT()
  const { setNodeRef, over } = useDayDrop(date)
  const d = parseYmd(date)
  const isToday = date === todayISODate()
  const head = (
    <div className={`flex items-center gap-1.5 ${stacked ? '' : 'justify-center'}`}>
      <span className={`text-[11px] ${d.getDay() === 0 ? 'text-red-500/80' : 'text-sub'}`}>
        {weekdayNames('short')[d.getDay()]}
      </span>
      <button
        type="button"
        onClick={(e) => onOpenDay(date, e.currentTarget)}
        aria-label={t('calendar.dayButton', { date: fmtDate(d, { dateStyle: 'full' }) })}
        className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs hover:bg-hover ${
          isToday ? 'bg-accent font-semibold text-white hover:bg-accent' : 'text-ink'
        }`}
      >
        {d.getDate()}
      </button>
      {stacked && (
        <span className="text-xs text-sub">
          {fmtDate(d, { month: 'long' })}
          {isToday ? ` · ${t('common.today')}` : ''}
        </span>
      )}
    </div>
  )
  return (
    <div
      ref={setNodeRef}
      data-day={date}
      onClick={(e) => {
        if (isEmptyAreaClick(e)) onOpenDay(date, e.currentTarget)
      }}
      className={`flex min-w-0 cursor-pointer flex-col gap-1 border-line p-1.5 ${
        stacked ? 'border-b' : 'min-h-[60vh] border-r'
      } ${over ? 'bg-accent-soft' : isToday && !stacked ? 'bg-accent-soft/40' : ''}`}
    >
      {head}
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <ItemChip key={itemKey(it)} item={it} wsId={wsId} compact={false} />
        ))}
        {items.length === 0 && stacked && (
          <span className="px-1 text-[11px] text-sub/70">{t('calendar.emptyDay')}</span>
        )}
      </div>
    </div>
  )
}

// Phone only (below sm): list under the month view — every title (truncated in the narrow cells) in date order.
function Agenda({ items, wsId }: { items: CalendarEventDTO[]; wsId: string }) {
  const navigate = useNavigate()
  const t = useT()
  const groups = useMemo(() => {
    const m = new Map<string, CalendarEventDTO[]>()
    for (const ev of items) {
      const arr = m.get(ev.date)
      if (arr) arr.push(ev)
      else m.set(ev.date, [ev])
    }
    return [...m.entries()]
  }, [items])
  const today = todayISODate()
  if (groups.length === 0) {
    return <p className="mt-4 text-center text-xs text-sub sm:hidden">{t('calendar.emptyRange')}</p>
  }
  return (
    <div className="mt-4 flex flex-col gap-3 sm:hidden">
      {groups.map(([date, evs]) => {
        const d = parseYmd(date)
        return (
          <section key={date}>
            <h3 className={`mb-1 text-xs font-semibold ${date === today ? 'text-accent' : 'text-sub'}`}>
              {fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}
              {date === today ? ` · ${t('common.today')}` : ''}
            </h3>
            <ul className="overflow-hidden rounded-md border border-line">
              {evs.map((ev) => (
                <li key={itemKey(ev)} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => navigate(itemHref(wsId, ev))}
                    className={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-hover ${
                      ev.done ? 'opacity-50' : ''
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${KIND_DOT[ev.kind]}`} aria-hidden />
                    <span className={`min-w-0 flex-1 truncate ${ev.done ? 'line-through' : ''}`}>
                      {ev.title || t('common.untitled')}
                    </span>
                    <span className="max-w-[40%] shrink-0 truncate text-xs text-sub">{itemSource(ev)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

export function GlobalCalendar() {
  const { wsId } = useParams()
  const ws = wsId ?? ''
  const navigate = useNavigate()
  const t = useT()
  const { onToggleSidebar } = useLayout()
  const { openDaily, busy } = useDailyNote(ws)
  const prefs = usePrefs().calendar
  const view = prefs.view
  const isPhone = useIsPhone()
  const quickTask = useQuickTask(ws)
  const createPage = useCreatePage(ws)
  const { reschedule } = useDateItemActions(ws)

  // Anchor date (local YYYY-MM-DD). Month view shows its month; week view shows the week containing it (Sun–Sat).
  const [anchor, setAnchor] = useState(() => todayISODate())

  const { cells, from, to, label } = useMemo(() => {
    const a = parseYmd(anchor)
    const today = todayISODate()
    if (view === 'week') {
      const start = addDays(anchor, -a.getDay())
      const end = addDays(start, 6)
      const out: Cell[] = []
      for (let i = 0; i < 7; i++) {
        const date = addDays(start, i)
        const d = parseYmd(date)
        out.push({ date, day: d.getDate(), inMonth: true, isToday: date === today })
      }
      const s = parseYmd(start)
      const e = parseYmd(end)
      const lbl = fmtWeekRange(s, e)
      return { cells: out, from: start, to: end, label: lbl }
    }
    const year = a.getFullYear()
    const month = a.getMonth()
    const startOffset = new Date(year, month, 1).getDay() // 0=Sun … 6=Sat
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const weeks = Math.ceil((startOffset + daysInMonth) / 7)
    const out: Cell[] = []
    for (let i = 0; i < weeks * 7; i++) {
      // Date(year, month, dayNum) normalizes negative/overflowing dayNum locally → no UTC involved.
      const d = new Date(year, month, 1 - startOffset + i)
      const date = toISODate(d)
      out.push({ date, day: d.getDate(), inMonth: d.getMonth() === month, isToday: date === today })
    }
    return {
      cells: out,
      from: out[0].date,
      to: out[out.length - 1].date,
      label: fmtMonthYear(year, month),
    }
  }, [anchor, view])

  const calendar = useCalendar(ws, from, to)
  const all = useMemo(() => calendar.data ?? [], [calendar.data])

  // Date → items, after applying the filters (kind, show done)
  const visible = useMemo(
    () => all.filter((ev) => prefs[ev.kind] && (prefs.showDone || !ev.done)),
    [all, prefs],
  )
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEventDTO[]>()
    for (const ev of visible) {
      const arr = map.get(ev.date)
      if (arr) arr.push(ev)
      else map.set(ev.date, [ev])
    }
    return map
  }, [visible])
  const counts = useMemo(() => {
    const c: Record<DateItemKind, number> = { row: 0, page: 0, daily: 0, task: 0 }
    for (const ev of all) c[ev.kind]++
    return c
  }, [all])

  const step = (dir: 1 | -1) => {
    if (view === 'week') setAnchor((a) => addDays(a, dir * 7))
    else
      setAnchor((a) => {
        const d = parseYmd(a)
        return toISODate(new Date(d.getFullYear(), d.getMonth() + dir, 1))
      })
  }

  // ---- Empty-day popover ----
  const [pop, setPop] = useState<{ date: string; rect: DOMRect | null } | null>(null)
  const onOpenDay = useCallback((date: string, el: HTMLElement) => {
    setPop({ date, rect: el.getBoundingClientRect() })
  }, [])
  const closePop = useCallback(() => setPop(null), [])

  const onQuickTask = async (title: string) => {
    if (!pop) return
    const date = pop.date
    try {
      const r = await quickTask.mutateAsync({ title, date })
      toast({
        message: t('calendar.taskAdded', { title }),
        actionLabel: t('calendar.openDoc'),
        onAction: () =>
          navigate(`/w/${ws}/p/${r.pageId}${r.blockId ? `?block=${encodeURIComponent(r.blockId)}` : ''}`),
      })
    } catch (err) {
      toast({
        message:
          err instanceof Error
            ? t('calendar.taskAddFailedWith', { error: err.message })
            : t('calendar.taskAddFailed'),
      })
      throw err
    }
  }

  const onNewPage = (title: string) => {
    if (!pop || createPage.isPending) return
    const date = pop.date
    // Follows the "New page location" setting — the calendar has no current page, so top level.
    const target = newPageTarget(getPrefs().newPageLocation, undefined)
    createPage.mutate(
      { workspaceId: ws, ...target, title, date },
      {
        onSuccess: (page) => {
          setPop(null)
          navigate(`/w/${ws}/p/${page.id}`)
        },
        onError: (err) => toast({ message: t('calendar.pageCreateFailed', { error: err.message }) }),
      },
    )
  }

  // ---- Drag to reschedule ----
  const sensors = useSensors(
    // Touch needs a long press to drag — so finger scrolling isn't swallowed by chip drags (same rule as AppDnd).
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
  const [active, setActive] = useState<CalendarEventDTO | null>(null)
  const [overDay, setOverDay] = useState<string | null>(null)
  const onDragStart = (e: DragStartEvent) => {
    setActive((e.active.data.current?.item as CalendarEventDTO | undefined) ?? null)
  }
  const endDrag = () => {
    lastDragEndAt = Date.now()
    setActive(null)
    setOverDay(null)
  }
  const onDragEnd = (e: DragEndEvent) => {
    const item = e.active.data.current?.item as CalendarEventDTO | undefined
    const overId = e.over ? String(e.over.id) : null
    endDrag()
    if (!item || !overId?.startsWith('day:')) return
    void reschedule(item, overId.slice(4))
  }

  const dayProps = { wsId: ws, onOpenDay }
  const hasDaily = pop ? all.some((e) => e.kind === 'daily' && e.date === pop.date) : false

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('calendar.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink">
          <CalendarIcon size={16} className="text-sub" />
          <span className="font-medium">{t('calendar.title')}</span>
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto max-w-6xl px-2 py-4 sm:px-6 sm:py-6">
          {/* Row 1: navigation + Today + Month/Week */}
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label={view === 'week' ? t('calendar.prevWeek') : t('calendar.prevMonth')}
              className="flex h-7 w-7 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
            >
              <span className="inline-flex rotate-180">
                <ChevronRightIcon size={16} />
              </span>
            </button>
            <div className="min-w-[104px] text-center text-sm font-medium text-ink" data-testid="cal-label">
              {label}
            </div>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label={view === 'week' ? t('calendar.nextWeek') : t('calendar.nextMonth')}
              className="flex h-7 w-7 items-center justify-center rounded text-sub hover:bg-hover hover:text-ink"
            >
              <ChevronRightIcon size={16} />
            </button>
            <button
              type="button"
              onClick={() => setAnchor(todayISODate())}
              className="ml-1 rounded-md border border-line px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            >
              {t('common.today')}
            </button>
            {calendar.isFetching && (
              <span className="ml-1 inline-flex">
                <Spinner size={14} />
              </span>
            )}
            <div className="ml-auto inline-flex rounded-md border border-line p-0.5" role="group" aria-label={t('calendar.viewLabel')}>
              {(['month', 'week'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setCalendarPref('view', v)}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors ${
                    view === v ? 'bg-accent-soft font-medium text-accent' : 'text-sub hover:bg-hover hover:text-ink'
                  }`}
                >
                  {v === 'month' ? <CalendarIcon size={13} /> : <CalendarWeekIcon size={13} />}
                  {v === 'month' ? t('calendar.month') : t('calendar.week')}
                </button>
              ))}
            </div>
          </div>

          {/* Row 2: legend doubling as kind filter + show done */}
          <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('calendar.filterLabel')}>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={prefs[k]}
                onClick={() => setCalendarPref(k, !prefs[k])}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  prefs[k] ? 'border-line text-ink' : 'border-dashed border-line text-sub/60 line-through'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${KIND_DOT[k]} ${prefs[k] ? '' : 'opacity-40'}`} aria-hidden />
                {KIND_LABEL[k]}
                <span className="text-sub">{counts[k]}</span>
              </button>
            ))}
            <button
              type="button"
              aria-pressed={prefs.showDone}
              onClick={() => setCalendarPref('showDone', !prefs.showDone)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                prefs.showDone ? 'border-line text-ink' : 'border-dashed border-line text-sub/60'
              }`}
            >
              <CheckIcon size={12} />
              {t('calendar.showDone')}
            </button>
          </div>

          {calendar.isError ? (
            <p className="py-10 text-center text-sm text-sub">{t('calendar.loadFailed')}</p>
          ) : (
            <DnDState.Provider value={{ activeKey: active ? itemKey(active) : null, overDay }}>
              <DndContext
                sensors={sensors}
                onDragStart={onDragStart}
                onDragOver={(e) => {
                  const overId = e.over ? String(e.over.id) : null
                  setOverDay(overId?.startsWith('day:') ? overId.slice(4) : null)
                }}
                onDragEnd={onDragEnd}
                onDragCancel={endDrag}
              >
                {view === 'month' ? (
                  <div className="min-w-0">
                    {/* Weekday header — the 7 cells fit the screen width (no horizontal scroll) */}
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
                    <div className="grid grid-cols-7 border-l border-line" data-testid="month-grid">
                      {cells.map((cell) => (
                        <MonthCell
                          key={cell.date}
                          cell={cell}
                          items={byDate.get(cell.date) ?? []}
                          onMore={(date) => {
                            setAnchor(date)
                            setCalendarPref('view', 'week')
                          }}
                          {...dayProps}
                        />
                      ))}
                    </div>
                  </div>
                ) : isPhone ? (
                  // Phone week view: days stacked vertically (7 columns don't fit in 412px).
                  <div className="overflow-hidden rounded-md border border-line" data-testid="week-grid">
                    {cells.map((cell) => (
                      <WeekDay key={cell.date} date={cell.date} items={byDate.get(cell.date) ?? []} stacked {...dayProps} />
                    ))}
                  </div>
                ) : (
                  // Tablet/desktop week view: 7 columns. When narrow, scroll horizontally inside this container only.
                  <div className="overflow-x-auto rounded-md border-l border-t border-line">
                    <div className="grid min-w-[700px] grid-cols-7" data-testid="week-grid">
                      {cells.map((cell) => (
                        <WeekDay
                          key={cell.date}
                          date={cell.date}
                          items={byDate.get(cell.date) ?? []}
                          stacked={false}
                          {...dayProps}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <DragOverlay dropAnimation={null}>
                  {active ? (
                    <div
                      className={`max-w-[200px] truncate rounded px-1.5 py-0.5 text-xs shadow-lg ${KIND_CHIP[active.kind]}`}
                    >
                      {active.title || t('common.untitled')}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </DnDState.Provider>
          )}

          {!calendar.isError && view === 'month' && <Agenda items={visible} wsId={ws} />}
          <p className="mt-4 text-[11px] text-sub max-sm:hidden">
            {t('calendar.help')} <code>{t('calendar.helpExample1')}</code>, <code>9/30</code>,{' '}
            <code>{t('calendar.helpExample3')}</code>.
          </p>
        </div>
      </div>

      {pop && (
        <DayPopover
          key={pop.date}
          date={pop.date}
          anchor={pop.rect}
          sheet={isPhone}
          hasDaily={hasDaily}
          busy={busy || createPage.isPending}
          onClose={closePop}
          onQuickTask={onQuickTask}
          onNewPage={onNewPage}
          onOpenDaily={() => {
            const d = pop.date
            setPop(null)
            openDaily(d)
          }}
        />
      )}
    </div>
  )
}
