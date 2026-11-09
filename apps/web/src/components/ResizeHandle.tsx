import { useRef } from 'react'

// A vertical resize handle (role="separator"), shared by the sidebar edge and the table header
// (docs/adr/1350-*, docs/adr/1351-*). The drag never re-renders the app: `onPreview` runs at most once
// per animation frame (the caller writes a CSS variable), and `onCommit` runs once on release.
// Pointer capture keeps the moves coming when the pointer crosses an iframe, and
// <html data-resizing> turns off text selection and iframe hit testing while it lasts.

export function ResizeHandle({
  label,
  value,
  min,
  max,
  className,
  startWidth,
  clamp,
  onPreview,
  onEnd,
  onCommit,
  onReset,
  onKey,
}: {
  label: string
  value: number
  min: number
  max: number
  className: string
  /** the width when the drag starts (measured from the element being resized) */
  startWidth: () => number
  clamp: (w: number) => number
  onPreview: (w: number) => void
  /** the drag ended (released or cancelled): drop the preview; onCommit follows when the width changed */
  onEnd: () => void
  onCommit: (w: number) => void
  /** double-click: back to the default width */
  onReset: () => void
  /** keyboard: the next width for a key, or null when the key is not handled */
  onKey: (key: string, shift: boolean) => number | null
}) {
  const drag = useRef<{ x: number; w: number; next: number; raf: number } | null>(null)

  const end = (commit: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    cancelAnimationFrame(d.raf)
    delete document.documentElement.dataset.resizing
    onEnd()
    if (commit && d.next !== d.w) onCommit(d.next)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-print-hide
      className={className}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        const w = startWidth()
        drag.current = { x: e.clientX, w, next: w, raf: 0 }
        document.documentElement.dataset.resizing = ''
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        d.next = clamp(d.w + e.clientX - d.x)
        if (!d.raf)
          d.raf = requestAnimationFrame(() => {
            if (drag.current !== d) return
            d.raf = 0
            onPreview(d.next)
          })
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(true)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onReset()
      }}
      onKeyDown={(e) => {
        const next = onKey(e.key, e.shiftKey)
        if (next === null) return
        e.preventDefault()
        e.stopPropagation()
        onCommit(next)
      }}
    />
  )
}
