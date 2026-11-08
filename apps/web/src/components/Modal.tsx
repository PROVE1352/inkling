import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { usePresence } from '../lib/motion'
import { XIcon } from './Icons'

// Lightweight shared modal. Rendered in a portal; closes on Esc or an outside click.
// Opens with a fade + scale (a rise from below on phones) and closes with a short fade (docs/adr/1281-*).
// While closing it shows the last children it rendered open, so a caller that clears its state in
// onClose never renders half-empty content during the exit, and it takes no input.
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
  const { mounted, leaving } = usePresence(open)
  const last = useRef<{ title?: string; children: ReactNode }>({ title, children })
  if (open) last.current = { title, children }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!mounted) return null
  const shown = open ? { title, children } : last.current

  return createPortal(
    <div
      className={`nd-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 ${leaving ? 'nd-out' : ''}`}
      onMouseDown={(e) => {
        if (open && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-hidden={leaving || undefined}
        className={`nd-dialog max-h-full w-full ${size === 'lg' ? 'max-w-3xl' : size === 'md' ? 'max-w-lg' : 'max-w-sm'} overflow-y-auto rounded-xl border border-line bg-app p-5 shadow-xl ${leaving ? 'nd-out' : ''}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">{shown.title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={leaving}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-sub transition duration-150 hover:bg-hover hover:text-ink active:scale-[.98]"
          >
            <XIcon size={18} />
          </button>
        </div>
        {shown.children}
      </div>
    </div>,
    document.body,
  )
}
