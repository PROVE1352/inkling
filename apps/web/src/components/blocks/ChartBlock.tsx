// Chart block (docs/adr/1600-*): one prop, `config` — the canonical JSON of a ChartBlockConfig
// (source + what to draw). No data is stored: each viewer's aggregate is fetched when the block is
// on screen, and the chart library is loaded then (ChartPanel). The config is shared with the
// server schema (packages/shared blocks.ts) and reads as `<!-- inkling:chart {…} -->` for agents.
import { useState } from 'react'
import { useParams } from 'react-router'
import { createReactBlockSpec } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import type { BlockNoteEditor } from '@blocknote/core'
import { canonicalChartJson, chartBlockConfig, parseChartBlockConfig } from '@inkling/shared'
import { t } from '../../i18n'
import { insertFromSlash, type SlashEditor } from '../../lib/slashInsert'
import { ChartGlyph, ChartPanel } from '../charts/ChartPanel'
import { ChartSettingsForm } from '../charts/ChartSettings'

type AnyEditor = BlockNoteEditor<any, any, any>

function ChartBlockView({ editor, block }: { editor: AnyEditor; block: { id: string; props: { config: string } } }) {
  const { wsId = '' } = useParams()
  const config = parseChartBlockConfig(block.props.config)
  const editable = editor.isEditable
  const [editing, setEditing] = useState(false)

  const save = (json: string) => {
    editor.updateBlock(block.id, { type: 'chart', props: { config: json } } as never)
    setEditing(false)
  }

  if (!config || editing) {
    if (!editable) {
      return (
        <div contentEditable={false} className="w-full rounded-md border border-dashed border-line px-3 py-4 text-sm text-sub">
          {t('chart.notSetUp')}
        </div>
      )
    }
    return (
      <div contentEditable={false} className="w-full" data-chart-setup>
        {!config && (
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
            <ChartGlyph /> {t('chart.setupTitle')} <span className="font-normal text-sub">— {t('chart.setupHint')}</span>
          </p>
        )}
        <ChartSettingsForm
          wsId={wsId}
          initial={config}
          onSave={(settings, source) => save(canonicalChartJson({ ...settings, source }))}
          onCancel={config ? () => setEditing(false) : undefined}
        />
      </div>
    )
  }

  return (
    <div contentEditable={false} className="group/chart w-full rounded-lg border border-line px-3 pb-2 pt-2" data-chart-block>
      <ChartPanel
        wsId={wsId}
        config={config}
        toolbar={
          editable ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded px-1.5 py-0.5 text-xs text-sub opacity-100 transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-hover/chart:opacity-100"
            >
              {t('chart.edit')}
            </button>
          ) : null
        }
      />
    </div>
  )
}

export const chartBlockSpec = createReactBlockSpec(chartBlockConfig, {
  render: ({ block, editor }) => <ChartBlockView editor={editor as unknown as AnyEditor} block={block as never} />,
  // Copy / client HTML export: the title only (the numbers depend on who reads them)
  toExternalHTML: ({ block }) => {
    const c = parseChartBlockConfig(block.props.config)
    return <p>{c?.title ? `${t('chart.slashTitle')}: ${c.title}` : t('chart.slashTitle')}</p>
  },
})()

/** Slash-menu entry: an empty chart block that opens its settings. */
export function chartSlashItems(editor: AnyEditor): DefaultReactSuggestionItem[] {
  if (!('chart' in editor.schema.blockSchema)) return []
  return [
    {
      title: t('chart.slashTitle'),
      subtext: t('chart.slashSubtext'),
      // search data, not display text: English and Korean in every locale
      aliases: ['chart', 'graph', 'bar', 'pie', 'donut', 'line', 'plot', 'visualize', '차트', '그래프', '막대', '파이', '도넛', '선 그래프', '시각화'],
      group: t('linkEmbed.slashGroup'),
      icon: <ChartGlyph size={16} />,
      onItemClick: () => {
        insertFromSlash(editor as unknown as SlashEditor, { type: 'chart', props: { config: '' } } as never, 'own')
      },
    },
  ]
}
