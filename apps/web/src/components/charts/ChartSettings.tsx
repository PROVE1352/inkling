// Chart settings form: data source (blocks only), kind, grouping, measure, order, title and library
// options. Native controls throughout (keyboard and screen readers work without extra code).
import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CHART_BASIC_KINDS,
  CHART_GROUP_TYPES,
  CHART_MEASURE_TYPES,
  CHART_MORE_KINDS,
  CHART_SERIES_KINDS,
  CHART_TITLE_FIELD,
  canonicalChartConfig,
  chartOptionsSchema,
} from '@inkling/shared'
import type { ChartBlockConfig, ChartBucket, ChartFn, ChartKind, ChartSettings as Settings, ChartSort, CollectionDTO, CollectionField } from '@inkling/shared'
import { api, qk, usePages } from '../../api'
import { t } from '../../i18n'

const FIELD = 'h-8 w-full min-w-0 rounded-md border border-line bg-app px-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
const LABEL = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-sub'

const KIND_LABEL: Record<(typeof CHART_BASIC_KINDS)[number], () => string> = {
  bar: () => t('chart.kindBar'),
  barH: () => t('chart.kindBarH'),
  stackedBar: () => t('chart.kindStackedBar'),
  line: () => t('chart.kindLine'),
  area: () => t('chart.kindArea'),
  donut: () => t('chart.kindDonut'),
  pie: () => t('chart.kindPie'),
}

/**
 * One option of a choice group: a button with role="radio" (inside the editor a label around a
 * hidden radio does not reliably toggle — ProseMirror owns the pointer events of the node view).
 */
function Choice({ on, onPick, children }: { on: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={`rounded-md border px-2.5 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${on ? 'border-accent bg-accent-soft text-ink' : 'border-line text-sub hover:bg-hover'}`}
    >
      {children}
    </button>
  )
}

/** Definition only (no rows) of a collection, for the field pickers. */
function useCollectionDef(collectionId: string | null) {
  return useQuery({
    queryKey: [...qk.collection(collectionId ?? ''), 'def'],
    queryFn: () => api<{ collection: CollectionDTO }>(`/api/pages/${collectionId}/collection?rows=0`).then((r) => r.collection),
    enabled: !!collectionId,
    staleTime: 30_000,
  })
}

type Draft = {
  sourceType: 'collection' | 'query'
  collectionId: string
  viewId: string
  query: string
  kind: ChartKind
  groupBy: string
  bucket: ChartBucket | ''
  series: string
  seriesBucket: ChartBucket | ''
  fn: ChartFn
  measureField: string
  sort: ChartSort
  title: string
  options: string
}

function draftOf(c: Partial<ChartBlockConfig> | null, fixedCollection?: string): Draft {
  const src = c?.source
  return {
    sourceType: src?.type === 'query' ? 'query' : 'collection',
    collectionId: fixedCollection ?? (src?.type === 'collection' ? src.collectionId : ''),
    viewId: src?.type === 'collection' ? (src.viewId ?? '') : '',
    query: src?.type === 'query' ? src.query : '',
    kind: c?.kind ?? 'bar',
    groupBy: c?.groupBy?.field ?? '',
    bucket: c?.groupBy?.bucket ?? '',
    series: c?.series?.field ?? '',
    seriesBucket: c?.series?.bucket ?? '',
    fn: c?.measure?.fn ?? 'count',
    measureField: c?.measure?.field ?? '',
    sort: c?.sort ?? 'auto',
    title: c?.title ?? '',
    options: c?.options && Object.keys(c.options).length ? JSON.stringify(c.options, null, 1) : '',
  }
}

