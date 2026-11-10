/**
 * Admin status summary: facts → levels (docs/adr/1230-*). Pure: no I/O, so every threshold is
 * unit-tested (evaluate.test.ts). The facts are gathered by status/probes.ts.
 *
 * Levels: `ok`, `warn`, `error`, and `off` for "not configured / check disabled / not applicable
 * here" — `off` is shown on the admin cards but never counts as a problem and never raises the
 * banner. Items carry a stable `key` and structured `data` (numbers, ISO times, booleans, short
 * enums); the web client turns them into English or Korean text. No secret values, no file system
 * paths and no URLs other than a github.com release link are ever put in `data`.
 */
import type { BackupAlert, SidecarStatus } from '../backup/store'
import type { LatestRelease } from '../version'
import type { ErrorStats, RestartStats } from './runtime'

export type StatusLevel = 'ok' | 'warn' | 'error' | 'off'
export type StatusGroupId = 'backup' | 'storage' | 'app' | 'security' | 'update'
export type StatusData = Record<string, string | number | boolean | null>

export interface StatusItem {
  key: string
  group: StatusGroupId
  level: StatusLevel
  data: StatusData
}

export interface StatusGroup {
  id: StatusGroupId
  /** Worst level of the items (`off` items do not count; a group of only `off` items is `off`). */
  level: StatusLevel
  /** Key of the worst warn/error item: the group's one-line summary. Null when nothing is wrong. */
  summary: string | null
  items: StatusItem[]
}

export interface DiskFact {
  freeBytes: number
  totalBytes: number
}

export type DbPasswordReason = 'empty' | 'sameAsUser' | 'common' | 'short'

export interface StatusFacts {
  now: number
  isProd: boolean
  backup: {
    configured: boolean
    status: SidecarStatus | null
    alert: BackupAlert | null
    stale: boolean
  }
  disks: { data: DiskFact | null; backups: DiskFact | null; sameDisk: boolean }
  dbBytes: number | null
  uploads: { bytes: number; files: number } | null
  largePages: number | null
  uptimeSec: number
  version: string
  restarts: RestartStats
  errors: ErrorStats
  migrations: { applied: number; expected: number | null; latest: string | null } | null
  security: {
    secretKey: boolean
    /** Stored copies / outside URLs in plaintext (null = count failed). */
    plaintextSecrets: number | null
    /** Sealed values; unreadable when the key is missing. */
    sealedSecrets: number | null
    publicUrl: boolean
    publicUrlHttps: boolean
    cookieSecure: boolean
    signupRequiresKey: boolean
    delegated: boolean
    oidcEnabled: boolean
    /** OIDC_AUTO_CREATE=1 without OIDC_ALLOWED_DOMAINS: any account at the provider can join. */
    oidcOpenAutoCreate: boolean
    dbPasswordWeak: DbPasswordReason | null
    /** Uploads by AI agents (docs/adr/2065-*): server default and limits; warnings = values not taken as written. */
    agentUploads?: { mode: 'on' | 'off' | 'never'; maxBytes: number; dailyBytes: number | null; mcpBodyBytes: number; warnings: number }
  }
  /** Web push (docs/adr/2222-*): counts only, never endpoints. Absent = not gathered. */
  push?: {
    /** WEB_PUSH is not off. */
    enabled: boolean
    /** Why the server cannot push although it is on (VAPID key missing half, invalid or unreadable). */
    problem: string | null
    subscriptions: number
    /** Subscriptions whose last delivery failed. */
    failing: number
    /** Deliveries that gave up in the last 24 h. */
    dead24h: number
    lastFailureAt: string | null
  } | null
  /**
   * Database automations (docs/adr/2240-*, 0.18 integration): counts only. `queued` / `oldestQueuedMin`
   * are the pending rows of outbox topic 'automation'. Absent = not gathered.
   */
  automations?: {
    enabledRules: number
    queued: number
    /** Age of the oldest pending run in minutes (0 when none). */
    oldestQueuedMin: number
    failed24h: number
  } | null
  update: {
    enabled: boolean
    current: string
    latest: LatestRelease | null
    updateAvailable: boolean
    securityFix: boolean | null
  }
}

