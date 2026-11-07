import { ArrowLeftIcon, ArrowRightIcon } from './Icons'
import { useT } from '../i18n'

/**
 * Page number buttons (Previous · 1 2 3 … 9 · Next). `page` starts at 1.
 * Renders nothing when there is only one page.
 */
export function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number
  pageCount: number
  onChange: (page: number) => void
}) {
  const t = useT()
  if (pageCount <= 1) return null

  // Show first, last and one on each side of the current page; collapse the rest into ….
  const items: (number | '…')[] = []
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= 1) items.push(p)
    else if (items[items.length - 1] !== '…') items.push('…')
  }

  const btn =
    'min-w-7 rounded-md px-2 py-1 text-xs transition-colors duration-150 disabled:opacity-40'

  return (
    <nav className="mt-3 flex flex-wrap items-center justify-center gap-1" aria-label={t('pager.label')}>
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label={t('pager.previousPage')}
        className={`${btn} flex items-center gap-1 text-sub hover:bg-hover hover:text-ink`}
      >
        <ArrowLeftIcon size={12} />
        {t('common.previous')}
      </button>
      {items.map((it, i) =>
        it === '…' ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-sub">
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            onClick={() => onChange(it)}
            aria-current={it === page ? 'page' : undefined}
            className={`${btn} ${
              it === page
                ? 'bg-accent/10 font-semibold text-accent'
                : 'text-sub hover:bg-hover hover:text-ink'
            }`}
          >
            {it}
          </button>
        ),
      )}
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        aria-label={t('pager.nextPage')}
        className={`${btn} flex items-center gap-1 text-sub hover:bg-hover hover:text-ink`}
      >
        {t('common.next')}
        <ArrowRightIcon size={12} />
      </button>
    </nav>
  )
}

/** Slice a list into pages. An out-of-range page is clamped to the last page. */
export function paginate<T>(list: T[], page: number, perPage: number) {
  const pageCount = Math.max(1, Math.ceil(list.length / perPage))
  const current = Math.min(Math.max(1, page), pageCount)
  return {
    items: list.slice((current - 1) * perPage, current * perPage),
    page: current,
    pageCount,
  }
}
