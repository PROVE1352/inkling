import { Link, useParams } from 'react-router'
import { useT } from '../../i18n'
import { useOfflineStatus } from './runtime'

/**
 * One line above every page while the app runs without the server (docs/adr/2204-*): what you see
 * comes from this device, the tree is read-only, and how many pages still wait to be uploaded or
 * were kept for recovery. Also shown while online when there is something in recovery or storage
 * failed, since those need the user.
 */
export function OfflineBanner() {
  const t = useT()
  const { wsId } = useParams()
  const s = useOfflineStatus()
  const away = s.offline || s.fromDevice
  const failed = s.enabled && (s.storage === 'failed' || s.storage === 'unavailable')
  if (!away && !failed && s.recovery === 0) return null
  const parts: string[] = []
  if (away) parts.push(t('offline.banner'))
  if (failed) parts.push(t(s.storage === 'failed' ? 'offline.storageFailed' : 'offline.storageUnavailable'))
  if (s.pendingPages > 0) parts.push(t('offline.pendingPages', { count: s.pendingPages }))
  return (
    <div
      role="status"
      data-testid="offline-banner"
      data-offline={away ? '1' : '0'}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-amber-500/10 px-4 py-1.5 text-xs text-ink"
    >
      {parts.length > 0 && <span className="min-w-0">{parts.join(' · ')}</span>}
      {s.recovery > 0 && wsId && (
        <Link to={`/w/${wsId}/settings#offline`} className="text-accent hover:underline" data-testid="offline-recovery-link">
          {t('offline.recoveryCount', { count: s.recovery })}
        </Link>
      )}
    </div>
  )
}
