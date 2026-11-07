import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { dismissToast, getToasts, subscribeToasts } from '../lib/toast'
import { useT } from '../i18n'
import { XIcon } from './Icons'

// Bottom-right toast stack. Subscribes to the module store in lib/toast. Mounted once in AppLayout.
export function ToastContainer() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  const tr = useT()

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="nd-enter pointer-events-auto flex items-center gap-3 rounded-lg border border-line bg-app px-3 py-2.5 text-sm text-ink shadow-xl"
        >
          <span className="min-w-0 flex-1 truncate">{t.message}</span>
          {t.actionLabel && (
            <button
              type="button"
              onClick={() => {
                t.onAction?.()
                dismissToast(t.id)
              }}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors duration-150 hover:bg-accent-soft"
            >
              {t.actionLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label={tr('common.close')}
            className="shrink-0 rounded-md p-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <XIcon size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
