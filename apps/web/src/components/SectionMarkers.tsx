import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FOLDS_EVENT } from '../lib/headingFolds'
import { usePageSuggestions } from '../suggestionsApi'
import { useT } from '../i18n'
import type { InklingEditor } from './CollabEditor'
import { OPEN_SUGGESTIONS_EVENT } from './SuggestionsPanel'

interface Marker {
  blockId: string
  top: number
  left: number
  /** Room to the container's right edge (phones: the claim text is cut, never the page widened). */
  maxWidth: number
  suggestions: number
  claim: { by: string; until: string } | null
}

// Next to a section heading (docs/adr/1530-*, 1535-*): "✎ 2 suggested" (opens the suggestions dialog)
// and "Claude is working on this section" while an agent connection claims it. Display only: people
// are never blocked by a claim. Positioned like CommentBadges, in the scroll container's content
// coordinates (a portal), never inside the editor's DOM.
export function SectionMarkers({
  pageId,
  editor,
  containerRef,
}: {
  pageId: string
  editor: InklingEditor | null
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const q = usePageSuggestions(pageId)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [tick, setTick] = useState(0)

  const byBlock = new Map<string, Omit<Marker, 'top' | 'left' | 'maxWidth'>>()
  for (const s of q.data?.suggestions ?? []) {
    if (!s.blockId) continue
    const m = byBlock.get(s.blockId) ?? { blockId: s.blockId, suggestions: 0, claim: null }
    m.suggestions++
    byBlock.set(s.blockId, m)
  }
  for (const c of q.data?.claims ?? []) {
    if (!c.blockId) continue
    const m = byBlock.get(c.blockId) ?? { blockId: c.blockId, suggestions: 0, claim: null }
    m.claim = { by: c.by, until: c.expiresAt }
    byBlock.set(c.blockId, m)
  }
  const key = [...byBlock.values()].map((m) => `${m.blockId}:${m.suggestions}:${m.claim?.by ?? ''}:${m.claim?.until ?? ''}`).join(',')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      setMarkers([])
      return
    }
    const cRect = container.getBoundingClientRect()
    const next: Marker[] = []
    byBlock.forEach((m) => {
      // the heading's own content box (the outer block also holds its top margin), else the block
      const el =
        container.querySelector(`[data-id="${m.blockId}"] [data-content-type="heading"]`) ?? container.querySelector(`[data-id="${m.blockId}"]`)
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      // right after the heading text when it is measurable, else at the block's right edge
      const inline = el.querySelector('.bn-inline-content') ?? el
      const ir = inline.getBoundingClientRect()
      const textRight = inline instanceof HTMLElement && inline.firstChild ? Math.min(textEnd(inline) ?? ir.right, r.right - 8) : r.right - 8
      const left = textRight - cRect.left + container.scrollLeft + 10
      next.push({
        ...m,
        // centred on the heading text line, not on the block box (its padding is above the text)
        top: (inline === el ? r.top + r.height / 2 : ir.top + ir.height / 2) - cRect.top + container.scrollTop,
        left,
        maxWidth: Math.max(80, container.clientWidth + container.scrollLeft - left - 8),
      })
    })
    setMarkers(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, containerRef])

  useEffect(() => {
    if (!editor) return
    let h: number | undefined
    const unsub = editor.onChange(() => {
      window.clearTimeout(h)
      h = window.setTimeout(() => setTick((v) => v + 1), 300)
    })
    return () => {
      window.clearTimeout(h)
      unsub?.()
    }
  }, [editor])

  useEffect(() => {
    const onResize = () => setTick((v) => v + 1)
    window.addEventListener('resize', onResize)
    window.addEventListener(FOLDS_EVENT, onResize)
    const first = window.setTimeout(onResize, 150)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener(FOLDS_EVENT, onResize)
      window.clearTimeout(first)
    }
  }, [pageId])

  const container = containerRef.current
  if (!container || markers.length === 0) return null
  return createPortal(
    <>
      {markers.map((m) => (
        <div
          key={m.blockId}
          style={{ position: 'absolute', top: m.top, left: m.left, maxWidth: m.maxWidth }}
          className="nd-pop z-10 flex min-w-0 -translate-y-1/2 items-center gap-1"
          data-testid="section-marker"
        >
          {m.suggestions > 0 && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SUGGESTIONS_EVENT, { detail: { blockId: m.blockId } }))}
              title={t('suggestions.badgeTitle')}
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-accent/40 bg-app px-2 py-0.5 text-[11px] leading-none text-accent shadow-sm transition-colors hover:bg-accent/10"
            >
              <span aria-hidden>✎</span>
              {t('suggestions.badge', { count: m.suggestions })}
            </button>
          )}
          {m.claim && (
            <span
              title={t('claims.until', { time: new Date(m.claim.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
              className="flex min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-app px-2 py-0.5 text-[11px] leading-none text-sub shadow-sm"
            >
              <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
              <span className="min-w-0 truncate">{t('claims.working', { name: m.claim.by })}</span>
            </span>
          )}
        </div>
      ))}
    </>,
    container,
  )
}

/** Right edge of the text inside `el` (a Range over its contents), or null when it has none. */
function textEnd(el: HTMLElement): number | null {
  const range = document.createRange()
  range.selectNodeContents(el)
  const rects = range.getClientRects()
  const last = rects[rects.length - 1]
  return last ? last.right : null
}
