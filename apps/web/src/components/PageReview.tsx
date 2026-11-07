import { useState } from 'react'
import type { PageMetaDTO } from '@inkling/shared'
import { ApiError, useMarkReviewed, useMe, useMembers, usePageReview, useSetLiving, useSetPageOwner } from '../api'
import { fmtDate, useT } from '../i18n'
import { CheckIcon } from './Icons'
import { Spinner } from './Spinner'

// Document owner + last review (docs/adr/0951-*), shown in the right panel. Any member who can see
// the page may set the owner and mark it reviewed; reminders come from the workspace review
// interval and go out through webhooks, not the in-app inbox.

// readOnly (edit lock, docs/adr/0970-*): owner and living are page writes the lock denies; marking
// reviewed is not, so it stays.
export function PageReviewCard({
  wsId,
  page,
  readOnly = false,
}: {
  wsId: string
  page: PageMetaDTO
  readOnly?: boolean
}) {
  const t = useT()
  const review = usePageReview(page.id)
  const members = useMembers(wsId)
  const me = useMe()
  const setOwner = useSetPageOwner(page.id)
  const mark = useMarkReviewed(page.id)
  const living = useSetLiving(page.id)
  const [error, setError] = useState<string | null>(null)
  const r = review.data
  const onErr = (e: unknown) => setError(e instanceof ApiError ? e.message : t('common.unknownError'))

  if (review.isLoading) return <Spinner size={14} />
  if (!r) return null
  // A private page is visible only to its author, so only they can own it: offer "me" and "nobody".
  const options = page.scope === 'private' ? (members.data ?? []).filter((m) => m.id === me.data?.id) : (members.data ?? [])

  return (
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-xs text-sub">{t('review.owner')}</span>
        <select
          value={r.owner?.id ?? ''}
          disabled={readOnly || setOwner.isPending}
          aria-label={t('review.owner')}
          onChange={(e) => {
            setError(null)
            setOwner.mutate(e.target.value || null, { onError: onErr })
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-app px-1.5 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <option value="">{t('review.noOwner')}</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          {r.owner && !options.some((m) => m.id === r.owner?.id) && <option value={r.owner.id}>{r.owner.name}</option>}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-xs text-sub">{t('review.reviewed')}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink">
          {r.reviewedAt
            ? t('review.reviewedBy', { date: fmtDate(r.reviewedAt), name: r.reviewedBy?.name ?? '—' })
            : t('review.neverReviewed')}
        </span>
      </div>
      {r.dueOn && (
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-sub">{t('review.next')}</span>
          <span className={`text-xs ${r.stale ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-ink'}`}>
            {r.stale ? t('review.staleSince', { date: r.dueOn }) : r.dueOn}
          </span>
        </div>
      )}
      {r.priority && (
        <div className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-sub">{t('review.priorityLabel')}</span>
          <span className="text-xs text-ink" title={t('review.priorityTitle', { date: r.priority.computedOn })}>
            {t('review.priorityLine', { p: `${Math.round(r.priority.pStale * 100)}%`, count: r.priority.reads30 })}
          </span>
        </div>
      )}
      {r.intervalDays != null && page.kind === 'doc' && (
        <label className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-sub">{t('review.livingLabel')}</span>
          <select
            value={r.livingOverride === null ? 'auto' : r.livingOverride ? 'yes' : 'no'}
            disabled={readOnly || living.isPending}
            aria-label={t('review.livingLabel')}
            onChange={(e) => {
              setError(null)
              const v = e.target.value
              living.mutate(v === 'auto' ? null : v === 'yes', { onError: onErr })
            }}
            className="min-w-0 flex-1 rounded-md border border-line bg-app px-1.5 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <option value="auto">
              {t('review.livingAuto', { state: r.priority?.living ? t('review.livingYes') : t('review.livingNo') })}
            </option>
            <option value="yes">{t('review.livingYes')}</option>
            <option value="no">{t('review.livingNo')}</option>
          </select>
        </label>
      )}
      {page.kind !== 'folder' && (
        <button
          type="button"
          disabled={mark.isPending}
          onClick={() => {
            setError(null)
            mark.mutate(undefined, { onError: onErr })
          }}
          className="flex items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50"
        >
          {mark.isPending ? <Spinner size={12} /> : <CheckIcon size={13} />} {t('review.markReviewed')}
        </button>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