export function ChartSettingsForm({
  wsId,
  initial,
  fixedCollectionId,
  onSave,
  onCancel,
  saving,
}: {
  wsId: string
  initial: Partial<ChartBlockConfig> | null
  /** chart view: the collection is the view's own (no source picker) */
  fixedCollectionId?: string
  onSave: (settings: Settings, source: ChartBlockConfig['source']) => void
  onCancel?: () => void
  saving?: boolean
}) {
  const id = useId()
  const [d, setD] = useState<Draft>(() => draftOf(initial, fixedCollectionId))
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const pages = usePages(wsId)
  const collections = useMemo(
    () => (pages.data ?? []).filter((p) => p.kind === 'collection').sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [pages.data],
  )
  const def = useCollectionDef(d.sourceType === 'collection' && d.collectionId ? d.collectionId : null)
  const fields: CollectionField[] = def.data?.fields ?? []
  const groupFields = fields.filter((f) => CHART_GROUP_TYPES.has(f.type))
  const numberFields = fields.filter((f) => CHART_MEASURE_TYPES.has(f.type))
  const fieldOf = (fid: string) => fields.find((f) => f.id === fid)
  const isDate = (fid: string) => d.sourceType === 'query' || fieldOf(fid)?.type === 'date'
  const seriesAllowed = CHART_SERIES_KINDS.includes(d.kind)

  let optionsError = false
  let options: Settings['options']
  if (d.options.trim()) {
    try {
      const parsed = chartOptionsSchema.safeParse(JSON.parse(d.options))
      if (parsed.success) options = parsed.data
      else optionsError = true
    } catch {
      optionsError = true
    }
  }
  const needsNumber = d.fn !== 'count' && !d.measureField
  const sourceOk = d.sourceType === 'query' ? !!d.query.trim() : !!d.collectionId
  const canSave = sourceOk && !!d.groupBy && !needsNumber && !optionsError && !saving

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    const settings: Settings = canonicalChartConfig<Settings>({
      kind: d.kind,
      groupBy: { field: d.groupBy, ...(d.bucket && isDate(d.groupBy) ? { bucket: d.bucket } : {}) },
      ...(seriesAllowed && d.series ? { series: { field: d.series, ...(d.seriesBucket && isDate(d.series) ? { bucket: d.seriesBucket } : {}) } } : {}),
      ...(d.fn !== 'count' ? { measure: { fn: d.fn, field: d.measureField } } : {}),
      ...(d.sort !== 'auto' ? { sort: d.sort } : {}),
      ...(d.title.trim() ? { title: d.title.trim() } : {}),
      ...(options && Object.keys(options).length ? { options } : {}),
    })
    const source: ChartBlockConfig['source'] =
      d.sourceType === 'query'
        ? { type: 'query', query: d.query.trim() }
        : { type: 'collection', collectionId: d.collectionId, ...(d.viewId ? { viewId: d.viewId } : {}) }
    onSave(settings, source)
  }

  const fieldSelect = (value: string, onChange: (v: string) => void, list: CollectionField[], withTitle: boolean, withNone: boolean, label: string) =>
    d.sourceType === 'query' ? (
      <input className={FIELD} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('chart.column')} aria-label={label} />
    ) : (
      <select className={FIELD} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{withNone ? t('chart.none') : '—'}</option>
        {withTitle && <option value={CHART_TITLE_FIELD}>{t('chart.title_field')}</option>}
        {list.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    )

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line bg-app p-3 text-ink shadow-sm" contentEditable={false} onKeyDown={(e) => e.stopPropagation()}>
      {!fixedCollectionId && (
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-sub">{t('chart.source')}</legend>
          <div role="radiogroup" aria-label={t('chart.source')} className="flex gap-1">
            {(['collection', 'query'] as const).map((s) => (
              <Choice key={s} on={d.sourceType === s} onPick={() => set('sourceType', s)}>
                {s === 'collection' ? t('chart.sourceCollection') : t('chart.sourceQuery')}
              </Choice>
            ))}
          </div>
          {d.sourceType === 'collection' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className={LABEL}>
                {t('chart.sourceCollection')}
                <select
                  className={FIELD}
                  value={d.collectionId}
                  onChange={(e) => setD((x) => ({ ...x, collectionId: e.target.value, viewId: '', groupBy: '', series: '', measureField: '' }))}
                >
                  <option value="">{t('chart.pickCollection')}</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title || t('common.untitled')}
                    </option>
                  ))}
                </select>
                {!pages.isLoading && collections.length === 0 && <span className="font-normal">{t('chart.noCollections')}</span>}
              </label>
              <label className={LABEL}>
                {t('chart.view')}
                <select className={FIELD} value={d.viewId} onChange={(e) => set('viewId', e.target.value)} disabled={!d.collectionId}>
                  <option value="">{t('chart.allRows')}</option>
                  {(def.data?.views ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {t('chart.viewFilters', { name: v.name })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <label className={LABEL}>
              {t('chart.query')}
              <textarea className={`${FIELD} h-20 py-1 font-mono text-xs`} value={d.query} onChange={(e) => set('query', e.target.value)} spellCheck={false} />
              <span className="font-normal">{t('chart.queryHint')}</span>
            </label>
          )}
        </fieldset>
      )}

      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-1 text-xs font-medium text-sub">{t('chart.kind')}</legend>
        <div role="radiogroup" aria-label={t('chart.kind')} className="flex flex-wrap gap-1">
          {CHART_BASIC_KINDS.map((k) => (
            <Choice key={k} on={d.kind === k} onPick={() => set('kind', k)}>
              {KIND_LABEL[k]()}
            </Choice>
          ))}
          <select
            className={`h-7 rounded-md border px-1.5 text-xs ${(CHART_MORE_KINDS as readonly string[]).includes(d.kind) ? 'border-accent text-ink' : 'border-line text-sub'} bg-app`}
            value={(CHART_MORE_KINDS as readonly string[]).includes(d.kind) ? d.kind : ''}
            onChange={(e) => e.target.value && set('kind', e.target.value as ChartKind)}
            aria-label={t('chart.moreKinds')}
          >
            <option value="">{t('chart.moreKinds')}…</option>
            {CHART_MORE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className={LABEL}>
          {t('chart.groupBy')}
          {fieldSelect(d.groupBy, (v) => set('groupBy', v), groupFields, true, false, t('chart.groupBy'))}
        </label>
        {d.groupBy && isDate(d.groupBy) && (
          <label className={LABEL}>
            {t('chart.bucket')}
            <select className={FIELD} value={d.bucket} onChange={(e) => set('bucket', e.target.value as ChartBucket | '')}>
              <option value="">{t('chart.bucketDay')}</option>
              <option value="week">{t('chart.bucketWeek')}</option>
              <option value="month">{t('chart.bucketMonth')}</option>
            </select>
          </label>
        )}
        {seriesAllowed && (
          <label className={LABEL}>
            {t('chart.series')}
            {fieldSelect(d.series, (v) => set('series', v), groupFields, false, true, t('chart.series'))}
          </label>
        )}
        <label className={LABEL}>
          {t('chart.measure')}
          <select className={FIELD} value={d.fn} onChange={(e) => set('fn', e.target.value as ChartFn)}>
            <option value="count">{t('chart.fnCount')}</option>
            <option value="sum">{t('chart.fnSum')}</option>
            <option value="avg">{t('chart.fnAvg')}</option>
            <option value="min">{t('chart.fnMin')}</option>
            <option value="max">{t('chart.fnMax')}</option>
          </select>
        </label>
        {d.fn !== 'count' && (
          <label className={LABEL}>
            {t('chart.of')}
            {fieldSelect(d.measureField, (v) => set('measureField', v), numberFields, false, false, t('chart.of'))}
            {needsNumber && <span className="font-normal text-red-600 dark:text-red-400">{t('chart.needsNumber')}</span>}
          </label>
        )}
        <label className={LABEL}>
          {t('chart.sort')}
          <select className={FIELD} value={d.sort} onChange={(e) => set('sort', e.target.value as ChartSort)}>
            <option value="auto">{t('chart.sortAuto')}</option>
            <option value="label">{t('chart.sortLabel')}</option>
            <option value="valueDesc">{t('chart.sortValueDesc')}</option>
            <option value="valueAsc">{t('chart.sortValueAsc')}</option>
          </select>
        </label>
        <label className={LABEL}>
          {t('chart.title')}
          <input className={FIELD} value={d.title} maxLength={120} onChange={(e) => set('title', e.target.value)} placeholder={t('chart.titlePlaceholder')} />
        </label>
      </div>

      <details className="text-xs text-sub">
        <summary className="cursor-pointer select-none">{t('chart.advanced')}</summary>
        <textarea
          className={`${FIELD} mt-1 h-16 py-1 font-mono text-xs`}
          value={d.options}
          onChange={(e) => set('options', e.target.value)}
          spellCheck={false}
          aria-invalid={optionsError}
          aria-label={t('chart.advanced')}
        />
        <p className={optionsError ? 'text-red-600 dark:text-red-400' : ''}>{optionsError ? t('chart.advancedInvalid') : t('chart.advancedHint')}</p>
      </details>

      <div className="flex items-center justify-end gap-2">
        {!d.groupBy && <span className="mr-auto text-xs text-sub">{t('chart.needsGroup')}</span>}
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink">
            {t('chart.cancel')}
          </button>
        )}
        <button type="submit" disabled={!canSave} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">
          {t('chart.save')}
        </button>
      </div>
    </form>
  )
}
