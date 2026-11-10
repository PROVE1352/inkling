import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import type { ActivityItemDTO } from '@inkling/shared'
import { useMembers, usePages } from '../api'
import {
  DEFAULT_ACTIVITY_FILTERS,
  useActivity,
  useChangeDiff,
  type ActivityFilters,
} from '../notificationsApi'
import { useLayout } from '../components/AppLayout'
import { DiffView } from '../components/DiffView'
import { HistoryIcon, MenuIcon } from '../components/Icons'
import { Modal } from '../components/Modal'
import { offersRevert, revertSourceOf } from '../components/PageChanges'
import { RevertDialog, type RevertSource } from '../components/RevertDialog'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import { ThemeToggle } from '../components/ThemeToggle'
import { groupByDay, relativeDay } from '../lib/activity'
import { relativeTime, formatDateTime } from '../lib/time'
import { fmtDate, parseYmd, tMaybe, useT } from '../i18n'

// Workspace activity (/w/:wsId/activity, docs/adr/1003-*): changes by people and AI agents,
// newest first, grouped by day. `?rootId=` narrows it to a page and everything under it.

const selectCls =
  'rounded-md border border-line bg-app px-2 py-1 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

function kindLabel(kind: string): string {
  return tMaybe(`activity.kind.${kind}`) ?? kind
}

