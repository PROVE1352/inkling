import { useAuthMode } from '../../api'
import { useT } from '../../i18n'

/**
 * The strip of a server whose storage fuse has tripped (LIMIT_INSTANCE_STORAGE_MB, docs/adr/2532-*):
 * `instanceFull` in GET /api/auth/mode. Nothing on a server without the setting (the field is absent).
 */
export function InstanceFullNotice() {
  const t = useT()
  if (!useAuthMode().data?.instanceFull) return null
  return (
    <div role="status" data-instance-full className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-ink [overflow-wrap:anywhere]">
      {t('limits.instanceFull')}
    </div>
  )
}
