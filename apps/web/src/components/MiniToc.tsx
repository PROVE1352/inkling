import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { InklingEditor } from './CollabEditor'
import { computeOutline, type Heading } from '../lib/docOutline'
import { FOLDS_EVENT, revealBlock } from '../lib/headingFolds'
import { t as tr } from '../i18n'

// Outline in the right margin, like Notion's (docs/adr/1220-mini-outline-in-the-margin.md).
// A short line per heading; pointing at them (or focusing them) opens the list, a click scrolls to the
// heading. The heading being read is drawn darker.
//
// Cost on large pages: the headings come from computeOutline (per-block WeakMap cache, ADR 0705), read
// 300 ms after an edit stops. Heading offsets are measured once per change (one querySelectorAll, one
// getBoundingClientRect per heading) and again only when the editor's height changes (ResizeObserver)
// or folds change; scrolling then only reads scrollTop and binary-searches those offsets, once per frame.

/** Rail geometry measured on Notion (2026-11-08): 2px bars, 16px (top level) / 12px, 12px apart. */
const BAR_GAP = 12
const MAX_BARS = 28
/** Space needed between the end of the text and the scroll container's right edge: the rail (56px plus
 *  8px) and room for the comment badges that sit just right of the text. */
const MIN_MARGIN = 104
const MIN_HEADINGS = 3

