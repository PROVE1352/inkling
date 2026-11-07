/**
 * Process facts for the admin status summary (docs/adr/1231-*): restarts in the last 24 hours and
 * errors logged since boot. Both are best effort and cheap; nothing here can stop the server.
 *
 * Restarts: a small JSON file under DATA_DIR (the only volume that survives a container restart)
 * keeps the last boots. Each boot records how the previous process ended: `clean` (graceful
 * shutdown, exit code 0), `error` (graceful shutdown with a non-zero code, e.g. after an
 * uncaughtException), or `unknown` (no exit record: SIGKILL, OOM kill, power loss, watchdog).
 *
 * Errors: a counter fed by pino's logMethod hook (index.ts) for every record at level >= 50
 * (error, fatal). Only timestamps are kept, never the message.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { env } from '../env'

export type PrevExit = 'clean' | 'error' | 'unknown' | 'first'
export interface BootRecord {
  at: string
  prev: PrevExit
}
export interface BootLog {
  boots: BootRecord[]
  exit?: { at: string; code: number } | null
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Boots kept in the file: enough for a crash loop to be visible, small enough to rewrite. */
const MAX_BOOTS = 50

export function bootLogFile(dataDir = env.dataDir): string {
  return path.join(dataDir, 'status', 'boots.json')
}

function readLog(file: string): BootLog {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BootLog>
    const boots = Array.isArray(raw.boots)
      ? raw.boots.filter((b): b is BootRecord => !!b && typeof b.at === 'string' && typeof b.prev === 'string')
      : []
    const exit =
      raw.exit && typeof raw.exit.at === 'string' && typeof raw.exit.code === 'number' ? raw.exit : null
    return { boots, exit }
  } catch {
    return { boots: [], exit: null }
  }
}

function writeLog(file: string, log: BootLog): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(log) + '\n')
  renameSync(tmp, file)
}

/** Pure: the log after a boot at `now`. */
export function addBoot(log: BootLog, now: Date): BootLog {
  const last = log.boots[log.boots.length - 1]
  let prev: PrevExit
  if (!last) prev = 'first'
  else if (log.exit && Date.parse(log.exit.at) >= Date.parse(last.at)) prev = log.exit.code === 0 ? 'clean' : 'error'
  else prev = 'unknown'
  const boots = [...log.boots, { at: now.toISOString(), prev }].slice(-MAX_BOOTS)
  return { boots, exit: null }
}

let available = false

/** Called once at boot (index.ts), after DATA_DIR exists. Never throws. */
export function recordBoot(file = bootLogFile(), now = new Date()): void {
  try {
    writeLog(file, addBoot(readLog(file), now))
    available = true
  } catch {
    available = false
  }
}

/** Called at the end of a graceful shutdown (index.ts). Synchronous: the process exits right after. */
export function recordExit(code: number, file = bootLogFile(), now = new Date()): void {
  if (!available) return
  try {
    const log = readLog(file)
    writeLog(file, { ...log, exit: { at: now.toISOString(), code } })
  } catch {
    // best effort
  }
}

export interface RestartStats {
  /** False when the boot file could not be written (read-only or missing DATA_DIR). */
  available: boolean
  /** Boots in the last 24 h that followed an earlier process (the very first boot is not a restart). */
  restarts24h: number
  /** Of those, the ones whose previous process did not shut down cleanly. */
  unclean24h: number
  lastUncleanAt: string | null
}

/** Pure: restart counts from a log. */
export function restartStatsOf(log: BootLog, now: number): RestartStats {
  let restarts24h = 0
  let unclean24h = 0
  let lastUncleanAt: string | null = null
  for (const b of log.boots) {
    if (now - Date.parse(b.at) > DAY_MS || b.prev === 'first') continue
    restarts24h++
    if (b.prev === 'error' || b.prev === 'unknown') {
      unclean24h++
      lastUncleanAt = b.at
    }
  }
  return { available: true, restarts24h, unclean24h, lastUncleanAt }
}

export function restartStats(now = Date.now(), file = bootLogFile()): RestartStats {
  if (!available) return { available: false, restarts24h: 0, unclean24h: 0, lastUncleanAt: null }
  return restartStatsOf(readLog(file), now)
}

// ---------------------------------------------------------------------------
// Logged errors (level >= 50)
// ---------------------------------------------------------------------------

/** Timestamps of the newest logged errors (ms), oldest first. Bounded: a flood cannot grow memory. */
const errorTimes: number[] = []
const MAX_ERROR_TIMES = 2000
let errorsSinceBoot = 0

/** pino logMethod hook calls this for level >= 50. Must stay O(1) amortised and never throw. */
export function noteLoggedError(now = Date.now()): void {
  errorsSinceBoot++
  errorTimes.push(now)
  if (errorTimes.length > MAX_ERROR_TIMES) errorTimes.splice(0, errorTimes.length - MAX_ERROR_TIMES)
}

export interface ErrorStats {
  sinceBoot: number
  /** Capped at MAX_ERROR_TIMES (the count is "at least" beyond that). */
  last24h: number
  lastHour: number
  lastAt: string | null
}

export function errorStats(now = Date.now()): ErrorStats {
  let last24h = 0
  let lastHour = 0
  for (let i = errorTimes.length - 1; i >= 0; i--) {
    const age = now - errorTimes[i]
    if (age > DAY_MS) break
    last24h++
    if (age <= 60 * 60 * 1000) lastHour++
  }
  const last = errorTimes[errorTimes.length - 1]
  return { sinceBoot: errorsSinceBoot, last24h, lastHour, lastAt: last ? new Date(last).toISOString() : null }
}

/** Tests only. */
export function _resetRuntimeStats(): void {
  errorTimes.length = 0
  errorsSinceBoot = 0
  available = false
}
