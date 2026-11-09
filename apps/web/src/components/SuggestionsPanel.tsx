import { useEffect, useState } from 'react'
import type { SuggestionDTO } from '@inkling/shared'
import { ApiError } from '../api'
import { useT } from '../i18n'
import type { TKey } from '../i18n'
import { toast } from '../lib/toast'
import { useDecideSuggestion, usePageSuggestionHistory, usePageSuggestions } from '../suggestionsApi'
import { DiffView } from './DiffView'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

// Suggested edits from agents (docs/adr/1530-*, 1533-*): one quiet line above the document
// ("N suggested edits from agents · Review") and a dialog with each suggestion's diff against the
// section as it is now. People who can edit accept or reject; accepting a suggestion whose section
// changed after the agent read it asks once more ("Accept anyway"). Section markers next to the
// headings (SectionMarkers) open the same dialog through OPEN_SUGGESTIONS_EVENT.

export const OPEN_SUGGESTIONS_EVENT = 'inkling:open-suggestions'

const MODE_LABEL: Record<SuggestionDTO['mode'], TKey> = {
  replace: 'suggestions.mode.replace',
  append: 'suggestions.mode.append',
  prepend: 'suggestions.mode.prepend',
  insert_after: 'suggestions.mode.insert_after',
  delete: 'suggestions.mode.delete',
  page_replace: 'suggestions.mode.page_replace',
  page_append: 'suggestions.mode.page_append',
}

export function SuggestionsNotice({ pageId }: { pageId: string }) {
  const t = useT()
  const q = usePageSuggestions(pageId)
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)

  useEffect(() => {
    const onOpen = (e: Event) => {
      setFocus((e as CustomEvent<{ blockId?: string }>).detail?.blockId ?? null)
      setOpen(true)
    }
    window.addEventListener(OPEN_SUGGESTIONS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SUGGESTIONS_EVENT, onOpen)
  }, [])

  const list = q.data?.suggestions ?? []
  if (!list.length && !open) return null
  return (
    <>
      {list.length > 0 && (
        <div
          role="note"
          data-testid="suggestions-notice"
          className="mb-2 flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-1 text-xs text-ink"
        >
          <span aria-hidden className="text-accent">✎</span>
          <span className="min-w-0 flex-1">
            {list.length === 1 ? t('suggestions.noticeOne') : t('suggestions.notice', { count: list.length })}
          </span>
          <button
            type="button"
            onClick={() => {
              setFocus(null)
              setOpen(true)
            }}
            className="shrink-0 rounded px-1.5 py-0.5 font-medium text-accent transition-colors duration-150 hover:bg-hover"
          >
            {t('suggestions.review')}
          </button>
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={t('suggestions.title')} size="lg">
        <SuggestionTabs pageId={pageId} focus={focus} onEmpty={() => setOpen(false)} />
      </Modal>
    </>
  )
}

function SuggestionTabs({ pageId, focus, onEmpty }: { pageId: string; focus: string | null; onEmpty: () => void }) {
  const t = useT()
  const [tab, setTab] = useState<'open' | 'history'>('open')
  const tabClass = (on: boolean) =>
    `rounded-md px-2.5 py-1 text-xs transition-colors duration-150 ${on ? 'bg-hover font-medium text-ink' : 'text-sub hover:text-ink'}`
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" className="flex gap-1">
        <button type="button" role="tab" aria-selected={tab === 'open'} className={tabClass(tab === 'open')} onClick={() => setTab('open')}>
          {t('suggestions.open')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          data-testid="suggestions-history-tab"
          className={tabClass(tab === 'history')}
          onClick={() => setTab('history')}
        >
          {t('suggestions.history')}
        </button>
      </div>
      {tab === 'open' ? <SuggestionList pageId={pageId} focus={focus} onEmpty={onEmpty} /> : <SuggestionHistory pageId={pageId} />}
    </div>
  )
}

/** Decided suggestions, newest last, with who or which rule decided (docs/adr/1545-*). */
function SuggestionHistory({ pageId }: { pageId: string }) {
  const t = useT()
  const q = usePageSuggestionHistory(pageId, true)
  if (q.isLoading) return <Spinner size={16} />
  const done = (q.data?.suggestions ?? []).filter((s) => s.status !== 'open')
  if (!done.length) return <p className="text-xs text-sub">{t('suggestions.historyEmpty')}</p>
  return (
    <ul className="flex max-h-[60vh] flex-col divide-y divide-line overflow-y-auto rounded-md border border-line" data-testid="suggestions-history">
      {done.map((s) => (
        <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-xs">
          <span className="font-medium text-ink">{s.anchor === '' ? t('suggestions.wholePage') : s.headingPath || t('suggestions.intro')}</span>
          <span className="text-sub">· {t(MODE_LABEL[s.mode])}</span>
          <span className="text-sub">· {s.via ? t('suggestions.by', { name: s.author.name, client: s.via }) : s.author.name}</span>
          <span
            className={`ml-auto rounded px-1.5 py-0.5 ${s.status === 'accepted' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-hover text-sub'}`}
          >
            {statusText(t, s)}
          </span>
          {s.decidedAt && <span className="w-full text-[11px] text-sub">{new Date(s.decidedAt).toLocaleString()}</span>}
        </li>
      ))}
    </ul>
  )
}

function statusText(t: ReturnType<typeof useT>, s: SuggestionDTO): string {
  if (s.status === 'accepted' && s.rule) {
    return t('suggestions.status.acceptedRule', { rule: s.rule === 'workspace' ? t('suggestions.rule.workspace') : t('suggestions.rule.page') })
  }
  if (s.status === 'accepted') return t('suggestions.status.accepted', { name: s.decidedBy?.name ?? '' })
  if (s.status === 'rejected') return t('suggestions.status.rejected', { name: s.decidedBy?.name ?? '' })
  return t('suggestions.status.withdrawn')
}

function SuggestionList({ pageId, focus, onEmpty }: { pageId: string; focus: string | null; onEmpty: () => void }) {
  const t = useT()
  const q = usePageSuggestions(pageId)
  if (q.isLoading) return <Spinner size={16} />
  if (q.isError) return <p className="text-xs text-sub">{t('suggestions.loadError')}</p>
  const list = q.data?.suggestions ?? []
  if (!list.length) return <p className="text-xs text-sub">{t('suggestions.empty')}</p>
  // the section that was clicked first, the rest in the server's order
  const sorted = focus ? [...list.filter((s) => s.blockId === focus), ...list.filter((s) => s.blockId !== focus)] : list
  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1" data-testid="suggestions-list">
      {!q.data?.canDecide && <p className="text-xs text-sub">{t('suggestions.cannotDecide')}</p>}
      {sorted.map((s) => (
        <SuggestionItem key={s.id} s={s} pageId={pageId} canDecide={!!q.data?.canDecide} onDone={list.length === 1 ? onEmpty : undefined} />
      ))}
    </div>
  )
}

