import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { getConfirm, subscribeConfirm } from '../lib/confirm'
import { useT } from '../i18n'

// Renderer for the confirm dialog in the lib/confirm store. Mounted once at the AppLayout root.
// Enter = confirm, Esc/outside click = cancel. Focuses the confirm button on open (keeps the keyboard delete flow).
export function ConfirmDialog() {
  const req = useSyncExternalStore(subscribeConfirm, getConfirm, () => null)
  const okRef = useRef<HTMLButtonElement>(null)
  const t = useT()

  useEffect(() => {
    if (!req) return
    const prev = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => okRef.current?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        req.resolve(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [req])

  if (!req) return null

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[20dvh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) req.resolve(false)
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t('common.deleteConfirm')}
        className="nd-pop w-full max-w-xs rounded-lg border border-line bg-app p-4 shadow-xl"
      >
        <p className="mb-4 whitespace-pre-line text-sm leading-relaxed text-ink">{req.message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => req.resolve(false)}
            className="rounded-md px-3 py-1.5 text-xs text-sub transition duration-150 hover:bg-hover active:scale-[.98]"
          >
            {t('common.cancel')}
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={() => req.resolve(true)}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition duration-150 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 active:scale-[.98]"
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
