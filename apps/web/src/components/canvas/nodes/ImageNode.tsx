import { NodeResizer, type NodeProps } from '@xyflow/react'
import { useT } from '../../../i18n'
import type { RFNodeData } from '../types'
import { borderColor } from '../canvasColors'
import { NodeHandles } from './NodeHandles'

// Image dropped onto the canvas. src only accepts attachments uploaded by this app (/files/<uuid>) —
// any collaborator can write node data, so this stops them from inserting an external URL to leak viewers' IPs
// or getting an unexpected scheme rendered.
const FILE_URL_RE =
  /^\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ImageNode({ data, selected }: NodeProps) {
  const t = useT()
  const d = data as RFNodeData
  const url = typeof d.url === 'string' && FILE_URL_RE.test(d.url) ? d.url : null

  return (
    <div
      className="group relative h-full w-full overflow-hidden rounded-lg border bg-app shadow-sm"
      style={{ borderColor: borderColor(d.color) }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={60}
        minHeight={60}
        color="var(--color-accent)"
      />
      <NodeHandles />
      {url ? (
        <img
          src={url}
          alt={d.name ?? t('canvas.image')}
          draggable={false}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-sub">
          {t('canvas.imageLoadFailed')}
        </div>
      )}
    </div>
  )
}
