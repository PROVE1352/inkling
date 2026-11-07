import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate } from 'react-router'
import type { CollectionField, CollectionViewDTO, RowDTO, ViewConfig } from '@inkling/shared'
import { fmtDate, monthNames } from '../../i18n'
import { applyView } from '../../lib/collection'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { useCollectionReadOnly } from './readOnlyContext'
import { S } from './strings'

type Zoom = NonNullable<ViewConfig['zoom']>

const ROW_H = 34
const HEADER_H = 32
const TITLE_W = 220
const PX_PER_DAY: Record<Zoom, number> = { day: 36, week: 14, month: 4 }
/** padding (days) around the data range */
const PAD: Record<Zoom, [number, number]> = { day: [7, 28], week: [28, 90], month: [62, 240] }
const MAX_SPAN_DAYS = 3660
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// UTC day numbers keep the math free of DST/timezone drift.
const dayNum = (ymd: string) =>
  Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86_400_000)
const fromDayNum = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10)
/** Day number → localized label (Intl options), formatted at local midnight of that date. */
const fmtDay = (n: number, opts: Intl.DateTimeFormatOptions) => {
  const ymd = fromDayNum(n)
  return fmtDate(new Date(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)), opts)
}
const todayNum = () => {
  const d = new Date()
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
}

type Drag = {
  rowId: string
  mode: 'move' | 'start' | 'end'
  originX: number
  start: number
  end: number
  delta: number
  moved: boolean
}