// ---------------------------------------------------------------------------
// Thresholds (every number is listed in docs/adr/1230-* and docs/OPERATIONS.md)
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const MB = 1024 * 1024

export const THRESHOLDS = {
  /** Web push deliveries that gave up in the last 24 h → warn (docs/adr/2222-*). */
  pushDeadWarn24h: 20,
  /** An automation run waiting this long means the queue is not keeping up → warn (docs/adr/2240-*). */
  automationBacklogWarnMin: 15,
  /** Last successful backup older than 2 × schedule interval + 1 h → warn (one run missed). */
  backupMissedFactor: 2,
  backupSlackMs: HOUR,
  /** … older than 7 days → error (warn for manual-only schedules). No success yet although the
   * sidecar has been up longer than one interval + 1 h → warn. */
  backupErrorMs: 7 * DAY,
  /** Restore test older than 2 × BACKUP_RESTORE_TEST_DAYS → warn. */
  restoreTestFactor: 2,
  /** Free space on the data disk: error below 512 MB or 3 %, warn below 2 × (DB + uploads) or 10 %. */
  diskErrorBytes: 512 * MB,
  diskErrorPct: 3,
  diskWarnPct: 10,
  diskWarnFactor: 2,
  /** Backup disk: error below last set + BACKUP_MIN_FREE_MB (the next run fails), warn below 2 × last set + margin. */
  defaultMinFreeMb: 256,
  /** Restarts: warn at 3 in 24 h (production only) or any unclean exit; error at 3 unclean exits in 24 h (crash loop). */
  restartsWarn: 3,
  uncleanError: 3,
  /** Logged errors (level ≥ 50): warn at 10 in 24 h, error at 50 in the last hour. */
  errorsWarn24h: 10,
  errorsErrorHour: 50,
} as const

const RANK: Record<StatusLevel, number> = { off: 0, ok: 1, warn: 2, error: 3 }
export const worst = (levels: StatusLevel[]): StatusLevel =>
  levels.reduce<StatusLevel>((a, b) => (RANK[b] > RANK[a] ? b : a), 'off')

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null)
const ts = (s?: string | null) => (s ? Date.parse(s) || 0 : 0)
const hours = (ms: number) => Math.round((ms / HOUR) * 10) / 10

/** BACKUP_SCHEDULE → run interval in ms; null for `off` / unknown (manual only). */
export function scheduleIntervalMs(schedule: string | undefined | null): number | null {
  const s = (schedule ?? '').trim().toLowerCase()
  if (s.startsWith('daily@')) return DAY
  if (s.startsWith('hourly@')) return HOUR
  const m = /^every@(\d+)([mh])$/.exec(s)
  if (m) {
    const n = Number(m[1])
    if (n > 0) return n * (m[2] === 'h' ? HOUR : 60 * 1000)
  }
  return null
}

/** Level for "a production setting is missing": warn in production, off elsewhere (dev, tests). */
const prodWarn = (f: StatusFacts, bad: boolean): StatusLevel => (bad ? (f.isProd ? 'warn' : 'off') : 'ok')

// ---------------------------------------------------------------------------
// Database password (judged, never returned)
// ---------------------------------------------------------------------------

// 'nodian': the old project name, the development default up to 0.18 and still on installs that kept it.
const COMMON_PASSWORDS = new Set([
  'nodian', 'inkling', 'postgres', 'postgresql', 'password', 'passw0rd', 'changeme', 'change-me',
  'secret', 'admin', 'root', 'example', 'test', '123456', '12345678', 'qwerty', 'letmein',
])
/** `openssl rand -base64 24` (the documented way) gives 32 characters. */
const MIN_DB_PASSWORD = 12

