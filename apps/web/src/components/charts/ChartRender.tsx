// The chart library's React side, in its own chunk: loaded by ChartPanel (React.lazy) the first time
// a chart is on screen, so pages without charts never download it (docs/adr/1601-*, PERFORMANCE.md).
// The library draws SVG with keyboard focus per mark, a screen-reader description and data table,
// and reduced motion; theme and language come from the app.
//
// Only the components of the kinds we offer are imported (15 of the library's 36): the spec becomes
// props the way the library's own <Chart> does it (resolveDef + encodingToProps + options), without
// pulling its registry of every chart. Measured: 98.5 kB gzip with <Chart>, see PERFORMANCE.md.
import type { ComponentType } from 'react'
import {
  AreaChart,
  autoLegend,
  BarChart,
  DonutChart,
  encodingToProps,
  FunnelChart,
  Heatmap,
  Legend,
  LineChart,
  LollipopChart,
  ParetoChart,
  PieChart,
  RadarChart,
  RadialBarChart,
  resolveDef,
  SegmentedBar,
  StreamGraph,
  ThemeProvider,
  Treemap,
  WaffleChart,
} from 'ztd-charts'
import type { ChartSpec } from 'ztd-charts/spec'

const COMPONENTS: Record<string, ComponentType<any>> = {
  bar: BarChart,
  line: LineChart,
  area: AreaChart,
  stream: StreamGraph,
  donut: DonutChart,
  pie: PieChart,
  lollipop: LollipopChart,
  funnel: FunnelChart,
  treemap: Treemap,
  waffle: WaffleChart,
  radialBar: RadialBarChart,
  pareto: ParetoChart,
  segmented: SegmentedBar,
  heatmap: Heatmap,
  radar: RadarChart,
}

export default function ChartRender({ spec, dark, locale, height }: { spec: ChartSpec; dark: boolean; locale: string; height: number }) {
  const Comp = COMPONENTS[spec.type]
  const def = resolveDef(spec.type, spec.encoding)
  if (!Comp || !def) return null
  const rows = spec.data as Record<string, unknown>[]
  // a series needs its colors named: the library's own legend for the spec (as its cards do)
  const legend = spec.encoding?.series ? autoLegend(spec, rows, locale) : []
  return (
    <ThemeProvider theme={dark ? 'dark' : 'light'} locale={locale}>
      {legend.length > 1 && (
        <div className="mb-2">
          <Legend items={legend} locale={locale} />
        </div>
      )}
      <Comp {...encodingToProps(def, spec.encoding)} {...(spec.options ?? {})} data={rows} height={height} locale={locale} />
    </ThemeProvider>
  )
}
