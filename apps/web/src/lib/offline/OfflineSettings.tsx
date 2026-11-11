import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useMe } from '../../api'
import { Group, Row, Toggle } from '../../components/SettingsRows'
import { fmtDateTime, useT, type TKey } from '../../i18n'
import { fmtBytes } from '../../status/text'
import { askConfirm } from '../confirm'
import { isInstalledApp } from './settings'
import { adoptUser, deleteRecovery, listRecovery, refreshCounts, setOfflineEnabled, useOfflineStatus, wipeOffline } from './runtime'
import type { RecoveryItem, RecoveryReason } from './store'

// The editor is in its own chunk: only load it when a recovery item is opened.
const RecoveryPreview = lazy(() => import('./RecoveryPreview').then((m) => ({ default: m.RecoveryPreview })))

const REASON: Record<RecoveryReason, TKey> = {
  restored: 'offline.reason.restored',
  replaced: 'offline.reason.replaced',
  readonly: 'offline.reason.readonly',
  trashed: 'offline.reason.trashed',
  outdated: 'offline.reason.outdated',
}

const btn =
  'rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40'

/** Settings → Offline (docs/adr/2203-*): the device switch, what is stored, delete now, recovery items. */
export function OfflineSettings() {
  const t = useT()
  const s = useOfflineStatus()
  const { wsId } = useParams()
  const me = useMe()
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    void refreshCounts()
  }, [])
  useEffect(() => {
    let alive = true
    void listRecovery().then((r) => alive && setItems(r))
    return () => {
      alive = false
    }
  }, [s.recovery, s.enabled])

  const toggle = async (on: boolean) => {
    if (!on && s.pendingPages > 0) {
      const ok = await askConfirm(`${t('offline.clearConfirm')} ${t('offline.clearConfirmPending', { count: s.pendingPages })}`, t('offline.clearNow'))
      if (!ok) return
    }
    await setOfflineEnabled(on)
    // pages opened from now on are kept (an editor already open keeps going without a copy)
    if (on && me.data) await adoptUser(me.data)
  }
  const clearNow = async () => {
    const msg = s.pendingPages > 0 ? `${t('offline.clearConfirm')} ${t('offline.clearConfirmPending', { count: s.pendingPages })}` : t('offline.clearConfirm')
    if (!(await askConfirm(msg, t('offline.clearNow')))) return
    await wipeOffline()
    if (s.enabled && me.data) await adoptUser(me.data)
  }

  return (
    <>
      <Group title={t('settings.offline')}>
        <Row
          id="offline"
          deviceOnly
          title={t('offline.settingTitle')}
          desc={
            <>
              {t('offline.settingHint')} {t(isInstalledApp() ? 'offline.defaultInstalled' : 'offline.defaultBrowser')}
              {s.enabled && s.storage === 'unavailable' && <span className="mt-1 block text-amber-600 dark:text-amber-400">{t('offline.storageUnavailable')}</span>}
              {s.enabled && s.storage === 'failed' && <span className="mt-1 block text-amber-600 dark:text-amber-400">{t('offline.storageFailed')}</span>}
            </>
          }
        >
          <Toggle checked={s.enabled} onChange={(v) => void toggle(v)} label={t('offline.settingTitle')} />
        </Row>
        {s.enabled && (
          <Row
            title={s.docs > 0 ? t('offline.usage', { count: s.docs, size: fmtBytes(s.bytes) }) : t('offline.usageNone')}
            desc={s.pendingPages > 0 ? t('offline.pendingPages', { count: s.pendingPages }) : undefined}
          >
            <button type="button" className={btn} data-testid="offline-clear" disabled={s.docs === 0 && s.recovery === 0} onClick={() => void clearNow()}>
              {t('offline.clearNow')}
            </button>
          </Row>
        )}
      </Group>
      {items.length > 0 && (
        <Group title={t('offline.recoveryTitle')} desc={t('offline.recoveryIntro')}>
          {items.map((it) => (
            <div key={it.id} className="px-4 py-3" data-testid="offline-recovery-item">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {it.title || '—'}
                  <span className="ml-2 text-xs text-sub">
                    {t(REASON[it.reason])} · {fmtDateTime(new Date(it.createdAt).toISOString())}
                  </span>
                </span>
                <button type="button" className={btn} onClick={() => setOpen(open === it.id ? null : it.id)}>
                  {t('offline.recoveryOpen')}
                </button>
                {wsId && (
                  <Link className={btn} to={`/w/${it.wsId}/p/${it.pageId}`}>
                    ↗
                  </Link>
                )}
                <button
                  type="button"
                  className={btn}
                  onClick={() => {
                    if (open === it.id) setOpen(null)
                    void deleteRecovery(it.id)
                  }}
                >
                  {t('offline.recoveryDelete')}
                </button>
              </div>
              {open === it.id && me.data && (
                <div className="mt-2 rounded-md border border-line p-2">
                  <Suspense fallback={null}>
                    <RecoveryPreview item={it} me={me.data} />
                  </Suspense>
                </div>
              )}
            </div>
          ))}
        </Group>
      )}
    </>
  )
}
