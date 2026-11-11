import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { env } from '../env'
import { AppError } from '../errors'
import { limits, mbToBytes } from '../limits'

/**
 * Instance storage fuse (LIMIT_INSTANCE_STORAGE_MB, contract §14, security review F4, docs/adr/2532-*).
 *
 * What it measures, once a minute at most: `pg_database_size(current_database())` plus the bytes of
 * every file under DATA_DIR (uploads, the import/export scratch folder, plugins, the boot log). The
 * folder is walked on disk instead of summing `files.size`: a blob whose row is gone (a crash between
 * the commit and the unlink, review F13) or a scratch file left behind still takes disk, and a fuse
 * that cannot see it would trip late.
 *
 * At or past the limit the server is "full": sign-up, every write under /api except the ones that make
 * room or that a person must still be able to do (quota/instanceGate.ts), and live editing are refused
 * (503 INSTANCE_FULL); reading, signing in, exporting, deleting, the admin screens, consent and leaving
 * still work. The state is cached: `instanceFullNow()` answers from memory for the collab socket, and a
 * measurement older than a minute is refreshed in the background (and by the hourly housekeeping).
 *
 * The fuse is weaker than a filesystem with a size limit: it does not see the WAL, the backups, the
 * logs, or what grows in the minute between two measurements, and the database file does not shrink
 * when rows are deleted (VACUUM keeps the space for reuse inside the table). Once tripped it usually
 * stays tripped until the operator makes room (OPERATIONS.md, the steps measured for the 0.22 report).
 *
 * Without the setting nothing here measures anything: every function answers "not full" from memory.
 */

/** A measurement is reused for this long. */
export const INSTANCE_MEASURE_MS = 60_000

export interface InstanceStorage {
  dbBytes: number
  fileBytes: number
  total: number
  limit: number
  full: boolean
  /** Epoch ms of the measurement. */
  at: number
}

let last: InstanceStorage | null = null
let inFlight: Promise<InstanceStorage> | null = null
const listeners: ((full: boolean) => void)[] = []

/** LIMIT_INSTANCE_STORAGE_MB in bytes, null = no fuse. */
export function instanceStorageLimitBytes(): number | null {
  return limits.instanceStorageMb === undefined ? null : mbToBytes(limits.instanceStorageMb)
}

/**
 * What one file or folder takes on disk (0.22.1, review N2): the blocks it holds (`st_blocks × 512`),
 * not its apparent size, so a one-byte upload counts as the 4 KB block it fills; never less than the
 * apparent size (a filesystem that reports no blocks, or a sparse file, counts as 0.22.0 did).
 */
export function diskBytes(st: { size: number; blocks?: number }): number {
  const blocks = typeof st.blocks === 'number' && Number.isFinite(st.blocks) ? st.blocks * 512 : 0
  return Math.max(st.size, blocks)
}

/** lstat calls in flight at once while walking DATA_DIR (a folder of 100k uploads, measured in the 0.22.1 report). */
const WALK_BATCH = 64

/**
 * Bytes on disk under `dir`: every file's blocks and the folders' own blocks (a folder with many
 * entries grows too). Missing folder → 0.
 */
export async function folderDiskBytes(dir: string): Promise<number> {
  let entries: import('node:fs').Dirent[]
  let total = 0
  try {
    total = diskBytes(await lstat(dir))
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0 // missing folder (a test, a fresh install)
  }
  for (let i = 0; i < entries.length; i += WALK_BATCH) {
    const sizes = await Promise.all(
      entries.slice(i, i + WALK_BATCH).map(async (e) => {
        const p = path.join(dir, e.name)
        try {
          if (e.isDirectory()) return await folderDiskBytes(p)
          if (e.isFile()) return diskBytes(await lstat(p))
        } catch {
          // removed meanwhile
        }
        return 0
      }),
    )
    for (const n of sizes) total += n
  }
  return total
}

