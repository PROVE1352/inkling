import { useNavigate } from 'react-router'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import { usePages } from '../../../api'
import { useT } from '../../../i18n'
import { pageIcon } from '../../../lib/pageIcon'
import type { RFNodeData } from '../types'
import { borderColor, tintBackground } from '../canvasColors'
import { useCanvasContext } from '../canvasContext'
import { NodeHandles } from './NodeHandles'

// Page link card. Title/icon are looked up live from the pages cache. Click → navigate to that page.
export function PageNode({ data, selected }: NodeProps) {
  const t = useT()
  const d = data as RFNodeData
  const { wsId } = useCanvasContext()
  const navigate = useNavigate()
  const pages = usePages(wsId)
  const target = (pages.data ?? []).find((p) => p.id === d.pageId)

  const open = () => {
    if (d.pageId) navigate(`/w/${wsId}/p/${d.pageId}`)
  }

  return (
    <div
      className="group flex h-full w-full items-center gap-2 overflow-hidden rounded-lg border px-3 text-sm text-ink shadow-sm"
      style={{ borderColor: borderColor(d.color), background: tintBackground(d.color) }}
      onDoubleClick={open}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={140}
        minHeight={44}
        color="var(--color-accent)"
      />
      <NodeHandles />
      <span className="shrink-0 text-[15px] leading-none">
        {target ? pageIcon(target) : '🔗'}
      </span>
      <button
        type="button"
        onClick={open}
        className="nodrag min-w-0 flex-1 truncate text-left font-medium hover:text-accent"
        title={target?.title || t('canvas.deletedPage')}
      >
        {target ? target.title || t('common.untitled') : t('canvas.deletedPage')}
      </button>
    </div>
  )
}
