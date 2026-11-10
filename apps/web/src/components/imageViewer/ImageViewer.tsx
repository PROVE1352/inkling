// The image viewer (lightbox), docs/adr/2386-*. A lazy chunk: openImageViewer.ts imports it on the first
// open and mounts it in its own root on <body>, so the editor and the public page share it.
//
// - Zoom: wheel and trackpad pinch (wheel + ctrlKey) about the cursor, two-finger pinch on touch, +/-,
//   0 fits, double-click toggles fit / 100%. Drag pans. The image moves by transform only; pointer and
//   wheel input only update refs and one requestAnimationFrame writes the transform and the % label,
//   so React does not re-render while zooming (a 3910 x 2060 screenshot stays smooth).
// - Modal: role=dialog + aria-modal, the rest of <body> is inert, focus is trapped, every key is taken
//   in the capture phase and stopped (the editor and the app shortcuts never see it), the page does
//   not scroll. Closing (Esc, a click on the backdrop, the button, browser Back) returns focus
//   (openImageViewer.ts).
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { t } from '../../i18n'
import {
  clampPan,
  fitView,
  percent,
  stepZoom,
  toggleActual,
  wheelFactor,
  zoomAt,
  type Size,
  type View,
} from '../../lib/imageZoom'
import { ChevronRightIcon, XIcon } from '../Icons'
import type { ViewerImage } from './openImageViewer'
import './imageViewer.css'

type Props = { images: ViewerImage[]; index: number; onClose: () => void }

/** Movement (px) under which a press on the backdrop counts as a click. */
const CLICK_SLOP = 5

