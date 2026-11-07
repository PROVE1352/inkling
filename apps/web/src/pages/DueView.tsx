import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { DueItemDTO, DueSection } from '@inkling/shared'
import { useDue, useQuickTask } from '../api'
import { useLayout } from '../components/AppLayout'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import { AlarmIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, MenuIcon, PlusIcon } from '../components/Icons'
import {
  KIND_DOT,
  KIND_LABEL,
  canComplete,
  itemHref,
  itemKey,
  itemSource,
  relativeDateLabel,
  useDateItemActions,
} from '../lib/dateItems'
import { todayISODate } from '../lib/time'
import { toast } from '../lib/toast'
import { useT, type TKey } from '../i18n'

// Due view: /w/:wsId/due. Collection rows (due-like date fields) · page date properties · tasks inside documents,
// grouped into Overdue / Today / Tomorrow / This week / Next 30 days / Done, with in-place completion checkboxes.
// Daily notes aren't deadlines, so they're not here (calendar only). The input at the top adds straight to the "Tasks" document.

// Labels are dictionary keys, translated at render.
const SECTIONS: { key: DueSection; label: TKey }[] = [
  { key: 'overdue', label: 'due.sectionOverdue' },
  { key: 'today', label: 'common.today' },
  { key: 'tomorrow', label: 'common.tomorrow' },
  { key: 'week', label: 'due.sectionWeek' },
  { key: 'next30', label: 'due.sectionNext30' },
  { key: 'done', label: 'due.sectionDone' },
]

