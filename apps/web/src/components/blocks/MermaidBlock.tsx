import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { BlockNoteEditor } from '@blocknote/core'
import { cachedMermaid, renderMermaid, type MermaidResult } from '../../lib/mermaid'
import { useTheme } from '../../lib/theme'
import { useT } from '../../i18n'
import { queryCodeBlockSpec } from './QueryBlock'

/**
 * Mermaid diagrams (docs/adr/2104-*): a code block in language `mermaid` (or `mmd`) shows its
 * diagram under the code. The block stays a code block, so the source round-trips as a ```mermaid
 * fence through Markdown, MCP, vault sync and exports with no schema change; the diagram is view
 * state only.
 *
 * Built on the query block's spec (the same node-view host + portal pattern, QueryBlock.tsx): the
 * node view gets a non-editable host after the code, and <MermaidPortals> renders into it.
 *
 * Code and diagram: the code is shown while the caret is in the block, while the source is empty or
 * has an error, and always after "Show code"; otherwise only the diagram. Clicking the diagram puts
 * the caret into the code. The choice is per block and per tab (not stored in the document).
 * Errors are one short line in the block; the page never breaks on a bad diagram.
 */

export const MERMAID_LANGUAGES: ReadonlySet<string> = new Set(['mermaid', 'mmd'])
export const isMermaidLanguage = (lang: unknown) => typeof lang === 'string' && MERMAID_LANGUAGES.has(lang.toLowerCase())

type RenderFn = (typeof queryCodeBlockSpec)['implementation']['render']
const baseRender: RenderFn = queryCodeBlockSpec.implementation.render

type Host = { el: HTMLElement; blockId: string; content: HTMLElement }
const hostsByEditor = new WeakMap<object, Host[]>()
const listenersByEditor = new WeakMap<object, Set<() => void>>()
const EMPTY_HOSTS: Host[] = []
/** Per tab: blocks whose code stays visible ("Show code"). */
const pinnedCode = new Set<string>()

function notify(editor: object) {
  listenersByEditor.get(editor)?.forEach((l) => l())
}

export const mermaidCodeBlockSpec = {
  ...queryCodeBlockSpec,
  implementation: {
    ...queryCodeBlockSpec.implementation,
    render(this: ThisParameterType<RenderFn>, block: Parameters<RenderFn>[0], editor: Parameters<RenderFn>[1]) {
      const view = baseRender.call(this, block, editor)
      const isNodeView = (this as { renderType?: string } | undefined)?.renderType === 'nodeView'
      if (!isNodeView || !isMermaidLanguage(block.props.language)) return view
      const content = view.dom as HTMLElement
      content.classList.add('nd-mermaid')
      const host = document.createElement('div')
      host.className = 'nd-mermaid-host'
      host.contentEditable = 'false'
      // the block content is a flex row (language select, code): wrap so the diagram sits below
      host.style.flex = '0 0 100%'
      host.style.minWidth = '0'
      content.style.flexWrap = 'wrap'
      content.appendChild(host)
      host.addEventListener('mousemove', (e) => e.stopPropagation())
      const key = editor as object
      hostsByEditor.set(key, [...(hostsByEditor.get(key) ?? []), { el: host, blockId: block.id, content }])
      notify(key)
      const destroy = (view as { destroy?: () => void }).destroy
      return {
        ...view,
        // React renders into the host and toggles classes on the block content: neither is an edit
        ignoreMutation: (m: { target: Node; type: string; attributeName?: string | null }) =>
          m.type !== 'selection' &&
          (host.contains(m.target) || (m.type === 'attributes' && m.target === content && m.attributeName === 'class')),
        stopEvent: (e: Event) => e.target instanceof Node && host.contains(e.target),
        destroy: () => {
          hostsByEditor.set(key, (hostsByEditor.get(key) ?? []).filter((h) => h.el !== host))
          notify(key)
          destroy?.()
        },
      }
    },
  },
} as typeof queryCodeBlockSpec

