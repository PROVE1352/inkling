// A chart with its data: aggregate (only once on screen), states, and the lazily loaded library.
// Used by the chart block and the collection chart view (docs/adr/1600-*, 1603-*).
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { chartAggregateInput } from '@inkling/shared'
import type { ChartBlockConfig, ChartDataDTO } from '@inkling/shared'
import { ApiError } from '../../api'
import { useChartData } from '../../chartApi'
import { t, useLocale } from '../../i18n'
import { useTheme } from '../../lib/theme'
import { toChartSpec } from './adapter'
import type { AdapterLabels } from './adapter'

const ChartRender = lazy(() => import('./ChartRender'))

/** Small inline chart glyph (kept here so the shared icon set is untouched). */
export function ChartGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16" />
      <rect x="6" y="11" width="3" height="7" rx="0.6" />
      <rect x="11" y="6" width="3" height="12" rx="0.6" />
      <rect x="16" y="13" width="3" height="5" rx="0.6" />
    </svg>
  )
}

/** True once the element has been on screen (charts and their data load lazily). */
export function useSeen(el: HTMLElement | null): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true)
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [el, seen])
  return seen
}

export function measureName(data: Pick<ChartDataDTO, 'measure'>): string {
  const fn = data.measure.fn
  if (fn === 'count') return t('chart.fnCount')
  const name = { sum: t('chart.fnSum'), avg: t('chart.fnAvg'), min: t('chart.fnMin'), max: t('chart.fnMax') }[fn]
  return `${name} · ${data.measure.name ?? data.measure.field ?? ''}`
}

export function adapterLabels(data: Pick<ChartDataDTO, 'measure'>): AdapterLabels {
  return { noValue: t('chart.noValue'), checked: t('chart.checked'), unchecked: t('chart.unchecked'), measure: measureName(data) }
}

export function ChartPanel({
  wsId,
  config,
  height = 300,
  extraKey = '',
  toolbar,
}: {
  wsId: string
  config: ChartBlockConfig
  height?: number
  /** joins the cache key (a view's filters) */
  extraKey?: string
  toolbar?: React.ReactNode
}) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const seen = useSeen(host)
  const input = useMemo(() => chartAggregateInput(config), [config])
  const q = useChartData(wsId, input, seen, extraKey)
  const { resolved } = useTheme()
  const locale = useLocale() === 'ko' ? 'ko-KR' : 'en-US'
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 480px)').matches
  const h = narrow ? Math.min(height, 260) : height

  const data = q.data
  const spec = useMemo(() => (data ? toChartSpec(config, data, adapterLabels(data), locale) : null), [config, data, locale])

  let body: React.ReactNode
  const err = q.error
  if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
    body = (
      <div role="status" className="flex flex-col items-center justify-center gap-1 px-4 text-center" style={{ minHeight: h / 2 }}>
        <p className="text-sm font-medium text-ink">{t('chart.noAccess')}</p>
        <p className="max-w-sm text-xs text-sub">{t('chart.noAccessHint')}</p>
      </div>
    )
  } else if (err) {
    body = (
      <p role="alert" className="px-1 py-6 text-center text-sm text-red-600 dark:text-red-400">
        {t('chart.failed')}: {(err as Error).message}
      </p>
    )
  } else if (!data || !spec) {
    body = <div aria-busy="true" className="animate-pulse rounded-md bg-hover/60" style={{ height: h }} aria-label={t('chart.loading')} />
  } else if (data.rowCount === 0 || data.groups.length === 0) {
    body = (
      <p role="status" className="px-1 py-10 text-center text-sm text-sub">
        {t('chart.empty')}
      </p>
    )
  } else {
    body = (
      <Suspense fallback={<div aria-busy="true" className="animate-pulse rounded-md bg-hover/60" style={{ height: h }} />}>
        <ChartRender spec={spec} dark={resolved === 'dark'} locale={locale} height={h} />
      </Suspense>
    )
  }

  const notes: string[] = []
  if (data) {
    notes.push(t('chart.rows', { count: data.rowCount }))
    if (data.omittedGroups) notes.push(t('chart.omitted', { count: data.omittedGroups }))
    if (data.truncated) notes.push(t('chart.truncated'))
  }
  const caption = [data?.source.type === 'collection' ? data.source.title : null, data ? measureName(data) : null, data?.group.name]
    .filter(Boolean)
    .join(' · ')

  return (
    <figure ref={setHost} className="m-0 w-full min-w-0" aria-label={config.title ? t('chart.ariaLabel', { title: config.title }) : undefined}>
      {(config.title || toolbar) && (
        <div className="mb-1 flex min-h-7 items-center gap-2">
          {config.title && <figcaption className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{config.title}</figcaption>}
          {!config.title && <span className="flex-1" />}
          {toolbar}
        </div>
      )}
      <div className="w-full min-w-0 overflow-hidden">{body}</div>
      {data && (
        <div className="mt-1 truncate text-[11px] leading-4 text-sub" title={caption} data-chart-caption>
          {caption}
          {notes.length ? ` — ${notes.join(' · ')}` : ''}
        </div>
      )}
    </figure>
  )
}
