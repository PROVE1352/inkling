/**
 * Read side of the backup sidecar (deploy/backup/*.sh). The app never runs pg_dump itself; it
 * talks to the sidecar through two shared directories (docs/adr/0605-*):
 *
 *   BACKUP_DIR (default /backups, mounted read-only)   status.json + sets/<id>/manifest.json
 *   BACKUP_CTL_DIR (default /backup-ctl, read-write)   run.request (trigger), app-info.json
 *
 * When BACKUP_DIR does not exist (dev, or the sidecar is not deployed) everything reports
 * "unconfigured" instead of failing.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env'
import pkg from '../../package.json' with { type: 'json' }

export const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR?.trim() || '/backups')
export const BACKUP_CTL_DIR = path.resolve(process.env.BACKUP_CTL_DIR?.trim() || '/backup-ctl')
export const SETS_DIR = path.join(BACKUP_DIR, 'sets')
export const TRIGGER_FILE = path.join(BACKUP_CTL_DIR, 'run.request')
const PROCESSING_FILE = path.join(BACKUP_CTL_DIR, 'run.processing')

/** Set ids are UTC timestamps (YYYYMMDD-HHMMSS) — the only thing ever joined into a path. */
export const SET_ID_RE = /^\d{8}-\d{6}$/

/** The sidecar writes a heartbeat every 60 s; older than this means it is not running. */
const STALE_MS = 10 * 60 * 1000
/** Upper bound on manifests read per request (GFS defaults keep ~17 sets). */
const MAX_SETS = 500

export interface BackupRunInfo {
  at: string
  setId?: string
  kind?: string
  message?: string
  ok?: boolean
  sizeBytes?: number
  durationSec?: number
  tables?: number
  rows?: number
  setCount?: number
}

/** status.json as written by the sidecar (all fields optional — it is merged incrementally). */
export interface SidecarStatus {
  startedAt?: string
  stoppedAt?: string | null
  heartbeatAt?: string
  nextRunAt?: string | null
  running?: { kind: string; startedAt: string; setId: string; pid: number } | null
  lastSuccess?: BackupRunInfo
  lastFailure?: BackupRunInfo
  lastVerify?: BackupRunInfo
  lastRestoreTest?: BackupRunInfo
  lastRestore?: BackupRunInfo
  remote?: BackupRunInfo
  setCount?: number
  config?: {
    enabled?: boolean
    schedule?: string
    timezone?: string
    keepDaily?: number
    keepWeekly?: number
    keepMonthly?: number
    restoreTestDays?: number
    minFreeMb?: number
    encrypted?: boolean
    cipher?: string
    remote?: string
    remoteTool?: string
  }
}

export interface BackupSetSummary {
  id: string
  kind: string
  createdAt: string
  totalBytes: number
  encrypted: boolean
  appVersion: string | null
  migration: string | null
  migrationsApplied: number | null
  files: { name: string; bytes: number }[]
}

export type BackupAlert = { kind: string; message: string; at: string }

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

const ts = (iso?: string | null) => (iso ? Date.parse(iso) || 0 : 0)

export async function isConfigured(): Promise<boolean> {
  try {
    return (await stat(BACKUP_DIR)).isDirectory()
  } catch {
    return false
  }
}

export async function readStatus(): Promise<SidecarStatus | null> {
  return readJson<SidecarStatus>(path.join(BACKUP_DIR, 'status.json'))
}

/** Sidecar enabled but silent for > STALE_MS. */
export function isStale(st: SidecarStatus, now = Date.now()): boolean {
  if (st.config?.enabled === false) return false
  return now - ts(st.heartbeatAt) > STALE_MS
}

/**
 * The one problem worth a red banner / admin notification, newest first:
 * failed run newer than the last success, failing restore test, failing remote copy, or a
 * sidecar that stopped reporting.
 */
