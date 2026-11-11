import { fmtDateTime, t, type TKey, type TParams } from '../i18n'
import type { StatusGroupId, StatusItem } from './api'

// Status item → text in the current language (i18n/<locale>/admin-status.ts). The server sends
// stable keys and structured data only (docs/adr/1230-*); every sentence is built here.

const tk = (key: string, params?: TParams) => t(key as TKey, params)

export function fmtBytes(n: unknown): string {
  const v = typeof n === 'number' ? n : 0
  if (v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)))
  return `${(v / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const time = (v: unknown) => (typeof v === 'string' && v ? fmtDateTime(v) : '—')
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

export function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m < 60) return tk('adminStatus.duration.minutes', { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return tk('adminStatus.duration.hours', { hours: h, minutes: m % 60 })
  return tk('adminStatus.duration.days', { days: Math.floor(h / 24), hours: h % 24 })
}

export const groupTitle = (id: StatusGroupId) => tk(`adminStatus.group.${id}`)
export const itemLabel = (it: StatusItem) => tk(`adminStatus.${it.key}`)

/** The value column of one item: what is true now, in one short line. */
export function itemValue(it: StatusItem): string {
  const d = it.data
  const k = `adminStatus.${it.key}`
  switch (it.key) {
    case 'backup.service':
      return tk(`${k}.${String(d.state)}`, { time: time(d.heartbeatAt) })
    case 'backup.lastRun': {
      if (d.reason === 'failed') return tk(`${k}.failed`, { time: time(d.failedAt) })
      if (d.reason === 'never') return tk(`${k}.never`)
      if (!d.at) return tk(`${k}.none`)
      if (d.reason === 'missed') return tk(`${k}.missed`, { hours: Math.round(num(d.ageHours)) })
      if (d.reason === 'old') return tk(`${k}.old`, { days: Math.floor(num(d.ageHours) / 24) })
      return tk(`${k}.ok`, { time: time(d.at), size: fmtBytes(d.sizeBytes) })
    }
    case 'backup.verify':
      return it.level === 'off' ? tk(`${k}.off`) : tk(d.ok === false ? `${k}.failed` : `${k}.ok`, { time: time(d.at) })
    case 'backup.restoreTest': {
      const p = { time: time(d.at), days: num(d.everyDays) }
      if (it.level === 'off') return tk(`${k}.off`)
      if (d.reason) return tk(`${k}.${String(d.reason)}`, p)
      return tk(d.at ? `${k}.ok` : `${k}.pending`, p)
    }
    case 'backup.next':
      return it.level === 'off' ? tk(`${k}.off`) : tk(`${k}.ok`, { time: time(d.at) })
    case 'backup.remote':
      return tk(`${k}.${it.level === 'error' ? 'error' : it.level === 'off' ? 'off' : 'ok'}`, { time: time(d.at) })
    case 'backup.encryption':
      return tk(`${k}.${it.level === 'ok' ? 'ok' : it.level === 'warn' ? 'warn' : 'off'}`)
    case 'storage.dataDisk':
    case 'storage.backupDisk':
      if (it.level === 'off') return tk('adminStatus.storage.disk.off')
      return tk(d.sameDisk ? 'adminStatus.storage.disk.same' : 'adminStatus.storage.disk.ok', {
        free: fmtBytes(d.freeBytes),
        total: fmtBytes(d.totalBytes),
        pct: d.freePct === null ? '—' : String(d.freePct),
      })
    case 'storage.database':
      return it.level === 'off' ? tk('adminStatus.storage.off') : tk(`${k}.ok`, { size: fmtBytes(d.bytes) })
    case 'storage.uploads':
      return it.level === 'off' ? tk('adminStatus.storage.off') : tk(`${k}.ok`, { size: fmtBytes(d.bytes), count: num(d.files) })
    case 'storage.largePages':
      return it.level === 'off' ? tk('adminStatus.storage.off') : tk(`${k}.ok`, { count: num(d.count) })
    case 'app.uptime':
      return tk(`${k}.ok`, { duration: fmtDuration(num(d.seconds)), version: String(d.version ?? '') })
    case 'app.restarts':
      if (it.level === 'off') return tk(`${k}.off`)
      return num(d.unclean) > 0
        ? tk(`${k}.unclean`, { count: num(d.restarts), unclean: num(d.unclean), time: time(d.lastUncleanAt) })
        : tk(`${k}.ok`, { count: num(d.restarts) })
    case 'app.errors':
      return tk(`${k}.ok`, { count: num(d.last24h), hour: num(d.lastHour) })
    case 'app.migrations':
      return tk(`${k}.${String(d.state)}`, {
        count: d.state === 'pending' ? num(d.expected) - num(d.applied) : num(d.applied),
        applied: num(d.applied),
        expected: num(d.expected),
      })
    case 'app.push':
      // web push (docs/adr/2222-*): subscriptions and deliveries that gave up, counts only
      return tk(`${k}.${String(d.state)}`, { count: num(d.subscriptions), failing: num(d.failing), dead: num(d.dead24h), problem: String(d.problem ?? '') })
    case 'app.automations':
      // database automations (docs/adr/2240-*): enabled rules, queued runs, failures in 24 h
      return tk(`${k}.${String(d.state)}`, { rules: num(d.rules), queued: num(d.queued), failed: num(d.failed24h), minutes: num(d.oldestQueuedMin) })
    case 'security.mode':
      return tk(`${k}.${it.level === 'off' ? 'off' : 'ok'}`)
    case 'security.secretKey':
      if (d.set) return tk(`${k}.ok`)
      if (num(d.unreadable) > 0) return tk(`${k}.unreadable`, { count: num(d.unreadable) })
      if (num(d.plaintext) > 0) return tk(`${k}.plaintext`, { count: num(d.plaintext) })
      return tk(`${k}.missing`)
    case 'security.publicUrl':
      return tk(`${k}.${!d.set ? 'missing' : d.https ? 'https' : 'http'}`)
    case 'security.cookies':
      return tk(`${k}.${d.secure ? 'ok' : 'missing'}`)
    case 'security.signup':
      if (d.policy === 'open') return tk(`${k}.open`)
      if (d.oidcOpenAutoCreate) return tk(`${k}.oidcOpen`)
      return tk(`${k}.${String(d.policy)}`)
    case 'security.dbPassword':
      return tk(`${k}.${d.weak ? String(d.reason) : 'ok'}`)
    case 'security.agentUploads': {
      // the values in use, always; a value that was cut or ignored adds a warning (docs/adr/2065-*)
      const parts = [
        d.mode === 'never'
          ? tk(`${k}.never`)
          : tk(`${k}.${String(d.mode)}${d.dailyMb === null ? 'NoBudget' : ''}`, { max: num(d.maxMb), daily: num(d.dailyMb) }),
      ]
      if (d.mode !== 'never' && num(d.mcpBodyMb) > 12) parts.push(tk(`${k}.mcpBody`, { mb: num(d.mcpBodyMb) }))
      if (num(d.warnings) > 0) parts.push(tk(`${k}.invalid`))
      return parts.join(' · ')
    }
    case 'security.signupCap':
      // open sign-up (restricted mode, docs/adr/2500-*): the account cap, or none
      return d.max === null || d.max === undefined ? tk(`${k}.none`) : tk(`${k}.set`, { max: num(d.max) })
    case 'security.accountLifetime':
      if (d.days === null || d.days === undefined) return tk(`${k}.dryRunOnly`)
      return tk(d.dryRun ? `${k}.dryRun` : `${k}.on`, { days: num(d.days) })
    case 'update.check': {
      const p = { current: String(d.current ?? ''), latest: String(d.latest ?? '') }
      if (!d.enabled) return tk(`${k}.disabled`, p)
      if (d.failed) return tk(`${k}.failed`, p)
      if (!d.available) return tk(`${k}.current`, p)
      return tk(d.securityFix ? `${k}.security` : `${k}.available`, p)
    }
    default:
      return ''
  }
}

/** One line for a problem: "Label: value". */
export const problemText = (it: StatusItem) => `${itemLabel(it)}: ${itemValue(it)}`
