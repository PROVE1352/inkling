import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { XIcon } from './Icons'

// Lightweight shared modal. Rendered in a portal; closes on Esc or an outside click.
export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'sm',
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** sm = forms (default); md = forms with a list; lg = galleries and two-pane dialogs. */
  size?: 'sm' | 'md' | 'lg'
}) {
  const t = useT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`nd-pop max-h-full w-full ${size === 'lg' ? 'max-w-3xl' : size === 'md' ? 'max-w-lg' : 'max-w-sm'} overflow-y-auto rounded-lg border border-line bg-app p-5 shadow-xl`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
          >
            <XIcon size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