/** Measure now (no cache). Updates the cached state and tells the listeners when "full" changed. */
export async function measureInstanceStorage(): Promise<InstanceStorage> {
  const limit = instanceStorageLimitBytes() ?? Number.POSITIVE_INFINITY
  const { db } = await import('../db/index') // lazily: the collab path imports this module
  const [r] = (await db.execute(sql`SELECT pg_database_size(current_database())::bigint AS n`)) as unknown as { n: string | number }[]
  const dbBytes = Number(r?.n ?? 0)
  const fileBytes = await folderDiskBytes(path.resolve(env.dataDir))
  const total = dbBytes + fileBytes
  const was = last?.full ?? false
  last = { dbBytes, fileBytes, total, limit, full: total >= limit, at: Date.now() }
  if (last.full !== was) {
    console.warn(
      last.full
        ? `[inkling] instance storage fuse tripped: ${total} of ${limit} bytes used (database ${dbBytes}, files ${fileBytes}); only reading and deleting work until there is room`
        : `[inkling] instance storage is under its fuse again: ${total} of ${limit} bytes`,
    )
    for (const fn of listeners) {
      try {
        fn(last.full)
      } catch (err) {
        console.error('[inkling] instance fuse listener failed', err)
      }
    }
  }
  return last
}

function refresh(): Promise<InstanceStorage> {
  if (!inFlight) {
    inFlight = measureInstanceStorage().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

function stale(): boolean {
  return !last || Date.now() - last.at >= INSTANCE_MEASURE_MS || last.limit !== (instanceStorageLimitBytes() ?? Number.POSITIVE_INFINITY)
}

/**
 * Is the instance full? With the setting: the last measurement answers; one older than a minute is
 * measured again in the background (one measurement at a time), so a write never waits for the walk of
 * DATA_DIR (0.22.1, review N2: 100k files take seconds). Only the first answer after boot (or after the
 * limit changed) waits for a measurement. A failed measurement keeps the last answer. Without the
 * setting: false, no read. Called by the sign-up and the OAuth registration paths too (contract §14).
 */
export async function isInstanceFull(): Promise<boolean> {
  const limit = instanceStorageLimitBytes()
  if (limit == null) return false
  if (!last || last.limit !== limit) {
    try {
      await refresh()
    } catch (err) {
      console.warn('[inkling] instance storage measurement failed', err)
    }
  } else if (stale()) {
    void refresh().catch((err: unknown) => console.warn('[inkling] instance storage measurement failed', err))
  }
  return last?.full ?? false
}

/**
 * The cached answer, synchronously (the collab socket decides per frame without awaiting). A stale
 * measurement is refreshed in the background. Without the setting: false.
 */
export function instanceFullNow(): boolean {
  if (instanceStorageLimitBytes() == null) return false
  if (stale()) void refresh().catch((err: unknown) => console.warn('[inkling] instance storage measurement failed', err))
  return last?.full ?? false
}

/** The last measurement (admin status), measuring first when stale. Null without the setting. */
export async function instanceStorageStatus(): Promise<InstanceStorage | null> {
  if (instanceStorageLimitBytes() == null) return null
  await isInstanceFull()
  return last
}

/** Called with the new state whenever "full" changes (collab.ts closes or reopens live editing). */
export function onInstanceFullChange(fn: (full: boolean) => void): () => void {
  listeners.push(fn)
  return () => {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}

/** Test hook: forget the cached measurement (the next check measures again). */
export function _resetInstanceStorage(): void {
  last = null
}

/** Test hook: pretend a measurement, so tests need not fill a disk. */
export function _setInstanceStorageForTests(s: { dbBytes: number; fileBytes: number } | null, at = Date.now()): void {
  if (!s) {
    last = null
    return
  }
  const limit = instanceStorageLimitBytes() ?? Number.POSITIVE_INFINITY
  const total = s.dbBytes + s.fileBytes
  const was = last?.full ?? false
  last = { ...s, total, limit, full: total >= limit, at }
  if (last.full !== was) for (const fn of listeners) fn(last.full)
}

/** The 503 every refused write answers with. */
export function instanceFullError(): AppError {
  return new AppError(
    503,
    'INSTANCE_FULL',
    "This server's storage is full: only reading, exporting and deleting work until the operator makes room",
  )
}
