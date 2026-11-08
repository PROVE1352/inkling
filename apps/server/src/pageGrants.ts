import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { GuestAccessLevel, PageAccessLevel, WorkspaceAccessRole } from '@inkling/shared'
import { db } from './db/index'
import { AppError } from './errors'
import { BoundedLru } from './lru'
import { bumpAcl, cacheable } from './aclVersion'
import type { AclState } from './aclVersion'

/**
 * People with access to a page tree, and guests (docs/adr/1250-*, 1251-*, 1252-*).
 *
 * `page_grants(page_id, user_id, level)`: the nearest row on a page's ancestor-or-self path is the
 * person's level there. Two uses of the same rows:
 *
 *   - **Who sees (guests).** Someone who is not a member of the workspace sees exactly the shared
 *     pages under their rows there. That narrowing is carried like a connection range
 *     (docs/adr/1202-*): `requireUser` enters a guest scope for an account that has rows, and
 *     `visibleTo` / `pageInRangeSql` (tokenRange.ts) add the guest term for the guest's workspaces
 *     only. An account without rows has no scope and gets no SQL at all.
 *   - **What they may do (members and guests).** `editLock.ts` intersects the bits of the level with
 *     the lock bits: assertCan / capsFor / pageLockStatus. A workspace without rows needs no walk:
 *     "has rows" is cached per workspace access version (docs/adr/1071-*), so the only cost there is
 *     one EXISTS per version change.
 *
 * Fail-closed default: a guest is not a member, so `requireMembership` refuses them unless the
 * route opted in with `{ guests: true }` (helpers.ts). The list of opted-in routes is the guest
 * surface; everything else stays member-only.
 */

export const CAP_EDIT = 1
export const CAP_COMMENT = 2
const CAP_ALL = CAP_EDIT | CAP_COMMENT

/** Bits a level gives (EDIT/COMMENT; `full` adds managing people, which is not a bit here). */
export function levelCaps(level: PageAccessLevel | null): number {
  switch (level) {
    case 'full':
    case 'edit':
      return CAP_ALL
    case 'comment':
      return CAP_COMMENT
    default:
      return 0
  }
}

export function isManager(role: WorkspaceAccessRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Level of `role` on a page whose nearest row says `grant` (null = no row on the path):
 * owners/admins full; a member's row replaces the default (edit); a non-member has only their row.
 */
export function effectiveLevel(role: WorkspaceAccessRole | null, grant: PageAccessLevel | null): PageAccessLevel | null {
  if (isManager(role)) return 'full'
  if (role === 'guest' || role === null) {
    if (!grant) return role === 'guest' ? null : null
    // A guest row is never `full` (refused on write); read it as edit if one got in by hand.
    return grant === 'full' ? 'edit' : grant
  }
  return grant ?? 'edit'
}

/**
 * Bits of `role` given its nearest row. `role === null` is a caller that did not resolve
 * membership (legacy guards that checked membership earlier): without a row it keeps every bit,
 * as before this feature; with a row the row decides.
 */
export function grantCaps(role: WorkspaceAccessRole | null, grant: PageAccessLevel | null): number {
  if (isManager(role)) return CAP_ALL
  if (!grant) return role === 'guest' ? 0 : CAP_ALL
  return levelCaps(effectiveLevel(role, grant))
}

// ---------------------------------------------------------------------------
// Guest scope (who sees what)
// ---------------------------------------------------------------------------

export interface GuestScope {
  userId: string
  /** Workspaces where the account is a guest → its rows there (page roots and levels). */
  workspaces: Map<string, { pageId: string; level: GuestAccessLevel }[]>
  /** A token request (MCP, API token): guest workspaces are not reachable at all (docs/adr/1253-*). */
  token: boolean
  /** The account has page rows at all; false = every level lookup for this user is skipped. */
  hasRows: boolean
}

const store = new AsyncLocalStorage<GuestScope>()

export function runAsGuest<T>(scope: GuestScope, fn: () => T): T {
  return store.run(scope, fn)
}

/** The guest scope of the current request for `userId` (null: none, or a query about someone else). */
export function currentGuest(userId?: string): GuestScope | null {
  const s = store.getStore()
  if (!s) return null
  if (userId !== undefined && s.userId !== userId) return null
  return s
}

/** The current request's user is a guest in `workspaceId` (and may use it: not a token). */
/**
 * The request's user has no page row anywhere (known from the user lookup): their level lookups are
 * skipped. false outside a request scope (collab socket, jobs): those look it up.
 */
export function knownWithoutRows(userId: string): boolean {
  const s = currentGuest(userId)
  return !!s && !s.hasRows
}

export function isGuestIn(workspaceId: string, userId: string): boolean {
  const s = currentGuest(userId)
  return !!s && !s.token && s.workspaces.has(workspaceId)
}

function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

/** Depth cap of the walks here; equals TREE_MAX_DEPTH in pageTree.ts (import cycle). */
const MAX_DEPTH = 64

/** SQL: ids of the shared subtrees under `rootIds` (inclusive). Uncorrelated: one walk per statement. */
export function guestSubtreeSql(rootIds: string[]): SQL {
  return sql`(WITH RECURSIVE ink_guest_sub(id, depth) AS (
      SELECT gr.id, 0 FROM pages gr WHERE gr.id = ANY(${uuidArray(rootIds)}::uuid[]) AND gr.scope = 'shared'
      UNION ALL
      SELECT gc.id, gs.depth + 1 FROM pages gc JOIN ink_guest_sub gs ON gc.parent_id = gs.id
       WHERE gs.depth < ${MAX_DEPTH} AND gc.scope = 'shared'
    ) SELECT id FROM ink_guest_sub)`
}

/**
 * SQL: the page in `idCol`/`wsCol` is visible to the guest scope of `userId`: in a workspace where
 * they are not a guest, or under one of their rows there. null = no guest scope (no SQL added).
 */
export function guestPageSql(idCol: AnyPgColumn | SQL, wsCol: AnyPgColumn | SQL | null, userId?: string): SQL | null {
  const s = currentGuest(userId)
  if (!s || s.workspaces.size === 0) return null
  const wsIds = [...s.workspaces.keys()].sort()
  const roots = s.token ? [] : [...s.workspaces.values()].flatMap((r) => r.map((x) => x.pageId)).sort()
  const inside = roots.length ? sql`${idCol} IN ${guestSubtreeSql(roots)}` : sql`false`
  if (!wsCol) return inside
  return sql`(${wsCol} <> ALL(${uuidArray(wsIds)}::uuid[]) OR ${inside})`
}

/** A short string per guest scope, for result caches keyed by user. '' = none. */
export function guestCacheKey(userId: string): string {
  const s = currentGuest(userId)
  if (!s || s.workspaces.size === 0) return ''
  const parts = [...s.workspaces.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ws, r]) => `${ws}:${r.map((x) => x.pageId).sort().join('+')}`)
  return `g${s.token ? 't' : ''}:${parts.join(',')}`
}

