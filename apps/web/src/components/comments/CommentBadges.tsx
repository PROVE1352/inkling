import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useComments } from '../../api'
import { FOLDS_EVENT } from '../../lib/headingFolds'
import type { InklingEditor } from '../CollabEditor'
import { useT } from '../../i18n'

interface Badge {
  blockId: string
  count: number
  top: number
  left: number
}

// Overlays a 💬 count badge on the DOM ([data-id]) of blocks that have comments.
// Absolutely positioned in the scroll container's content coordinates → moves with its scroll (portal).
export function CommentBadges({
  pageId,
  editor,
  containerRef,
  onOpen,
}: {
  pageId: string
  editor: InklingEditor | null
  containerRef: RefObject<HTMLDivElement | null>
  onOpen: (blockId: string) => void
}) {
  const tr = useT()
  const comments = useComments(pageId)
  const [badges, setBadges] = useState<Badge[]>([])
  // Re-measure trigger (block positions shift while typing/resizing)
  const [tick, setTick] = useState(0)

  // Comment count per block (resolved or not)
  const counts = new Map<string, number>()
  for (const c of comments.data ?? []) {
    counts.set(c.blockId, (counts.get(c.blockId) ?? 0) + 1)
  }
  const countKey = [...counts.entries()].map(([k, v]) => `${k}:${v}`).join(',')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      setBadges([])
      return
    }
    const cRect = container.getBoundingClientRect()
    const next: Badge[] = []
    counts.forEach((count, blockId) => {
      const el = container.querySelector(`[data-id="${blockId}"]`)
      if (!el) return
      const r = el.getBoundingClientRect()
      // inside a folded section (docs/adr/1221-*): no box, no badge
      if (r.width === 0 && r.height === 0) return
      next.push({
        blockId,
        count,
        top: r.top - cRect.top + container.scrollTop + 12,
        left: r.right - cRect.left + container.scrollLeft - 4,
      })
    })
    setBadges(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countKey, tick, containerRef])

  // Recompute positions on typing (document changes) — debounced
  useEffect(() => {
    if (!editor) return
    let t: number | undefined
    const unsub = editor.onChange(() => {
      window.clearTimeout(t)
      t = window.setTimeout(() => setTick((v) => v + 1), 300)
    })
    return () => {
      window.clearTimeout(t)
      unsub?.()
    }
  }, [editor])

  // Recompute on resize
  useEffect(() => {
    const onResize = () => setTick((v) => v + 1)
    window.addEventListener('resize', onResize)
    window.addEventListener(FOLDS_EVENT, onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener(FOLDS_EVENT, onResize)
    }
  }, [])

  // Once more right after the first mount (waits for block DOM to render)
  useEffect(() => {
    const id = window.setTimeout(() => setTick((v) => v + 1), 120)
    return () => window.clearTimeout(id)
  }, [pageId])

  const container = containerRef.current
  if (!container || badges.length === 0) return null

  return createPortal(
    <>
      {badges.map((b) => (
        <button
          key={b.blockId}
          type="button"
          onClick={() => onOpen(b.blockId)}
          title={tr('comments.badgeTitle', { count: b.count })}
          style={{ position: 'absolute', top: b.top, left: b.left }}
          className="nd-pop z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-full border border-line bg-app px-1.5 py-0.5 text-[10px] leading-none text-sub shadow-sm transition-colors hover:text-accent"
        >
          <span className="leading-none">💬</span>
          {b.count}
        </button>
      ))}
    </>,
    container,
  )
}
