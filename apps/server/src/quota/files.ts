import { rm } from 'node:fs/promises'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { files } from '../db/schema'
import { env } from '../env'
import { AppError } from '../errors'
import { fileLimitBytes } from './room'

/**
 * File size (LIMIT_FILE_MB, docs/adr/2505-*): the per-file cap of an upload. The browser's cap is
 * min(25 MB, LIMIT_FILE_MB), a connection's min(AGENT_UPLOAD_MAX_MB, LIMIT_FILE_MB). Without the
 * setting the caps and the answer (413 PAYLOAD_TOO_LARGE) are those of 0.21.1.
 */
export function uploadCapBytes(defaultCap: number): number {
  const l = fileLimitBytes()
  return l == null ? defaultCap : Math.min(defaultCap, l)
}

/** The file limit is what cut this upload (and not the built-in cap). */
export function fileLimitApplies(defaultCap: number): boolean {
  const l = fileLimitBytes()
  return l != null && l < defaultCap
}

/** 413 LIMIT_FILE with `{ limit, used }` in bytes; `used` is what had arrived when the upload was cut. */
export function fileLimitError(limit: number, used: number): AppError {
  return new AppError(413, 'LIMIT_FILE', `File is too large (max ${(limit / 1024 / 1024).toFixed(1)} MB on this server)`, undefined, {
    limit,
    used,
  })
}

/** Remove file rows and their blobs (best effort): uploads of an import that made no page. */
export async function dropFiles(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await db.delete(files).where(inArray(files.id, ids))
  } catch (err) {
    console.warn('[inkling] could not remove the files of a refused import', err)
  }
  for (const id of ids) await rm(path.join(env.dataDir, 'uploads', id), { force: true }).catch(() => {})
}
