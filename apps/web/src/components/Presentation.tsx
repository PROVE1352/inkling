import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { prefersReducedMotion } from '../lib/motion'
import { useTheme } from '../lib/theme'
import { slideKey, splitSlides, swipeDirection } from '../lib/present'
import { renderMathIn } from '../lib/katex'
import { useT } from '../i18n'

// Presentation mode (docs/adr/1843-*): a page's blocks as full-screen slides, split at its
// highest-level headings and at dividers. Read-only: slides show copies of the blocks (the live
// editor's DOM, or a public link's server HTML), never the editor itself, so nothing typed or
// clicked here can reach the document. ←/→ (also PageUp/PageDown, Space, Home/End), swipe, Esc.
// The slide change animates only without prefers-reduced-motion.

/** "Present" glyph (a screen on a stand). Own icon so Icons.tsx stays untouched. */
export function PresentIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M12 16v4M8 20h8M10 8.5v4l3.5-2z" />
    </svg>
  )
}

export function Presentation({
  title,
  icon,
  blocks,
  renderMath = false,
  onClose,
}: {
  title: string
  icon?: ReactNode
  /** Top-level blocks to present: detached copies (they are cloned again per slide view). */
  blocks: Element[]
  /** Server HTML carries equations as LaTeX source (public links); the editor's copies are rendered already. */
  renderMath?: boolean
  onClose: () => void
}) {
  const t = useT()
  const slides = useMemo(() => splitSlides(blocks), [blocks])
  const [index, setIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const reduced = useMemo(() => prefersReducedMotion(), [])
  // BlockNote's themed variables key off data-color-scheme on .bn-container
  const { resolved } = useTheme()
  const count = slides.length
  // the latest onClose without re-running the full-screen effect when the parent re-renders
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(count - 1, i))), [count])

  // Fill the slide with fresh copies (the same block may be shown again after going back).
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.replaceChildren(...(slides[index] ?? []).map((b) => b.cloneNode(true)))
    el.scrollTop = 0
    return renderMath ? renderMathIn(el) : undefined
  }, [slides, index, renderMath])

  // Full screen where the browser allows it (iOS Safari: the fixed overlay is the fallback). Leaving
  // full screen from the browser (its own Esc) ends the presentation too.
  useEffect(() => {
    const el = rootRef.current
    let entered = false
    const onChange = () => {
      if (document.fullscreenElement) entered = true
      else if (entered) closeRef.current()
    }
    document.addEventListener('fullscreenchange', onChange)
    if (el?.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen().catch(() => {
        // not allowed (no user gesture in this frame, iframe policy): the overlay still covers the page
      })
    }
    el?.focus()
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      // Space/Enter on the presenter's own buttons press them
      if ((e.key === ' ' || e.key === 'Enter') && (e.target as HTMLElement | null)?.closest?.('button')) return
      const next = slideKey(e.key, index, count)
      if (next === null) return
      e.preventDefault()
      e.stopPropagation()
      go(next)
    }
    // capture: app shortcuts and the editor underneath never see the presenter's keys
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, count, go])

  // Swipe (touch and pen; a mouse drag selects text as usual)
  const start = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    start.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current
    start.current = null
    if (!s) return
    const dir = swipeDirection(e.clientX - s.x, e.clientY - s.y)
    if (dir) go(index + dir)
  }

  const btn =
    'rounded-md px-3 py-2 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('present.label', { title: title || t('common.untitled') })}
      aria-roledescription={t('present.roleDescription')}
      tabIndex={-1}
      data-testid="presentation"
      onPointerDown={(e) => {
        // the app's drag sensors live on the document; keep the presenter's gestures here
        e.stopPropagation()
        onPointerDown(e)
      }}
      onPointerUp={onPointerUp}
      className="fixed inset-0 z-[100] flex flex-col bg-app text-ink outline-none"
      style={{ touchAction: 'pan-y' }}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 py-8 sm:px-16">
        <div
          key={`slide:${index}`}
          className={`flex max-h-full w-full max-w-5xl flex-col overflow-y-auto ${reduced ? '' : 'nd-fade'}`}
          aria-live="polite"
        >
          {index === 0 && (
            <div className={slides[0]?.length ? 'mb-8' : 'flex min-h-[50vh] flex-col justify-center'}>
              {icon && <div className="mb-3 text-6xl leading-none">{icon}</div>}
              <h1 className="text-4xl font-bold leading-tight sm:text-6xl">{title || t('common.untitled')}</h1>
            </div>
          )}
          <div
            ref={bodyRef}
            data-color-scheme={resolved}
            className="bn-container bn-default-styles nd-public-body nd-present-body text-[clamp(1.1rem,2.2vw,1.75rem)] leading-relaxed [&_h1]:text-[2em] [&_h2]:text-[1.6em] [&_h3]:text-[1.3em] [&_img]:mx-auto [&_img]:max-h-[60vh]"
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2 text-sm">
        <button type="button" onClick={onClose} className={btn} data-testid="presentation-close">
          {t('present.exit')}
        </button>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label={t('present.previous')} className={btn}>
            ←
          </button>
          <span className="min-w-16 text-center tabular-nums text-sub" aria-live="polite">
            {t('present.position', { current: index + 1, total: count })}
          </span>
          <button type="button" onClick={() => go(index + 1)} disabled={index >= count - 1} aria-label={t('present.next')} className={btn}>
            →
          </button>
        </div>
        <span className="hidden text-xs text-sub sm:block">{t('present.keysHint')}</span>
      </div>
    </div>,
    document.body,
  )
}
