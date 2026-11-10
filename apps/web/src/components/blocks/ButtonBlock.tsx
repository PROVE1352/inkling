// Button block (docs/adr/2244-*): `label`, `color` and `actions` (canonical JSON of ButtonAction[],
// packages/shared automations.ts). Pressing it runs the actions in order in the presser's browser,
// through the REST routes that person may use anyway (lib/buttonRun.ts); the server decides.
//
// Where it runs: only in the page editor whose page is known for certain (PageView registers its
// editor with the page id, lib/activeEditor.ts registerPageEditor). Anywhere else — a read-only page embed (the host route's page
// id is not the block's page), a row template's body — the button shows but stays inactive, so
// 'this', "set this row" and the button webhook never aim at the wrong page.
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { createReactBlockSpec } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import type { BlockNoteEditor } from '@blocknote/core'
import { BUTTON_COLORS, buttonBlockConfig, parseButtonActions } from '@inkling/shared'
import type { ButtonColor } from '@inkling/shared'
import { api, qk, useMe, usePages } from '../../api'
import { t, useT } from '../../i18n'
import { pageOfEditor } from '../../lib/activeEditor'
import { fetchCollectionFields } from '../../lib/automationsApi'
import { createRunGuard, localToday, runButtonActions, type ButtonRunResult } from '../../lib/buttonRun'
import { insertFromSlash, type SlashEditor } from '../../lib/slashInsert'
import { SettingsIcon } from '../Icons'
import { Spinner } from '../Spinner'
import { BUTTON_COLOR_CLASS, ButtonSettingsForm, actionTypeKey, rowCollectionOf } from './ButtonSettings'

type AnyEditor = BlockNoteEditor<any, any, any>
type ButtonProps = { label: string; color: string; actions: string }

/** The page of the editor this block is in, when known for certain (the page editor); else null. */
function hostPageOf(editor: AnyEditor): string | null {
  return pageOfEditor(editor)
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const colorOf = (c: string): ButtonColor => ((BUTTON_COLORS as readonly string[]).includes(c) ? (c as ButtonColor) : 'default')

function ButtonGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="7" width="18" height="10" rx="3" />
      <path d="M12 17v4M9.5 19.5 12 21l2.5-1.5" />
    </svg>
  )
}