/** SQL boolean column: the user `userIdCol` has any page row (folded into the session lookup). */
export function hasGrantsSql(userIdCol: AnyPgColumn | SQL): SQL<boolean> {
  return sql<boolean>`exists (select 1 from page_grants hg where hg.user_id = ${userIdCol})`
}

/**
 * The guest scope of `userId`: their rows in live workspaces they are not a member of, on live
 * pages. One statement; only run for accounts that have rows at all.
 */
export async function loadGuestScope(userId: string, token: boolean): Promise<GuestScope> {
  const rows = (await db.execute(sql`
    SELECT g.page_id AS "pageId", p.workspace_id AS "workspaceId", g.level
      FROM page_grants g
      JOIN pages p ON p.id = g.page_id AND p.deleted_at IS NULL
      JOIN workspaces w ON w.id = p.workspace_id AND w.deleted_at IS NULL
     WHERE g.user_id = ${userId}
       AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = p.workspace_id AND m.user_id = ${userId})
     ORDER BY p.workspace_id, g.page_id
  `)) as unknown as { pageId: string; workspaceId: string; level: PageAccessLevel }[]
  const workspaces = new Map<string, { pageId: string; level: GuestAccessLevel }[]>()
  for (const r of rows) {
    const list = workspaces.get(r.workspaceId) ?? []
    list.push({ pageId: r.pageId, level: r.level === 'full' ? 'edit' : r.level })
    workspaces.set(r.workspaceId, list)
  }
  return { userId, workspaces, token, hasRows: true }
}

/** The scope requireUser enters for an authenticated request (no statement without rows). */
export async function peopleScopeFor(userId: string, hasRows: boolean, token: boolean): Promise<GuestScope> {
  if (!hasRows) return { userId, workspaces: new Map(), token, hasRows: false }
  return loadGuestScope(userId, token)
}

// ---------------------------------------------------------------------------
// Levels on pages (what they may do), cached per workspace access version
// ---------------------------------------------------------------------------

type Exec = Pick<typeof db, 'execute'>

const hasRowsCache = new BoundedLru<{ v: number; has: boolean }>(20_000, 60 * 60_000)
const levelCache = new BoundedLru<{ ws: string; v: number; level: PageAccessLevel | null }>(50_000, 60 * 60_000)
let walks = 0

/** Test hook: number of grant walks run by this process. */
export function _grantWalks(): number {
  return walks
}

/** Test hook: forget cached answers. */
export function _resetGrantCaches(): void {
  hasRowsCache.clear()
  levelCache.clear()
}

/**
 * Does any page of the workspace have a people row? Answered from memory while the access version
 * is the one `acl` read (every row change bumps it); else one EXISTS.
 */
export async function workspaceHasGrants(exec: Exec, acl: AclState): Promise<boolean> {
  const hit = hasRowsCache.get(acl.workspaceId)
  if (hit && hit.v === acl.version) return hit.has
  const [r] = (await exec.execute(sql`
    SELECT EXISTS (SELECT 1 FROM page_grants g JOIN pages p ON p.id = g.page_id WHERE p.workspace_id = ${acl.workspaceId}) AS has
  `)) as unknown as { has: boolean }[]
  const has = !!r?.has
  if (cacheable(exec)) hasRowsCache.set(acl.workspaceId, { v: acl.version, has })
  return has
}

