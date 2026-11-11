import { useState } from 'react'
import type { ShareStatusDTO } from '@inkling/shared'
import { ApiError, useUpdateShare } from '../api'
import { useT } from '../i18n'

// Charts on the public page (docs/adr/2440-*, 2444-*): how many charts of what the link shows stay off it,
// and the link's "include charts" switch. Off by default; turning it on approves the databases and queries
// the charts use now, and the public page shows their charts' labels and numbers as aggregated by the
// manager who turned it on (never its rows). A chart added later over another source waits until a manager
// presses "Publish these charts too". Before a link exists only the count shows: the switch belongs to the link.
export function ShareChartsOption({
  pageId,
  status,
  shared,
  canManage,
}: {
  pageId: string
  status: ShareStatusDTO
  shared: boolean
  canManage: boolean
}) {
  const t = useT()
  const update = useUpdateShare(pageId)
  const [error, setError] = useState<string | null>(null)
  const charts = status.charts
  if (!charts || charts.total === 0) return null
  const on = !!status.includeCharts
  const send = (body: { includeCharts: boolean } | { approveChartSources: true }) => {
    setError(null)
    update.mutate(body, { onError: (err) => setError(err instanceof ApiError ? err.message : t('shareLink.updateFailed')) })
  }
  const toggle = (next: boolean) => send({ includeCharts: next })
  const pending = shared && on ? charts.pending : 0
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line px-3 py-2.5 text-sm" data-testid="share-charts">
      {charts.hidden - pending > 0 && (
        <p className="text-sm text-ink" role="status" data-testid="share-charts-hidden">
          {t('publicCharts.hidden', { count: charts.hidden - pending })}
        </p>
      )}
      {pending > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="share-charts-pending">
          <p className="min-w-0 flex-1 text-sm text-ink" role="status">
            {t('publicCharts.pending', { count: pending })}
          </p>
          {canManage && (
            <button
              type="button"
              disabled={update.isPending}
              onClick={() => send({ approveChartSources: true })}
              data-testid="share-charts-approve"
              className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-60"
            >
              {t('publicCharts.approve')}
            </button>
          )}
        </div>
      )}
      {shared && (
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-sub">{t('publicCharts.label')}</span>
          {canManage ? (
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={on} disabled={update.isPending} onChange={(e) => toggle(e.target.checked)} data-testid="share-include-charts" />
              {t('publicCharts.include')}
            </label>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-ink">{on ? t('publicCharts.on') : t('publicCharts.off')}</span>
          )}
        </div>
      )}
      <p className={`text-xs text-sub ${shared ? 'pl-[92px] max-sm:pl-0' : ''}`}>
        {shared ? t('publicCharts.hint') : t('publicCharts.hintBeforeLink')}
      </p>
      {shared && on && status.chartsBy && (
        <p className="pl-[92px] text-xs text-sub max-sm:pl-0">{t('publicCharts.by', { name: status.chartsBy })}</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
