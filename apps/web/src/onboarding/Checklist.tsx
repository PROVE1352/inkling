import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { OnboardingDTO, OnboardingItemId } from '@inkling/shared'
import { usePages } from '../api'
import { useT, type TKey } from '../i18n'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '../components/Icons'
import { playIntro, useCreateSample, useUpdateOnboarding } from './api'
import { showHint } from './hint'

// The "Getting started" card (docs/adr/2380-*): first steps that tick themselves as the person does
// them. Pressing an item goes where it is done and points at the button with a short bubble; nothing
// is forced. Shown on the empty workspace screen and, folded, at the bottom of the sidebar.

/** The browser can keep offline copies or install the app (the "install" item is shown only then). */
export function canInstallOrOffline(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof indexedDB !== 'undefined'
}

export function visibleItems(dto: OnboardingDTO) {
  return dto.checklist.items.filter((i) => i.id !== 'install' || canInstallOrOffline())
}

export function progress(dto: OnboardingDTO): { done: number; total: number } {
  const items = visibleItems(dto)
  return { done: items.filter((i) => i.done).length, total: items.length }
}

const LABEL: Record<OnboardingItemId, TKey> = {
  page: 'getStarted.item.page',
  slash: 'getStarted.item.slash',
  link: 'getStarted.item.link',
  database: 'getStarted.item.database',
  share: 'getStarted.item.share',
  ai: 'getStarted.item.ai',
  explore: 'getStarted.item.explore',
  comment: 'getStarted.item.comment',
  install: 'getStarted.item.install',
}

export function Checklist({ wsId, dto, variant }: { wsId: string; dto: OnboardingDTO; variant: 'home' | 'sidebar' }) {
  const t = useT()
  const navigate = useNavigate()
  const update = useUpdateOnboarding()
  const sample = useCreateSample()
  const pages = usePages(wsId)
  const [failed, setFailed] = useState(false)
  const items = visibleItems(dto)
  const { done, total } = progress(dto)
  const folded = variant === 'sidebar' && dto.checklist.collapsed
  const samplePage = dto.samples[wsId]
  const canSample = dto.audience !== 'guest'

  const somePage = () => {
    if (samplePage) return samplePage
    return (pages.data ?? []).find((p) => p.kind === 'doc' && !p.deletedAt)?.id ?? null
  }
  const hint = (id: OnboardingItemId, selectors: string[]) => showHint(selectors, t(`${LABEL[id]}.hint` as TKey), t('getStarted.hintClose'))
  const label = (k: TKey) => t(k).replace(/"/g, '\\"')

  const go = (id: OnboardingItemId) => {
    switch (id) {
      case 'page':
        navigate(`/w/${wsId}`)
        hint(id, ['[data-onboarding="new-page"]'])
        break
      case 'slash':
      case 'link':
      case 'comment': {
        const p = somePage()
        if (p) navigate(`/w/${wsId}/p/${p}`)
        hint(id, p ? ['.bn-editor'] : ['[data-onboarding="new-page"]'])
        break
      }
      case 'database':
        hint(id, [`[aria-label="${label('sidebar.newItemKind')}"]`])
        break
      case 'share':
        hint(id, [`button[title="${label('members.copyInvite')}"]`, `[aria-label="${label('members.copyInvite')}"]`, `[aria-label="${label('page.shareToWeb')}"]`])
        break
      case 'ai':
        navigate(`/w/${wsId}/settings#connections`)
        hint(id, ['[data-pref="mcp"]'])
        break
      case 'explore':
        hint(id, [`[aria-label="${label('tree.label')}"]`])
        break
      case 'install':
        navigate(`/w/${wsId}/settings#offline`)
        hint(id, ['[data-pref="offline"]'])
        break
    }
  }

  const makeSample = () => {
    setFailed(false)
    sample.mutate(wsId, {
      onSuccess: (r) => navigate(`/w/${wsId}/p/${r.pageId}`),
      onError: () => setFailed(true),
    })
  }

  const pct = total ? Math.round((done / total) * 100) : 0
  const box =
    variant === 'home'
      ? 'w-full max-w-sm rounded-[var(--radius-lg)] border border-line bg-app p-4 text-left shadow-sm'
      : 'mx-2 mb-2 rounded-[var(--radius-lg)] border border-line bg-app p-2 text-left'
  const link = 'rounded-md px-1.5 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink'

  return (
    <section className={box} aria-labelledby={`onb-title-${variant}`} data-testid={`onboarding-card-${variant}`}>
      <div className="flex items-center gap-2">
        {variant === 'sidebar' ? (
          <button
            type="button"
            onClick={() => update.mutate({ collapsed: !folded })}
            aria-expanded={!folded}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-sm font-medium text-ink hover:bg-hover"
          >
            {folded ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
            <span id={`onb-title-${variant}`} className="truncate">
              {t('getStarted.title')}
            </span>
            <span className="ml-auto shrink-0 text-xs font-normal text-sub">{t('getStarted.progress', { done, total })}</span>
          </button>
        ) : (
          <>
            <h2 id={`onb-title-${variant}`} className="flex-1 text-base font-semibold text-ink">
              {t('getStarted.title')}
            </h2>
            <span className="text-xs text-sub">{t('getStarted.progress', { done, total })}</span>
          </>
        )}
      </div>
      <div className="mx-1 mt-1.5 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      {!folded && (
        <>
          <ul className="mt-2 flex flex-col gap-0.5">
            {items.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => go(i.id)}
                  data-item={i.id}
                  data-done={i.done ? 'true' : 'false'}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-hover"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      i.done ? 'border-accent bg-accent text-white' : 'border-sub/60'
                    }`}
                    aria-hidden="true"
                  >
                    {i.done && <CheckIcon size={11} />}
                  </span>
                  <span className={`min-w-0 flex-1 ${i.done ? 'text-sub line-through' : 'text-ink'}`}>
                    {t(LABEL[i.id])}
                  </span>
                  <span className="sr-only">{i.done ? '✓' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
          {dto.checklist.complete && <p className="mt-1 px-1.5 text-xs text-sub">{t('getStarted.allDone')}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
            {canSample &&
              (samplePage ? (
                <button type="button" className={link} onClick={() => navigate(`/w/${wsId}/p/${samplePage}`)} data-testid="onboarding-sample-open">
                  {t('getStarted.sampleOpen')}
                </button>
              ) : (
                <button
                  type="button"
                  className={link}
                  onClick={makeSample}
                  disabled={sample.isPending}
                  title={t('getStarted.sampleHint')}
                  data-testid="onboarding-sample-create"
                >
                  {t('getStarted.sampleCreate')}
                </button>
              ))}
            <button type="button" className={link} onClick={playIntro} data-testid="onboarding-intro">
              {t('getStarted.watchIntro')}
            </button>
            <button type="button" className={`${link} ml-auto`} onClick={() => update.mutate({ dismissed: true })} data-testid="onboarding-dismiss">
              {t('getStarted.dismiss')}
            </button>
          </div>
          {failed && <p className="mt-1 px-1.5 text-xs text-red-600">{t('getStarted.sampleFailed')}</p>}
        </>
      )}
    </section>
  )
}