export function ActivityView() {
  const t = useT()
  const { wsId = '' } = useParams()
  const { onToggleSidebar } = useLayout()
  const [params, setParams] = useSearchParams()
  const rootId = params.get('rootId') ?? ''
  const [rest, setRest] = useState<Omit<ActivityFilters, 'rootId'>>(DEFAULT_ACTIVITY_FILTERS)
  const filters = useMemo<ActivityFilters>(() => ({ ...rest, rootId }), [rest, rootId])
  const [openSeq, setOpenSeq] = useState<string | null>(null)
  const [revertSource, setRevertSource] = useState<RevertSource | null>(null)

  const pages = usePages(wsId)
  const members = useMembers(wsId)
  const activity = useActivity(wsId, filters)

  const items = useMemo(() => activity.data?.pages.flatMap((p) => p.items) ?? [], [activity.data])
  const clients = activity.data?.pages[0]?.clients ?? []
  const groups = useMemo(() => groupByDay(items), [items])
  const pageOptions = useMemo(
    () =>
      [...(pages.data ?? [])].sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }),
      ),
    [pages.data],
  )
  const rootTitle = rootId ? pages.data?.find((p) => p.id === rootId)?.title : undefined

  const set = <K extends keyof Omit<ActivityFilters, 'rootId'>>(k: K, v: ActivityFilters[K]) =>
    setRest((f) => ({ ...f, [k]: v }))
  const setRoot = (id: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('rootId', id)
    else next.delete('rootId')
    setParams(next, { replace: true })
  }

  const dayLabel = (day: string) => {
    const rel = relativeDay(day)
    if (rel === 'today') return t('common.today')
    if (rel === 'yesterday') return t('common.yesterday')
    const d = parseYmd(day)
    return d ? fmtDate(d, { dateStyle: 'full' }) : day
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('activity.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink">
          <HistoryIcon size={16} className="text-sub" />
          <span className="font-medium">{t('activity.title')}</span>
          {rootId && (
            <>
              <span className="px-0.5 text-sub/50">›</span>
              <span className="truncate text-accent">{rootTitle || t('common.untitled')}</span>
            </>
          )}
        </div>
        {/* the team agents board (docs/adr/1862-*): who is working on what right now */}
        <Link
          to={`/w/${wsId}/team-agents`}
          className="rounded-md px-2 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
          data-testid="open-team-agents"
        >
          {t('teamAgents.open')}
        </Link>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          {/* Filters */}
          <div className="mb-6 flex flex-wrap items-center gap-2" data-testid="activity-filters">
            <select
              aria-label={t('activity.who')}
              value={rest.actor}
              onChange={(e) => set('actor', e.target.value as ActivityFilters['actor'])}
              className={selectCls}
            >
              <option value="any">{t('activity.whoAny')}</option>
              <option value="human">{t('activity.whoHuman')}</option>
              <option value="ai">{t('activity.whoAi')}</option>
            </select>
            {clients.length > 0 && (
              <select
                aria-label={t('activity.client')}
                value={rest.via}
                onChange={(e) => set('via', e.target.value)}
                className={selectCls}
              >
                <option value="">{t('activity.clientAny')}</option>
                {clients.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label={t('activity.member')}
              value={rest.userId}
              onChange={(e) => set('userId', e.target.value)}
              className={selectCls}
            >
              <option value="">{t('activity.memberAny')}</option>
              {(members.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t('activity.page')}
              value={rootId}
              onChange={(e) => setRoot(e.target.value)}
              className={`${selectCls} max-w-[12rem]`}
            >
              <option value="">{t('activity.pageAny')}</option>
              {rootId && !pageOptions.some((p) => p.id === rootId) && (
                <option value={rootId}>{t('activity.pageScope', { title: t('common.untitled') })}</option>
              )}
              {pageOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || t('common.untitled')}
                </option>
              ))}
            </select>
            {rootId && (
              <button
                type="button"
                onClick={() => setRoot('')}
                className="rounded-md px-2 py-1 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
              >
                {t('activity.clearPage')}
              </button>
            )}
            <select
              aria-label={t('activity.kind')}
              value={rest.kind}
              onChange={(e) => set('kind', e.target.value as ActivityFilters['kind'])}
              className={selectCls}
            >
              <option value="any">{t('activity.kindAny')}</option>
              <option value="edit">{t('activity.kindEdit')}</option>
              <option value="page">{t('activity.kindPage')}</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink">
              <input
                type="checkbox"
                checked={rest.aiPagesOnly}
                onChange={(e) => set('aiPagesOnly', e.target.checked)}
              />
              {t('activity.aiPagesOnly')}
            </label>
          </div>

          {activity.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner size={20} />
            </div>
          ) : activity.isError ? (
            <p className="py-12 text-center text-sm text-red-600">{t('activity.loadFailed')}</p>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-sm text-sub">{t('activity.empty')}</p>
          ) : (
            <div className="flex flex-col gap-6" data-testid="activity-list">
              {groups.map((g) => (
                <section key={g.day}>
                  <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
                    {dayLabel(g.day)}
                  </h2>
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {g.items.map((it) => (
                      <ActivityRow
                        key={it.seq}
                        wsId={wsId}
                        item={it}
                        onOpen={() => setOpenSeq(it.seq)}
                        onRevert={() => setRevertSource(revertSourceOf(it))}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {activity.hasNextPage && (
                <button
                  type="button"
                  onClick={() => void activity.fetchNextPage()}
                  disabled={activity.isFetchingNextPage}
                  className="mx-auto flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-60"
                >
                  {activity.isFetchingNextPage && <Spinner size={14} />}
                  {t('activity.loadMore')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <ChangeDiffModal seq={openSeq} onClose={() => setOpenSeq(null)} />
      <RevertDialog wsId={wsId} source={revertSource} onClose={() => setRevertSource(null)} />
    </div>
  )
}

function ViaBadge({ via }: { via: string }) {
  const t = useT()
  return (
    <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent">
      {t('activity.via', { client: via })}
    </span>
  )
}

function ActivityRow({ wsId, item, onOpen, onRevert }: { wsId: string; item: ActivityItemDTO; onOpen: () => void; onRevert: () => void }) {
  const t = useT()
  return (
    <li
      className={`flex items-start gap-3 px-3 py-2 ${item.hasDiff ? 'cursor-pointer hover:bg-hover' : ''}`}
      onClick={(e) => {
        // Links inside the row navigate; anywhere else opens the diff.
        if (!item.hasDiff || (e.target as HTMLElement).closest('a,button')) return
        onOpen()
      }}
      data-testid="activity-item"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
          <span className="font-medium text-ink">{item.actor?.name ?? t('activity.someone')}</span>
          {item.via && <ViaBadge via={item.via} />}
          {item.revert?.isRevert && (
            <span className="shrink-0 rounded bg-hover px-1.5 py-px text-[10px] font-medium text-sub">{t('revert.badgeRevert')}</span>
          )}
          <span className="text-sub">{kindLabel(item.kind)}</span>
          {item.pageTitle !== null ? (
            <Link to={`/w/${wsId}/p/${item.pageId}`} className="min-w-0 truncate text-ink hover:underline">
              {item.pageTitle || t('common.untitled')}
            </Link>
          ) : (
            <span className="text-sub italic">{t('activity.hiddenPage')}</span>
          )}
          {item.pageCreatedVia && (
            <span
              title={t('provenance.writtenByAi', { client: item.pageCreatedVia })}
              className="shrink-0 rounded border border-line px-1 text-[10px] text-sub"
            >
              {t('activity.aiPage')}
            </span>
          )}
        </div>
        {item.headingPath && <div className="truncate text-xs text-sub">{item.headingPath}</div>}
        {item.revert?.revertedBy && (
          <div className="text-[11px] text-sub" data-testid="activity-reverted">
            {t('revert.revertedBy', { name: item.revert.revertedBy.name })} · {relativeTime(item.revert.revertedBy.at)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <time dateTime={item.changedAt} title={formatDateTime(item.changedAt)} className="text-[11px] text-sub">
          {relativeTime(item.changedAt)}
        </time>
        {item.hasDiff ? (
          <button type="button" onClick={onOpen} className="text-[11px] text-accent hover:underline">
            {t('activity.showChanges')}
          </button>
        ) : item.large ? (
          <span className="text-[11px] text-sub">{t('activity.large')}</span>
        ) : null}
        {offersRevert(item) && !item.revert?.revertedBy && item.pageTitle !== null && (
          <button type="button" onClick={onRevert} className="text-[11px] text-accent hover:underline" data-testid="activity-revert">
            {item.revert?.isRevert ? t('revert.undoShort') : t('revert.short')}
          </button>
        )}
      </div>
    </li>
  )
}

function ChangeDiffModal({ seq, onClose }: { seq: string | null; onClose: () => void }) {
  const t = useT()
  const diff = useChangeDiff(seq)
  const d = diff.data
  return (
    <Modal open={!!seq} onClose={onClose} title={d?.pageTitle ?? t('diff.title')} size="lg">
      {diff.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner size={18} />
        </div>
      ) : diff.isError || !d ? (
        <p className="py-6 text-center text-xs text-red-600">{t('diff.loadFailed')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-sub">
            <span className="font-medium text-ink">{d.actor?.name ?? t('activity.someone')}</span>
            {d.via && <ViaBadge via={d.via} />}
            <span>{kindLabel(d.kind)}</span>
            {d.headingPath && <span>· {d.headingPath}</span>}
            <span>· {formatDateTime(d.changedAt)}</span>
          </div>
          <DiffView ops={d.ops} large={d.large || d.ops === null} before={d.before} after={d.after} />
        </div>
      )}
    </Modal>
  )
}
