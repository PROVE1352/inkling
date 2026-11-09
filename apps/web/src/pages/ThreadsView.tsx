import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { ThreadSummaryDTO } from '@inkling/shared'
import { useLayout } from '../components/AppLayout'
import { ThemeToggle } from '../components/ThemeToggle'
import { NavButtons } from '../components/NavButtons'
import { Spinner } from '../components/Spinner'
import { CheckIcon, MenuIcon, MessageIcon } from '../components/Icons'
import { useFollowThread, useMarkThreadRead, useThreads } from '../laterApi'
import { relativeTime } from '../lib/time'
import { useT } from '../i18n'

// Threads view (docs/adr/1412-*): followed comment threads with replies by others since I last read
// them, newest activity first. Opening one marks it read (here and its bell items).

function ThreadRow({ th, wsId }: { th: ThreadSummaryDTO; wsId: string }) {
  const t = useT()
  const navigate = useNavigate()
  const read = useMarkThreadRead()
  const follow = useFollowThread()
  const open = () => {
    read.mutate(th.threadId)
    navigate(`/w/${wsId}/p/${th.pageId}?thread=${th.threadId}`)
  }
  const fresh = th.newReplies > 0
  return (
    <li
      className={`group rounded-md border px-3 py-2.5 ${fresh ? 'border-accent/40 bg-accent-soft/30' : 'border-line'}`}
      data-testid="thread-item"
      data-new={th.newReplies}
    >
      <div className="flex items-start gap-2">
        <button type="button" onClick={open} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-sub">
            <MessageIcon size={12} className="shrink-0" />
            <span className="truncate font-medium text-ink/80">{th.pageTitle || t('common.untitled')}</span>
            {th.resolved && <span className="shrink-0 text-green-600">· {t('threads.resolved')}</span>}
            <span className="shrink-0">· {relativeTime(th.lastActivityAt)}</span>
          </span>
          <span className="line-clamp-2 text-sm text-ink">
            {th.rootAuthor && <span className="font-medium">{th.rootAuthor}: </span>}
            {th.rootExcerpt}
          </span>
          {th.lastReply && (
            <span className="line-clamp-2 border-l-2 border-line pl-2 text-xs text-sub">
              <span className="font-medium text-ink/80">{th.lastReply.author ?? t('notifications.someone')}: </span>
              {th.lastReply.excerpt}
            </span>
          )}
          <span className="flex items-center gap-2 text-[11px]">
            {fresh ? (
              <span className="rounded-full bg-accent px-1.5 py-px font-medium text-white" data-testid="thread-new">
                {t('threads.newReplies', { count: th.newReplies })}
              </span>
            ) : (
              <span className="text-sub">{t('threads.replies', { count: th.replies })}</span>
            )}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5 sm:opacity-60 sm:group-hover:opacity-100">
          {fresh && (
            <button
              type="button"
              onClick={() => read.mutate(th.threadId)}
              aria-label={t('threads.markRead')}
              title={t('threads.markRead')}
              className="rounded p-1.5 text-sub hover:bg-hover hover:text-ink"
            >
              <CheckIcon size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={() => follow.mutate({ threadId: th.threadId, following: false })}
            className="rounded px-1.5 py-1 text-[11px] text-sub hover:bg-hover hover:text-ink"
          >
            {t('threads.unfollow')}
          </button>
        </span>
      </div>
    </li>
  )
}

export function ThreadsView() {
  const { wsId } = useParams()
  const { onToggleSidebar } = useLayout()
  const t = useT()
  const ws = wsId ?? ''
  const [all, setAll] = useState(false)
  const threads = useThreads(ws, all)
  const list = threads.data?.threads ?? []

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
          <MessageIcon size={16} className="text-sub" />
          <span className="font-medium">{t('threads.title')}</span>
          {threads.isFetching && <Spinner size={12} />}
        </div>
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="nd-enter mx-auto max-w-3xl px-3 py-5 sm:px-6 sm:py-8">
          <div className="flex flex-wrap items-center gap-2 px-1">
            <p className="min-w-0 flex-1 text-xs text-sub">{t('threads.subtitle')}</p>
            <label className="flex items-center gap-1.5 text-xs text-sub">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              {t('threads.showAll')}
            </label>
          </div>
          <div className="mt-4">
            {threads.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size={20} />
              </div>
            ) : list.length === 0 ? (
              <p className="py-8 text-center text-sm text-sub">{all ? t('threads.emptyAll') : t('threads.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="threads-list">
                {list.map((th) => (
                  <ThreadRow key={th.threadId} th={th} wsId={ws} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