function SuggestionItem({ s, pageId, canDecide, onDone }: { s: SuggestionDTO; pageId: string; canDecide: boolean; onDone?: () => void }) {
  const t = useT()
  const decide = useDecideSuggestion(pageId)
  const [confirming, setConfirming] = useState(false)
  const p = s.preview
  const where = s.anchor === '' ? t('suggestions.wholePage') : s.headingPath || t('suggestions.intro')
  const run = (decision: 'accept' | 'reject', confirmChanged = false) =>
    decide.mutate(
      { id: s.id, decision, confirmChanged },
      {
        onSuccess: () => {
          toast({ message: t(decision === 'accept' ? 'suggestions.accepted' : 'suggestions.rejected') })
          onDone?.()
        },
        onError: (err) => {
          // The section changed between loading and clicking: show the warning and ask again.
          if (err instanceof ApiError && err.code === 'SUGGESTION_CHANGED') setConfirming(true)
          else toast({ message: err instanceof ApiError ? err.message : t('suggestions.failed') })
        },
      },
    )
  const accept = () => {
    if (p?.changed && !confirming) setConfirming(true)
    else run('accept', !!p?.changed || confirming)
  }
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line p-3" data-testid="suggestion-item" data-suggestion-id={s.id}>
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className="font-medium text-ink">{where}</span>
        <span className="text-sub">· {t(MODE_LABEL[s.mode])}</span>
        <span className="ml-auto text-sub">
          {s.via ? t('suggestions.by', { name: s.author.name, client: s.via }) : s.author.name} ·{' '}
          {new Date(s.createdAt).toLocaleString()}
        </span>
      </header>
      {s.origin === 'lock' && !s.reviewReason && !s.autoAt && <p className="text-[11px] text-sub">{t('suggestions.origin.lock')}</p>}
      {s.autoAt && (
        <p className="rounded bg-accent/10 px-2 py-1 text-xs text-accent" data-testid="suggestion-auto-at">
          {t('suggestions.autoAt', { time: new Date(s.autoAt).toLocaleString() })}
        </p>
      )}
      {s.reviewReason && <p className="text-[11px] text-sub">{t('suggestions.needsReview', { reason: s.reviewReason })}</p>}
      {p && !p.found && <p className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">{t('suggestions.gone')}</p>}
      {p?.found && p.changed && (
        <p role="alert" data-testid="suggestion-changed" className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
          {t('suggestions.changed')}
        </p>
      )}
      {p && <DiffView ops={p.ops} large={p.large} before={p.before} after={p.after} />}
      {canDecide && (
        <div className="flex items-center justify-end gap-2">
          {decide.isPending && <Spinner size={12} />}
          {confirming ? (
            <>
              <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-3 py-1.5 text-xs text-sub hover:bg-hover">
                {t('suggestions.cancel')}
              </button>
              <button
                type="button"
                onClick={() => run('accept', true)}
                disabled={decide.isPending}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                {t('suggestions.acceptAnyway')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => run('reject')}
                disabled={decide.isPending}
                className="rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-hover disabled:opacity-60"
              >
                {t('suggestions.reject')}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={decide.isPending || (p ? !p.found && s.anchor !== '' : false)}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                {t('suggestions.accept')}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}
