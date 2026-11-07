import { useEffect, useMemo, useRef, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import type { BlockNoteEditor } from '@blocknote/core'
import { PlugIcon } from '../components/Icons'
import { usePlugins, usePluginsEnabled, type PluginInfo } from './api'
import { contextFromLocation, onSlotFreed, startBlockFrame, type PluginFrame } from './host'
import { clampHeight, LIMITS, parseBlockData } from './protocol'
import { PLUGIN_STRINGS as S } from './strings'

// Custom plugin block (Plugin API v0).
//
// Stored in the document as a plain placeholder block:
//   { type: 'pluginBlock', props: { pluginId, blockType, data: '<JSON string ≤ 16 KB>' } }
// The app never runs plugin code to *store* a block; rendering is delegated to a sandboxed
// plugin iframe (host.ts) that is created only while the block is on screen.
//
// This spec is ALWAYS part of the editor schema, even when the `plugins` experiment is off or the
// plugin is gone: otherwise y-prosemirror would drop unknown nodes on the next edit and the user's
// block data would be lost. Without an active plugin it renders an inert placeholder card.
// Like pageEmbed/callout, the server-side BlockNote schema does not know this block, so Markdown
// export drops it (documented limitation).

const pluginBlockConfig = {
  type: 'pluginBlock' as const,
  propSchema: {
    pluginId: { default: '' },
    blockType: { default: '' },
    data: { default: '{}' },
  },
  content: 'none' as const,
} as const

/** Tear a frame down after it has been off-screen this long (frees a slot). */
const OFFSCREEN_GRACE_MS = 3_000
const DEFAULT_HEIGHT = 120

function Placeholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      contentEditable={false}
      className="flex w-full items-start gap-2 rounded-md border border-dashed border-line px-3 py-2 text-xs text-sub"
    >
      <PlugIcon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-medium text-ink">{title}</div>
        {hint && <div className="mt-0.5 break-words">{hint}</div>}
      </div>
    </div>
  )
}

type ViewProps = {
  editor: BlockNoteEditor<any, any, any>
  blockId: string
  pluginId: string
  blockType: string
  dataRaw: string
}

function ActivePluginBlock({
  plugin,
  editor,
  blockId,
  blockType,
  dataRaw,
  initialHeight,
}: ViewProps & { plugin: PluginInfo; initialHeight: number }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<PluginFrame | null>(null)
  const [height, setHeight] = useState(initialHeight)
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<'idle' | 'running' | 'waiting' | 'stopped'>('idle')
  const [retry, setRetry] = useState(0)
  const data = useMemo(() => parseBlockData(dataRaw), [dataRaw])
  const dataRef = useRef(dataRaw)
  dataRef.current = dataRaw
  const editable = editor.isEditable

  // Visibility: create the frame only while (nearly) on screen.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    let offTimer: number | null = null
    const io = new IntersectionObserver(
      (entries) => {
        const on = entries.some((e) => e.isIntersecting)
        if (on) {
          if (offTimer !== null) window.clearTimeout(offTimer)
          offTimer = null
          setVisible(true)
        } else if (offTimer === null) {
          offTimer = window.setTimeout(() => {
            offTimer = null
            setVisible(false)
          }, OFFSCREEN_GRACE_MS)
        }
      },
      { rootMargin: '200px 0px' },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      if (offTimer !== null) window.clearTimeout(offTimer)
    }
  }, [])

  // Frame lifecycle.
  useEffect(() => {
    const el = hostRef.current
    if (!visible || !el || state === 'stopped') return
    let frame: PluginFrame | null = null
    let unsubSlot: (() => void) | null = null

    const tryStart = () => {
      frame = startBlockFrame({
        plugin,
        container: el,
        context: contextFromLocation(),
        block: {
          type: blockType,
          data: parseBlockData(dataRef.current),
          editable: editor.isEditable,
          onResize: (h) => setHeight(clampHeight(h)),
          onSetData: (next) => {
            if (!editor.isEditable) return
            const text = JSON.stringify(next)
            if (text.length > LIMITS.blockDataMaxChars || text === dataRef.current) return
            editor.updateBlock(blockId, { props: { data: text } } as never)
          },
        },
        onDead: (reason) => {
          frameRef.current = null
          if (reason !== 'closed') setState('stopped')
        },
      })
      if (frame) {
        frameRef.current = frame
        setState('running')
        unsubSlot?.()
        unsubSlot = null
        return true
      }
      return false
    }

    if (!tryStart()) {
      setState('waiting')
      unsubSlot = onSlotFreed(() => {
        tryStart()
      })
    }
    return () => {
      unsubSlot?.()
      frame?.destroy()
      frameRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, plugin.frameUrl, blockType, retry])

  // Push document-side data changes (local undo, collaborators) into the running frame.
  useEffect(() => {
    frameRef.current?.updateBlock(data, editable)
  }, [data, editable])

  return (
    <div ref={boxRef} contentEditable={false} className="w-full" data-plugin-block={`${plugin.id}/${blockType}`}>
      {/* The iframe is appended imperatively into this element, so React never renders children in it. */}
      <div
        ref={hostRef}
        className="relative w-full overflow-hidden rounded-md"
        style={{ height: state === 'running' ? height : 0 }}
      />
      {state === 'waiting' && <Placeholder title={S.blockWaiting} />}
      {state === 'idle' && <Placeholder title={S.blockLoading} />}
      {state === 'stopped' && (
        <div className="flex items-center gap-2">
          <Placeholder title={S.blockStopped} hint={`${plugin.name} / ${blockType}`} />
          <button
            type="button"
            className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            onClick={() => {
              setState('idle')
              setRetry((n) => n + 1)
            }}
          >
            {S.blockRestart}
          </button>
        </div>
      )}
    </div>
  )
}

function PluginBlockView(props: ViewProps) {
  const enabled = usePluginsEnabled()
  const plugins = usePlugins()
  const plugin = enabled ? plugins.data?.find((p) => p.id === props.pluginId) : undefined
  const decl = plugin?.blocks.find((b) => b.type === props.blockType)
  if (!plugin || !decl || !plugin.permissions.includes('blocks')) {
    return (
      <Placeholder title={S.blockUnavailable} hint={S.blockUnavailableHint(props.pluginId, props.blockType)} />
    )
  }
  return <ActivePluginBlock {...props} plugin={plugin} initialHeight={decl.height ?? DEFAULT_HEIGHT} />
}

export const pluginBlockSpec = createReactBlockSpec(pluginBlockConfig, {
  render: ({ block, editor }) => (
    <PluginBlockView
      editor={editor as BlockNoteEditor<any, any, any>}
      blockId={block.id}
      pluginId={String(block.props.pluginId ?? '')}
      blockType={String(block.props.blockType ?? '')}
      dataRaw={String(block.props.data ?? '{}')}
    />
  ),
  // Outside the editor (copy / HTML export) a plugin block is just a labelled placeholder.
  toExternalHTML: ({ block }) => (
    <p>
      [plugin block: {String(block.props.pluginId)}/{String(block.props.blockType)}]
    </p>
  ),
})()
