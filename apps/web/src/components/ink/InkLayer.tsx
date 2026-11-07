import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { INK_CANVAS_WIDTH } from '@inkling/shared'
import type { InkDTO, InkStroke } from '@inkling/shared'
import { ApiError, usePageInk, useSaveInk } from '../../api'
import { strokeHit, strokePath } from '../../lib/inkStroke'
import { toast } from '../../lib/toast'
import { InkToolbar } from './InkToolbar'
import type { InkSettings } from './InkToolbar'
import { isMod } from '../../lib/platform'
import { t } from '../../i18n'

// Ink layer overlaid on the page body. Like PDF annotations it is not anchored to blocks: the body
// column is treated as a sheet of "paper" INK_CANVAS_WIDTH wide, and strokes are stored in that
// coordinate system. When a narrow screen shrinks the column, the whole layer scales with it (viewBox).
//
// Input rules: pen and mouse draw, fingers scroll.
// The layer's touch-action must still be 'none' — with pan-y, Android Chrome also takes S Pen drags
// as scroll gestures, so only the first point lands and pointercancel cuts the stroke.
// With browser scrolling off, finger scrolling is driven manually below (with inertia).
// The S Pen's back-end eraser (button 5 / buttons 32) erases regardless of the selected tool.

const SAVE_DEBOUNCE_MS = 1200
const ERASER_RADIUS = 10
/** Finger-scroll inertia — per-frame decay and stop threshold (px/frame) */
const INERTIA_FRICTION = 0.94
const INERTIA_STOP = 0.3

type Action =
  | { type: 'add'; stroke: InkStroke }
  | { type: 'erase'; strokes: { index: number; stroke: InkStroke }[] }

function newId(): string {
  return crypto.randomUUID()
}

