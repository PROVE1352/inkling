import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { applyUpdate, dismissUpdate, getUpdateSnapshot, subscribeUpdate } from '../lib/update'
import { Spinner } from './Spinner'
import { XIcon } from './Icons'

// "A new version is available · Reload" (docs/adr/0991-*, 0993-*). Mounted once at the app root
// (main.tsx, next to <App>), so it shows on every route — login, settings, public pages — with or
// without a service worker. The single update notice: lib/pwa.ts no longer shows its own toast.
export function UpdateBanner() {
  const s = useSyncExternalStore(subscribeUpdate, getUpdateSnapshot, getUpdateSnapshot)
  const tr = useT()
  if (!s.bannerVisible || typeof document === 'undefined') return null

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
      <div
        role="alert"
        data-testid="update-banner"
        className="nd-toast pointer-events-auto flex max-w-full items-center gap-3 rounded-lg border border-line bg-app px-3 py-2 text-sm text-ink shadow-xl"
      >
        <span className="min-w-0 truncate">{tr('pwa.updateReady')}</span>
        <button
          type="button"
          disabled={s.applying}
          onClick={() => void applyUpdate()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {s.applying && <Spinner size={12} />}
          {tr('pwa.reload')}
        </button>
        {!s.applying && (
          <button
            type="button"
            onClick={dismissUpdate}
            aria-label={tr('pwa.later')}
            title={tr('pwa.later')}
            className="shrink-0 rounded-md p-1 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <XIcon size={14} />
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