function ButtonBlockView({ editor, block }: { editor: AnyEditor; block: { id: string; props: ButtonProps } }) {
  const tt = useT()
  const { wsId = '', pageId: routePageId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = useMe()
  const pages = usePages(wsId)
  const actions = parseButtonActions(block.props.actions)
  const color = colorOf(block.props.color)
  const editable = editor.isEditable
  const [editing, setEditing] = useState(false)
  const [hostPageId, setHostPageId] = useState<string | null>(() => hostPageOf(editor))
  const guard = useRef(createRunGuard())
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' } | { kind: 'error'; text: string } | null>(null)

  // PageView registers its editor in an effect after the editor is ready: look again shortly after mount.
  useEffect(() => {
    if (hostPageId) return
    const timers = [0, 300, 1500].map((ms) => window.setTimeout(() => setHostPageId(hostPageOf(editor)), ms))
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [editor, hostPageId])

  // The short "done" mark fades by itself.
  useEffect(() => {
    if (result?.kind !== 'ok') return
    const id = window.setTimeout(() => setResult(null), 2000)
    return () => window.clearTimeout(id)
  }, [result])

  // Settings: the page the button is on, or — in a row template's body (no page yet) — the
  // collection the route shows, whose rows the template makes.
  const settingsRowCollection =
    rowCollectionOf(pages.data, hostPageId) ??
    (!hostPageId && pages.data?.find((p) => p.id === routePageId)?.kind === 'collection' ? (routePageId ?? null) : null)

  const describe = (r: Extract<ButtonRunResult, { ok: false }>) =>
    tt('button.failedAt', {
      n: r.failedIndex + 1,
      kind: tt(actionTypeKey(r.failedType)),
      message: r.code ? tt(`button.err.${r.code}` as never) : r.message,
    })

  const run = () => {
    if (!actions.length) return
    void guard.current.run(async () => {
      const pageId = hostPageOf(editor)
      setHostPageId(pageId)
      if (!pageId) {
        setResult({ kind: 'error', text: tt('button.onlyOnPage') })
        return
      }
      setRunning(true)
      setResult(null)
      try {
        const page = pages.data?.find((p) => p.id === pageId)
        const res = await runButtonActions(
          actions,
          {
            pageId,
            rowCollectionId: rowCollectionOf(pages.data, pageId),
            blockId: block.id,
            ctx: {
              today: localToday(),
              userId: me.data?.id ?? null,
              userName: me.data?.name,
              pageId,
              pageTitle: page?.title ?? '',
            },
          },
          {
            request: (path, init) => api(path, init),
            loadFields: fetchCollectionFields,
            openPage: (id) => navigate(`/w/${wsId}/p/${id}`),
            openUrl: (url) => {
              window.open(url, '_blank', 'noopener,noreferrer')
            },
            tz: browserTimeZone(),
          },
        )
        for (const c of res.collections) void qc.invalidateQueries({ queryKey: qk.collection(c) })
        if (res.collections.length) void qc.invalidateQueries({ queryKey: qk.pages(wsId) })
        setResult(res.ok ? { kind: 'ok' } : { kind: 'error', text: describe(res) })
      } finally {
        setRunning(false)
      }
    })
  }

  const save = (label: string, c: ButtonColor, actionsJson: string) => {
    editor.updateBlock(block.id, { type: 'button', props: { label, color: c, actions: actionsJson } } as never)
    setEditing(false)
    setResult(null)
  }

  const showForm = editable && (editing || actions.length === 0)

  if (showForm) {
    return (
      <div contentEditable={false} className="w-full" data-inkling-button data-print-hide>
        {actions.length === 0 && !editing && (
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
            <ButtonGlyph /> {tt('button.setupTitle')} <span className="font-normal text-sub">— {tt('button.setupHint')}</span>
          </p>
        )}
        <ButtonSettingsForm
          wsId={wsId}
          initial={{ label: block.props.label, color, actions }}
          rowCollectionId={settingsRowCollection}
          onSave={save}
          onCancel={actions.length ? () => setEditing(false) : undefined}
        />
      </div>
    )
  }

  if (!actions.length) {
    return (
      <div contentEditable={false} className="w-full rounded-md border border-dashed border-line px-3 py-2 text-sm text-sub" data-inkling-button data-print-hide>
        {tt('button.notSetUp')}
      </div>
    )
  }

  const usable = !!hostPageId && !!me.data && !!pages.data
  const label = block.props.label.trim() || tt('button.defaultLabel')
  return (
    <div
      contentEditable={false}
      className="group/button flex w-full flex-col items-start gap-1 py-0.5"
      data-inkling-button
      data-print-hide
      // a slow page load may register the editor after the checks above: look again on approach
      onPointerEnter={() => !hostPageId && setHostPageId(hostPageOf(editor))}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-button-run
          onClick={run}
          disabled={!usable || running}
          aria-busy={running}
          title={!hostPageId ? tt('button.onlyOnPage') : undefined}
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_COLOR_CLASS[color]}`}
        >
          {running ? <Spinner size={14} /> : <ButtonGlyph />}
          <span className="max-w-[28rem] truncate">{label}</span>
        </button>
        {editable && (
          <button
            type="button"
            data-button-settings
            onClick={() => setEditing(true)}
            aria-label={tt('button.settings')}
            title={tt('button.settings')}
            className="rounded p-1 text-sub opacity-100 transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-hover/button:opacity-100"
          >
            <SettingsIcon size={14} />
          </button>
        )}
        {result?.kind === 'ok' && (
          <span className="text-xs text-green-700 dark:text-green-400" role="status">
            {tt('button.done')}
          </span>
        )}
      </div>
      {!hostPageId && !editable && <p className="text-[11px] text-sub">{tt('button.onlyOnPage')}</p>}
      {result?.kind === 'error' && (
        <p className="text-xs text-red-600" role="alert" data-button-error>
          {result.text}
        </p>
      )}
    </div>
  )
}

export const buttonBlockSpec = createReactBlockSpec(buttonBlockConfig, {
  render: ({ block, editor }) => <ButtonBlockView editor={editor as unknown as AnyEditor} block={block as never} />,
  // Copy / client HTML export: the label only — never the actions (ids of webhooks, collections).
  toExternalHTML: ({ block }) => <p>[{block.props.label.trim() || t('button.defaultLabel')}]</p>,
})()

/** Slash-menu entry: an empty button that opens its settings. */
export function buttonSlashItems(editor: AnyEditor): DefaultReactSuggestionItem[] {
  if (!('button' in editor.schema.blockSchema)) return []
  return [
    {
      title: t('button.slashTitle'),
      subtext: t('button.slashSubtext'),
      // search data, not display text: English and Korean in every locale
      aliases: ['button', 'action', 'automation', 'run', 'trigger', '버튼', '동작', '실행', '자동화'],
      group: t('linkEmbed.slashGroup'),
      icon: <ButtonGlyph size={16} />,
      onItemClick: () => {
        insertFromSlash(editor as unknown as SlashEditor, { type: 'button', props: {} } as never, 'own')
      },
    },
  ]
}
