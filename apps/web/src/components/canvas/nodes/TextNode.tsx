import { useEffect, useRef, useState } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import { useT } from '../../../i18n'
import type { RFNodeData } from '../types'
import { borderColor, tintBackground } from '../canvasColors'
import { useCanvasContext } from '../canvasContext'
import { NodeHandles } from './NodeHandles'

// Text card. Double-click → edit in a textarea (nodrag); resize with NodeResizer.
// While editing, remote changes do not overwrite the draft.
export function TextNode({ id, data, selected }: NodeProps) {
  const t = useT()
  const d = data as RFNodeData
  const { commitText } = useCanvasContext()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(d.text ?? '')
  const timerRef = useRef<number | undefined>(undefined)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Apply remote/external text only when not editing
  useEffect(() => {
    if (!editing) setDraft(d.text ?? '')
  }, [d.text, editing])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const startEdit = () => {
    setEditing(true)
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.select()
    })
  }

  const onChange = (value: string) => {
    setDraft(value)
    window.clearTimeout(timerRef.current)
    // Commit to Y with a 300ms debounce
    timerRef.current = window.setTimeout(() => commitText(id, value), 300)
  }

  const finishEdit = () => {
    setEditing(false)
    window.clearTimeout(timerRef.current)
    commitText(id, draft)
  }

  return (
    <div
      className="group h-full w-full overflow-hidden rounded-lg border text-sm text-ink shadow-sm"
      style={{ borderColor: borderColor(d.color), background: tintBackground(d.color) }}
      onDoubleClick={startEdit}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={60}
        color="var(--color-accent)"
      />
      <NodeHandles />
      {editing ? (
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onBlur={finishEdit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              finishEdit()
            }
          }}
          className="nodrag nowheel h-full w-full resize-none bg-transparent p-2.5 text-sm text-ink focus-visible:outline-none"
          placeholder={t('canvas.textPlaceholder')}
        />
      ) : (
        <div className="h-full w-full whitespace-pre-wrap break-words p-2.5">
          {draft || <span className="text-sub/60">{t('canvas.emptyCard')}</span>}
        </div>
      )}
    </div>
  )
}
