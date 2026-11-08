import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { BlockNoteEditor } from '@blocknote/core'
import { createCodeBlockSpec } from '@blocknote/core'
import { codeBlockOptions } from '../../lib/codeBlockOptions'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { tryParseQuery } from '@inkling/shared'
import { runQuery, usePages } from '../../api'
import { DatabaseIcon } from '../Icons'
import { t } from '../../i18n'
import { ResultView } from './QueryResultView'
import { insertFromSlash, type SlashEditor } from '../../lib/slashInsert'

/**
 * Query block (Dataview subset) — docs/QUERY.md, docs/adr/0204-query-block-as-dataview-fence.md.
 *
 * The block IS a code block with language `dataview`. That keeps the query text editable like
 * code and makes it round-trip as a ```dataview fence through every markdown path (zip export,
 * MCP, vault sync) with no server schema change. Results are rendered below the code by a React
 * portal: the code block's node view gets a non-editable host element, and <QueryBlockPortals>
 * (mounted inside BlockNoteView, so router + React Query context are available) renders into it.
 *
 * Data fetching: only while the block is on screen (IntersectionObserver); the cache key includes
 * a workspace "version" derived from the already-polled page list, so edits elsewhere refresh the
 * result without any new polling loop.
 */

// UI strings — a thin facade over the i18n dictionary (getters, so nothing freezes at import time).
export const QUERY_STRINGS = {
  get slashTitle() { return t('queryBlock.slashTitle') },
  get slashSubtext() { return t('queryBlock.slashSubtext') },
  get languageName() { return t('queryBlock.languageName') },
  get empty() { return t('queryBlock.empty') },
  get noResults() { return t('queryBlock.noResults') },
  get loading() { return t('queryBlock.loading') },
  get page() { return t('common.page') },
  get value() { return t('queryBlock.value') },
  get syntaxError() { return t('queryBlock.syntaxError') },
  at: (line: number, col: number) => t('queryBlock.at', { line, col }),
  get failed() { return t('queryBlock.failed') },
}

export const QUERY_LANGUAGE = 'dataview'
// Inserted into the document when the block is created — document data, not UI, so not translated.
const DEFAULT_QUERY = 'TABLE file.mtime AS "Modified"\nSORT file.mtime DESC\nLIMIT 10'

// ---------------------------------------------------------------------------
// code block spec: plain code + a results host when language = dataview
// ---------------------------------------------------------------------------

// `dataview` is selectable in the language menu but highlighted as plain text: the `text` entry
// (first in the list, so getLanguageId() hits it first) aliases it, which keeps shiki from trying
// to load a grammar that does not exist.
const languages = { ...codeBlockOptions.supportedLanguages } as Record<string, { name: string; aliases?: string[] }>
languages.text = {
  ...(languages.text ?? { name: 'Plain Text' }),
  aliases: [...(languages.text?.aliases ?? []), QUERY_LANGUAGE, 'query'],
}
// getter: the language menu reads the name at render time, in the current locale
languages[QUERY_LANGUAGE] = {
  get name() {
    return QUERY_STRINGS.languageName
  },
}

const baseSpec = createCodeBlockSpec({ ...codeBlockOptions, supportedLanguages: languages })
type RenderFn = (typeof baseSpec)['implementation']['render']
const baseRender: RenderFn = baseSpec.implementation.render

type Host = { el: HTMLElement; blockId: string }
const hostsByEditor = new WeakMap<object, Host[]>()
const listenersByEditor = new WeakMap<object, Set<() => void>>()
const EMPTY_HOSTS: Host[] = []

function notify(editor: object) {
  listenersByEditor.get(editor)?.forEach((l) => l())
}

export const queryCodeBlockSpec = {
  ...baseSpec,
  implementation: {
    ...baseSpec.implementation,
    render(this: ThisParameterType<RenderFn>, block: Parameters<RenderFn>[0], editor: Parameters<RenderFn>[1]) {
      const view = baseRender.call(this, block, editor)
      const isNodeView = (this as { renderType?: string } | undefined)?.renderType === 'nodeView'
      if (block.props.language !== QUERY_LANGUAGE || !isNodeView) return view
      const host = document.createElement('div')
      host.className = 'nd-query-results'
      host.contentEditable = 'false'
      // the code block's content element is a flex row: wrap so results sit below the code
      host.style.flex = '0 0 100%'
      host.style.minWidth = '0'
      ;(view.dom as HTMLElement).style.flexWrap = 'wrap'
      ;(view.dom as HTMLElement).appendChild(host)
      // keep editor-level hover logic (table handles, side menu) away from the results
      host.addEventListener('mousemove', (e) => e.stopPropagation())
      const key = editor as object
      hostsByEditor.set(key, [...(hostsByEditor.get(key) ?? []), { el: host, blockId: block.id }])
      notify(key)
      const destroy = (view as { destroy?: () => void }).destroy
      return {
        ...view,
        // React renders into the host; without these ProseMirror would treat those DOM changes
        // as edits and redraw the node view (destroy → new host → render → …, an endless loop),
        // and would swallow clicks on result links.
        ignoreMutation: (m: { target: Node; type: string }) => m.type !== 'selection' && host.contains(m.target),
        stopEvent: (e: Event) => e.target instanceof Node && host.contains(e.target),
        destroy: () => {
          hostsByEditor.set(key, (hostsByEditor.get(key) ?? []).filter((h) => h.el !== host))
          notify(key)
          destroy?.()
        },
      }
    },
  },
} as typeof baseSpec

