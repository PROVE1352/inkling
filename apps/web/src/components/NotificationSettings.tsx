import { useState } from 'react'
import { Link } from 'react-router'
import { NOTIFICATION_LEVELS, type EmailDigestMode, type NotificationLevel, type SubscriptionDTO } from '@inkling/shared'
import { ApiError } from '../api'
import {
  useNotificationSettings,
  useSetPageSubscription,
  useSetWorkspaceNotificationLevel,
  useUpdateNotificationSettings,
} from '../notificationsApi'
import { useT } from '../i18n'
import { Group, Row, Select, Toggle } from './SettingsRows'
import { levelDesc, levelLabel, levelOptions } from './notifLevel'
import { Spinner } from './Spinner'

// Settings → Notifications (docs/adr/1000-*, 1001-*): mail choices (stored on the server) and the
// list of pages/workspaces I set a notification level on.
export function NotificationSettings() {
  const t = useT()
  const settings = useNotificationSettings()
  const update = useUpdateNotificationSettings()
  const [error, setError] = useState<string | null>(null)

  const onError = (err: unknown) => setError(err instanceof ApiError ? err.message : t('notifSettings.saveFailed'))
  const patch = (input: { emailInstant?: boolean; emailDigest?: EmailDigestMode; threadAutoFollow?: boolean; threadReplies?: boolean; agentHandoffCopy?: boolean }) => {
    setError(null)
    update.mutate(input, { onError })
  }

  const data = settings.data
  return (
    <Group title={t('notifSettings.title')}>
      {settings.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner size={18} />
        </div>
      ) : !data ? (
        <p className="px-4 py-3 text-xs text-red-600">{t('notifSettings.loadFailed')}</p>
      ) : (
        <>
          <Row
            id="emailInstant"
            title={t('notifSettings.emailInstant')}
            desc={data.mailAvailable ? t('notifSettings.emailInstantDesc') : t('notifSettings.noMail')}
          >
            <Toggle
              label={t('notifSettings.emailInstant')}
              checked={data.mailAvailable && data.emailInstant}
              disabled={!data.mailAvailable}
              onChange={(v) => patch({ emailInstant: v })}
            />
          </Row>
          <Row
            id="emailDigest"
            title={t('notifSettings.emailDigest')}
            desc={data.mailAvailable ? t('notifSettings.emailDigestDesc') : t('notifSettings.noMail')}
          >
            <Select<EmailDigestMode>
              label={t('notifSettings.emailDigest')}
              value={data.mailAvailable ? data.emailDigest : 'off'}
              disabled={!data.mailAvailable}
              onChange={(v) => patch({ emailDigest: v })}
              options={[
                { value: 'off', label: t('notifSettings.digestOff') },
                { value: 'daily', label: t('notifSettings.digestDaily') },
                { value: 'weekly', label: t('notifSettings.digestWeekly') },
              ]}
            />
          </Row>
          {/* Followed comment threads (docs/adr/1412-*) */}
          <Row id="threadAutoFollow" title={t('notifSettings.threadAutoFollow')} desc={t('notifSettings.threadAutoFollowDesc')}>
            <Toggle
              label={t('notifSettings.threadAutoFollow')}
              checked={data.threadAutoFollow}
              onChange={(v) => patch({ threadAutoFollow: v })}
            />
          </Row>
          <Row id="threadReplies" title={t('notifSettings.threadReplies')} desc={t('notifSettings.threadRepliesDesc')}>
            <Toggle
              label={t('notifSettings.threadReplies')}
              checked={data.threadReplies}
              onChange={(v) => patch({ threadReplies: v })}
            />
          </Row>
          {/* copies of hand-offs to my agent connections (docs/adr/1863-*) */}
          <Row id="agentHandoffCopy" title={t('notifSettings.agentHandoffCopy')} desc={t('notifSettings.agentHandoffCopyDesc')}>
            <Toggle
              label={t('notifSettings.agentHandoffCopy')}
              checked={data.agentHandoffCopy === true}
              onChange={(v) => patch({ agentHandoffCopy: v })}
            />
          </Row>

          <div className="px-4 py-3">
            <div className="text-sm text-ink">{t('notifSettings.subscriptions')}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-sub">{t('notifSettings.subscriptionsDesc')}</div>
            {data.subscriptions.length === 0 ? (
              <p className="mt-3 text-xs text-sub">{t('notifSettings.noSubscriptions')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-line rounded-md border border-line" data-testid="notif-subscriptions">
                {data.subscriptions.map((s) => (
                  <SubscriptionRow key={`${s.workspaceId}:${s.rootPageId ?? ''}`} sub={s} onError={onError} />
                ))}
              </ul>
            )}
          </div>

          <div className="px-4 py-3">
            <div className="text-sm text-ink">{t('notifSettings.levelsTitle')}</div>
            <dl className="mt-1.5 grid gap-1 text-xs leading-relaxed">
              {NOTIFICATION_LEVELS.map((l) => (
                <div key={l} className="flex gap-2">
                  <dt className="w-36 shrink-0 font-medium text-ink">{levelLabel(l)}</dt>
                  <dd className="min-w-0 flex-1 text-sub">{levelDesc(l)}</dd>
                </div>
              ))}
            </dl>
          </div>
          {error && <p className="px-4 py-2 text-xs text-red-600">{error}</p>}
        </>
      )}
    </Group>
  )
}

function SubscriptionRow({ sub, onError }: { sub: SubscriptionDTO; onError: (err: unknown) => void }) {
  const t = useT()
  const setPage = useSetPageSubscription()
  const setWs = useSetWorkspaceNotificationLevel()
  const busy = setPage.isPending || setWs.isPending
  const isWorkspace = sub.rootPageId === null

  const changeLevel = (level: NotificationLevel) => {
    if (sub.rootPageId === null) {
      setWs.mutate({ workspaceId: sub.workspaceId, level, agentDigest: sub.agentDigest }, { onError })
    } else {
      // Resend subtree/agentDigest so changing the level keeps the rest of the row.
      setPage.mutate(
        { pageId: sub.rootPageId, input: { level, subtree: sub.subtree, agentDigest: sub.agentDigest } },
        { onError },
      )
    }
  }

  // Remove = inherit again for a page; a workspace row goes back to the default level.
  const remove = () => {
    if (sub.rootPageId === null) setWs.mutate({ workspaceId: sub.workspaceId, level: 'mentions', agentDigest: false }, { onError })
    else setPage.mutate({ pageId: sub.rootPageId, input: { level: null } }, { onError })
  }

  const details = [
    sub.workspaceName,
    isWorkspace ? null : sub.subtree ? t('notifSettings.pageAndSubpages') : t('notifSettings.pageOnly'),
    sub.agentDigest ? t('notifSettings.agentDigest') : null,
  ].filter(Boolean)

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">
          {isWorkspace ? (
            t('notifSettings.wholeWorkspace')
          ) : (
            <Link to={`/w/${sub.workspaceId}/p/${sub.rootPageId}`} className="hover:underline">
              {sub.rootTitle || t('common.untitled')}
            </Link>
          )}
        </div>
        <div className="truncate text-xs text-sub">{details.join(' · ')}</div>
      </div>
      <Select<NotificationLevel>
        label={t('notifSettings.level')}
        value={sub.level}
        disabled={busy}
        onChange={changeLevel}
        options={levelOptions()}
      />
      <button
        type="button"
        onClick={remove}
        disabled={busy || (isWorkspace && sub.level === 'mentions' && !sub.agentDigest)}
        className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40"
      >
        {isWorkspace ? t('notifSettings.resetDefault') : t('common.remove')}
      </button>
    </li>
  )
}
