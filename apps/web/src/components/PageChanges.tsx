import { useState } from 'react'
import { Link } from 'react-router'
import type { ActivityItemDTO } from '@inkling/shared'
import { tMaybe, useT } from '../i18n'
import { relativeTime } from '../lib/time'
import { usePageChanges } from '../revertApi'
import { RevertDialog, type RevertSource } from './RevertDialog'

// Recent changes of this page in the right panel's History (docs/adr/1620-*): who changed which
// section, agents marked "via …", and a revert action on agent changes and on reverts themselves.

export function revertSourceOf(it: ActivityItemDTO): RevertSource {
  return {
    seq: it.seq,
    pageId: it.pageId,
    pageTitle: it.pageTitle,
    headingPath: it.headingPath,
    via: it.via,
    actor: it.actor,
    changedAt: it.changedAt,
    isRevert: it.revert?.isRevert,
  }
}

/** The change can be offered for a revert in the lists: an agent's change, or a revert itself. */
export function offersRevert(it: ActivityItemDTO): boolean {
  return !!it.revert?.revertable && (!!it.via || !!it.revert.isRevert)
}

export function PageChanges({ wsId, pageId, readOnly }: { wsId: string; pageId: string; readOnly: boolean }) {
  const t = useT()
  const q = usePageChanges(pageId, true)
  const [source, setSource] = useState<RevertSource | null>(null)
  const items = (q.data?.items ?? []).filter((it) => it.kind !== 'page_added')
  if (!items.length) return null
  return (
    <div className="mt-2 flex flex-col gap-0.5 border-t border-line/60 pt-2" data-testid="page-changes">
      <span className="text-[11px] font-medium uppercase tracking-wide text-sub">{t('revert.recentChanges')}</span>
      <ul className="flex flex-col">
        {items.slice(0, 6).map((it) => (
          <li key={it.seq} className="flex items-center gap-1.5 py-0.5 text-xs" data-testid="page-change">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-ink">{it.actor?.name ?? t('activity.someone')}</span>
              {it.via && <span className="ml-1 rounded-full bg-accent-soft px-1 text-[10px] text-accent">{it.via}</span>}
              {it.revert?.isRevert && <span className="ml-1 rounded bg-hover px-1 text-[10px] text-sub">{t('revert.badgeRevert')}</span>}
              <span className="text-sub"> · {it.headingPath || (tMaybe(`activity.kind.${it.kind}`) ?? it.kind)}</span>
            </span>
            {it.revert?.revertedBy ? (
              <span className="shrink-0 text-[10px] text-sub" title={t('revert.revertedBy', { name: it.revert.revertedBy.name })}>
                {t('revert.reverted')}
              </span>
            ) : (
              !readOnly &&
              offersRevert(it) && (
                <button
                  type="button"
                  onClick={() => setSource(revertSourceOf(it))}
                  className="shrink-0 rounded px-1 text-[11px] text-accent hover:bg-hover"
                  data-testid="page-change-revert"
                >
                  {it.revert?.isRevert ? t('revert.undoShort') : t('revert.short')}
                </button>
              )
            )}
            <span className="shrink-0 text-[10px] text-sub">{relativeTime(it.changedAt)}</span>
          </li>
        ))}
      </ul>
      <Link to={`/w/${wsId}/activity?rootId=${pageId}`} className="mt-0.5 self-start text-xs text-accent hover:underline">
        {t('revert.allChanges')}
      </Link>
      <RevertDialog wsId={wsId} source={source} onClose={() => setSource(null)} />
    </div>
  )
}