export function InkLayer({
  pageId,
  columnRef,
  containerRef,
  onClose,
}: {
  pageId: string
  /** Body column the ink sits on (measured) */
  columnRef: RefObject<HTMLElement | null>
  /** Scroll container — ink is absolutely positioned in its content coordinates */
  containerRef: RefObject<HTMLDivElement | null>
  onClose: () => void
}) {
  const ink = usePageInk(pageId)
  const saveInk = useSaveInk(pageId)

  const [strokes, setStrokes] = useState<InkStroke[]>([])
  const [settings, setSettings] = useState<InkSettings>({
    tool: 'pen',
    color: '#ef4444',
    size: 3,
  })
  // Stroke being drawn — not added to strokes until committed.
  const [draft, setDraft] = useState<number[] | null>(null)

  const draftRef = useRef<number[]>([])
  const drawingRef = useRef(false)
  const erasingRef = useRef(false)
  const historyRef = useRef<Action[]>([])
  const rafRef = useRef<number | undefined>(undefined)
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const strokesRef = useRef<InkStroke[]>([])
  strokesRef.current = strokes

  // Finger-scroll (handled manually) state
  const panRef = useRef<{ id: number; lastY: number; lastT: number; v: number } | null>(null)
  const inertiaRef = useRef<number | undefined>(undefined)

  // Copy the strokes loaded from the server into local state once (local is the truth afterwards).
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current || !ink.data) return
    loadedRef.current = true
    setStrokes(ink.data.strokes)
    baseRef.current = { updatedAt: ink.data.updatedAt, ids: new Set(ink.data.strokes.map((s) => s.id)) }
  }, [ink.data])

  // Portal target (scroll container) — the ref is empty on the first render, so it is lifted into state.
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => setPortalHost(containerRef.current), [containerRef])

  // ---- Layer position/size measurement -----------------------------------
  // Measures the column in the container's content coordinates (scroll included) and overlays it.
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 })

  const measure = useCallback(() => {
    const column = columnRef.current
    const container = containerRef.current
    if (!column || !container) return
    const c = container.getBoundingClientRect()
    const r = column.getBoundingClientRect()
    const top = r.top - c.top + container.scrollTop
    setBox({
      left: r.left - c.left + container.scrollLeft,
      top,
      width: r.width,
      // Extend down to the bottom of the screen even for a short body — like jotting in a page margin.
      height: Math.max(r.height, container.clientHeight - top),
    })
  }, [columnRef, containerRef])

  useLayoutEffect(() => {
    measure()
    const column = columnRef.current
    const container = containerRef.current
    if (!column) return
    // Body height changes late (images loading, fonts applying) → observe and follow it.
    const ro = new ResizeObserver(measure)
    ro.observe(column)
    if (container) ro.observe(container)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure, columnRef, containerRef])

  // Logical coordinate scale — when the column is narrower than the reference width, draw scaled down.
  const scale = box.width > 0 ? box.width / INK_CANVAS_WIDTH : 1
  const viewHeight = scale > 0 ? box.height / scale : box.height

  // ---- Save (debounced) --------------------------------------------------
  // At most one PUT in flight (docs/adr/0854-*): the PUT replaces the whole stroke list, so two
  // overlapping requests can finish out of order and the older list wins on the server. While one
  // is in flight, changes only mark the layer dirty; when it settles, the *latest* strokes go out
  // in a single follow-up request (coalescing everything drawn meanwhile). A failed request keeps
  // the layer dirty and is not retried in a loop — the next stroke or unmount sends the latest.
  // mutateAsync (not mutate callbacks): the follow-up must still run if the layer unmounted.
  //
  // Two devices (docs/adr/0815-*): each PUT carries the server version the local strokes are based
  // on. On 412 INK_CONFLICT the server's strokes are merged with the local changes since that base
  // (strokes added here are kept, strokes erased here are dropped) and the save is sent again.
  const inFlightRef = useRef(false)
  // undefined until the first load: the PUT then omits the version (last write wins).
  const baseRef = useRef<{ updatedAt: string | null; ids: Set<string> } | undefined>(undefined)
  const conflictsRef = useRef(0)
  const flush = useCallback(() => {
    window.clearTimeout(saveTimerRef.current)
    if (!dirtyRef.current || inFlightRef.current) return
    dirtyRef.current = false
    inFlightRef.current = true
    let failed = false
    const sent = strokesRef.current
    saveInk
      .mutateAsync({ strokes: sent, expectedUpdatedAt: baseRef.current?.updatedAt })
      .then((saved) => {
        conflictsRef.current = 0
        baseRef.current = { updatedAt: saved.updatedAt, ids: new Set(sent.map((s) => s.id)) }
      })
      .catch((err) => {
        const server = err instanceof ApiError && err.status === 412 ? (err.details.ink as InkDTO | undefined) : undefined
        if (server && baseRef.current && conflictsRef.current++ < 3) {
          const base = baseRef.current.ids
          const local = strokesRef.current
          const localIds = new Set(local.map((s) => s.id))
          const serverIds = new Set(server.strokes.map((s) => s.id))
          const merged = [
            ...server.strokes.filter((s) => localIds.has(s.id) || !base.has(s.id)),
            ...local.filter((s) => !base.has(s.id) && !serverIds.has(s.id)),
          ]
          baseRef.current = { updatedAt: server.updatedAt, ids: serverIds }
          strokesRef.current = merged
          setStrokes(merged)
          dirtyRef.current = true // the finally block sends the merged list right away
          return
        }
        failed = true
        dirtyRef.current = true
        toast({ message: t('ink.saveFailed') })
      })
      .finally(() => {
        inFlightRef.current = false
        if (!failed && dirtyRef.current) flushRef.current()
      })
  }, [saveInk])

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])

  // On unmount (ink mode off, page change) flush pending changes immediately.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => {
    const onHide = () => flushRef.current()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.clearTimeout(saveTimerRef.current)
      flushRef.current()
    }
  }, [])

  // ---- Coordinate conversion ---------------------------------------------
  const toLocal = useCallback(
    (clientX: number, clientY: number) => {
      const column = columnRef.current
      if (!column) return { x: 0, y: 0 }
      const r = column.getBoundingClientRect()
      const s = r.width > 0 ? r.width / INK_CANVAS_WIDTH : 1
      return { x: (clientX - r.left) / s, y: (clientY - r.top) / s }
    },
    [columnRef],
  )

  // ---- Eraser -------------------------------------------------------------
  const eraseAt = useCallback((x: number, y: number) => {
    const removed: { index: number; stroke: InkStroke }[] = []
    const next = strokesRef.current.filter((s, index) => {
      if (!strokeHit(s.points, x, y, ERASER_RADIUS + s.size / 2)) return true
      removed.push({ index, stroke: s })
      return false
    })
    if (removed.length === 0) return
    historyRef.current.push({ type: 'erase', strokes: removed })
    setStrokes(next)
  }, [])

  // ---- Finger scroll (manual, since browser gestures are off) ------------
  const stopInertia = useCallback(() => {
    if (inertiaRef.current !== undefined) {
      window.cancelAnimationFrame(inertiaRef.current)
      inertiaRef.current = undefined
    }
  }, [])

  const panStart = (e: ReactPointerEvent) => {
    stopInertia()
    panRef.current = { id: e.pointerId, lastY: e.clientY, lastT: performance.now(), v: 0 }
  }

  const panMove = (e: ReactPointerEvent) => {
    const pan = panRef.current
    const container = containerRef.current
    if (!pan || pan.id !== e.pointerId || !container) return
    const now = performance.now()
    const dy = e.clientY - pan.lastY
    const dt = Math.max(1, now - pan.lastT)
    container.scrollTop -= dy
    // Convert to distance per frame (≈16 ms) and use it directly for inertia.
    pan.v = (dy / dt) * 16
    pan.lastY = e.clientY
    pan.lastT = now
  }

  const panEnd = (e: ReactPointerEvent) => {
    const pan = panRef.current
    if (!pan || pan.id !== e.pointerId) return
    panRef.current = null
    let v = pan.v
    if (Math.abs(v) < 0.5) return
    const step = () => {
      const container = containerRef.current
      if (!container) return
      container.scrollTop -= v
      v *= INERTIA_FRICTION
      inertiaRef.current =
        Math.abs(v) > INERTIA_STOP ? window.requestAnimationFrame(step) : undefined
    }
    inertiaRef.current = window.requestAnimationFrame(step)
  }

  useEffect(() => stopInertia, [stopInertia])

  // Safety net: block touch scrolling entirely while a stroke is being drawn, so the stroke
  // survives even in environments that ignore touch-action and take the gesture.
  // (preventDefault only works with passive:false)
  useEffect(() => {
    const host = containerRef.current
    if (!host) return
    const block = (e: TouchEvent) => {
      if (drawingRef.current || erasingRef.current) e.preventDefault()
    }
    host.addEventListener('touchmove', block, { passive: false })
    return () => host.removeEventListener('touchmove', block)
  }, [containerRef])

  // ---- Pointer ------------------------------------------------------------
  const isDrawingPointer = (e: ReactPointerEvent) =>
    e.pointerType === 'pen' || e.pointerType === 'mouse'

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch') {
      panStart(e)
      return
    }
    if (!isDrawingPointer(e)) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)

    const { x, y } = toLocal(e.clientX, e.clientY)
    // The S Pen's back-end eraser erases regardless of the tool setting.
    const eraserTip = e.button === 5 || (e.buttons & 32) !== 0
    if (settings.tool === 'eraser' || eraserTip) {
      erasingRef.current = true
      eraseAt(x, y)
      return
    }

    drawingRef.current = true
    draftRef.current = [x, y, e.pressure || 0.5]
    setDraft(draftRef.current)
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch') {
      panMove(e)
      return
    }
    if (!isDrawingPointer(e)) return

    if (erasingRef.current) {
      const { x, y } = toLocal(e.clientX, e.clientY)
      eraseAt(x, y)
      return
    }
    if (!drawingRef.current) return
    e.preventDefault()

    // The browser delivers one event per frame, but the S Pen reports several in between.
    // Unpack all coalesced events so fast strokes don't come out jagged.
    const native = e.nativeEvent as PointerEvent & {
      getCoalescedEvents?: () => PointerEvent[]
    }
    const events =
      typeof native.getCoalescedEvents === 'function'
        ? native.getCoalescedEvents()
        : [native]
    for (const ev of events.length > 0 ? events : [native]) {
      const { x, y } = toLocal(ev.clientX, ev.clientY)
      draftRef.current.push(x, y, ev.pressure || 0.5)
    }

    // Re-rendering on every event lags behind fast hands → only once per frame.
    if (rafRef.current === undefined) {
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = undefined
        setDraft([...draftRef.current])
      })
    }
  }

  const endStroke = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch') {
      panEnd(e)
      return
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (erasingRef.current) {
      erasingRef.current = false
      markDirty()
      return
    }
    if (!drawingRef.current) return
    drawingRef.current = false

    if (rafRef.current !== undefined) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = undefined
    }

    const points = draftRef.current
    draftRef.current = []
    setDraft(null)
    if (points.length < 3) return

    const stroke: InkStroke = {
      id: newId(),
      tool: settings.tool === 'highlighter' ? 'highlighter' : 'pen',
      color: settings.color,
      size: settings.tool === 'highlighter' ? settings.size * 5 : settings.size,
      points: points.map((n) => Math.round(n * 10) / 10),
    }
    historyRef.current.push({ type: 'add', stroke })
    setStrokes((prev) => [...prev, stroke])
    markDirty()
  }

  // When the gesture is cancelled (browser took it over, system popup, …) drop the stroke in progress.
  // Committing it here would produce exactly the "single dot and done" symptom.
  const cancelStroke = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch') {
      panRef.current = null
      return
    }
    drawingRef.current = false
    erasingRef.current = false
    if (rafRef.current !== undefined) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = undefined
    }
    draftRef.current = []
    setDraft(null)
  }

  // ---- Undo / clear all ---------------------------------------------------
  const undo = useCallback(() => {
    const action = historyRef.current.pop()
    if (!action) return
    if (action.type === 'add') {
      setStrokes((prev) => prev.filter((s) => s.id !== action.stroke.id))
    } else {
      setStrokes((prev) => {
        const next = [...prev]
        // To undo the erase order, re-insert starting from the smallest index.
        for (const { index, stroke } of [...action.strokes].sort((a, b) => a.index - b.index)) {
          next.splice(Math.min(index, next.length), 0, stroke)
        }
        return next
      })
    }
    markDirty()
  }, [markDirty])

  const clearAll = useCallback(() => {
    if (strokesRef.current.length === 0) return
    historyRef.current.push({
      type: 'erase',
      strokes: strokesRef.current.map((stroke, index) => ({ index, stroke })),
    })
    setStrokes([])
    markDirty()
  }, [markDirty])

  // Ctrl/Cmd+Z undo — body editing is locked, so it does not conflict with the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMod(e) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, onClose])

  const draftStroke =
    draft && draft.length >= 3
      ? {
          path: strokePath(
            draft,
            settings.tool === 'highlighter' ? settings.size * 5 : settings.size,
          ),
          highlighter: settings.tool === 'highlighter',
        }
      : null

  const layer = (
    <svg
      aria-label={t('ink.layer')}
      width={box.width}
      height={box.height}
      viewBox={`0 0 ${INK_CANVAS_WIDTH} ${Math.max(1, viewHeight)}`}
      preserveAspectRatio="none"
      className="absolute z-30"
      style={{
        left: box.left,
        top: box.top,
        // Turn off all browser gestures — with pan-y, S Pen drags get taken as scrolls.
        // Finger scrolling is handled by panStart/panMove/panEnd above instead.
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        cursor: settings.tool === 'eraser' ? 'cell' : 'crosshair',
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endStroke}
      onPointerCancel={cancelStroke}
      onPointerLeave={endStroke}
    >
      {/* pointerEvents:none — touch-action is not inherited, so putting the pen on a stroke made
          that <path> (touch-action:auto) the hit target and the browser took the gesture.
          Hit testing is done by coordinates anyway (strokeHit), so DOM hits are not needed. */}
      {strokes.map((s) => (
        <path
          key={s.id}
          d={strokePath(s.points, s.size)}
          fill={s.color}
          opacity={s.tool === 'highlighter' ? 0.32 : 1}
          style={{ pointerEvents: 'none' }}
        />
      ))}
      {draftStroke && (
        <path
          d={draftStroke.path}
          fill={settings.color}
          opacity={draftStroke.highlighter ? 0.32 : 1}
          style={{ pointerEvents: 'none' }}
        />
      )}
    </svg>
  )

  return (
    <>
      {/* Absolutely positioned in the scroll container's content coordinates — scrolls with
          the body (same approach as comment badges). */}
      {portalHost && createPortal(layer, portalHost)}

      <InkToolbar
        settings={settings}
        onChange={setSettings}
        onUndo={undo}
        onClear={clearAll}
        onClose={onClose}
        saving={saveInk.isPending}
        strokeCount={strokes.length}
      />
    </>
  )
}
