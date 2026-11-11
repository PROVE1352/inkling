// The chart chunk of public pages (docs/adr/2440-*), loaded by lib/publicCharts.ts only when a page has
// charts. Each chart is the app's own chart component (ChartRender, the same chunk the editor loads)
// drawn from the public aggregate through the same adapter, in front of the table that stands for it;
// the table (and its title) are then hidden from the screen only.
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { chartDataOfPublic } from '@inkling/shared'
import type { PublicChartDTO } from '@inkling/shared'
import { getLocale, t } from '../../i18n'
import { toChartSpec } from './adapter'
import ChartRender from './ChartRender'
import './publicCharts.css'

/** Hidden from the screen, kept for screen readers (and shown again when the chart goes). */
const SOURCE_CLASS = 'nd-public-chart-source'

function measureName(c: PublicChartDTO): string {
  const fn = c.measure.fn
  if (fn === 'count') return t('chart.fnCount')
  const name = { sum: t('chart.fnSum'), avg: t('chart.fnAvg'), min: t('chart.fnMin'), max: t('chart.fnMax') }[fn]
  return `${name} · ${c.measure.name ?? ''}`
}

function PublicChartFigure({ chart, dark, locale, height, still }: { chart: PublicChartDTO; dark: boolean; locale: string; height: number; still: boolean }) {
  const labels = { noValue: t('chart.noValue'), checked: t('chart.checked'), unchecked: t('chart.unchecked'), measure: measureName(chart) }
  // drawn at once rather than when scrolled into view: a printed page or PDF must show every chart;
  // while printing, without any animation (the snapshot is taken right away)
  const options: Record<string, boolean> = still ? { animateOnView: false, animate: false } : { animateOnView: false }
  const spec = toChartSpec({ kind: chart.kind, options, ...(chart.title ? { title: chart.title } : {}) }, chartDataOfPublic(chart), labels, locale)
  const notes: string[] = []
  if (chart.omittedGroups) notes.push(t('chart.omitted', { count: chart.omittedGroups }))
  if (chart.truncated) notes.push(t('chart.truncated'))
  const caption = [measureName(chart), chart.group].filter(Boolean).join(' · ')
  return (
    <figure className="m-0 w-full min-w-0" aria-label={chart.title ? t('chart.ariaLabel', { title: chart.title }) : undefined}>
      {chart.title && <figcaption className="mb-1 truncate text-sm font-semibold text-ink">{chart.title}</figcaption>}
      <div className="nd-public-chart-plot w-full min-w-0 overflow-hidden">
        <ChartRender spec={spec} dark={dark} locale={locale} height={height} />
      </div>
      <div className="mt-1 truncate text-[11px] leading-4 text-sub" title={caption}>
        {caption}
        {notes.length ? ` — ${notes.join(' · ')}` : ''}
      </div>
    </figure>
  )
}

let lastDraw: Promise<void> = Promise.resolve()

/** Resolves after the last mount has had two frames to lay out (the library measures its box). */
export function drawn(): Promise<void> {
  return lastDraw
}

/**
 * Draw each chart in front of its table and hide the table from the screen. While printing (the print
 * dialog, "Save as PDF", a print-media PDF) the charts are drawn again in the light palette without
 * animation: print.css puts the page on white paper whatever the theme. Returns the undo.
 */
export function mountPublicCharts(
  found: { chart: PublicChartDTO; table: HTMLElement; title: HTMLElement | null }[],
  theme: 'light' | 'dark',
): () => void {
  const locale = getLocale() === 'ko' ? 'ko-KR' : 'en-US'
  const printMedia = typeof window !== 'undefined' ? window.matchMedia?.('print') : undefined
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 480px)').matches
  const height = narrow ? 260 : 300
  const undo: (() => void)[] = []
  const draws: ((printing: boolean) => void)[] = []
  for (const { chart, table, title } of found) {
    // nothing to draw: the table (a header) says so as it is
    if (!chart.groups.length) continue
    const first = title ?? table
    const host = first.ownerDocument.createElement('div')
    host.className = 'nd-public-chart my-2 rounded-lg border border-line px-3 pb-2 pt-2'
    host.setAttribute('data-public-chart', chart.kind)
    first.before(host)
    const root = createRoot(host)
    const draw = (printing: boolean) =>
      flushSync(() =>
        root.render(<PublicChartFigure chart={chart} dark={theme === 'dark' && !printing} locale={locale} height={height} still={printing} />),
      )
    try {
      draw(printMedia?.matches ?? false)
    } catch {
      root.unmount()
      host.remove()
      continue
    }
    draws.push(draw)
    const hidden = [title, table].filter((el): el is HTMLElement => !!el)
    for (const el of hidden) el.classList.add(SOURCE_CLASS)
    undo.push(() => {
      root.unmount()
      host.remove()
      for (const el of hidden) el.classList.remove(SOURCE_CLASS)
    })
  }
  lastDraw = new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  let printing = printMedia?.matches ?? false
  const redraw = (next: boolean) => {
    if (next === printing) return
    printing = next
    for (const d of draws) d(next)
  }
  const onMedia = () => redraw(printMedia?.matches ?? false)
  const onBefore = () => redraw(true)
  const onAfter = () => redraw(printMedia?.matches ?? false)
  if (draws.length) {
    printMedia?.addEventListener('change', onMedia)
    window.addEventListener('beforeprint', onBefore)
    window.addEventListener('afterprint', onAfter)
  }
  return () => {
    printMedia?.removeEventListener('change', onMedia)
    window.removeEventListener('beforeprint', onBefore)
    window.removeEventListener('afterprint', onAfter)
    for (const u of undo) u()
  }
}
