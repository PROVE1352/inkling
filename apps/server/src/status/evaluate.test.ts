// Admin status summary (docs/adr/1230-*, 1231-*): thresholds of the pure evaluator, the boot log
// and the error counter. No database, no network.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { dbPasswordWeakness, evaluateStatus, scheduleIntervalMs, type StatusFacts } from './evaluate'
import {
  _resetRuntimeStats,
  addBoot,
  errorStats,
  noteLoggedError,
  recordBoot,
  recordExit,
  restartStats,
  restartStatsOf,
} from './runtime'

const H = 60 * 60 * 1000
const D = 24 * H
const GB = 1024 ** 3
const NOW = Date.parse('2026-11-08T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/** A healthy production server; tests change one thing at a time. */
function healthy(): StatusFacts {
  return {
    now: NOW,
    isProd: true,
    backup: {
      configured: true,
      alert: null,
      stale: false,
      status: {
        startedAt: ago(30 * D),
        heartbeatAt: ago(30 * 1000),
        nextRunAt: new Date(NOW + 15 * H).toISOString(),
        lastSuccess: { at: ago(9 * H), sizeBytes: 50 * 1024 * 1024 },
        lastVerify: { at: ago(9 * H), ok: true },
        lastRestoreTest: { at: ago(2 * D), ok: true },
        config: { enabled: true, schedule: 'daily@03:00', restoreTestDays: 7, minFreeMb: 256, encrypted: true, remote: 'b2:x/y' },
        remote: { at: ago(9 * H), ok: true },
      },
    },
    disks: { data: { freeBytes: 40 * GB, totalBytes: 100 * GB }, backups: { freeBytes: 40 * GB, totalBytes: 100 * GB }, sameDisk: true },
    dbBytes: 200 * 1024 * 1024,
    uploads: { bytes: GB, files: 1200 },
    largePages: 2,
    uptimeSec: 3 * 3600,
    version: '0.7.0',
    restarts: { available: true, restarts24h: 1, unclean24h: 0, lastUncleanAt: null },
    errors: { sinceBoot: 0, last24h: 0, lastHour: 0, lastAt: null },
    migrations: { applied: 38, expected: 38, latest: '0037_v070' },
    security: {
      secretKey: true,
      plaintextSecrets: 0,
      sealedSecrets: 12,
      publicUrl: true,
      publicUrlHttps: true,
      cookieSecure: true,
      signupRequiresKey: true,
      delegated: false,
      oidcEnabled: false,
      oidcOpenAutoCreate: false,
      dbPasswordWeak: null,
    },
    update: { enabled: false, current: '0.7.0', latest: null, updateAvailable: false, securityFix: null },
  }
}

const item = (f: StatusFacts, key: string) => {
  const it = evaluateStatus(f).groups.flatMap((g) => g.items).find((i) => i.key === key)
  assert.ok(it, key)
  return it
}

describe('admin status: evaluator', () => {
  it('a healthy server is ok with no issues; off items do not count', () => {
    const s = evaluateStatus(healthy())
    assert.equal(s.level, 'ok')
    assert.deepEqual(s.issues, [])
    assert.equal(item(healthy(), 'update.check').level, 'off')
    assert.ok(s.groups.every((g) => g.summary === null))
  })

  it('backup age: warn after one missed run, error after 7 days, manual schedule only reminds', () => {
    const f = healthy()
    f.backup.status!.lastSuccess = { at: ago(48 * H) }
    assert.equal(item(f, 'backup.lastRun').level, 'ok')
    f.backup.status!.lastSuccess = { at: ago(50 * H) }
    assert.equal(item(f, 'backup.lastRun').level, 'warn')
    assert.equal(item(f, 'backup.lastRun').data.reason, 'missed')
    f.backup.status!.lastSuccess = { at: ago(8 * D) }
    assert.equal(item(f, 'backup.lastRun').level, 'error')
    f.backup.status!.config!.schedule = 'off'
    assert.equal(item(f, 'backup.lastRun').level, 'warn')
    f.backup.status!.lastSuccess = { at: ago(6 * D) }
    assert.equal(item(f, 'backup.lastRun').level, 'ok')
    assert.equal(scheduleIntervalMs('every@30m'), 30 * 60 * 1000)
    assert.equal(scheduleIntervalMs('hourly@05'), H)
    assert.equal(scheduleIntervalMs('off'), null)
  })

  it('backup failures come from the sidecar alert and land on the right item', () => {
    const f = healthy()
    f.backup.alert = { kind: 'scheduled', message: 'x', at: ago(H) }
    assert.equal(item(f, 'backup.lastRun').level, 'error')
    const g = healthy()
    g.backup.alert = { kind: 'restore-test', message: 'x', at: ago(H) }
    assert.equal(item(g, 'backup.restoreTest').level, 'error')
    assert.equal(item(g, 'backup.lastRun').level, 'ok')
    const r = healthy()
    r.backup.alert = { kind: 'remote', message: 'x', at: ago(H) }
    assert.equal(item(r, 'backup.remote').level, 'error')
    const s = healthy()
    s.backup.stale = true
    assert.equal(item(s, 'backup.service').level, 'error')
    assert.equal(evaluateStatus(s).level, 'error')
  })

  it('restore test: off at 0 days, warn when older than twice the interval', () => {
    const f = healthy()
    f.backup.status!.config!.restoreTestDays = 0
    assert.equal(item(f, 'backup.restoreTest').level, 'off')
    const g = healthy()
    g.backup.status!.lastRestoreTest = { at: ago(15 * D), ok: true }
    assert.equal(item(g, 'backup.restoreTest').level, 'warn')
  })

  it('encryption: off locally is a choice, unencrypted off-site copies warn', () => {
    const f = healthy()
    f.backup.status!.config!.encrypted = false
    assert.equal(item(f, 'backup.encryption').level, 'warn')
    f.backup.status!.config!.remote = ''
    assert.equal(item(f, 'backup.encryption').level, 'off')
    assert.equal(item(f, 'backup.remote').level, 'off')
  })

  it('no sidecar: warn in production, off in development', () => {
    const f = healthy()
    f.backup = { configured: false, status: null, alert: null, stale: false }
    assert.equal(item(f, 'backup.service').level, 'warn')
    f.isProd = false
    assert.equal(item(f, 'backup.service').level, 'off')
  })

  it('disk thresholds', () => {
    const f = healthy()
    f.disks.data = { freeBytes: 2 * GB, totalBytes: 10 * GB } // 20 %, need 2 × 1.2 GB = 2.4 GB → warn
    assert.equal(item(f, 'storage.dataDisk').level, 'warn')
    f.disks.data = { freeBytes: 400 * 1024 * 1024, totalBytes: 100 * GB }
    assert.equal(item(f, 'storage.dataDisk').level, 'error')
    f.disks.data = { freeBytes: 5 * GB, totalBytes: 200 * GB } // 2.5 %
    assert.equal(item(f, 'storage.dataDisk').level, 'error')
    const g = healthy()
    g.disks.backups = { freeBytes: 200 * 1024 * 1024, totalBytes: 100 * GB } // < 50 MB set + 256 MB
    assert.equal(item(g, 'storage.backupDisk').level, 'error')
    g.disks.backups = { freeBytes: 330 * 1024 * 1024, totalBytes: 1 * GB } // < 2 × 50 + 256
    assert.equal(item(g, 'storage.backupDisk').level, 'warn')
  })

  it('restarts and logged errors', () => {
    const f = healthy()
    f.restarts = { available: true, restarts24h: 3, unclean24h: 0, lastUncleanAt: null }
    assert.equal(item(f, 'app.restarts').level, 'warn')
    assert.equal(item({ ...f, isProd: false }, 'app.restarts').level, 'off') // dev reloads
    f.restarts = { available: true, restarts24h: 2, unclean24h: 0, lastUncleanAt: null }
    assert.equal(item(f, 'app.restarts').level, 'ok')
    f.restarts = { available: true, restarts24h: 1, unclean24h: 1, lastUncleanAt: ago(H) }
    assert.equal(item(f, 'app.restarts').level, 'warn')
    f.restarts = { available: true, restarts24h: 3, unclean24h: 3, lastUncleanAt: ago(H) }
    assert.equal(item(f, 'app.restarts').level, 'error')
    f.restarts = { available: false, restarts24h: 0, unclean24h: 0, lastUncleanAt: null }
    assert.equal(item(f, 'app.restarts').level, 'off')
    f.errors = { sinceBoot: 9, last24h: 9, lastHour: 9, lastAt: ago(1000) }
    assert.equal(item(f, 'app.errors').level, 'ok')
    f.errors = { sinceBoot: 10, last24h: 10, lastHour: 0, lastAt: ago(2 * H) }
    assert.equal(item(f, 'app.errors').level, 'warn')
    f.errors = { sinceBoot: 50, last24h: 50, lastHour: 50, lastAt: ago(1000) }
    assert.equal(item(f, 'app.errors').level, 'error')
  })

  it('migrations', () => {
    const f = healthy()
    f.migrations = { applied: 39, expected: 38, latest: 'x' }
    assert.equal(item(f, 'app.migrations').data.state, 'dbNewer')
    assert.equal(item(f, 'app.migrations').level, 'error')
    f.migrations = null
    assert.equal(item(f, 'app.migrations').level, 'off')
  })

  it('security settings warn in production only; unreadable sealed values are an error everywhere', () => {
    const f = healthy()
    f.security = { ...f.security, secretKey: false, plaintextSecrets: 4, publicUrl: false, publicUrlHttps: false, cookieSecure: false, signupRequiresKey: false, dbPasswordWeak: 'common', sealedSecrets: 0 }
    const keys = evaluateStatus(f).issues.map((i) => i.key).sort()
    assert.deepEqual(keys, ['security.cookies', 'security.dbPassword', 'security.publicUrl', 'security.secretKey', 'security.signup'])
    assert.equal(item(f, 'security.secretKey').data.plaintext, 4)
    f.isProd = false
    assert.deepEqual(evaluateStatus(f).issues, [])
    f.security.sealedSecrets = 3
    assert.equal(item(f, 'security.secretKey').level, 'error')
    const o = healthy()
    o.security.oidcOpenAutoCreate = true
    assert.equal(item(o, 'security.signup').level, 'warn')
  })

  it('update: off unless enabled; a security fix in a newer release is an error', () => {
    const f = healthy()
    f.update = { enabled: true, current: '0.7.0', latest: { version: '0.7.0', url: '' }, updateAvailable: false, securityFix: null }
    assert.equal(item(f, 'update.check').level, 'ok')
    f.update = { enabled: true, current: '0.7.0', latest: { version: '0.8.0', url: 'https://github.com/o/r/releases/tag/v0.8.0' }, updateAvailable: true, securityFix: false }
    assert.equal(item(f, 'update.check').level, 'warn')
    f.update.securityFix = true
    assert.equal(item(f, 'update.check').level, 'error')
    f.update = { enabled: true, current: '0.7.0', latest: null, updateAvailable: false, securityFix: null }
    assert.equal(item(f, 'update.check').level, 'off')
    assert.equal(item(f, 'update.check').data.failed, true)
  })

  it('never puts secret values, paths or the database URL in the output', () => {
    const f = healthy()
    f.security.dbPasswordWeak = 'short'
    const json = JSON.stringify(evaluateStatus(f))
    for (const bad of ['b2:x/y', '/backups', '/data', 'postgres://']) assert.ok(!json.includes(bad), bad)
  })

  it('database password judged without returning it', () => {
    assert.equal(dbPasswordWeakness('postgres://nodian:nodian@db:5432/nodian'), 'sameAsUser')
    assert.equal(dbPasswordWeakness('postgres://app:changeme@db/x'), 'common')
    assert.equal(dbPasswordWeakness('postgres://app:Abc123@db/x'), 'short')
    assert.equal(dbPasswordWeakness('postgres://app@db/x'), 'empty')
    assert.equal(dbPasswordWeakness('postgres://app:q8%2FZr4kP0vW2mXy7Lb9s@db/x'), null)
    assert.equal(dbPasswordWeakness('not a url'), null)
  })
})

describe('admin status: boot log and error counter', () => {
  it('records how the previous process ended', () => {
    let log = addBoot({ boots: [] }, new Date(NOW - 5 * H))
    assert.equal(log.boots[0].prev, 'first')
    log = addBoot(log, new Date(NOW - 4 * H)) // no exit record: killed
    assert.equal(log.boots[1].prev, 'unknown')
    log = addBoot({ ...log, exit: { at: ago(3 * H + 1000), code: 0 } }, new Date(NOW - 3 * H))
    assert.equal(log.boots[2].prev, 'clean')
    log = addBoot({ ...log, exit: { at: ago(2 * H + 1000), code: 1 } }, new Date(NOW - 2 * H))
    assert.equal(log.boots[3].prev, 'error')
    const s = restartStatsOf(log, NOW)
    assert.deepEqual(s, { available: true, restarts24h: 3, unclean24h: 2, lastUncleanAt: ago(2 * H) })
    assert.equal(restartStatsOf(log, NOW + 2 * D).restarts24h, 0)
  })

  it('writes the file, survives a corrupt one, and keeps at most 50 boots', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inkling-boots-'))
    const file = path.join(dir, 'status', 'boots.json')
    try {
      _resetRuntimeStats()
      assert.equal(restartStats(NOW, file).available, false)
      recordBoot(file, new Date(NOW - 2 * H))
      recordExit(0, file, new Date(NOW - H - 1000))
      recordBoot(file, new Date(NOW - H))
      assert.deepEqual(restartStats(NOW, file), { available: true, restarts24h: 1, unclean24h: 0, lastUncleanAt: null })
      writeFileSync(file, '{oops')
      recordBoot(file, new Date(NOW))
      assert.equal(restartStats(NOW, file).restarts24h, 0) // a fresh log: this boot is the first
      for (let i = 0; i < 60; i++) recordBoot(file, new Date(NOW + i))
      assert.equal(restartStats(NOW + 100, file).restarts24h, 50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      _resetRuntimeStats()
    }
  })

  it('counts logged errors in windows', () => {
    _resetRuntimeStats()
    noteLoggedError(NOW - 2 * D)
    noteLoggedError(NOW - 3 * H)
    noteLoggedError(NOW - 1000)
    const e = errorStats(NOW)
    assert.equal(e.sinceBoot, 3)
    assert.equal(e.last24h, 2)
    assert.equal(e.lastHour, 1)
    assert.equal(e.lastAt, ago(1000))
    _resetRuntimeStats()
  })
})