/**
 * Judges the database password in DATABASE_URL (compose builds it from POSTGRES_PASSWORD) without
 * returning it: only a reason category leaves this function.
 */
export function dbPasswordWeakness(databaseUrl: string): DbPasswordReason | null {
  let user = ''
  let pass = ''
  try {
    const u = new URL(databaseUrl)
    user = decodeURIComponent(u.username)
    pass = decodeURIComponent(u.password)
  } catch {
    return null // not a URL we can read (socket path etc.): no judgement
  }
  if (!pass) return 'empty'
  if (pass.toLowerCase() === user.toLowerCase()) return 'sameAsUser'
  if (COMMON_PASSWORDS.has(pass.toLowerCase())) return 'common'
  if (pass.length < MIN_DB_PASSWORD) return 'short'
  return null
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function backupItems(f: StatusFacts): StatusItem[] {
  const g = 'backup' as const
  const item = (key: string, level: StatusLevel, data: StatusData = {}): StatusItem => ({ key, group: g, level, data })
  const { configured, status: st, alert, stale } = f.backup
  if (!configured) return [item('backup.service', prodWarn(f, true), { state: 'unconfigured' })]
  if (!st) return [item('backup.service', 'warn', { state: 'notStarted' })]
  const cfg = st.config ?? {}
  if (cfg.enabled === false) return [item('backup.service', prodWarn(f, true), { state: 'disabled' })]

  const out: StatusItem[] = []
  out.push(
    item('backup.service', stale ? 'error' : 'ok', {
      state: stale ? 'stale' : st.running ? 'running' : 'idle',
      heartbeatAt: st.heartbeatAt ?? null,
    }),
  )

  // Last run: the sidecar's own alert (currentAlert, docs/adr/0607-*) decides failures; age decides staleness.
  const interval = scheduleIntervalMs(cfg.schedule)
  const lastAt = ts(st.lastSuccess?.at)
  const age = lastAt ? f.now - lastAt : null
  const runAlert = alert && alert.kind !== 'restore-test' && alert.kind !== 'remote' && alert.kind !== 'sidecar'
  let lastLevel: StatusLevel = 'ok'
  let reason: string | null = null
  if (runAlert) {
    lastLevel = 'error'
    reason = 'failed'
  } else if (age === null) {
    const upFor = f.now - ts(st.startedAt)
    const grace = (interval ?? THRESHOLDS.backupErrorMs) + THRESHOLDS.backupSlackMs
    if (ts(st.startedAt) && upFor > grace) {
      lastLevel = 'warn'
      reason = 'never'
    }
  } else if (interval === null) {
    // manual-only schedule (BACKUP_SCHEDULE=off): a reminder, not a failure
    if (age > THRESHOLDS.backupErrorMs) {
      lastLevel = 'warn'
      reason = 'old'
    }
  } else if (age > THRESHOLDS.backupErrorMs) {
    lastLevel = 'error'
    reason = 'old'
  } else if (age > THRESHOLDS.backupMissedFactor * interval + THRESHOLDS.backupSlackMs) {
    lastLevel = 'warn'
    reason = 'missed'
  }
  out.push(
    item('backup.lastRun', lastLevel, {
      at: st.lastSuccess?.at ?? null,
      ageHours: age === null ? null : hours(age),
      sizeBytes: st.lastSuccess?.sizeBytes ?? null,
      failedAt: runAlert ? alert!.at : null,
      reason,
    }),
  )

  const v = st.lastVerify
  out.push(
    item('backup.verify', !v ? 'off' : v.ok === false && ts(v.at) >= lastAt ? 'error' : 'ok', {
      at: v?.at ?? null,
      ok: v ? v.ok !== false : null,
    }),
  )

  const days = typeof cfg.restoreTestDays === 'number' ? cfg.restoreTestDays : 7
  const rt = st.lastRestoreTest
  let rtLevel: StatusLevel = 'ok'
  let rtReason: string | null = null
  if (days <= 0) rtLevel = 'off'
  else if (alert?.kind === 'restore-test' || rt?.ok === false) {
    rtLevel = 'error'
    rtReason = 'failed'
  } else {
    const limit = THRESHOLDS.restoreTestFactor * days * DAY
    const rtAt = ts(rt?.at)
    if (rtAt && f.now - rtAt > limit) {
      rtLevel = 'warn'
      rtReason = 'old'
    } else if (!rtAt && lastAt && f.now - ts(st.startedAt) > limit) {
      rtLevel = 'warn'
      rtReason = 'never'
    }
  }
  out.push(item('backup.restoreTest', rtLevel, { at: rt?.at ?? null, everyDays: days, reason: rtReason }))

  out.push(item('backup.next', st.nextRunAt ? 'ok' : 'off', { at: st.nextRunAt ?? null, schedule: cfg.schedule ?? null }))

  const remoteOn = !!cfg.remote
  out.push(
    item(
      'backup.remote',
      !remoteOn ? 'off' : alert?.kind === 'remote' || st.remote?.ok === false ? 'error' : 'ok',
      { configured: remoteOn, at: st.remote?.at ?? null },
    ),
  )
  // Encryption: only the fact that BACKUP_PASSPHRASE is set (status.json config.encrypted).
  // Unencrypted sets copied off-site are a warning (docs/BACKUP.md "Use BACKUP_PASSPHRASE when the
  // remote is not under your control"); unencrypted local sets are the operator's choice.
  const encrypted = cfg.encrypted === true
  out.push(item('backup.encryption', encrypted ? 'ok' : remoteOn ? 'warn' : 'off', { encrypted, remote: remoteOn }))
  return out
}

function diskLevel(d: DiskFact, needBytes: number, errorBytes: number): StatusLevel {
  const pct = d.totalBytes > 0 ? (d.freeBytes / d.totalBytes) * 100 : 100
  if (d.freeBytes < errorBytes || pct < THRESHOLDS.diskErrorPct) return 'error'
  if (d.freeBytes < needBytes || pct < THRESHOLDS.diskWarnPct) return 'warn'
  return 'ok'
}

const diskData = (d: DiskFact): StatusData => ({
  freeBytes: d.freeBytes,
  totalBytes: d.totalBytes,
  freePct: d.totalBytes > 0 ? Math.round((d.freeBytes / d.totalBytes) * 1000) / 10 : null,
})

function storageItems(f: StatusFacts): StatusItem[] {
  const g = 'storage' as const
  const out: StatusItem[] = []
  const used = (f.dbBytes ?? 0) + (f.uploads?.bytes ?? 0)
  if (f.disks.data) {
    const need = THRESHOLDS.diskWarnFactor * used
    out.push({ key: 'storage.dataDisk', group: g, level: diskLevel(f.disks.data, need, THRESHOLDS.diskErrorBytes), data: diskData(f.disks.data) })
  } else {
    out.push({ key: 'storage.dataDisk', group: g, level: 'off', data: {} })
  }
  if (f.backup.configured && f.disks.backups) {
    const st = f.backup.status
    const minFree = (st?.config?.minFreeMb ?? THRESHOLDS.defaultMinFreeMb) * MB
    // The next set is about as big as the last one (or DB + uploads before the first set).
    const setBytes = st?.lastSuccess?.sizeBytes ?? used
    out.push({
      key: 'storage.backupDisk',
      group: g,
      level: diskLevel(f.disks.backups, 2 * setBytes + minFree, setBytes + minFree),
      data: { ...diskData(f.disks.backups), sameDisk: f.disks.sameDisk },
    })
  }
  out.push({ key: 'storage.database', group: g, level: f.dbBytes === null ? 'off' : 'ok', data: { bytes: f.dbBytes } })
  out.push({
    key: 'storage.uploads',
    group: g,
    level: f.uploads ? 'ok' : 'off',
    data: { bytes: f.uploads?.bytes ?? null, files: f.uploads?.files ?? null },
  })
  // Large pages (docs/adr/1103-*): a fact with a pointer to workspace settings, never a warning —
  // it is how people write, not a server fault.
  out.push({ key: 'storage.largePages', group: g, level: f.largePages === null ? 'off' : 'ok', data: { count: f.largePages } })
  return out
}

function appItems(f: StatusFacts): StatusItem[] {
  const g = 'app' as const
  const out: StatusItem[] = []
  out.push({
    key: 'app.uptime',
    group: g,
    level: 'ok',
    data: { seconds: Math.round(f.uptimeSec), startedAt: iso(f.now - f.uptimeSec * 1000), version: f.version },
  })
  const r = f.restarts
  let rl: StatusLevel = 'ok'
  if (!r.available) rl = 'off'
  else if (r.unclean24h >= THRESHOLDS.uncleanError) rl = 'error'
  else if (r.unclean24h > 0) rl = 'warn'
  // clean restarts are deploys (or `pnpm dev` reloads): a warning only on a production server
  else rl = prodWarn(f, r.restarts24h >= THRESHOLDS.restartsWarn)
  out.push({
    key: 'app.restarts',
    group: g,
    level: rl,
    data: { restarts: r.restarts24h, unclean: r.unclean24h, lastUncleanAt: r.lastUncleanAt },
  })
  const e = f.errors
  const el: StatusLevel =
    e.lastHour >= THRESHOLDS.errorsErrorHour ? 'error' : e.last24h >= THRESHOLDS.errorsWarn24h ? 'warn' : 'ok'
  out.push({ key: 'app.errors', group: g, level: el, data: { last24h: e.last24h, lastHour: e.lastHour, lastAt: e.lastAt } })
  const m = f.migrations
  let ml: StatusLevel = 'ok'
  let mstate = 'current'
  if (!m || m.expected === null) {
    ml = 'off'
    mstate = 'unknown'
  } else if (m.applied > m.expected) {
    ml = 'error'
    mstate = 'dbNewer'
  } else if (m.applied < m.expected) {
    ml = 'error'
    mstate = 'pending'
  }
  out.push({
    key: 'app.migrations',
    group: g,
    level: ml,
    data: { state: mstate, applied: m?.applied ?? null, expected: m?.expected ?? null, latest: m?.latest ?? null },
  })
  const p = f.push
  if (p) {
    const state = !p.enabled ? 'off' : p.problem ? 'problem' : 'ok'
    const pl: StatusLevel = state === 'off' ? 'off' : state === 'problem' || p.dead24h >= THRESHOLDS.pushDeadWarn24h ? 'warn' : 'ok'
    out.push({
      key: 'app.push',
      group: g,
      level: pl,
      data: { state, problem: p.problem, subscriptions: p.subscriptions, failing: p.failing, dead24h: p.dead24h, lastFailureAt: p.lastFailureAt },
    })
  }
  const a = f.automations
  if (a) {
    const backlog = a.queued > 0 && a.oldestQueuedMin >= THRESHOLDS.automationBacklogWarnMin
    const state = backlog ? 'backlog' : a.enabledRules === 0 && a.queued === 0 ? 'off' : 'ok'
    out.push({
      key: 'app.automations',
      group: g,
      level: backlog ? 'warn' : state === 'off' ? 'off' : 'ok',
      data: { state, rules: a.enabledRules, queued: a.queued, oldestQueuedMin: a.oldestQueuedMin, failed24h: a.failed24h },
    })
  }
  return out
}

function securityItems(f: StatusFacts): StatusItem[] {
  const g = 'security' as const
  const s = f.security
  const out: StatusItem[] = []
  out.push({ key: 'security.mode', group: g, level: f.isProd ? 'ok' : 'off', data: { production: f.isProd } })
  // APP_SECRET_KEY: missing → warn in production; sealed values without the key are unusable → error.
  const unreadable = !s.secretKey ? (s.sealedSecrets ?? 0) : 0
  out.push({
    key: 'security.secretKey',
    group: g,
    level: unreadable > 0 ? 'error' : prodWarn(f, !s.secretKey),
    data: { set: s.secretKey, plaintext: s.secretKey ? 0 : s.plaintextSecrets, unreadable },
  })
  out.push({ key: 'security.publicUrl', group: g, level: prodWarn(f, !s.publicUrl), data: { set: s.publicUrl, https: s.publicUrlHttps } })
  out.push({ key: 'security.cookies', group: g, level: prodWarn(f, !s.cookieSecure), data: { secure: s.cookieSecure } })
  const policy = s.delegated ? 'delegated' : s.signupRequiresKey ? 'key' : 'open'
  out.push({
    key: 'security.signup',
    group: g,
    level: prodWarn(f, policy === 'open' || s.oidcOpenAutoCreate),
    data: { policy, oidcOpenAutoCreate: s.oidcOpenAutoCreate },
  })
  out.push({
    key: 'security.dbPassword',
    group: g,
    level: prodWarn(f, s.dbPasswordWeak !== null),
    data: { weak: s.dbPasswordWeak !== null, reason: s.dbPasswordWeak },
  })
  if (s.agentUploads) {
    const a = s.agentUploads
    out.push({
      key: 'security.agentUploads',
      group: g,
      level: a.warnings > 0 ? 'warn' : a.mode === 'on' ? 'ok' : 'off',
      data: {
        mode: a.mode,
        maxMb: Math.round((a.maxBytes / 1048576) * 10) / 10,
        // null = no daily budget (AGENT_UPLOAD_DAILY_MB=0)
        dailyMb: a.dailyBytes === null ? null : Math.round((a.dailyBytes / 1048576) * 10) / 10,
        mcpBodyMb: Math.round((a.mcpBodyBytes / 1048576) * 10) / 10,
        warnings: a.warnings,
      },
    })
  }
  return out
}

function updateItems(f: StatusFacts): StatusItem[] {
  const u = f.update
  if (!u.enabled) return [{ key: 'update.check', group: 'update', level: 'off', data: { enabled: false, current: u.current } }]
  const level: StatusLevel = !u.updateAvailable ? (u.latest ? 'ok' : 'off') : u.securityFix ? 'error' : 'warn'
  return [
    {
      key: 'update.check',
      group: 'update',
      level,
      data: {
        enabled: true,
        current: u.current,
        latest: u.latest?.version ?? null,
        url: u.latest?.url || null,
        available: u.updateAvailable,
        securityFix: u.updateAvailable ? u.securityFix : false,
        failed: !u.latest,
      },
    },
  ]
}

export interface StatusSummary {
  level: Exclude<StatusLevel, 'off'>
  groups: StatusGroup[]
  /** warn/error items, errors first (the banner's content). */
  issues: StatusItem[]
}

export function evaluateStatus(f: StatusFacts): StatusSummary {
  const lists: [StatusGroupId, StatusItem[]][] = [
    ['backup', backupItems(f)],
    ['storage', storageItems(f)],
    ['app', appItems(f)],
    ['security', securityItems(f)],
    ['update', updateItems(f)],
  ]
  const groups: StatusGroup[] = lists.map(([id, items]) => {
    const level = worst(items.map((i) => i.level))
    const bad = items.filter((i) => i.level === 'warn' || i.level === 'error').sort((a, b) => RANK[b.level] - RANK[a.level])
    return { id, level, summary: bad[0]?.key ?? null, items }
  })
  const issues = groups
    .flatMap((g) => g.items)
    .filter((i) => i.level === 'warn' || i.level === 'error')
    .sort((a, b) => RANK[b.level] - RANK[a.level])
  const top = worst(groups.map((g) => g.level))
  return { level: top === 'off' ? 'ok' : top, groups, issues }
}