/** Nearest row of `userId` on each leaf's path (one statement for any number of leaves). */
export async function nearestGrants(exec: Exec, leafIds: string[], userId: string): Promise<Map<string, { level: PageAccessLevel; pageId: string } | null>> {
  const out = new Map<string, { level: PageAccessLevel; pageId: string } | null>(leafIds.map((id) => [id, null]))
  if (!leafIds.length) return out
  walks++
  const rows = (await exec.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id AS leaf, id, parent_id, 0 AS depth FROM pages WHERE id = ANY(${uuidArray(leafIds)}::uuid[])
      UNION ALL
      SELECT u.leaf, p.id, p.parent_id, u.depth + 1 FROM pages p JOIN up u ON p.id = u.parent_id
       WHERE u.depth < ${MAX_DEPTH}
    )
    SELECT DISTINCT ON (up.leaf) up.leaf, g.level, g.page_id AS "pageId"
      FROM up JOIN page_grants g ON g.page_id = up.id AND g.user_id = ${userId}
     ORDER BY up.leaf, up.depth
  `)) as unknown as { leaf: string; level: PageAccessLevel; pageId: string }[]
  for (const r of rows) out.set(r.leaf, { level: r.level, pageId: r.pageId })
  return out
}

/**
 * The nearest row's level of `userId` on each page (null = none), given the pages' access states.
 * No statement at all in a workspace without rows; else cached per (page, user, version).
 */
export async function grantLevelsFor(
  exec: Exec,
  pageIds: string[],
  userId: string,
  acl: Map<string, AclState>,
): Promise<Map<string, PageAccessLevel | null>> {
  const out = new Map<string, PageAccessLevel | null>()
  if (knownWithoutRows(userId)) {
    for (const id of pageIds) out.set(id, null)
    return out
  }
  const miss: string[] = []
  for (const id of pageIds) {
    const a = acl.get(id)
    if (a && !(await workspaceHasGrants(exec, a))) {
      out.set(id, null)
      continue
    }
    const hit = a ? levelCache.get(`${id}:${userId}`) : undefined
    if (hit && a && hit.v === a.version && hit.ws === a.workspaceId) out.set(id, hit.level)
    else miss.push(id)
  }
  if (miss.length) {
    const fresh = await nearestGrants(exec, miss, userId)
    const keep = cacheable(exec)
    for (const id of miss) {
      const level = fresh.get(id)?.level ?? null
      out.set(id, level)
      const a = acl.get(id)
      if (a && keep) levelCache.set(`${id}:${userId}`, { ws: a.workspaceId, v: a.version, level })
    }
  }
  return out
}

/** Pages strictly below `rootId` that carry a row of `userId` (for subtree checks). */
export async function grantedDescendants(exec: Exec, rootId: string, userId: string): Promise<string[]> {
  const rows = (await exec.execute(sql`
    WITH RECURSIVE d(id, depth) AS (
      SELECT id, 0 FROM pages WHERE id = ${rootId}
      UNION ALL
      SELECT p.id, d.depth + 1 FROM pages p JOIN d ON p.parent_id = d.id WHERE d.depth < ${MAX_DEPTH}
    )
    SELECT d.id FROM d JOIN page_grants g ON g.page_id = d.id AND g.user_id = ${userId} WHERE d.id <> ${rootId}
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/** 403 PAGE_ACCESS: the person's level here does not allow it (phrased for people and agents). */
export function pageAccessError(level: PageAccessLevel | null, bit: number): AppError {
  const what = bit === CAP_COMMENT ? 'comment on' : 'edit'
  const have = level === 'comment' ? 'comment access' : level === 'view' ? 'view access' : 'no access'
  return new AppError(
    403,
    'PAGE_ACCESS',
    `You have ${have} to this page, so you cannot ${what} it. Ask someone with full access to change your access.`,
    undefined,
    { level },
  )
}

// ---------------------------------------------------------------------------
// Membership changes
// ---------------------------------------------------------------------------

/**
 * Removes every page row of `userId` in `workspaceId`, bumping the access version first when there
 * is one. Called when someone joins (member default replaces their guest rows) and when a member
 * leaves or is removed (a leftover row would turn them into a guest of that page: access the removal
 * meant to end). Call after lockWorkspaceMembers, before touching page rows.
 */
export async function dropWorkspaceRowsTx(
  tx: Exec,
  workspaceId: string,
  userId: string,
  opts: { bumped?: boolean } = {},
): Promise<number> {
  const [r] = (await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM page_grants g JOIN pages p ON p.id = g.page_id
                    WHERE g.user_id = ${userId} AND p.workspace_id = ${workspaceId}) AS has
  `)) as unknown as { has: boolean }[]
  if (!r?.has) return 0
  if (!opts.bumped) await bumpAcl(tx, workspaceId)
  const rows = (await tx.execute(sql`
    DELETE FROM page_grants g USING pages p
     WHERE p.id = g.page_id AND p.workspace_id = ${workspaceId} AND g.user_id = ${userId}
    RETURNING g.page_id
  `)) as unknown as { page_id: string }[]
  return rows.length
}