// ---------------------------------------------------------------------------
// slash menu item
// ---------------------------------------------------------------------------

export function querySlashItem(editor: BlockNoteEditor<any, any, any>): DefaultReactSuggestionItem {
  return {
    title: QUERY_STRINGS.slashTitle,
    subtext: QUERY_STRINGS.slashSubtext,
    // Aliases are search data, not display text: English and Korean are kept in every locale.
    aliases: ['query', 'dataview', 'table', 'list', 'task', '쿼리', '데이터뷰', '조회'],
    // Join BlockNote's own "Advanced" group (where the table item lives) in the active dictionary.
    group: editor.dictionary.slash_menu.table.group,
    icon: <DatabaseIcon size={16} />,
    onItemClick: () => {
      const block = {
        type: 'codeBlock' as const,
        props: { language: QUERY_LANGUAGE },
        content: DEFAULT_QUERY,
      }
      insertFromSlash(editor as unknown as SlashEditor, block, 'inside')
    },
  }
}

// ---------------------------------------------------------------------------
// portals
// ---------------------------------------------------------------------------

export function QueryBlockPortals({ editor, wsId }: { editor: BlockNoteEditor<any, any, any>; wsId: string }) {
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
  return (
    <>
      {hosts.map((h) =>
        createPortal(<QueryResults editor={editor} blockId={h.blockId} host={h.el} wsId={wsId} />, h.el, h.blockId),
      )}
    </>
  )
}

function blockText(editor: BlockNoteEditor<any, any, any>, id: string): string {
  const b = editor.getBlock(id)
  if (!b || !Array.isArray(b.content)) return ''
  return (b.content as { type: string; text?: string }[]).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
}

function useVisible(el: HTMLElement): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      rootMargin: '200px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [el])
  return visible
}

/** Workspace change marker derived from the page list that is already polled every 20 s. */
function useWorkspaceVersion(wsId: string): string {
  const pages = usePages(wsId)
  return useMemo(() => {
    const list = pages.data ?? []
    let max = ''
    for (const p of list) if (p.updatedAt > max) max = p.updatedAt
    return `${list.length}:${max}`
  }, [pages.data])
}

function QueryResults({
  editor,
  blockId,
  host,
  wsId,
}: {
  editor: BlockNoteEditor<any, any, any>
  blockId: string
  host: HTMLElement
  wsId: string
}) {
  const [source, setSource] = useState(() => blockText(editor, blockId))
  // follow edits of the query text (debounced) — content edits don't re-create the node view
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const off = editor.onChange(() => {
      clearTimeout(t)
      t = setTimeout(() => setSource(blockText(editor, blockId)), 500)
    })
    return () => {
      clearTimeout(t)
      off?.()
    }
  }, [editor, blockId])

  const visible = useVisible(host)
  const version = useWorkspaceVersion(wsId)
  const parsed = useMemo(() => (source.trim() ? tryParseQuery(source) : null), [source])

  const result = useQuery({
    queryKey: ['query', wsId, source, version],
    queryFn: () => runQuery(wsId, source),
    enabled: visible && !!parsed?.ok,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })

  let body: React.ReactNode
  if (!source.trim()) {
    body = <p className="text-xs text-sub">{QUERY_STRINGS.empty}</p>
  } else if (parsed && !parsed.ok) {
    const line = source.split('\n')[parsed.error.line - 1] ?? ''
    body = (
      <div className="text-xs" role="alert">
        <p className="font-medium text-red-600 dark:text-red-400">
          {QUERY_STRINGS.syntaxError} ({QUERY_STRINGS.at(parsed.error.line, parsed.error.col)}): {parsed.error.message}
        </p>
        <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-4 text-sub">
          {line}
          {'\n'}
          {' '.repeat(Math.max(0, parsed.error.col - 1))}^
        </pre>
      </div>
    )
  } else if (result.isError) {
    body = (
      <p className="text-xs text-red-600 dark:text-red-400" role="alert">
        {QUERY_STRINGS.failed}: {(result.error as Error).message}
      </p>
    )
  } else if (!result.data) {
    body = <p className="text-xs text-sub">{QUERY_STRINGS.loading}</p>
  } else {
    body = <ResultView data={result.data} wsId={wsId} />
  }

  return (
    <div
      className="mt-1 rounded-md border border-line bg-app px-3 py-2 font-sans text-sm text-ink"
      style={{ whiteSpace: 'normal' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {body}
    </div>
  )
}