function DueRow({
  item,
  wsId,
  onToggle,
}: {
  item: DueItemDTO
  wsId: string
  onToggle: (item: DueItemDTO) => void
}) {
  const navigate = useNavigate()
  const t = useT()
  const completable = canComplete(item)
  const overdue = item.section === 'overdue'
  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover" data-testid="due-item" data-kind={item.kind}>
      {completable ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={item.done}
          aria-label={item.done ? t('due.markUndone', { title: item.title }) : t('due.markDone', { title: item.title })}
          onClick={() => onToggle(item)}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors max-sm:h-6 max-sm:w-6 ${
            item.done ? 'border-accent bg-accent text-white' : 'border-sub/50 hover:border-accent'
          }`}
        >
          {item.done && <CheckIcon size={13} />}
        </button>
      ) : (
        // Row that can't be checked (collection has no checkbox field) — just keeps the alignment
        <span className="flex h-5 w-5 shrink-0 items-center justify-center max-sm:h-6 max-sm:w-6" title={t('due.noCheckboxField')}>
          <span className={`h-2 w-2 rounded-full ${KIND_DOT[item.kind]}`} />
        </span>
      )}
      <button
        type="button"
        onClick={() => navigate(itemHref(wsId, item))}
        className="flex min-w-0 flex-1 flex-col text-left"
      >
        <span className={`truncate text-sm ${item.done ? 'text-sub line-through' : 'text-ink'}`}>
          {item.kind !== 'task' && item.icon ? `${item.icon} ` : ''}
          {item.title || t('common.untitled')}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-sub">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[item.kind]}`} aria-hidden />
          <span className="shrink-0">{KIND_LABEL[item.kind]}</span>
          <span className="text-sub/50">·</span>
          <span className="truncate">{itemSource(item)}</span>
        </span>
      </button>
      <span
        title={item.date}
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
          item.done
            ? 'bg-hover text-sub'
            : overdue
              ? 'bg-red-500/15 text-red-500'
              : item.section === 'today'
                ? 'bg-accent-soft text-accent'
                : 'bg-hover text-sub'
        }`}
      >
        {relativeDateLabel(item.date)}
      </span>
    </li>
  )
}

export function DueView() {
  const { wsId } = useParams()
  const { onToggleSidebar } = useLayout()
  const t = useT()
  const ws = wsId ?? ''
  const due = useDue(ws)
  const quickTask = useQuickTask(ws)
  const { setDone } = useDateItemActions(ws)
  const [showDone, setShowDone] = useState(false)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(() => todayISODate())

  const grouped = useMemo(() => {
    const m = new Map<DueSection, DueItemDTO[]>()
    for (const it of due.data?.items ?? []) {
      const arr = m.get(it.section)
      if (arr) arr.push(it)
      else m.set(it.section, [it])
    }
    return m
  }, [due.data])
  const counts = due.data?.counts
  const openTotal = counts
    ? counts.overdue + counts.today + counts.tomorrow + counts.week + counts.next30
    : 0

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = title.trim()
    if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(date) || quickTask.isPending) return
    try {
      await quickTask.mutateAsync({ title: text, date })
      setTitle('')
      toast({ message: t('due.taskAdded', { when: relativeDateLabel(date) }) })
    } catch (err) {
      toast({
        message: err instanceof Error ? t('due.taskAddFailedWith', { error: err.message }) : t('due.taskAddFailed'),
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3 pr-14">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('due.toggleSidebar')}
          className="rounded-md p-1.5 text-sub transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <MenuIcon size={18} />
        </button>
        <NavButtons />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink">
          <AlarmIcon size={16} className="text-sub" />
          <span className="font-medium">{t('due.title')}</span>
          {due.isFetching && <Spinner size={12} />}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto max-w-3xl px-3 py-5 sm:px-6 sm:py-8">
          {/* Quick add — appended as a checklist item to the workspace's "Tasks" document */}
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
            <PlusIcon size={16} className="ml-1 shrink-0 text-sub" />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('due.addPlaceholder')}
              aria-label={t('due.taskTitleLabel')}
              maxLength={300}
              className="min-w-0 flex-1 basis-40 bg-transparent px-1 py-1 text-sm text-ink outline-none placeholder:text-sub/70 max-sm:text-base"
            />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value || todayISODate())}
              aria-label={t('due.dueDateLabel')}
              className="rounded-md border border-line bg-app px-2 py-1 text-xs text-ink outline-none focus-visible:border-accent max-sm:text-sm"
            />
            <button
              type="submit"
              disabled={!title.trim() || quickTask.isPending}
              className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {t('common.add')}
            </button>
          </form>
          <p className="mt-1.5 px-1 text-[11px] text-sub">
            {t('due.helpBefore')} <code>{t('due.helpExample1')}</code>
            {' · '}
            <code>9/30</code>
            {' · '}
            <code>{t('due.helpExample3')}</code>
            {t('due.helpAfter')}
          </p>

          <div className="mt-6">
            {due.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size={20} />
              </div>
            ) : due.isError ? (
              <p className="py-8 text-center text-sm text-sub">{t('due.loadFailed')}</p>
            ) : (
              <>
                {openTotal === 0 && (
                  <p className="py-6 text-center text-sm text-sub">{t('due.empty')}</p>
                )}
                {SECTIONS.map(({ key, label }) => {
                  const list = grouped.get(key) ?? []
                  if (list.length === 0) return null
                  const collapsed = key === 'done' && !showDone
                  return (
                    <section key={key} className="mb-5" data-testid={`due-section-${key}`}>
                      <h2 className="mb-1 flex items-center gap-1.5 px-2 text-xs font-semibold">
                        {key === 'done' ? (
                          <button
                            type="button"
                            onClick={() => setShowDone((v) => !v)}
                            aria-expanded={!collapsed}
                            className="inline-flex items-center gap-1 text-sub hover:text-ink"
                          >
                            {collapsed ? <ChevronRightIcon size={13} /> : <ChevronDownIcon size={13} />}
                            {t(label)}
                          </button>
                        ) : (
                          <span className={key === 'overdue' ? 'text-red-500' : key === 'today' ? 'text-accent' : 'text-sub'}>
                            {t(label)}
                          </span>
                        )}
                        <span className="rounded-full bg-hover px-1.5 text-[10px] font-medium text-sub">
                          {list.length}
                        </span>
                      </h2>
                      {!collapsed && (
                        <ul className="flex flex-col gap-0.5">
                          {list.map((it) => (
                            <DueRow
                              key={itemKey(it)}
                              item={it}
                              wsId={ws}
                              onToggle={(x) => void setDone(x, !x.done)}
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                  )
                })}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