export function currentAlert(st: SidecarStatus, now = Date.now()): BackupAlert | null {
  const f = st.lastFailure
  // a failure is cleared by a later success of the same kind of step
  const clearedAt =
    f?.kind === 'restore-test'
      ? st.lastRestoreTest?.ok
        ? st.lastRestoreTest.at
        : undefined
      : f?.kind === 'remote'
        ? st.remote?.ok
          ? st.remote.at
          : undefined
        : st.lastSuccess?.at
  if (f && ts(f.at) > ts(clearedAt)) {
    return { kind: f.kind ?? 'backup', message: f.message ?? 'Backup failed', at: f.at }
  }
  if (st.lastRestoreTest && st.lastRestoreTest.ok === false) {
    return {
      kind: 'restore-test',
      message: st.lastRestoreTest.message ?? 'Restore test failed',
      at: st.lastRestoreTest.at,
    }
  }
  if (st.remote && st.remote.ok === false) {
    return { kind: 'remote', message: st.remote.message ?? 'Remote copy failed', at: st.remote.at }
  }
  if (isStale(st, now)) {
    const at = st.heartbeatAt ?? st.startedAt ?? new Date(now).toISOString()
    return {
      kind: 'sidecar',
      message: 'The backup service has not reported for over 10 minutes. Is the "backup" container running?',
      at,
    }
  }
  return null
}

interface Manifest {
  id?: string
  kind?: string
  createdAt?: string
  totalBytes?: number
  encrypted?: boolean
  app?: { version?: string; migration?: string }
  db?: { migrationsApplied?: number }
  files?: { name: string; bytes: number }[]
}

/** Complete sets (with manifest.json), newest first. */
export async function listSets(): Promise<BackupSetSummary[]> {
  let names: string[]
  try {
    names = await readdir(SETS_DIR)
  } catch {
    return []
  }
  const ids = names.filter((n) => SET_ID_RE.test(n)).sort().reverse().slice(0, MAX_SETS)
  const manifests = await Promise.all(
    ids.map((id) => readJson<Manifest>(path.join(SETS_DIR, id, 'manifest.json'))),
  )
  const out: BackupSetSummary[] = []
  ids.forEach((id, i) => {
    const m = manifests[i]
    if (!m) return // incomplete or being pruned
    out.push({
      id,
      kind: m.kind ?? 'unknown',
      createdAt: m.createdAt ?? '',
      totalBytes: Number(m.totalBytes) || 0,
      encrypted: m.encrypted === true,
      appVersion: m.app?.version && m.app.version !== 'unknown' ? m.app.version : null,
      migration: m.app?.migration && m.app.migration !== 'unknown' ? m.app.migration : null,
      migrationsApplied: typeof m.db?.migrationsApplied === 'number' ? m.db.migrationsApplied : null,
      files: (m.files ?? []).map((f) => ({ name: String(f.name), bytes: Number(f.bytes) || 0 })),
    })
  })
  return out
}

/** Absolute path of a complete set, or null. Callers must not join anything else. */
export async function setDir(id: string): Promise<string | null> {
  if (!SET_ID_RE.test(id)) return null
  const dir = path.join(SETS_DIR, id)
  try {
    await stat(path.join(dir, 'manifest.json'))
    return dir
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** A trigger file is waiting, or the sidecar is processing one. */
export async function pendingTrigger(): Promise<'queued' | 'processing' | null> {
  if (await exists(PROCESSING_FILE)) return 'processing'
  if (await exists(TRIGGER_FILE)) return 'queued'
  return null
}

/**
 * Drop the trigger file. 'wx' makes creation exclusive, so two concurrent clicks (or two
 * admins) queue exactly one run. Returns false when one is already queued.
 */
export async function writeTrigger(requestedBy: string): Promise<boolean> {
  try {
    await writeFile(
      TRIGGER_FILE,
      JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy }) + '\n',
      { flag: 'wx', mode: 0o644 },
    )
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/**
 * Tell the sidecar which app version / migration produced the data, so each manifest records
 * it (the sidecar has no access to the app's files). Best effort; silent when not configured.
 */
export async function writeAppInfo(log: (msg: string) => void): Promise<void> {
  if (!(await exists(BACKUP_CTL_DIR))) return
  let migration = 'unknown'
  let migrationsCount: number | null = null
  const journal = await readJson<{ entries?: { tag: string }[] }>(
    path.join(env.drizzleDir, 'meta', '_journal.json'),
  )
  if (journal?.entries?.length) {
    migrationsCount = journal.entries.length
    migration = journal.entries[journal.entries.length - 1].tag
  }
  const info = {
    appVersion: process.env.APP_VERSION?.trim() || pkg.version,
    migration,
    migrationsCount,
    writtenAt: new Date().toISOString(),
  }
  try {
    await writeFile(path.join(BACKUP_CTL_DIR, 'app-info.json'), JSON.stringify(info, null, 2) + '\n')
  } catch (err) {
    log(`[backup] cannot write app-info.json: ${(err as Error).message}`)
  }
}
