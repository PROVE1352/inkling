import { Link } from 'react-router'
import { ApiError } from '../api'
import { fmtRelative, useT } from '../i18n'
import { fmtSize, fmtTokens, useLargePages } from '../largePagesApi'
import { Spinner } from './Spinner'

// Workspace settings → Large pages (owners and admins, docs/adr/1103-*): pages over the large-page
// thresholds, largest first, with what their version history stores.
export function LargePagesPanel({ wsId }: { wsId: string }) {
  const t = useT()
  const q = useLargePages(wsId)
  if (q.isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size={18} />
      </div>
    )
  }
  if (q.error || !q.data) {
    return (
      <p className="px-1 text-sm text-red-600 dark:text-red-400">
        {q.error instanceof ApiError ? q.error.message : t('largePages.loadError')}
      </p>
    )
  }
  const { pages, thresholds } = q.data
  return (
    <section className="mb-8">
      <h2 className="mb-1 px-1 text-sm font-semibold text-ink">{t('largePages.title')}</h2>
      <p className="mb-3 px-1 text-xs text-sub">
        {t('largePages.intro', { size: fmtSize(thresholds.stateBytes), tokens: fmtTokens(thresholds.tokens) })}
      </p>
      <div className="divide-y divide-line rounded-lg border border-line" data-testid="large-pages-list">
        {pages.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-sub">{t('largePages.empty')}</p>
        ) : (
          pages.map((p) => (
            <div key={p.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
              <span className="w-5 shrink-0 text-center">{p.icon ?? ''}</span>
              <div className="min-w-0 flex-1">
                <Link to={`/w/${wsId}/p/${p.id}`} className="block truncate text-ink hover:underline">
                  {p.title || t('common.untitled')}
                </Link>
                <div className="flex flex-wrap gap-x-1 text-xs text-sub">
                  <span>
                    {t('largePages.colTokens')} {fmtTokens(p.tokens)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t('largePages.colUpdated')} {fmtRelative(p.updatedAt)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t('largePages.colHistory')} {t('largePages.history', { size: fmtSize(p.snapshotBytes), count: p.snapshotCount })}
                  </span>
                </div>
              </div>
              <span
                className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-xs tabular-nums text-ink"
                title={t('largePages.colSize')}
              >
                {fmtSize(p.stateBytes)}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
