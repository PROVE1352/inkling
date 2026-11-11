import { sql } from 'drizzle-orm'
import { AppError } from '../errors'
import { limits, mbToBytes } from '../limits'

/**
 * Limits of restricted mode (0.22, docs/adr/2505-*): the checks every creating path runs inside its
 * own transaction, right before it inserts.
 *
 * With no limit set none of these reads the database (not even a lock): the server behaves as 0.21.1.
 * With a limit set the check takes a lock first and counts under it, so concurrent requests cannot
 * pass the limit together:
 * - pages and bytes: `ws-quota:<workspace>` (advisory, transaction scoped), taken after any tree or
 *   member lock the path already holds and before the insert, so the lock order stays
 *   tree → members → quota everywhere;
 * - members: the member lock `ws-members:<workspace>` (helpers.ts lockWorkspaceMembers) that the
 *   join and add paths already take;
 * - owned workspaces: `user-ws:<user>`.
 * Called with the bare `db` instead of a transaction the lock ends at once: the count is still
 * checked, but two concurrent requests could both pass (the call sites table in ADR 2505 lists them).
 */

/** Anything that can run raw SQL: `db` or a transaction. */
export type QuotaExec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }

async function rows<T>(exec: QuotaExec, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await exec.execute(q)) as unknown as T[]
}

async function lockKey(exec: QuotaExec, key: string): Promise<void> {
  await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`)
}

/** LIMIT_WORKSPACE_STORAGE_MB in bytes, null = no limit. */
export function storageLimitBytes(): number | null {
  return limits.workspaceStorageMb == null ? null : mbToBytes(limits.workspaceStorageMb)
}

/** LIMIT_FILE_MB in bytes, null = no limit (the 25 MB multipart ceiling still applies). */
export function fileLimitBytes(): number | null {
  return limits.fileMb == null ? null : mbToBytes(limits.fileMb)
}

/**
 * Largest stored body (Yjs state) of one page while a storage limit is set: a quarter of the
 * workspace limit, so one page cannot take the whole workspace by itself. Null = no cap.
 */
export function pageBodyLimitBytes(): number | null {
  const ws = storageLimitBytes()
  return ws == null ? null : Math.floor(ws / 4)
}

export function storageError(limit: number, used: number): AppError {
  return new AppError(
    413,
    'LIMIT_STORAGE',
    'This workspace has used up its storage. Delete files or pages (and empty the trash) to edit again',
    undefined,
    { limit, used },
  )
}

/**
 * Room for `need` more pages, bytes or members in a workspace, checked in `tx` (the creating
 * transaction). Throws LIMIT_PAGES (403), LIMIT_STORAGE (413) or LIMIT_MEMBERS (403) with
 * `{ limit, used }`. A workspace past its storage limit takes no new page either (read-only).
 *
 * `bytes` are reserved: the cached `workspaces.storage_bytes` grows by them in the same transaction,
 * so a rollback gives them back and the next check sees them at once.
 */
export async function assertWorkspaceRoom(
  tx: QuotaExec,
  workspaceId: string,
  need: {
    pages?: number
    bytes?: number
    members?: number
    /** the joining user: no check when already a member */
    memberId?: string
    /** false = only check the bytes, do not add them to the cache (a check before the real one) */
    reserve?: boolean
  },
): Promise<void> {
  const pageLimit = need.pages != null && need.pages > 0 ? limits.pagesPerWorkspace : null
  const memberLimit = need.members != null && need.members > 0 ? limits.membersPerWorkspace : null
  const storage = (need.pages ?? 0) > 0 || (need.bytes ?? 0) > 0 ? storageLimitBytes() : null
  if (pageLimit == null && memberLimit == null && storage == null) return

  if (memberLimit != null) {
    await lockKey(tx, 'ws-members:' + workspaceId)
    const [{ n, already }] = await rows<{ n: number; already: boolean | null }>(
      tx,
      sql`SELECT count(*)::int AS n, bool_or(user_id = ${need.memberId ?? null}::uuid) AS already
            FROM workspace_members WHERE workspace_id = ${workspaceId}`,
    )
    if (!already && n + need.members! > memberLimit) {
      throw new AppError(403, 'LIMIT_MEMBERS', `This workspace already has ${n} of ${memberLimit} members`, undefined, {
        limit: memberLimit,
        used: n,
      })
    }
  }
  if (pageLimit == null && storage == null) return

  await lockKey(tx, 'ws-quota:' + workspaceId)
  if (pageLimit != null) {
    const [{ n }] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM pages WHERE workspace_id = ${workspaceId}`)
    if (n + need.pages! > pageLimit) {
      throw new AppError(
        403,
        'LIMIT_PAGES',
        `This workspace already has ${n} of ${pageLimit} pages (the trash counts too)`,
        undefined,
        { limit: pageLimit, used: n },
      )
    }
  }
  if (storage != null) {
    const [ws] = await rows<{ used: string | number; over: boolean }>(
      tx,
      sql`SELECT storage_bytes AS used, over_storage AS over FROM workspaces WHERE id = ${workspaceId}`,
    )
    if (!ws) return
    const used = Number(ws.used)
    const bytes = Math.max(0, need.bytes ?? 0)
    if (ws.over || used >= storage || used + bytes > storage) throw storageError(storage, used)
    if (bytes > 0 && need.reserve !== false) await tx.execute(sql`UPDATE workspaces SET storage_bytes = storage_bytes + ${bytes} WHERE id = ${workspaceId}`)
  }
}