export function ImageViewer({ images, index: startIndex, onClose }: Props) {
  const [index, setIndex] = useState(startIndex)
  const [failed, setFailed] = useState(false)
  const image = images[index]
  const many = images.length > 1

  const dialogRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const pctRef = useRef<HTMLSpanElement>(null)

  // live view state: refs, written to the DOM in one frame
  const view = useRef<View>({ scale: 1, x: 0, y: 0 })
  const natural = useRef<Size>({ w: 0, h: 0 })
  const frame = useRef(0)

  const stageSize = (): Size => {
    const el = stageRef.current
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 }
  }

  const paint = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const img = imgRef.current
      const v = view.current
      if (img) img.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.scale})`
      const label = percent(v.scale)
      if (pctRef.current) {
        pctRef.current.textContent = label
        pctRef.current.parentElement?.setAttribute('aria-label', `${t('imageViewer.fit')} (${t('imageViewer.zoom', { pct: label })})`)
      }
      dialogRef.current?.setAttribute('data-scale', v.scale.toFixed(4))
      const fit = fitView(natural.current, stageSize()).scale
      stageRef.current?.toggleAttribute('data-zoomed', v.scale > fit + 0.001)
    })
  }, [])

  const set = useCallback(
    (v: View) => {
      view.current = v
      paint()
    },
    [paint],
  )

  const fit = useCallback(() => set(fitView(natural.current, stageSize())), [set])
  const step = useCallback((dir: 1 | -1) => set(stepZoom(view.current, dir, natural.current, stageSize())), [set])

  const go = useCallback(
    (d: 1 | -1) => {
      if (!many) return
      setIndex((i) => (i + d + images.length) % images.length)
    },
    [many, images.length],
  )

  // a new image: hidden until it has its natural size, then fitted
  useEffect(() => {
    setFailed(false)
    natural.current = { w: 0, h: 0 }
    const img = imgRef.current
    if (img) img.style.visibility = 'hidden'
    if (img?.complete && img.naturalWidth > 0) onLoad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  function onLoad() {
    const img = imgRef.current
    if (!img) return
    natural.current = { w: img.naturalWidth, h: img.naturalHeight }
    img.style.width = `${img.naturalWidth}px`
    img.style.height = `${img.naturalHeight}px`
    img.style.visibility = 'visible'
    fit()
  }

  // window resize keeps the image on screen (refits when it was fitted)
  useEffect(() => {
    let prev = stageSize()
    const onResize = () => {
      const now = stageSize()
      const wasFit = Math.abs(view.current.scale - fitView(natural.current, prev).scale) < 0.001
      prev = now
      if (wasFit) fit()
      else set(clampPan(view.current, natural.current, now))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fit, set])

  // keys: capture phase on window, before the editor, the app dispatcher and other window listeners
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.isComposing) return
      if (e.key === 'Tab') {
        trapTab(e)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return // browser keys (zoom, copy, …) stay the browser's
      let handled = true
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          go(-1)
          break
        case 'ArrowRight':
          go(1)
          break
        case '+':
        case '=':
          step(1)
          break
        case '-':
        case '_':
          step(-1)
          break
        case '0':
          fit()
          break
        case 'PageUp':
        case 'PageDown':
        case 'Home':
        case 'End':
        case 'ArrowUp':
        case 'ArrowDown':
          break // nothing behind may scroll
        case ' ':
          handled = !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement)
          break
        default:
          handled = false
      }
      if (handled) e.preventDefault()
    }
    const trapTab = (e: KeyboardEvent) => {
      const root = dialogRef.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')).filter((el) => el.getClientRects().length > 0)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!root.contains(active) || (e.shiftKey && (active === first || active === root)) || (!e.shiftKey && active === last)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    // keyup/keypress of the same keys must not reach the editor either
    const swallow = (e: KeyboardEvent) => e.stopPropagation()
    window.addEventListener('keyup', swallow, true)
    window.addEventListener('keypress', swallow, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', swallow, true)
      window.removeEventListener('keypress', swallow, true)
    }
  }, [onClose, go, step, fit])

  // wheel / trackpad pinch: a native listener, React's onWheel is passive and cannot stop page zoom
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!natural.current.w) return
      const r = stage.getBoundingClientRect()
      const v = view.current
      set(zoomAt(v, v.scale * wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), e.clientX - r.left, e.clientY - r.top, natural.current, stageSize()))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [set])

  // pointers: one drags, two pinch; a still press and release on the backdrop closes (on its click)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const closeArmed = useRef(false)
  const gesture = useRef<{
    start: { x: number; y: number }
    moved: boolean
    multi: boolean
    onBackdrop: boolean
    pinch?: { dist: number; mid: { x: number; y: number }; view: View }
  } | null>(null)

  const local = (x: number, y: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: x - r.left, y: y - r.top }
  }
  const pinchOf = () => {
    const [a, b] = Array.from(pointers.current.values())
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: local((a.x + b.x) / 2, (a.y + b.y) / 2), view: view.current }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    closeArmed.current = false
    if ((e.target as HTMLElement).closest('button, a')) return
    stageRef.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      const p = local(e.clientX, e.clientY)
      const v = view.current
      const onImage = p.x >= v.x && p.y >= v.y && p.x <= v.x + natural.current.w * v.scale && p.y <= v.y + natural.current.h * v.scale
      gesture.current = { start: { x: e.clientX, y: e.clientY }, moved: false, multi: false, onBackdrop: !onImage }
    } else if (gesture.current && pointers.current.size === 2) {
      gesture.current.multi = true
      gesture.current.pinch = pinchOf()
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointers.current.get(e.pointerId)
    const g = gesture.current
    if (!p || !g) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > CLICK_SLOP) g.moved = true
    if (pointers.current.size >= 2 && g.pinch) {
      const now = pinchOf()
      const { view: v0, dist, mid } = g.pinch
      const s = v0.scale * (now.dist / Math.max(1, dist))
      // zoom about the starting midpoint, then follow the midpoint's travel
      const z = zoomAt(v0, s, mid.x, mid.y, natural.current, stageSize())
      set(clampPan({ scale: z.scale, x: z.x + now.mid.x - mid.x, y: z.y + now.mid.y - mid.y }, natural.current, stageSize()))
      return
    }
    if (pointers.current.size === 1 && g.moved) {
      const v = view.current
      set(clampPan({ scale: v.scale, x: v.x + dx, y: v.y + dy }, natural.current, stageSize()))
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (pointers.current.size === 1 && g?.pinch) {
      // one finger left after a pinch: it pans from here without a jump
      g.pinch = undefined
      return
    }
    if (pointers.current.size > 0) return
    gesture.current = null
    closeArmed.current = e.type === 'pointerup' && !!g && g.onBackdrop && !g.moved && !g.multi
  }
  // Closing waits for the click that follows: closing on pointerup would let a touch's click land on the
  // page under the finger (and open the image there again).
  const onStageClick = () => {
    if (!closeArmed.current) return
    closeArmed.current = false
    onClose()
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!natural.current.w || (e.target as HTMLElement).closest('button, a')) return
    // pointer capture sends the click to the stage, so "on the image" is decided by the drawn box
    const p = local(e.clientX, e.clientY)
    const v = view.current
    const onImage = p.x >= v.x && p.y >= v.y && p.x <= v.x + natural.current.w * v.scale && p.y <= v.y + natural.current.h * v.scale
    if (!onImage) return
    set(toggleActual(view.current, p.x, p.y, natural.current, stageSize()))
  }

  // first focus inside the dialog; browser Back (or any history move) closes it, so it never stays
  // open over another screen
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
    window.addEventListener('popstate', onClose)
    return () => {
      window.removeEventListener('popstate', onClose)
      if (frame.current) cancelAnimationFrame(frame.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const title = image?.title || t('imageViewer.untitled')
  const counter = many ? t('imageViewer.counter', { n: index + 1, total: images.length }) : ''
  // no display class here: the zoom steps are `hidden sm:inline-flex` (a phone pinches instead)
  const btn =
    'h-9 min-w-9 items-center justify-center rounded-md px-2 text-sm text-white/90 transition-colors duration-150 hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/80'

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('imageViewer.dialog')}
      aria-describedby="nd-iv-title"
      tabIndex={-1}
      data-testid="image-viewer"
      data-index={index}
      className="nd-iv fixed inset-0 z-[200] flex flex-col text-white outline-none"
    >
      <div className="nd-iv-bar relative z-10 flex h-12 shrink-0 items-center gap-1 px-2 sm:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span id="nd-iv-title" data-testid="image-viewer-title" className="min-w-0 truncate text-sm font-medium" title={title}>
            {title}
          </span>
          {many && (
            <span data-testid="image-viewer-counter" className="shrink-0 text-xs tabular-nums text-white/70">
              {counter}
            </span>
          )}
        </div>
        <button type="button" className={`${btn} hidden sm:inline-flex`} onClick={() => step(-1)} aria-label={t('imageViewer.zoomOut')} title={t('imageViewer.zoomOut')}>
          <span aria-hidden="true" className="text-lg leading-none">−</span>
        </button>
        <button
          type="button"
          className={`${btn} inline-flex w-14 tabular-nums`}
          onClick={fit}
          aria-label={t('imageViewer.fit')}
          title={t('imageViewer.fit')}
        >
          <span ref={pctRef} data-testid="image-viewer-zoom">100%</span>
        </button>
        <button type="button" className={`${btn} hidden sm:inline-flex`} onClick={() => step(1)} aria-label={t('imageViewer.zoomIn')} title={t('imageViewer.zoomIn')}>
          <span aria-hidden="true" className="text-lg leading-none">+</span>
        </button>
        {image && (
          <a href={image.src} target="_blank" rel="noopener noreferrer" className={`${btn} inline-flex whitespace-nowrap`} title={t('imageViewer.originalHint')} data-testid="image-viewer-original">
            {t('imageViewer.original')}
          </a>
        )}
        <button type="button" className={`${btn} inline-flex`} onClick={onClose} aria-label={t('imageViewer.close')} title={t('imageViewer.close')} data-testid="image-viewer-close">
          <XIcon size={18} />
        </button>
      </div>

      <div
        ref={stageRef}
        data-testid="image-viewer-stage"
        className="nd-iv-stage relative min-h-0 flex-1 overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onStageClick}
        onDoubleClick={onDoubleClick}
      >
        {image && (
          <img
            key={image.src + index}
            ref={imgRef}
            src={image.src}
            alt={title}
            draggable={false}
            onLoad={onLoad}
            onError={() => setFailed(true)}
            data-testid="image-viewer-img"
            className="nd-iv-img absolute left-0 top-0 max-w-none select-none"
            style={{ visibility: 'hidden', transformOrigin: '0 0' }}
          />
        )}
        {failed && <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80">{t('imageViewer.failed')}</p>}
        {many && (
          <>
            <button
              type="button"
              className={`${btn} nd-iv-nav inline-flex absolute left-2 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full bg-black/40`}
              onClick={() => go(-1)}
              aria-label={t('imageViewer.prev')}
              title={t('imageViewer.prev')}
              data-testid="image-viewer-prev"
            >
              <ChevronRightIcon size={22} className="rotate-180" />
            </button>
            <button
              type="button"
              className={`${btn} nd-iv-nav inline-flex absolute right-2 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full bg-black/40`}
              onClick={() => go(1)}
              aria-label={t('imageViewer.next')}
              title={t('imageViewer.next')}
              data-testid="image-viewer-next"
            >
              <ChevronRightIcon size={22} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Mounts the viewer in its own root on <body>: the rest of the body is inert and the page cannot scroll
 * until it closes. `onClosed` runs after it is gone (focus goes back there).
 */
export function mountImageViewer({ images, index, onClosed }: { images: ViewerImage[]; index: number; onClosed: () => void }) {
  const host = document.createElement('div')
  host.setAttribute('data-image-viewer-root', '')
  const madeInert: Element[] = []
  for (const el of Array.from(document.body.children)) {
    if (el instanceof HTMLElement && !el.inert && el.tagName !== 'SCRIPT') {
      el.inert = true
      madeInert.push(el)
    }
  }
  const html = document.documentElement
  const prevOverflow = html.style.overflow
  html.style.overflow = 'hidden'
  document.body.appendChild(host)
  const root = createRoot(host)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    // after the event that closed it has finished (not inside React's own handler)
    queueMicrotask(() => {
      root.unmount()
      host.remove()
    })
    for (const el of madeInert) (el as HTMLElement).inert = false
    html.style.overflow = prevOverflow
    onClosed()
  }
  root.render(<ImageViewer images={images} index={index} onClose={close} />)
}
