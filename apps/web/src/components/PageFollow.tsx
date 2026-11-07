import { useEffect, useRef, useState } from 'react'
import type { NotificationLevel, PageSubscriptionDTO, SetPageSubscriptionInput } from '@inkling/shared'
import { ApiError } from '../api'
import { usePageSubscription, useSetPageSubscription } from '../notificationsApi'
import { useT, type TKey } from '../i18n'
import { BellIcon } from './Icons'
import { Spinner } from './Spinner'
import { levelLabel } from './notifLevel'

// Page notification control (docs/adr/1001-*): follow the page (or the page and its subpages),
// mentions only, nothing, mute, or inherit; plus the "AI daily summary" switch. The effective
// level and where it comes from are shown underneath.

type Choice = 'page' | 'subtree' | 'mentions' | 'nothing' | 'mute' | 'inherit'

const CHOICES: { value: Choice; label: TKey; desc?: TKey }[] = [
  { value: 'page', label: 'follow.followPage' },
  { value: 'subtree', label: 'follow.followSubtree' },
  { value: 'mentions', label: 'follow.mentions', desc: 'notifLevel.mentionsDesc' },
  { value: 'nothing', label: 'follow.nothing', desc: 'notifLevel.nothingDesc' },
  { value: 'mute', label: 'follow.mute', desc: 'notifLevel.muteDesc' },
  { value: 'inherit', label: 'follow.inherit', desc: 'follow.inheritDesc' },
]

function currentChoice(own: PageSubscriptionDTO['own']): Choice {
  if (!own) return 'inherit'
  if (own.level === 'all') return own.subtree ? 'subtree' : 'page'
  return own.level
}

/** PUT body for a choice. Levels other than "follow this page" cover the subpages too. */
function inputFor(choice: Choice, agentDigest: boolean): SetPageSubscriptionInput {
  if (choice === 'inherit') return { level: null }
  if (choice === 'page') return { level: 'all', subtree: false, agentDigest }
  if (choice === 'subtree') return { level: 'all', subtree: true, agentDigest }
  return { level: choice, subtree: true, agentDigest }
}

function sourceLine(eff: PageSubscriptionDTO['effective'], t: ReturnType<typeof useT>): string {
  switch (eff.source) {
    case 'page':
      return t('follow.sourcePage')
    case 'ancestor':
      return t('follow.sourceAncestor', { title: eff.fromTitle || t('common.untitled') })
    case 'workspace':
      return t('follow.sourceWorkspace')
    default:
      return t('follow.sourceDefault')
  }
}

export function PageFollowPanel({ pageId }: { pageId: string }) {
  const t = useT()
  const sub = usePageSubscription(pageId)
  const set = useSetPageSubscription()
  const [error, setError] = useState<string | null>(null)

  if (sub.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size={16} />
      </div>
    )
  }
  if (!sub.data) return <p className="px-1 py-2 text-xs text-red-600">{t('follow.loadFailed')}</p>

  const data = sub.data
  const own = data.own
  const choice = currentChoice(own)
  const save = (input: SetPageSubscriptionInput) => {
    setError(null)
    set.mutate(
      { pageId, input },
      { onError: (err) => setError(err instanceof ApiError ? err.message : t('follow.saveFailed')) },
    )
  }
  const toggleDigest = (v: boolean) => {
    // The summary lives on my row: without one, start a row at the level that applies now.
    const level: NotificationLevel = own?.level ?? data.effective.level
    save({ level, subtree: own?.subtree ?? true, agentDigest: v })
  }

  return (
    <div className="flex flex-col gap-2" data-testid="page-follow">
      <div role="radiogroup" aria-label={t('follow.button')} className="flex flex-col">
        {CHOICES.map((c) => (
          <label
            key={c.value}
            className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-hover"
          >
            <input
              type="radio"
              name={`follow-${pageId}`}
              className="mt-0.5"
              checked={choice === c.value}
              disabled={set.isPending}
              onChange={() => save(inputFor(c.value, own?.agentDigest ?? false))}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-ink">{t(c.label)}</span>
              {c.desc && <span className="text-sub">{t(c.desc)}</span>}
            </span>
          </label>
        ))}
      </div>
      <label className="flex cursor-pointer items-start gap-2 border-t border-line px-1.5 pt-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={own?.agentDigest ?? false}
          disabled={set.isPending}
          onChange={(e) => toggleDigest(e.target.checked)}
        />
        <span className="flex min-w-0 flex-col">
          <span className="text-ink">{t('follow.agentDigest')}</span>
          {data.agentDigest && !own?.agentDigest && (
            <span className="text-sub">{t('follow.agentDigestInherited')}</span>
          )}
        </span>
      </label>
      <p className="border-t border-line px-1.5 pt-2 text-[11px] leading-relaxed text-sub">
        {t('follow.effective', { level: levelLabel(data.effective.level) })} · {sourceLine(data.effective, t)}
        {data.implicit && data.effective.level !== 'nothing' && data.effective.level !== 'mute' && (
          <>
            <br />
            {t('follow.implicit')}
          </>
        )}
      </p>
      {error && <p className="px-1.5 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/** Bell button for the page header; opens the panel in a popover. */
export function PageFollowButton({ pageId }: { pageId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const sub = usePageSubscription(pageId)
  const following = sub.data?.effective.level === 'all'

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('follow.button')}
        aria-expanded={open}
        title={t('follow.button')}
        data-testid="page-follow-button"
        className={`rounded-md p-1.5 leading-none transition duration-150 hover:bg-hover active:scale-[.98] ${
          following || open ? 'text-accent' : 'text-sub hover:text-ink'
        }`}
      >
        <span className="relative block">
          <BellIcon size={18} />
          {following && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
        </span>
      </button>
      {open && (
        <div className="nd-pop absolute right-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-1.5rem)] origin-top-right rounded-md border border-line bg-app p-2 shadow-xl">
          <div className="mb-1 px-1.5 text-xs font-semibold text-ink">{t('follow.button')}</div>
          <PageFollowPanel pageId={pageId} />
        </div>
      )}
    </div>
  )
}