/**
 * The workspace is not read-only for being past its storage limit (body writes, comments,
 * handwriting), and the page's stored body (when given) is within the per-page cap. No limit set →
 * no read at all. Throws LIMIT_STORAGE.
 */
export async function assertWorkspaceWritable(exec: QuotaExec, workspaceId: string, pageId?: string): Promise<void> {
  const storage = storageLimitBytes()
  if (storage == null) return
  const [ws] = await rows<{ used: string | number; over: boolean; body: number | null }>(
    exec,
    sql`SELECT storage_bytes AS used, over_storage AS over,
               ${pageId ? sql`(SELECT octet_length(state) FROM page_docs WHERE page_id = ${pageId})` : sql`NULL::int`} AS body
          FROM workspaces WHERE id = ${workspaceId}`,
  )
  if (ws && (ws.over || Number(ws.used) > storage)) throw storageError(storage, Number(ws.used))
  const cap = pageBodyLimitBytes()!
  if (ws?.body != null && Number(ws.body) > cap) {
    throw new AppError(413, 'LIMIT_STORAGE', 'This page is too large to grow further: move part of it to a new page', undefined, {
      limit: cap,
      used: Number(ws.body),
    })
  }
}

/**
 * Room for `need.workspaces` more owned workspaces (LIMIT_WORKSPACES_PER_USER). Owned = every
 * workspace where the user is an owner, deleted-but-restorable ones included. `workspaces: 0` asks
 * "not already over" (restoring a deleted workspace, which is counted already). Throws
 * LIMIT_WORKSPACES (403).
 */
export async function assertUserRoom(tx: QuotaExec, userId: string, need: { workspaces: number }): Promise<void> {
  const limit = limits.workspacesPerUser
  if (limit == null) return
  await lockKey(tx, 'user-ws:' + userId)
  const [{ n }] = await rows<{ n: number }>(
    tx,
    sql`SELECT count(*)::int AS n FROM workspace_members WHERE user_id = ${userId} AND role = 'owner'`,
  )
  if (n + need.workspaces > limit) {
    throw new AppError(
      403,
      'LIMIT_WORKSPACES',
      `You already own ${n} of ${limit} workspaces. Deleted workspaces count until they are gone for good: ` +
        'permanently delete one under Settings → Deleted workspaces, or leave one you no longer need',
      undefined,
      { limit, used: n },
    )
  }
}

/**
 * Stored body bytes (state + state vector) of pages about to be copied, for `bytes` of
 * assertWorkspaceRoom. 0 without reading when no storage limit is set.
 */
export async function pageBodyBytes(exec: QuotaExec, pageIds: string[]): Promise<number> {
  if (storageLimitBytes() == null || pageIds.length === 0) return 0
  const [r] = await rows<{ n: string | number }>(
    exec,
    sql`SELECT coalesce(sum(octet_length(state) + coalesce(octet_length(state_vector), 0)), 0)::bigint AS n
          FROM page_docs WHERE page_id IN (${sql.join(pageIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
  )
  return Number(r?.n ?? 0)
}

/**
 * Run `fn` (which opens its own transaction, like transferOwnership and restoreWorkspace) while
 * holding the user's owned-workspace lock in an outer transaction, after checking the room. The lock
 * order is then user → workspace members everywhere. No limit → `fn()` alone.
 */
export async function withUserRoom<T>(userId: string, need: { workspaces: number }, fn: () => Promise<T>): Promise<T> {
  if (limits.workspacesPerUser == null) return fn()
  const { db } = await import('../db/index')
  return db.transaction(async (tx) => {
    await assertUserRoom(tx, userId, need)
    return fn()
  })
}
