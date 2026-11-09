import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { LaterItemDTO } from '@inkling/shared'
import { useLayout } from '../components/AppLayout'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import { CheckIcon, ClockIcon, EyeOffIcon, FileTextIcon, MenuIcon, MessageIcon, BellIcon, RestoreIcon, TrashIcon } from '../components/Icons'
import { LaterModal, reminderLine } from '../components/LaterPanel'
import { useDeleteLater, useLaterList, useMarkThreadRead, useUpdateLater, type LaterTarget } from '../laterApi'
import { relativeTime } from '../lib/time'
import { toast } from '../lib/toast'
import { t as tt, useT, type TKey } from '../i18n'

// Later list (docs/adr/1410-*): what the person set aside in this workspace, open or done, with the
// reminder each one has. Items the person can no longer open keep a row without their title.

const KIND_LABEL: Record<LaterItemDTO['kind'], TKey> = {
  page: 'later.kindPage',
  thread: 'later.kindThread',
  notification: 'later.kindNotification',
}

function KindIcon({ item }: { item: LaterItemDTO }) {
  if (!item.accessible) return <EyeOffIcon size={15} />
  if (item.kind === 'thread') return <MessageIcon size={15} />
  if (item.kind === 'notification') return <BellIcon size={15} />
  return <FileTextIcon size={15} />
}

const targetOf = (item: LaterItemDTO): LaterTarget => ({ kind: 'item', id: item.id })

function Row({ item, wsId, onRemind }: { item: LaterItemDTO; wsId: string; onRemind: (i: LaterItemDTO) => void }) {
  const t = useT()
  const navigate = useNavigate()
  const update = useUpdateLater()
  const del = useDeleteLater()
  const readThread = useMarkThreadRead()
  const remind = reminderLine(item, t)
  const open = () => {
    if (!item.accessible) return
    if (item.threadId) {
      readThread.mutate(item.threadId)
      navigate(`/w/${wsId}/p/${item.pageId}?thread=${item.threadId}`)
    } else navigate(`/w/${wsId}/p/${item.pageId}`)
  }
  return (
    <li className="group flex items-start gap-2 rounded-md px-2 py-2 hover:bg-hover" data-testid="later-item" data-kind={item.kind}>
      <span className={`mt-0.5 shrink-0 ${item.accessible ? 'text-sub' : 'text-sub/60'}`}>
        <KindIcon item={item} />
      </span>
      <button type="button" onClick={open} disabled={!item.accessible} className="flex min-w-0 flex-1 flex-col text-left disabled:cursor-default">
        <span className={`truncate text-sm ${item.done ? 'text-sub line-through' : item.accessible ? 'text-ink' : 'text-sub italic'}`}>
          {item.accessible ? item.pageTitle || t('common.untitled') : t('later.hidden')}
        </span>
        {item.accessible && item.preview && (
          <span className="line-clamp-2 text-xs text-sub">
            {item.actorName && <span className="font-medium text-ink/80">{item.actorName}: </span>}
            {item.preview}
          </span>
        )}
        {!item.accessible && <span className="text-xs text-sub">{t('later.hiddenHint')}</span>}
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-sub">
          <span>{t(KIND_LABEL[item.kind])}</span>
          <span className="text-sub/50">·</span>
          <span>{relativeTime(item.createdAt)}</span>
          {remind && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px ${
                item.reminded && !item.done ? 'bg-red-500/15 text-red-500' : 'bg-accent-soft text-accent'
              }`}
              data-testid="later-reminder"
            >
              <ClockIcon size={10} /> {remind}
            </span>
          )}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 sm:opacity-60 sm:group-hover:opacity-100">
        {!item.done && item.accessible && (
          <button
            type="button"
            onClick={() => onRemind(item)}
            aria-label={t('later.remind')}
            title={t('later.remind')}
            className="rounded p-1.5 text-sub hover:bg-app hover:text-ink"
          >
            <ClockIcon size={15} />
          </button>
        )}
        <button
          type="button"
          onClick={() => update.mutate({ id: item.id, done: !item.done })}
          aria-label={item.done ? t('later.reopen') : t('later.markDone')}
          title={item.done ? t('later.reopen') : t('later.markDone')}
          data-testid="later-done"
          className="rounded p-1.5 text-sub hover:bg-app hover:text-ink"
        >
          {item.done ? <RestoreIcon size={15} /> : <CheckIcon size={15} />}
        </button>
        <button
          type="button"
          onClick={() => del.mutate(item.id, { onSuccess: () => toast({ message: tt('later.removedToast') }) })}
          aria-label={t('later.delete')}
          title={t('later.delete')}
          className="rounded p-1.5 text-sub hover:bg-app hover:text-red-500"
        >
          <TrashIcon size={15} />
        </button>
      </span>
    </li>
  )
}

export function LaterView() {
  const { wsId } = useParams()
  const { onToggleSidebar } = useLayout()
  const t = useT()
  const ws = wsId ?? ''
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const list = useLaterList(ws, tab)
  const [reminding, setReminding] = useState<LaterItemDTO | null>(null)
  const items = list.data?.items ?? []

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
          <ClockIcon size={16} className="text-sub" />
          <span className="font-medium">{t('later.title')}</span>
          {list.isFetching && <Spinner size={12} />}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto max-w-3xl px-3 py-5 sm:px-6 sm:py-8">
          <p className="px-2 text-xs text-sub">{t('later.subtitle')}</p>
          <div className="mt-4 flex items-center gap-1 border-b border-line px-1" role="tablist">
            {(['open', 'done'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                  tab === k ? 'border-accent font-medium text-ink' : 'border-transparent text-sub hover:text-ink'
                }`}
              >
                {k === 'open' ? t('later.tabOpen') : t('later.tabDone')}
                {k === 'open' && (list.data?.open ?? 0) > 0 && tab === 'open' && (
                  <span className="ml-1.5 rounded-full bg-hover px-1.5 text-[10px] font-medium text-sub">{list.data?.open}</span>
                )}
              </button>
            ))}
            {tab === 'open' && (list.data?.due ?? 0) > 0 && (
              <span className="ml-auto rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-500">
                {t('later.due', { count: list.data?.due ?? 0 })}
              </span>
            )}
          </div>

          <div className="mt-3">
            {list.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size={20} />
              </div>
            ) : items.length === 0 ? (
              <p className="py-8 text-center text-sm text-sub">{tab === 'open' ? t('later.empty') : t('later.emptyDone')}</p>
            ) : (
              <ul className="flex flex-col" data-testid="later-list">
                {items.map((i) => (
                  <Row key={i.id} item={i} wsId={ws} onRemind={setReminding} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      {reminding && (
        <LaterModal open onClose={() => setReminding(null)} target={targetOf(reminding)} />
      )}
    </div>
  )
}