export function MermaidPortals({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const key = editor as object
  const subscribe = useCallback(
    (cb: () => void) => {
      const set = listenersByEditor.get(key) ?? new Set()
      set.add(cb)
      listenersByEditor.set(key, set)
      return () => {
        set.delete(cb)
      }
    },
    [key],
  )
  const getSnapshot = useCallback(() => hostsByEditor.get(key) ?? EMPTY_HOSTS, [key])
  const hosts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return <>{hosts.map((h) => createPortal(<MermaidPreview editor={editor} host={h} />, h.el, h.blockId))}</>
}

function blockText(editor: BlockNoteEditor<any, any, any>, id: string): string {
  const b = editor.getBlock(id)
  if (!b || !Array.isArray(b.content)) return ''
  return (b.content as { type: string; text?: string }[]).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
}

/** The caret is in this block (focused or not: when unsure, the code stays visible). */
function caretIn(editor: BlockNoteEditor<any, any, any>, id: string): boolean {
  try {
    return editor.getTextCursorPosition().block.id === id
  } catch {
    return false
  }
}

function MermaidPreview({ editor, host }: { editor: BlockNoteEditor<any, any, any>; host: Host }) {
  const t = useT()
  const { resolved } = useTheme()
  const { blockId, content } = host
  const [source, setSource] = useState(() => blockText(editor, blockId))
  const [editing, setEditing] = useState(() => caretIn(editor, blockId))
  const [pinned, setPinned] = useState(() => pinnedCode.has(blockId))
  const [result, setResult] = useState<MermaidResult | null>(() => cachedMermaid(blockText(editor, blockId).trim(), resolved) ?? null)

  // follow edits of the source (debounced; content edits do not re-create the node view)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = editor.onChange(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setSource(blockText(editor, blockId)), 350)
    })
    const offSel = editor.onSelectionChange(() => setEditing(caretIn(editor, blockId)))
    return () => {
      clearTimeout(timer)
      off?.()
      offSel?.()
    }
  }, [editor, blockId])

  const trimmed = source.trim()
  useEffect(() => {
    if (!trimmed) {
      setResult(null)
      return
    }
    let live = true
    const hit = cachedMermaid(trimmed, resolved)
    if (hit) setResult(hit)
    else void renderMermaid(trimmed, resolved).then((r) => live && setResult(r))
    return () => {
      live = false
    }
  }, [trimmed, resolved])

  const ok = result?.ok === true
  const showCode = pinned || editing || !trimmed || (result !== null && !result.ok)
  useEffect(() => {
    content.classList.toggle('nd-mermaid-code-hidden', !showCode)
    content.classList.toggle('nd-mermaid-ok', ok)
  }, [content, showCode, ok])

  const togglePinned = () => {
    if (pinned) pinnedCode.delete(blockId)
    else pinnedCode.add(blockId)
    setPinned(!pinned)
  }
  const editCode = () => {
    setEditing(true)
    try {
      editor.setTextCursorPosition(blockId, 'end')
      editor.focus()
    } catch {
      // the block went away meanwhile
    }
  }

  return (
    <div className="nd-mermaid-preview font-sans text-sm text-ink" style={{ whiteSpace: 'normal' }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="nd-mermaid-tools flex items-center justify-end gap-2 text-xs text-sub">
        {result && !result.ok && (
          <span className="mr-auto min-w-0 truncate text-red-600 dark:text-red-400" role="alert" title={result.message}>
            {t('mermaid.error')}: {result.message}
          </span>
        )}
        {!trimmed && <span className="mr-auto">{t('mermaid.empty')}</span>}
        {trimmed && !result && <span className="mr-auto">{t('mermaid.loading')}</span>}
        {ok && (
          <button type="button" className="rounded px-1.5 py-0.5 hover:bg-hover hover:text-ink" onClick={togglePinned} aria-pressed={pinned}>
            {pinned ? t('mermaid.hideCode') : t('mermaid.showCode')}
          </button>
        )}
      </div>
      {ok && (
        <button
          type="button"
          className="nd-mermaid-figure block w-full cursor-text overflow-x-auto py-2 text-center"
          onClick={editCode}
          title={t('mermaid.editHint')}
        >
          <img
            className="nd-mermaid-img mx-auto inline-block h-auto max-w-full"
            src={result.src}
            width={result.width}
            height={result.height}
            alt={`${t('mermaid.alt')}: ${trimmed.split('\n')[0].slice(0, 80)}`}
            draggable={false}
          />
        </button>
      )}
    </div>
  )
}
