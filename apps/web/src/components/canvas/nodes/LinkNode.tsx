import { NodeResizer, type NodeProps } from '@xyflow/react'
import type { RFNodeData } from '../types'
import { borderColor, tintBackground } from '../canvasColors'
import { LinkIcon } from '../../Icons'
import { NodeHandles } from './NodeHandles'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// Block dangerous schemes such as javascript:/data: — only http/https/mailto open in a new tab.
function isSafeUrl(url: string): boolean {
  try {
    const scheme = new URL(url).protocol
    return scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:'
  } catch {
    return false
  }
}

// URL card (simple form: shows the domain). Click → new tab.
export function LinkNode({ data, selected }: NodeProps) {
  const d = data as RFNodeData
  const url = d.url ?? ''

  const open = () => {
    if (url && isSafeUrl(url)) window.open(url, '_blank', 'noopener,noreferrer')
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
      <span className="shrink-0 text-sub">
        <LinkIcon size={15} />
      </span>
      <button
        type="button"
        onClick={open}
        className="nodrag min-w-0 flex-1 truncate text-left text-accent hover:underline"
        title={url}
      >
        {hostOf(url)}
      </button>
    </div>
  )
}