export function TimelineView({
  view,
  fields,
  rows,
  wsId,
  onCommitProps,
  onUpdateConfig,
}: {
  view: CollectionViewDTO
  fields: CollectionField[]
  rows: RowDTO[]
  wsId: string
  onCommitProps: (rowId: string, patch: Record<string, unknown>) => void
  onUpdateConfig: (config: ViewConfig) => void
}) {
  const navigate = useNavigate()
  const readOnly = useCollectionReadOnly()
  const config = view.config
  // Read-only: zoom is kept locally (the saved view config is a page write the lock denies).
  const [localZoom, setLocalZoom] = useState<Zoom | null>(null)
  const zoom: Zoom = (readOnly ? localZoom : null) ?? config.zoom ?? 'week'
  const ppd = PX_PER_DAY[zoom]
  const dateFields = fields.filter((f) => f.type === 'date')
  const startF = dateFields.find((f) => f.id === config.startFieldId) ?? dateFields[0]
  const endF = dateFields.find((f) => f.id === config.endFieldId && f.id !== startF?.id)

  const display = useMemo(() => applyView(rows, fields, config), [rows, fields, config])

  const spanOf = (row: RowDTO): [number, number] | null => {
    if (!startF) return null
    const s = row.props[startF.id]
    if (typeof s !== 'string' || !DATE_RE.test(s)) return null
    const a = dayNum(s)
    const e = endF ? row.props[endF.id] : undefined
    const b = typeof e === 'string' && DATE_RE.test(e) ? dayNum(e) : a
    return b < a ? [a, a] : [a, b]
  }

  // visible date range: data extent ∪ today, padded, capped
  const [rangeStart, rangeEnd] = useMemo(() => {
    let lo = todayNum()
    let hi = lo
    for (const r of display) {
      const sp = spanOf(r)
      if (!sp) continue
      if (sp[0] < lo) lo = sp[0]
      if (sp[1] > hi) hi = sp[1]
    }
    lo -= PAD[zoom][0]
    hi += PAD[zoom][1]
    if (hi - lo > MAX_SPAN_DAYS) {
      const t = todayNum()
      lo = Math.max(lo, t - MAX_SPAN_DAYS / 2)
      hi = lo + MAX_SPAN_DAYS
    }
    // align to Monday (day 0 of the epoch is a Thursday → +3)
    lo -= (lo + 3) % 7
    return [lo, hi]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, zoom, startF?.id, endF?.id])
  const totalDays = rangeEnd - rangeStart + 1
  const trackW = totalDays * ppd

  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const win = useWindowedRows({ count: display.length, rowHeight: ROW_H, listRef, scrollRef, threshold: 60 })

  // horizontal window for header labels
  const [scrollX, setScrollX] = useState(0)
  const [viewW, setViewW] = useState(800)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrollX(el.scrollLeft)
      })
    }
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const scrollToToday = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, (todayNum() - rangeStart) * ppd - (el.clientWidth - TITLE_W) / 3)
  }
  // start at "today" when the view or zoom changes
  useLayoutEffect(scrollToToday, [view.id, zoom]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- header ticks (only the visible slice) ----
  const ticks = useMemo(() => {
    const out: { x: number; label: string; strong: boolean }[] = []
    const months = monthNames('short')
    const monthDay: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
    const firstDay = rangeStart + Math.max(0, Math.floor((scrollX - TITLE_W) / ppd) - 40)
    const lastDay = Math.min(rangeEnd, rangeStart + Math.ceil((scrollX + viewW) / ppd) + 40)
    for (let n = firstDay; n <= lastDay; n++) {
      const ymd = fromDayNum(n)
      const d = +ymd.slice(8, 10)
      const m = +ymd.slice(5, 7) - 1
      const x = (n - rangeStart) * ppd
      if (zoom === 'day') out.push({ x, label: d === 1 ? fmtDay(n, monthDay) : String(d), strong: d === 1 })
      else if (zoom === 'week' && (n + 3) % 7 === 0) out.push({ x, label: fmtDay(n, monthDay), strong: d <= 7 })
      else if (zoom === 'month' && d === 1)
        out.push({ x, label: m === 0 ? fmtDay(n, { year: 'numeric', month: 'short' }) : months[m], strong: m === 0 })
    }
    return out
  }, [rangeStart, rangeEnd, scrollX, viewW, ppd, zoom])

  const gridBg =
    zoom === 'day'
      ? `repeating-linear-gradient(to right, var(--color-line, rgba(127,127,127,.18)) 0 1px, transparent 1px ${ppd}px)`
      : `repeating-linear-gradient(to right, var(--color-line, rgba(127,127,127,.18)) 0 1px, transparent 1px ${ppd * 7}px)`

  // ---- drag ----
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag

  const begin = (e: ReactPointerEvent, row: RowDTO, mode: Drag['mode'], sp: [number, number]) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ rowId: row.id, mode, originX: e.clientX, start: sp[0], end: sp[1], delta: 0, moved: false })
  }
  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const delta = Math.round((e.clientX - d.originX) / ppd)
    if (delta !== d.delta || (!d.moved && Math.abs(e.clientX - d.originX) > 3))
      setDrag({ ...d, delta, moved: d.moved || Math.abs(e.clientX - d.originX) > 3 })
  }
  const previewSpan = (d: Drag): [number, number] => {
    if (d.mode === 'move') return [d.start + d.delta, d.end + d.delta]
    if (d.mode === 'start') return [Math.min(d.start + d.delta, d.end), d.end]
    return [d.start, Math.max(d.end + d.delta, d.start)]
  }
  const end = (row: RowDTO) => {
    const d = dragRef.current
    // pointerup bubbles from a resize handle to the bar — consume the drag exactly once
    dragRef.current = null
    setDrag(null)
    if (!d || !startF) return
    if (!d.moved) {
      navigate(`/w/${wsId}/p/${row.id}`)
      return
    }
    if (d.delta === 0) return
    const [a, b] = previewSpan(d)
    const patch: Record<string, unknown> = { [startF.id]: fromDayNum(a) }
    if (endF) patch[endF.id] = fromDayNum(b)
    onCommitProps(row.id, patch)
  }

  const schedule = (e: ReactPointerEvent<HTMLDivElement>, row: RowDTO) => {
    if (!startF) return
    const rect = e.currentTarget.getBoundingClientRect()
    const day = rangeStart + Math.floor((e.clientX - rect.left) / ppd)
    const patch: Record<string, unknown> = { [startF.id]: fromDayNum(day) }
    if (endF) patch[endF.id] = fromDayNum(day + (zoom === 'day' ? 0 : zoom === 'week' ? 2 : 6))
    onCommitProps(row.id, patch)
  }

  if (!startF) {
    return <p className="px-2 py-10 text-center text-sm text-sub">{S.timelineNoDateField}</p>
  }

  const visible = display.slice(win.start, win.end)
  const todayX = (todayNum() - rangeStart) * ppd
  const bodyH = display.length * ROW_H

  return (
    <div className="pt-2">
      <div className="mb-2 flex items-center gap-1" data-print-hide>
        <span className="mr-1 text-xs text-sub">{S.timelineZoom}</span>
        {(['day', 'week', 'month'] as const).map((z) => (
          <button
            key={z}
            type="button"
            onClick={() => (readOnly ? setLocalZoom(z) : onUpdateConfig({ ...config, zoom: z }))}
            className={`rounded border px-2 py-0.5 text-xs ${
              zoom === z ? 'border-accent bg-accent-soft text-accent' : 'border-line text-sub hover:bg-hover'
            }`}
          >
            {z === 'day' ? S.zoomDay : z === 'week' ? S.zoomWeek : S.zoomMonth}
          </button>
        ))}
        <button
          type="button"
          onClick={scrollToToday}
          className="ml-2 rounded border border-line px-2 py-0.5 text-xs text-sub hover:bg-hover"
        >
          {S.today}
        </button>
      </div>

      <div
        ref={scrollRef}
        className="nd-timeline relative overflow-auto rounded-md border border-line"
        style={{ height: Math.min(HEADER_H + bodyH + 2, Math.round(window.innerHeight * 0.7)) }}
      >
        <div style={{ width: TITLE_W + trackW }} className="relative">
          {/* header */}
          <div className="sticky top-0 z-20 flex border-b border-line bg-app" style={{ height: HEADER_H }}>
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-line bg-app px-2.5 py-1.5 text-xs font-medium text-sub"
              style={{ width: TITLE_W }}
            >
              {startF.name}
              {endF ? ` → ${endF.name}` : ''}
            </div>
            <div className="relative" style={{ width: trackW }}>
              {ticks.map((t) => (
                <span
                  key={t.x}
                  className={`absolute top-0 whitespace-nowrap border-l border-line px-1 pt-1.5 text-[11px] ${
                    t.strong ? 'font-semibold text-ink' : 'text-sub'
                  }`}
                  style={{ left: t.x, height: HEADER_H }}
                >
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          {/* rows */}
          <div ref={listRef} className="relative" style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
            {visible.map((row) => {
              const base = spanOf(row)
              const live = drag && drag.rowId === row.id ? previewSpan(drag) : base
              return (
                <div key={row.id} className="flex border-b border-line/60" style={{ height: ROW_H }}>
                  <button
                    type="button"
                    onClick={() => navigate(`/w/${wsId}/p/${row.id}`)}
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 truncate border-r border-line bg-app px-2.5 text-left text-sm text-ink hover:bg-hover"
                    style={{ width: TITLE_W }}
                  >
                    {row.icon && <span className="shrink-0">{row.icon}</span>}
                    <span className="truncate">{row.title || <span className="text-sub/60">{S.untitled}</span>}</span>
                  </button>
                  <div
                    className="relative"
                    style={{ width: trackW, backgroundImage: gridBg }}
                    onPointerDown={live || readOnly ? undefined : (e) => schedule(e, row)}
                    title={live || readOnly ? undefined : S.noDates}
                  >
                    {live && (
                      <div
                        className={`absolute top-1 flex select-none items-center overflow-hidden rounded-md border border-accent/40 bg-accent-soft text-xs text-accent shadow-sm ${
                          readOnly
                            ? 'cursor-pointer'
                            : drag?.rowId === row.id
                              ? 'cursor-grabbing opacity-90'
                              : 'cursor-grab'
                        }`}
                        style={{
                          left: (live[0] - rangeStart) * ppd,
                          width: Math.max(8, (live[1] - live[0] + 1) * ppd),
                          height: ROW_H - 8,
                          touchAction: 'none',
                        }}
                        onPointerDown={readOnly ? undefined : (e) => begin(e, row, 'move', base ?? live)}
                        onPointerMove={readOnly ? undefined : onMove}
                        onPointerUp={readOnly ? undefined : () => end(row)}
                        onPointerCancel={readOnly ? undefined : () => setDrag(null)}
                        onClick={readOnly ? () => navigate(`/w/${wsId}/p/${row.id}`) : undefined}
                        title={`${fmtDay(live[0], { dateStyle: 'medium' })}${live[1] !== live[0] ? ` → ${fmtDay(live[1], { dateStyle: 'medium' })}` : ''}`}
                      >
                        {endF && !readOnly && (
                          <span
                            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
                            onPointerDown={(e) => begin(e, row, 'start', base ?? live)}
                            onPointerMove={onMove}
                            onPointerUp={() => end(row)}
                          />
                        )}
                        {(live[1] - live[0] + 1) * ppd >= 72 && (
                          <span className="truncate px-2">{row.title || S.untitled}</span>
                        )}
                        {endF && !readOnly && (
                          <span
                            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize"
                            onPointerDown={(e) => begin(e, row, 'end', base ?? live)}
                            onPointerMove={onMove}
                            onPointerUp={() => end(row)}
                          />
                        )}
                      </div>
                    )}
                    {/* narrow bars: show the title next to the bar */}
                    {live && (live[1] - live[0] + 1) * ppd < 72 && (
                      <span
                        className="pointer-events-none absolute inset-y-0 flex items-center whitespace-nowrap text-xs text-sub"
                        style={{ left: (live[1] - rangeStart + 1) * ppd + 6 }}
                      >
                        {row.title || S.untitled}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* today marker */}
          {todayX >= 0 && todayX <= trackW && (
            <div
              className="pointer-events-none absolute bottom-0 z-[5] w-px bg-red-500/70"
              style={{ left: TITLE_W + todayX + ppd / 2, top: HEADER_H }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
