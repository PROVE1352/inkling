import { Link } from 'react-router'
import { useT } from '../../i18n'
import { isStorageFull, useStorageLimited, useWorkspaceUsage } from './usage'

/**
 * The banner of a workspace that has used up its storage (docs/adr/2506-*): read-only until files or
 * pages are deleted. Asks for the usage only when the server set a storage limit.
 */
export function StorageFullNotice({ wsId }: { wsId: string | undefined }) {
  const t = useT()
  const limited = useStorageLimited()
  const usage = useWorkspaceUsage(wsId, limited)
  if (!limited || !wsId || !isStorageFull(usage.data)) return null
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-ink">
      <span>{t('limits.fullBody')}</span>
      <Link to={`/w/${wsId}/workspace-settings`} className="rounded-md px-2 py-0.5 text-accent transition-colors duration-150 hover:bg-hover">
        {t('limits.fullSettings')}
      </Link>
    </div>
  )
}
