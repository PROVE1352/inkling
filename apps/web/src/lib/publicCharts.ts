// Charts on public pages (/s/…, docs/adr/2440-*). The server sends each chart's aggregate as labels and
// numbers (`PublicPageDTO.charts`) and, in the page HTML, a title and a table in its place (blocks whose
// `data-id` is the chart's anchor). After the client sanitizer, this draws each chart with the app's own
// chart component in front of its table and hides the table from the screen only (screen readers, and a
// page whose chart could not be drawn, keep it). The chart code is a separate chunk, fetched only when a
// page has charts. Used by the public page and by its presentation slides.
import type { PublicChartDTO } from '@inkling/shared'

export type PublicChartTheme = 'light' | 'dark'

const pending = new Set<Promise<unknown>>()

/** Resolves once the charts being loaded now are drawn (printing waits for it, lib/printPage.ts). */
export function publicChartsIdle(): Promise<void> {
  return Promise.allSettled([...pending]).then(() => undefined)
}

/** The table block of each chart under `root` (by its anchor); charts without one are not drawn. */
export function chartTables(root: ParentNode, charts: readonly PublicChartDTO[]): { chart: PublicChartDTO; table: HTMLElement; title: HTMLElement | null }[] {
  const out: { chart: PublicChartDTO; table: HTMLElement; title: HTMLElement | null }[] = []
  for (const chart of charts) {
    if (!/^[A-Za-z0-9-]+$/.test(chart.anchor)) continue
    // the block's outer element (its inner container carries the same data-id)
    const table = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${chart.anchor}-t"]`)
    if (!table) continue
    out.push({ chart, table, title: root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${chart.anchor}"]`) })
  }
  return out
}

/**
 * Draw the charts of `root`. Returns a cleanup that removes them and shows the tables again (for a
 * theme change or new HTML).
 */
export function renderPublicChartsIn(root: HTMLElement, charts: readonly PublicChartDTO[] | undefined, theme: PublicChartTheme): () => void {
  if (!charts?.length) return () => {}
  const found = chartTables(root, charts)
  if (!found.length) return () => {}
  let live = true
  let undo: (() => void) | null = null
  const load = import('../components/charts/PublicChartMount')
    .then((m) => {
      if (live) undo = m.mountPublicCharts(found, theme)
      return m.drawn()
    })
    .catch(() => {}) // the tables stay
  pending.add(load)
  void load.finally(() => pending.delete(load))
  return () => {
    live = false
    undo?.()
  }
}
