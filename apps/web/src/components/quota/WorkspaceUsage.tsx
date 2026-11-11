import type { WorkspaceUsageDTO } from '@inkling/shared'
import { formatMb } from '../../i18n/errors'
import { useT } from '../../i18n'
import { isStorageFull, useWorkspaceUsage } from './usage'

/**
 * Workspace settings › General: what the workspace uses (docs/adr/2506-*). With no limit only the
 * numbers; with one, "used of limit" and a bar. A full workspace shows the read-only notice.
 */
export function WorkspaceUsage({ wsId }: { wsId: string }) {
  const t = useT()
  const usage = useWorkspaceUsage(wsId)
  const u = usage.data
  return (
    <section aria-labelledby="ws-usage-title" className="mb-8">
      <h2 id="ws-usage-title" className="mb-2 text-sm font-semibold text-ink">
        {t('limits.usageTitle')}
      </h2>
      {usage.isError ? (
        <p className="text-sm text-sub">{t('limits.loadFailed')}</p>
      ) : !u ? (
        <p className="text-sm text-sub">{t('limits.loading')}</p>
      ) : (
        <>
          {isStorageFull(u) && (
            <p role="status" className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-ink">
              <strong className="font-medium">{t('limits.fullTitle')}</strong>
              <span className="block text-sub">{t('limits.fullBody')}</span>
            </p>
          )}
          <dl className="divide-y divide-line rounded-md border border-line">
            <UsageRow label={t('limits.members')} used={u.members} limit={u.limits.members} />
            <UsageRow label={t('limits.pages')} used={u.pages} limit={u.limits.pages} />
            <UsageRow
              label={t('limits.storage')}
              used={u.storageBytes}
              limit={u.limits.storageBytes}
              format={formatMb}
              note={t('limits.storageFiles', { size: formatMb(u.fileBytes) })}
            />
          </dl>
          <p className="mt-2 text-xs text-sub">{t('limits.storageHint')}</p>
        </>
      )}
    </section>
  )
}

function UsageRow({
  label,
  used,
  limit,
  format = (n: number) => n.toLocaleString(),
  note,
}: {
  label: string
  used: number
  limit?: number
  format?: (n: number) => string
  note?: string
}) {
  const t = useT()
  const ratio = limit ? Math.min(1, used / limit) : 0
  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <dt className="text-sm text-ink">{label}</dt>
        <dd className="text-sm tabular-nums text-sub">
          {limit != null ? t('limits.ofLimit', { used: format(used), limit: format(limit) }) : format(used)}
        </dd>
      </div>
      {limit != null && (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover"
        >
          <div className={`h-full rounded-full ${ratio >= 1 ? 'bg-amber-500' : 'bg-accent'}`} style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      {note && <p className="mt-1 text-xs text-sub">{note}</p>}
    </div>
  )
}

export type { WorkspaceUsageDTO }
