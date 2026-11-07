import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { pluginStorage } from '../db/schema'
import { AppError, badRequest } from '../errors'

/**
 * Per-plugin, per-user KV storage (permission `storage`). Values are JSON, stored as text.
 * Rows are keyed (plugin_id, user_id, key): one plugin can never read another plugin's data and
 * one user can never read another user's data — both ids come from the server (route param that
 * was checked against the approved-plugin list, and the session user), never from the plugin.
 */
export const STORAGE_LIMITS = {
  keyMaxLength: 128,
  valueMaxBytes: 64 * 1024,
  maxKeys: 500,
  totalMaxBytes: 1024 * 1024,
} as const

export const STORAGE_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export function validateKey(key: string): string {
  if (!STORAGE_KEY_RE.test(key)) {
    throw badRequest('storage key must match ^[A-Za-z0-9_.:-]{1,128}$')
  }
  return key
}

/** Serialise and size-check a value. Throws 413 when too large, 400 when not JSON-serialisable. */
export function encodeValue(value: unknown): { text: string; bytes: number } {
  if (value === undefined) throw badRequest('value is required')
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    throw badRequest('value must be JSON-serialisable')
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > STORAGE_LIMITS.valueMaxBytes) {
    throw new AppError(413, 'PLUGIN_STORAGE_VALUE_TOO_LARGE', 'value exceeds 64 KB')
  }
  return { text, bytes }
}

export async function storageGet(pluginId: string, userId: string, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: pluginStorage.value })
    .from(pluginStorage)
    .where(and(eq(pluginStorage.pluginId, pluginId), eq(pluginStorage.userId, userId), eq(pluginStorage.key, key)))
    .limit(1)
  return row ? (JSON.parse(row.value) as unknown) : null
}

export async function storageKeys(pluginId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ key: pluginStorage.key })
    .from(pluginStorage)
    .where(and(eq(pluginStorage.pluginId, pluginId), eq(pluginStorage.userId, userId)))
    .orderBy(asc(pluginStorage.key))
    .limit(STORAGE_LIMITS.maxKeys)
  return rows.map((r) => r.key)
}

/**
 * Upsert under a per-(plugin,user) transaction advisory lock so concurrent writes cannot race past
 * the quota. The quota check is one aggregate over the primary-key prefix.
 */
export async function storageSet(pluginId: string, userId: string, key: string, value: unknown): Promise<void> {
  const { text, bytes } = encodeValue(value)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'plugin-storage:' + pluginId + ':' + userId}))`)
    const [agg] = await tx
      .select({
        keys: sql<number>`count(*)::int`,
        total: sql<number>`coalesce(sum(${pluginStorage.bytes}), 0)::int`,
        existing: sql<number>`coalesce(sum(case when ${pluginStorage.key} = ${key} then ${pluginStorage.bytes} else 0 end), 0)::int`,
        exists: sql<boolean>`bool_or(${pluginStorage.key} = ${key})`,
      })
      .from(pluginStorage)
      .where(and(eq(pluginStorage.pluginId, pluginId), eq(pluginStorage.userId, userId)))
    const keys = agg?.keys ?? 0
    const total = agg?.total ?? 0
    const existing = agg?.existing ?? 0
    const exists = !!agg?.exists
    if (!exists && keys >= STORAGE_LIMITS.maxKeys) {
      throw new AppError(413, 'PLUGIN_STORAGE_QUOTA', `plugin storage is limited to ${STORAGE_LIMITS.maxKeys} keys per user`)
    }
    if (total - existing + bytes > STORAGE_LIMITS.totalMaxBytes) {
      throw new AppError(413, 'PLUGIN_STORAGE_QUOTA', 'plugin storage quota (1 MB per user) exceeded')
    }
    await tx
      .insert(pluginStorage)
      .values({ pluginId, userId, key, value: text, bytes })
      .onConflictDoUpdate({
        target: [pluginStorage.pluginId, pluginStorage.userId, pluginStorage.key],
        set: { value: text, bytes, updatedAt: new Date() },
      })
  })
}

export async function storageDelete(pluginId: string, userId: string, key: string): Promise<void> {
  await db
    .delete(pluginStorage)
    .where(and(eq(pluginStorage.pluginId, pluginId), eq(pluginStorage.userId, userId), eq(pluginStorage.key, key)))
}

/** Admin "remove plugin data": every user's rows for one plugin. */
export async function storagePurgePlugin(pluginId: string): Promise<void> {
  await db.delete(pluginStorage).where(eq(pluginStorage.pluginId, pluginId))
}
