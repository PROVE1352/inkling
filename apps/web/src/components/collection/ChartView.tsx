// Collection "chart" view (docs/adr/1603-*): the view's config holds what to draw (`config.chart`);
// the rows are the ones the view's own filters keep (the filter menu is the same as other views').
// The server aggregates with the view's saved filters, and the key carries them, so a filter change
// draws again at once.
import { useMemo, useState } from 'react'
import { canonicalChartConfig } from '@inkling/shared'
import type { ChartBlockConfig, CollectionViewDTO, ViewConfig } from '@inkling/shared'
import { t } from '../../i18n'
import { ChartPanel } from '../charts/ChartPanel'
import { ChartSettingsForm } from '../charts/ChartSettings'
import { useCollectionReadOnly } from './readOnlyContext'

export function ChartView({
  view,
  wsId,
  collectionId,
  onUpdateConfig,
}: {
  view: CollectionViewDTO
  wsId: string
  collectionId: string
  onUpdateConfig: (config: ViewConfig) => void
}) {
  const readOnly = useCollectionReadOnly()
  const [editing, setEditing] = useState(false)
  const chart = view.config.chart
  const config: ChartBlockConfig | null = useMemo(
    () => (chart ? { ...chart, source: { type: 'collection', collectionId, viewId: view.id } } : null),
    [chart, collectionId, view.id],
  )
  const filtersKey = JSON.stringify(view.config.filters ?? [])

  if (!config || editing) {
    if (readOnly) return <p className="px-1 py-10 text-center text-sm text-sub">{t('chart.viewNotSet')}</p>
    return (
      <div className="mx-auto mt-3 w-full max-w-2xl">
        <ChartSettingsForm
          wsId={wsId}
          initial={config}
          fixedCollectionId={collectionId}
          onSave={(settings) => {
            onUpdateConfig({ ...view.config, chart: canonicalChartConfig(settings) })
            setEditing(false)
          }}
          onCancel={config ? () => setEditing(false) : undefined}
        />
      </div>
    )
  }

  return (
    <div className="mt-3 w-full min-w-0 rounded-lg border border-line px-3 pb-2 pt-2">
      <ChartPanel
        wsId={wsId}
        config={config}
        height={360}
        extraKey={filtersKey}
        toolbar={
          readOnly ? null : (
            <button type="button" onClick={() => setEditing(true)} className="rounded px-1.5 py-0.5 text-xs text-sub hover:bg-hover hover:text-ink">
              {t('chart.edit')}
            </button>
          )
        }
      />
    </div>
  )
}