type Placed = { id: string; top: number }

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function MiniToc({
  editor,
  containerRef,
  columnRef,
}: {
  editor: InklingEditor
  /** The page's scroll container */
  containerRef: RefObject<HTMLDivElement | null>
  /** The text column (EditorDropZone), to know whether the margin has room */
  columnRef: RefObject<HTMLDivElement | null>
}) {
  // headings, re-read 300 ms after the last edit (same rhythm as the right panel's outline)
  const [docTick, setDocTick] = useState(0)
  useEffect(() => {
    let timer: number | undefined
    const off = editor.onChange(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setDocTick((v) => v + 1), 300)
    })
    return () => {
      window.clearTimeout(timer)
      off?.()
    }
  }, [editor])
  const headings = useMemo(
    () => computeOutline(editor.prosemirrorState.doc as unknown as Parameters<typeof computeOutline>[0]).headings,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, docTick],
  )
  const minLevel = useMemo(() => headings.reduce((m, h) => Math.min(m, h.level), 6), [headings])

  // room in the right margin
  const [roomy, setRoomy] = useState(false)
  useEffect(() => {
    const container = containerRef.current
    const column = columnRef.current
    if (!container || !column || typeof ResizeObserver === 'undefined') return
    const check = () => {
      const c = container.getBoundingClientRect()
      const text = column.querySelector('.bn-editor') ?? column
      const r = text.getBoundingClientRect()
      // the editor keeps a 54px handle gutter on its right too; text ends there
      const textRight = r.right - 54
      setRoomy(c.right - textRight >= MIN_MARGIN)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(container)
    ro.observe(column)
    return () => ro.disconnect()
  }, [containerRef, columnRef])

  const enabled = roomy && headings.length >= MIN_HEADINGS

  // heading offsets in scroll coordinates
  const placedRef = useRef<Placed[]>([])
  const [active, setActive] = useState(-1)
  const headingsRef = useRef<Heading[]>(headings)
  headingsRef.current = headings

  const pickActive = useCallback(() => {
    const container = containerRef.current
    const placed = placedRef.current
    if (!container || !placed.length) {
      setActive(-1)
      return
    }
    // the heading whose section is at the top quarter of the view; the last one at the very bottom
    const line = container.scrollTop + Math.min(120, container.clientHeight / 4)
    let idx = -1
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) idx = placed.length - 1
    else {
      let lo = 0
      let hi = placed.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (placed[mid].top <= line) {
          idx = mid
          lo = mid + 1
        } else hi = mid - 1
      }
    }
    const id = idx >= 0 ? placed[idx].id : headingsRef.current[0]?.id
    setActive(headingsRef.current.findIndex((h) => h.id === id))
  }, [containerRef])

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const c = container.getBoundingClientRect()
    const base = container.scrollTop - c.top
    const out: Placed[] = []
    let last = 0
    for (const el of container.querySelectorAll('.bn-block-content[data-content-type="heading"]')) {
      const id = el.closest('.bn-block-outer')?.getAttribute('data-id')
      if (!id) continue
      const r = el.getBoundingClientRect()
      // a heading inside a fold has no box: it sits where its folded heading is
      const top = r.height === 0 && r.width === 0 ? last : r.top + base
      last = top
      out.push({ id, top })
    }
    placedRef.current = out
    pickActive()
  }, [containerRef, pickActive])

  useEffect(() => {
    if (!enabled) return
    measure()
    const container = containerRef.current
    const editorEl = container?.querySelector('.bn-editor')
    let frame = 0
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          pickActive()
        })
    }
    container?.addEventListener('scroll', onScroll, { passive: true })
    // height changes (images loading, folds, width) move the headings
    let lastH = -1
    const ro =
      editorEl && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            const h = entries[0]?.contentRect.height ?? 0
            if (h === lastH) return
            lastH = h
            measure()
          })
        : null
    if (editorEl) ro?.observe(editorEl)
    window.addEventListener(FOLDS_EVENT, measure)
    return () => {
      cancelAnimationFrame(frame)
      container?.removeEventListener('scroll', onScroll)
      ro?.disconnect()
      window.removeEventListener(FOLDS_EVENT, measure)
    }
  }, [enabled, headings, containerRef, measure, pickActive])

  // panel: opens on hover or keyboard focus, closes shortly after the pointer leaves
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const show = () => {
    window.clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const hideSoon = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 150)
  }
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  const navRef = useRef<HTMLElement>(null)

  const jump = (h: Heading) => {
    const container = containerRef.current
    if (!container) return
    revealBlock(h.id)
    const el = container.querySelector(`[data-id="${CSS.escape(h.id)}"]`)
    if (!el) return
    const c = container.getBoundingClientRect()
    const top = el.getBoundingClientRect().top - c.top + container.scrollTop - 16
    container.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  if (!enabled) return null

  // the rail shows at most MAX_BARS bars, a window around the heading being read
  let from = 0
  if (headings.length > MAX_BARS) {
    const center = active < 0 ? 0 : active
    from = Math.max(0, Math.min(headings.length - MAX_BARS, center - (MAX_BARS >> 1)))
  }
  const bars = headings.slice(from, from + MAX_BARS)

  // No colour transition on the bars: while the active bar changes during a scroll, a running
  // transition costs a style pass over the whole page per frame (2,000-block page: scroll p95 18 → 34 ms).
  return (
    <nav
      ref={navRef}
      aria-label={tr('toc.label')}
      data-mini-toc
      className="absolute right-2 top-24 z-20 hidden md:block print:hidden"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={(e) => {
        if (!navRef.current?.contains(e.relatedTarget as Node)) hideSoon()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setOpen(false)
          ;(document.activeElement as HTMLElement | null)?.blur()
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={tr('toc.label')}
        onClick={show}
        className={`flex w-14 flex-col items-start pb-3 pl-5 pr-2 pt-1 transition-opacity duration-200 focus-visible:outline-none ${
          open ? 'opacity-0' : 'opacity-100'
        }`}
        style={{ gap: BAR_GAP }}
      >
        {bars.map((h, i) => {
          const idx = from + i
          const top = h.level <= minLevel
          return (
            <span
              key={`${h.id}-${idx}`}
              aria-hidden
              className="block h-0.5 rounded-sm"
              style={{
                width: top ? 16 : 12,
                marginLeft: top ? 0 : 4,
                background: idx === active ? 'var(--color-ink)' : 'color-mix(in srgb, var(--color-sub) 35%, transparent)',
              }}
            />
          )
        })}
      </button>
      {open && (
        <div
          className="nd-fade absolute right-0 top-0 max-h-[min(60vh,640px)] w-60 overflow-y-auto rounded-xl border border-line bg-app p-2 shadow-xl"
          role="list"
        >
          {headings.map((h, i) => (
            <button
              key={`${h.id}-${i}`}
              type="button"
              role="listitem"
              onClick={() => jump(h)}
              title={h.text}
              style={{ paddingLeft: 4 + Math.min(2, h.level - minLevel) * 12 }}
              className={`block w-full rounded-md py-1 pr-1 text-left text-[13px] leading-[1.3] transition-colors hover:bg-hover ${
                i === active ? 'text-accent' : 'text-sub hover:text-ink'
              }`}
            >
              <span className="line-clamp-2 break-keep">{h.text}</span>
            </button>
          ))}
        </div>
      )}
    </nav>
  )
}
