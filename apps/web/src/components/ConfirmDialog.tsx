import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { getConfirm, subscribeConfirm } from '../lib/confirm'
import { usePresence } from '../lib/motion'
import { useT } from '../i18n'

// Renderer for the confirm dialog in the lib/confirm store. Mounted once at the AppLayout root.
// Enter = confirm, Esc/outside click = cancel. Focuses the confirm button on open (keeps the keyboard delete flow).
export function ConfirmDialog() {
  const req = useSyncExternalStore(subscribeConfirm, getConfirm, () => null)
  const okRef = useRef<HTMLButtonElement>(null)
  const t = useT()
  // Exit fade (docs/adr/1281-*): the request is gone once resolved, so the last one is shown while leaving.
  const { mounted, leaving } = usePresence(!!req)
  const lastReq = useRef(req)
  if (req) lastReq.current = req

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

  const shown = req ?? lastReq.current
  if (!mounted || !shown) return null

  return createPortal(
    <div
      className={`nd-backdrop fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[20dvh] ${leaving ? 'nd-out' : ''}`}
      onMouseDown={(e) => {
        if (req && e.target === e.currentTarget) req.resolve(false)
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t('common.deleteConfirm')}
        aria-hidden={leaving || undefined}
        className={`nd-pop w-full max-w-xs rounded-xl border border-line bg-app p-4 shadow-xl ${leaving ? 'nd-out' : ''}`}
      >
        <p className="mb-4 whitespace-pre-line text-sm leading-relaxed text-ink">{shown.message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => req?.resolve(false)}
            className="rounded-md px-3 py-1.5 text-xs text-sub transition duration-150 hover:bg-hover active:scale-[.98]"
          >
            {t('common.cancel')}
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={() => req?.resolve(true)}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition duration-150 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 active:scale-[.98]"
          >
            {shown.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
