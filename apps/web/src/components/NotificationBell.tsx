import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { NotificationDTO } from '@inkling/shared'
import { useMarkRead, useNotifications } from '../api'
import { relativeTime } from '../lib/time'
import { t, useT } from '../i18n'
import { BellIcon } from './Icons'

// Builds the notification text — actorName commented on / mentioned you in pageTitle. reminder (M17) is a due-date line.
// The switch is exhaustive over NotificationType, so a new type fails typecheck until it has a line.
function describe(n: NotificationDTO): string {
  const actor = n.actorName ?? t('notifications.someone')
  const title = n.pageTitle ?? t('notifications.deletedPage')
  const workspace = n.workspaceName ?? t('notifications.workspaceFallback')
  switch (n.type) {
    case 'workspace_added':
      return t('notifications.workspaceAdded', { actor, workspace })
    case 'webhook_disabled':
      return t('notifications.webhookDisabled', { workspace })
    case 'workspace_deleted':
      // no navigation target: the workspace is gone for members (owners restore it in Settings)
      return t('notifications.workspaceDeleted', { actor, workspace })
    case 'backup_failed':
      return t('notifications.backupFailed')
    case 'reminder':
      return t('notifications.reminderDue', { title })
    case 'comment_mention':
    case 'doc_mention':
      return t('notifications.mentioned', { actor, title })
    case 'comment':
      return t('notifications.commented', { actor, title })
    case 'comment_reply':
      return t('notifications.replied', { actor, title })
    case 'page_owner':
      return t('notifications.pageOwner', { actor, title })
    case 'task_assigned':
      return t('notifications.taskAssigned', { actor, title })
    case 'page_update':
      // Repeated edits collapse into one item: "3 updates to <title>" instead of one actor.
      return (n.count ?? 1) > 1
        ? t('notifications.pageUpdates', { count: n.count ?? 1, title })
        : t('notifications.pageUpdate', { actor, title })
    case 'agent_digest':
      return t('notifications.agentDigest', { title })
    case 'approval_request':
      return t('notifications.approvalRequest', { actor, title })
    case 'approval_result':
      return t('notifications.approvalResult', { actor, title })
    case 'large_page':
      return t('notifications.largePage', { title })
    default: {
      const never: never = n.type
      return String(never)
    }
  }
}

/** "×3" for collapsed repeats (page_update already says "3 updates" in its text). */
function repeatSuffix(n: NotificationDTO): string | null {
  const c = n.count ?? 1
  if (c <= 1 || n.type === 'page_update') return null
  return t('notifications.times', { count: c })
}

// Global notification bell (M13) — all my notifications regardless of workspace. Placed at the AppLayout level.
export function NotificationBell({ wsId }: { wsId: string }) {
  useT()
  const navigate = useNavigate()
  const notifications = useNotifications()
  const markRead = useMarkRead()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const unread = notifications.data?.unread ?? 0
  const list = notifications.data?.notifications ?? []

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const openItem = (n: NotificationDTO) => {
    if (!n.read) markRead.mutate([n.id])
    setOpen(false)
    // NotificationDTO has no workspaceId for page notifications, so navigate within the current workspace (see report).
    if ((n.type === 'workspace_added' || n.type === 'webhook_disabled') && n.workspaceId) navigate(`/w/${n.workspaceId}`)
    else if (n.type === 'backup_failed' && wsId) navigate(`/w/${wsId}/admin`)
    else if (n.type === 'large_page' && n.pageId && wsId) navigate(`/w/${wsId}/p/${n.pageId}?split=1`)
    else if (n.pageId && wsId) navigate(`/w/${wsId}/p/${n.pageId}`)
  }

  return (
    // Notch/punch-hole devices: #root is inset by the safe area, so inset the fixed bell by the same amount (matches the header's pr-14 slot).
    <div
      ref={ref}
      className="fixed right-[calc(env(safe-area-inset-right)+0.75rem)] top-[calc(env(safe-area-inset-top)+0.375rem)] z-30"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('notifications.title')}
        title={t('notifications.title')}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md border border-line bg-app/80 backdrop-blur transition-colors duration-150 hover:bg-hover ${
          open ? 'text-accent' : 'text-sub hover:text-ink'
        }`}
      >
        <BellIcon size={17} />
        {unread > 0 && (
          <span className="nd-pop absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="nd-pop absolute right-0 top-full mt-1 w-80 max-w-[calc(100vw-1.5rem)] origin-top-right overflow-hidden rounded-md border border-line bg-app shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-sm font-semibold text-ink">{t('notifications.title')}</span>
            <button
              type="button"
              onClick={() => markRead.mutate(undefined)}
              disabled={unread === 0 || markRead.isPending}
              className="text-xs text-accent hover:underline disabled:text-sub/60 disabled:no-underline"
            >
              {t('notifications.markAllRead')}
            </button>
          </div>

          <div className="max-h-[min(24rem,70dvh)] overflow-y-auto">
            {list.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-sub">{t('notifications.empty')}</p>
            ) : (
              <ul>
                {list.map((n) => {
                  // Quiet items (agent-written mentions, level "nothing") never count as unread.
                  const unreadItem = !n.read && !n.quiet
                  const repeat = repeatSuffix(n)
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => openItem(n)}
                        title={n.quiet ? t('notifications.quiet') : undefined}
                        data-quiet={n.quiet || undefined}
                        className={`flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-left transition-colors hover:bg-hover ${
                          unreadItem ? 'bg-accent-soft/40' : ''
                        } ${n.quiet ? 'opacity-60' : ''}`}
                      >
                        <span className="flex items-start gap-1.5">
                          {unreadItem && (
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                          )}
                          {n.type === 'reminder' && (
                            <span className="shrink-0 text-xs leading-4">⏰</span>
                          )}
                          <span className="min-w-0 flex-1 text-xs text-ink">
                            {describe(n)}
                            {n.via && <span className="text-sub"> {t('comments.via', { client: n.via })}</span>}
                            {repeat && <span className="ml-1 text-sub">{repeat}</span>}
                          </span>
                        </span>
                        {n.excerpt && (
                          <span className="block truncate pl-3 text-[11px] text-sub">{n.excerpt}</span>
                        )}
                        <span className="pl-3 text-[11px] text-sub">
                          {relativeTime(n.createdAt)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
