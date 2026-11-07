import { t, type TKey } from '../i18n'

// All user-visible Backups UI strings in one place. Members are getters / functions over the i18n
// dictionary (i18n/<locale>/auth-admin.ts, 'backup.*' keys) so every read follows the current language.

/** Builds a read-only map whose values are looked up on each access. */
function keyed<K extends string>(map: Record<K, TKey>): Record<K, string> {
  const out = {} as Record<K, string>
  for (const [k, key] of Object.entries(map) as [K, TKey][])
    Object.defineProperty(out, k, { get: () => t(key), enumerable: true })
  return out
}

export const BACKUP_STRINGS = {
  get title() { return t('backup.title') },
  get intro() { return t('backup.intro') },
  get notConfigured() { return t('backup.notConfigured') },
  get disabled() { return t('backup.disabled') },
  get notStarted() { return t('backup.notStarted') },
  get runNow() { return t('backup.runNow') },
  get queued() { return t('backup.queued') },
  get running() { return t('backup.running') },
  get queuedHint() { return t('backup.queuedHint') },
  get runFailed() { return t('backup.runFailed') },
  get alertTitle() { return t('backup.alertTitle') },
  alertKind: keyed<string>({
    backup: 'backup.alertBackup',
    scheduled: 'backup.alertScheduled',
    manual: 'backup.alertManual',
    'pre-restore': 'backup.alertPreRestore',
    'restore-test': 'backup.alertRestoreTest',
    remote: 'backup.alertRemote',
    sidecar: 'backup.alertSidecar',
    config: 'backup.alertConfig',
  }),
  get lastSuccess() { return t('backup.lastSuccess') },
  get lastFailure() { return t('backup.lastFailure') },
  get nextRun() { return t('backup.nextRun') },
  get verification() { return t('backup.verification') },
  get restoreTest() { return t('backup.restoreTest') },
  get remote() { return t('backup.remote') },
  get retention() { return t('backup.retention') },
  get encryption() { return t('backup.encryption') },
  get never() { return t('backup.never') },
  none: '—',
  get manualOnly() { return t('backup.manualOnly') },
  get ok() { return t('common.ok') },
  get failed() { return t('common.failed') },
  retentionValue: (d: number, w: number, m: number, count: number) =>
    t('backup.retentionValue', { d, w, m, count }),
  restoreTestEvery: (days: number) =>
    days > 0 ? t('backup.restoreTestEvery', { count: days }) : t('common.off'),
  get encryptionOn() { return t('backup.encryptionOn') },
  get encryptionOff() { return t('common.off') },
  get remoteOff() { return t('backup.remoteOff') },
  get remoteMissingTool() { return t('backup.remoteMissingTool') },
  get settings() { return t('backup.settings') },
  get settingsHint() { return t('backup.settingsHint') },
  setting: keyed({
    schedule: 'backup.settingSchedule',
    timezone: 'backup.settingTimezone',
    restoreTest: 'backup.restoreTest',
    minFree: 'backup.settingMinFree',
    cipher: 'backup.settingCipher',
    remote: 'backup.settingRemote',
  }),
  get sets() { return t('backup.sets') },
  get noSets() { return t('backup.noSets') },
  get download() { return t('backup.download') },
  downloadHint: (encrypted: boolean) =>
    encrypted ? t('backup.downloadHintEncrypted') : t('backup.downloadHintPlain'),
  get encryptedBadge() { return t('backup.encryptedBadge') },
  kind: keyed<string>({
    scheduled: 'backup.kindScheduled',
    manual: 'backup.kindManual',
    'pre-restore': 'backup.kindPreRestore',
  }),
  get migration() { return t('backup.migration') },
  get restoreCli() { return t('backup.restoreCli') },
}
