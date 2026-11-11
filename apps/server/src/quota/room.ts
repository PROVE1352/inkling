import { sql } from 'drizzle-orm'
import { AppError } from '../errors'
import { limits, mbToBytes } from '../limits'
import { currentGuest } from '../pageGrants'
import { collabUnsavedBytes } from './collabGrowth'

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

/**
 * What one upload counts toward the workspace's storage while a storage limit is set (contract §15,
 * review N2): at least one 4 KB block, plus 1 KB for its inode, folder entry and row, so a pile of
 * one-byte or empty files cannot hide in a few bytes of the count. Without a limit: the file's size.
 */
export const FILE_MIN_COUNTED_BYTES = 4096
export const FILE_OVERHEAD_BYTES = 1024

export function fileStorageBytes(size: number): number {
  if (storageLimitBytes() == null) return size
  return Math.max(size, FILE_MIN_COUNTED_BYTES) + FILE_OVERHEAD_BYTES
}

/**
 * The most `files` uploads add on top of their sizes (an archive's attachments, reserved before the
 * sizes of what is kept are known exactly). 0 without a storage limit.
 */
export function fileStorageOverhead(files: number): number {
  if (storageLimitBytes() == null) return 0
  return Math.max(0, files) * (FILE_MIN_COUNTED_BYTES + FILE_OVERHEAD_BYTES)
}

