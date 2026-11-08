import { useEffect, useRef, type ReactNode } from 'react'
import { useT } from '../i18n'
import { usePresence } from '../lib/motion'

// Inline popover for delete confirmation, used instead of window.confirm.
// Wraps the trigger element (children) and shows a confirm/cancel popover below it while open.
export function ConfirmPopover({
  open,
  onCancel,
  onConfirm,
  message,
  confirmLabel,
  children,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  message: ReactNode
  confirmLabel?: string
  children: ReactNode
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const { mounted, leaving } = usePresence(open)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    // Register on the next tick so the click that opened the popover does not close it immediately
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onCancel])

  return (
    <span ref={ref} className="relative inline-flex">
      {children}
      {mounted && (
        <div
          role="dialog"
          aria-hidden={leaving || undefined}
          className={`nd-pop absolute right-0 top-full z-50 mt-1 w-56 origin-top-right rounded-lg border border-line bg-app p-3 text-left shadow-xl ${leaving ? 'nd-out' : ''}`}
        >
          <p className="mb-3 text-xs leading-relaxed text-sub">{message}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-2.5 py-1 text-xs text-sub transition duration-150 hover:bg-hover active:scale-[.98]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white transition duration-150 hover:bg-red-700 active:scale-[.98]"
            >
              {confirmLabel ?? t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
