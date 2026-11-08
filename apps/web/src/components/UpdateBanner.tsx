import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
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

type LatestReleaseDTO = {
  enabled: boolean
  current: string
  latest: { version: string; url: string } | null
  updateAvailable: boolean
}

/**
 * Admin screen: "Inkling x.y.z is available" when the server's optional release check
 * (UPDATE_CHECK=github, docs/adr/0994-*) found a newer GitHub release. Renders nothing otherwise.
 */
export function ReleaseNotice() {
  const tr = useT()
  const q = useQuery({
    queryKey: ['version', 'latest'],
    queryFn: () => api<LatestReleaseDTO>('/api/version/latest'),
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
  const d = q.data
  if (!d?.enabled || !d.updateAvailable || !d.latest) return null
  return (
    <p className="mt-3 rounded-md border border-line bg-accent-soft px-3 py-2 text-xs text-ink" data-testid="release-notice">
      {tr('pwa.releaseAvailable', { version: d.latest.version, current: d.current })}
      {d.latest.url && (
        <>
          {' '}
          <a href={d.latest.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">
            {tr('pwa.releaseNotes')}
          </a>
        </>
      )}
    </p>
  )
}