/** SQL for the counted bytes of a `files` row's `size` column (same rule as fileStorageBytes). */
export function fileStorageSql(sizeCol: ReturnType<typeof sql>): ReturnType<typeof sql> {
  if (storageLimitBytes() == null) return sizeCol
  return sql`(greatest(${sizeCol}, ${FILE_MIN_COUNTED_BYTES}) + ${FILE_OVERHEAD_BYTES})`
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

/**
 * The request's user is a page guest in this workspace, not a member (docs/adr/1252-*): read from the
 * request's guest scope, so no query. False outside a request (collab socket, jobs).
 */
export function guestInWorkspace(workspaceId: string | undefined): boolean {
  if (!workspaceId) return false
  const g = currentGuest()
  return !!g && g.workspaces.has(workspaceId)
}

/**
 * 413 LIMIT_STORAGE. `{ limit, used }` are the workspace's numbers: members see them (they can read
 * GET /workspaces/:id/usage anyway); a page guest of `workspaceId` gets the code and the message only
 * (0.22.1, review N7).
 */
export function storageError(limit: number, used: number, workspaceId?: string): AppError {
  return new AppError(
    413,
    'LIMIT_STORAGE',
    'This workspace has used up its storage. Delete files or pages (and empty the trash) to edit again',
    undefined,
    guestInWorkspace(workspaceId) ? undefined : { limit, used, unit: 'bytes' },
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
    // live editing not stored yet counts too (quota/collabGrowth.ts): an upload and a burst of typing
    // do not both take the same room
    const used = Number(ws.used) + collabUnsavedBytes(workspaceId)
    const bytes = Math.max(0, need.bytes ?? 0)
    if (ws.over || used >= storage || used + bytes > storage) throw storageError(storage, used, workspaceId)
    if (bytes > 0 && need.reserve !== false) {
      await tx.execute(sql`UPDATE workspaces SET storage_bytes = storage_bytes + ${bytes} WHERE id = ${workspaceId}`)
      // new pages are indexed after their transaction (review N3): a recount once that has landed counts
      // their index rows (quota/storage.ts; imported lazily, storage.ts imports this module)
      if ((need.pages ?? 0) > 0) void import('./storage').then((m) => m.recountAfterIndex(workspaceId)).catch(() => {})
    }
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
  const used = ws ? Number(ws.used) + collabUnsavedBytes(workspaceId) : 0
  if (ws && (ws.over || used > storage)) throw storageError(storage, used, workspaceId)
  const cap = pageBodyLimitBytes()!
  if (ws?.body != null && Number(ws.body) > cap) {
    throw new AppError(
      413,
      'LIMIT_STORAGE',
      'This page is too large to grow further: move part of it to a new page',
      undefined,
      guestInWorkspace(workspaceId) ? undefined : { limit: cap, used: Number(ws.body), unit: 'bytes' },
    )
  }
}

/** JSON size of a request value: what a write that stores it adds, about. */
export function jsonBytes(v: unknown): number {
  if (v === undefined || v === null) return 0
  try {
    return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')
  } catch {
    return 0
  }
}

/** A recount from a write that does not fit happens at most this often per workspace. */
export const GROWTH_RECOUNT_MS = 10_000

/**
 * A write that adds about `bytes` to what a workspace stores, outside the creating paths (row and page
 * properties, collection fields, views and row templates, templates, rules, titles and aliases, edited
 * comments; security review F5, docs/adr/2533-*). No limit set → nothing at all, no read.
 *
 * Refuses (413 LIMIT_STORAGE) a workspace that is read-only for storage and a write that does not fit
 * in what is left; otherwise moves the cached use up by `bytes`, an upper bound (a replaced value is
 * counted twice until the next recount), so a run of such writes cannot outgrow the limit between two
 * recounts. When the cache says "does not fit" but was not recounted in the last GROWTH_RECOUNT_MS, the
 * workspace is recounted once first, so the upper bounds never lock a workspace that has room.
 * Called with the bare `db` (the recount writes the workspace row).
 */
export async function assertWorkspaceGrowth(exec: QuotaExec, workspaceId: string, bytes: number): Promise<void> {
  const storage = storageLimitBytes()
  if (storage == null) return
  const read = async () =>
    (
      await rows<{ used: string | number; over: boolean; fresh: boolean }>(
        exec,
        sql`SELECT storage_bytes AS used, over_storage AS over,
                   coalesce(storage_checked_at > now() - make_interval(secs => ${GROWTH_RECOUNT_MS / 1000}), false) AS fresh
              FROM workspaces WHERE id = ${workspaceId}`,
      )
    )[0]
  const n = Math.max(0, Math.ceil(bytes))
  const fits = (w: { used: string | number; over: boolean }) => !w.over && Number(w.used) + collabUnsavedBytes(workspaceId) + n <= storage
  let ws = await read()
  if (!ws) return
  if (!fits(ws) && !ws.fresh) {
    const { recountWorkspaceStorage } = await import('./storage')
    await recountWorkspaceStorage(workspaceId)
    ws = await read()
    if (!ws) return
  }
  if (!fits(ws)) throw storageError(storage, Number(ws.used) + collabUnsavedBytes(workspaceId), workspaceId)
  if (n > 0) await exec.execute(sql`UPDATE workspaces SET storage_bytes = storage_bytes + ${n} WHERE id = ${workspaceId}`)
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
 * Room for `need` more workspaces on the whole server (LIMIT_WORKSPACES_TOTAL, contract §14, security
 * review F1, docs/adr/2531-*). Counted: every `workspaces` row, deleted-but-restorable ones included.
 * Taken under one server-wide lock (`ws-total`), always after the person's own `user-ws:` lock, so
 * concurrent creations and sign-ups cannot pass the limit together. `need: 0` from a transaction that
 * already inserted its workspace (sign-up, a new OIDC account) asks "not past it". Unset → no read.
 * Throws LIMIT_WORKSPACES_TOTAL (403), or SIGNUP_FULL (403) when `as: 'signup'`.
 */
export async function assertWorkspacesTotalRoom(tx: QuotaExec, need: number, as: 'create' | 'signup' = 'create'): Promise<void> {
  const limit = limits.workspacesTotal
  if (limit === undefined) return
  await lockKey(tx, 'ws-total')
  const [{ n }] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM workspaces`)
  if (n + need <= limit) return
  if (as === 'signup') throw new AppError(403, 'SIGNUP_FULL', 'This server is not taking new accounts right now', undefined, { limit, used: n })
  throw new AppError(
    403,
    'LIMIT_WORKSPACES_TOTAL',
    `This server already holds ${n} of ${limit} workspaces (deleted ones count until they are gone for good)`,
    undefined,
    { limit, used: n },
  )
}

/** Workspaces on the server reached LIMIT_WORKSPACES_TOTAL (auth mode, the sign-up check before the transaction). */
export async function workspacesTotalReached(exec: QuotaExec): Promise<boolean> {
  const limit = limits.workspacesTotal
  if (limit === undefined) return false
  const [{ n }] = await rows<{ n: number }>(exec, sql`SELECT count(*)::int AS n FROM workspaces`)
  return n >= limit
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
