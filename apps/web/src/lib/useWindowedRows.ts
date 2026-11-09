import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * Minimal fixed-row-height list windowing (docs/adr/0302-own-virtualization.md).
 *
 * `listRef` is the element that contains the rows (its top is row 0). The scroll container is
 * either `scrollRef` (own viewport, e.g. the timeline) or the nearest scrollable ancestor (the
 * page body). Only rows intersecting the viewport ± overscan are rendered; the caller pads the
 * list with `padTop` / `padBottom` spacer heights.
 *
 * Printing: windowed rows would not print, so on `beforeprint` all rows (up to PRINT_CAP) are
 * rendered synchronously and the window is restored on `afterprint`.
 */
export const PRINT_CAP = 3000

export interface WindowedRange {
  start: number
  end: number
  padTop: number
  padBottom: number
  printing: boolean
}

export function scrollParent(el: HTMLElement | null): HTMLElement | Window {
  let cur = el?.parentElement ?? null
  while (cur) {
    const oy = getComputedStyle(cur).overflowY
    // overflow-x:auto wrappers compute overflow-y:auto too but never scroll vertically —
    // only accept an ancestor whose content is actually taller than its box
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) return cur
    cur = cur.parentElement
  }
  return window
}

export function useWindowedRows(opts: {
  count: number
  rowHeight: number
  listRef: RefObject<HTMLElement | null>
  scrollRef?: RefObject<HTMLElement | null>
  overscan?: number
  /** below this count everything is rendered (no windowing) */
  threshold?: number
}): WindowedRange {
  const { count, rowHeight, listRef, scrollRef, overscan = 8, threshold = 0 } = opts
  const windowed = count > threshold
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) })
  const [printing, setPrinting] = useState(false)

  const measure = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const sc = scrollRef?.current ?? scrollParent(list)
    let viewTop: number
    let viewHeight: number
    if (sc instanceof Window) {
      viewTop = -list.getBoundingClientRect().top
      viewHeight = window.innerHeight
    } else {
      const listRect = list.getBoundingClientRect()
      const scRect = sc.getBoundingClientRect()
      viewTop = scRect.top - listRect.top
      viewHeight = sc.clientHeight
    }
    const first = Math.max(0, Math.floor(viewTop / rowHeight) - overscan)
    const last = Math.min(count, Math.ceil((viewTop + viewHeight) / rowHeight) + overscan)
    setRange((r) => (r.start === first && r.end === Math.max(first, last) ? r : { start: first, end: Math.max(first, last) }))
  }, [count, rowHeight, listRef, scrollRef, overscan])

  useLayoutEffect(() => {
    if (windowed) measure()
  }, [windowed, measure])

  useEffect(() => {
    if (!windowed) return
    const list = listRef.current
    const sc = scrollRef?.current ?? scrollParent(list)
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        measure()
      })
    }
    sc.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      sc.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [windowed, measure, listRef, scrollRef])

  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true))
    const after = () => setPrinting(false)
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])

  if (!windowed) return { start: 0, end: count, padTop: 0, padBottom: 0, printing }
  if (printing) {
    const end = Math.min(count, PRINT_CAP)
    return { start: 0, end, padTop: 0, padBottom: 0, printing }
  }
  const start = Math.min(range.start, count)
  const end = Math.min(Math.max(range.end, start), count)
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (count - end) * rowHeight,
    printing,
  }
}
