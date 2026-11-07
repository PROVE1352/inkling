import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { AccessRange, AccessRangeView } from '@inkling/shared'
import { db } from './db/index'
import { pages, workspaceMembers, workspaces } from './db/schema'
import { AppError } from './errors'

/**
 * Connection range (docs/adr/1200-*, 1202-*).
 *
 * An OAuth grant or a personal API token may be limited to some workspaces or to one page's subtree.
 * The limit is carried like the agent scope of docs/adr/0947-*: `requireUser` (as a preHandler)
 * continues a bearer request inside `runInRange(scope)`, and the access checks every route already
 * goes through read it:
 *
 *   - `requireMembership` / `requireMembershipAcl` (helpers.ts): a workspace outside the range is
 *     403 OUT_OF_RANGE;
 *   - `agentAllowedSql(wsCol)` (agentAccess.ts), used by every cross-workspace list: workspace in range;
 *   - `visibleTo(userId)` (pageDto.ts), used by every page list, search, backlink and single-page
 *     guard: workspace in range and, for a subtree, `pages.id` in the root's subtree;
 *   - `pageInRangeSql(alias)` for the few raw SQL statements that spell visibility out by alias;
 *   - `assertPlacementInRange` (pageTree.ts assertPlacement) and `assertTopLevelInRange` for creates
 *     and moves.
 *
 * A request without a range (browser sessions, background jobs, connections whose range is 'all')
 * has no store, and every helper here then adds no SQL at all, so the plans and timings of those
 * requests are unchanged. The store also carries the user id: a query about another user (a
 * notification recipient computed inside the request) is never narrowed by the caller's range.
 */

export interface RangeScope {
  userId: string
  kind: 'workspaces' | 'subtree'
  /** Workspaces in range. For a subtree: the root page's current workspace, or [] when the root is gone. */
  workspaceIds: string[]
  /** Root page of a subtree range. */
  rootPageId: string | null
}

const store = new AsyncLocalStorage<RangeScope>()

/** Depth cap of the subtree walk; equals TREE_MAX_DEPTH in pageTree.ts (not imported: import cycle). Tested. */
export const RANGE_MAX_DEPTH = 64

/** Run `fn` (and everything it awaits) with `scope` as the connection range. */
export function runInRange<T>(scope: RangeScope, fn: () => T): T {
  return store.run(scope, fn)
}

/**
 * The range of the current request, or null when there is none. With `userId`, only a range that
 * belongs to that user (a query about someone else is not narrowed).
 */
export function currentRange(userId?: string): RangeScope | null {
  const s = store.getStore()
  if (!s) return null
  if (userId !== undefined && s.userId !== userId) return null
  return s
}

export const OUT_OF_RANGE_MESSAGE =
  'This connection is limited to part of your notes, and this is outside it. Change the range in Settings › Connections, or work inside the range'

/** 400 INVALID_RANGE: a chosen range names something the owner cannot see. */
export function invalidRange(message: string): AppError {
  return new AppError(400, 'INVALID_RANGE', message)
}

export function outOfRange(): AppError {
  return new AppError(403, 'OUT_OF_RANGE', OUT_OF_RANGE_MESSAGE)
}

function uuidArrayLiteral(ids: string[]): string {
  return `{${ids.join(',')}}`
}

/** SQL: `wsCol` is a workspace in the range. Plain `true` without a range. */
export function rangeWorkspaceSql(wsCol: AnyPgColumn | SQL, scope: RangeScope | null = currentRange()): SQL {
  if (!scope) return sql`true`
  if (scope.workspaceIds.length === 0) return sql`false`
  return sql`${wsCol} = ANY(${uuidArrayLiteral(scope.workspaceIds)}::uuid[])`
}

/**
 * SQL: the ids of the subtree rooted at `rootId` (inclusive), capped like every other tree walk
 * (pageTree.ts). Uncorrelated, so Postgres runs it once per statement (a hashed subplan).
 */
function subtreeIdsSql(rootId: string): SQL {
  return sql`(WITH RECURSIVE ink_range_sub(id, depth) AS (
      SELECT rr.id, 0 FROM pages rr WHERE rr.id = ${rootId}::uuid
      UNION ALL
      SELECT rc.id, rs.depth + 1 FROM pages rc JOIN ink_range_sub rs ON rc.parent_id = rs.id
       WHERE rs.depth < ${RANGE_MAX_DEPTH}
    ) SELECT id FROM ink_range_sub)`
}

/**
 * SQL: the page in `idCol` / `wsCol` is in range (workspace, and subtree when the range is one).
 * For raw statements that alias pages (`p.id`, `p.workspace_id`). Plain `true` without a range.
 */
export function pageInRangeSql(idCol: AnyPgColumn | SQL, wsCol: AnyPgColumn | SQL | null, userId?: string): SQL {
  const scope = currentRange(userId)
  if (!scope) return sql`true`
  const ws = wsCol ? rangeWorkspaceSql(wsCol, scope) : sql`true`
  if (scope.kind !== 'subtree' || !scope.rootPageId) {
    return scope.kind === 'subtree' ? sql`false` : ws
  }
  return sql`(${ws} AND ${idCol} IN ${subtreeIdsSql(scope.rootPageId)})`
}

/** The range term of `visibleTo(userId)` (pageDto.ts), or null when there is no range. */
export function visibleRangeSql(userId: string): SQL | null {
  if (!currentRange(userId)) return null
  return pageInRangeSql(pages.id, pages.workspaceId, userId)
}

/** 403 OUT_OF_RANGE when `workspaceId` is outside the current range (no-op without one). */
export function assertWorkspaceInRange(workspaceId: string, userId?: string): void {
  const scope = currentRange(userId)
  if (scope && !scope.workspaceIds.includes(workspaceId)) throw outOfRange()
}

/**
 * Creating or moving a page to the top level of a workspace (no parent) is outside every subtree
 * range: refused with 403 OUT_OF_RANGE. No-op without a range or for a workspace range.
 */
export function assertTopLevelInRange(workspaceId: string, userId?: string): void {
  const scope = currentRange(userId)
  if (!scope) return
  assertWorkspaceInRange(workspaceId, userId)
  if (scope.kind === 'subtree') throw outOfRange()
}

/**
 * Placement under a parent (pageTree.ts assertPlacement): the parent's ancestor chain must contain
 * the subtree root, and so must the moved page's. `parentChainIds` = the parent and its ancestors.
 */
export async function assertPlacementInRange(
  exec: Pick<typeof db, 'execute'>,
  workspaceId: string,
  parentChainIds: string[],
  movingId?: string,
): Promise<void> {
  const scope = currentRange()
  if (!scope) return
  assertWorkspaceInRange(workspaceId)
  if (scope.kind !== 'subtree') return
  if (!scope.rootPageId || !parentChainIds.includes(scope.rootPageId)) throw outOfRange()
  if (movingId) {
    // The moved page itself must come from inside the range (its route found it through visibleTo
    // already; this is the backstop for a route that did not).
    const rows = (await exec.execute(sql`
      SELECT ${movingId}::uuid IN ${subtreeIdsSql(scope.rootPageId)} AS inside
    `)) as unknown as { inside: boolean }[]
    if (!rows[0]?.inside) throw outOfRange()
  }
}

/**
 * Which of `ids` are in the current range (all of them without one). For answers that name pages
 * found by a walk other than visibleTo, such as the lock root above a page.
 */
export async function pageIdsInRange(ids: string[], userId?: string): Promise<Set<string>> {
  const scope = currentRange(userId)
  if (!scope || !ids.length) return new Set(ids)
  const rows = (await db.execute(sql`
    SELECT p.id FROM pages p
     WHERE p.id = ANY(${uuidArrayLiteral(ids)}::uuid[]) AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, userId)}
  `)) as unknown as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

// ---------------------------------------------------------------------------
// Stored form <-> AccessRange
// ---------------------------------------------------------------------------

export interface StoredRange {
  rangeKind: string | null
  rangeWorkspaceIds: string[] | null
  rangePageId: string | null
}

/** Columns to store for `range` (oauth_codes, oauth_grants, api_tokens). */
export function rangeToColumns(range: AccessRange): StoredRange {
  switch (range.kind) {
    case 'workspaces':
      return { rangeKind: 'workspaces', rangeWorkspaceIds: [...new Set(range.workspaceIds)].sort(), rangePageId: null }
    case 'subtree':
      return { rangeKind: 'subtree', rangeWorkspaceIds: null, rangePageId: range.pageId }
    default:
      return { rangeKind: 'all', rangeWorkspaceIds: null, rangePageId: null }
  }
}

/**
 * The stored columns as an AccessRange. Fails closed: an unknown kind, or a kind without its value,
 * reads as a range that contains nothing (an empty workspace list), never as 'all'.
 */
export function columnsToRange(c: StoredRange): AccessRange {
  if (c.rangeKind === null || c.rangeKind === 'all') return { kind: 'all' }
  if (c.rangeKind === 'subtree' && c.rangePageId) return { kind: 'subtree', pageId: c.rangePageId }
  if (c.rangeKind === 'workspaces' && c.rangeWorkspaceIds) return { kind: 'workspaces', workspaceIds: c.rangeWorkspaceIds }
  return { kind: 'workspaces', workspaceIds: [] }
}

/**
 * The request scope for a token's stored range, or null for 'all'. `rootWorkspaceId` is the root
 * page's current workspace (read in the token lookup's statement); null when the root is gone.
 */
export function scopeFromColumns(userId: string, c: StoredRange, rootWorkspaceId: string | null): RangeScope | null {
  const r = columnsToRange(c)
  if (r.kind === 'all') return null
  if (r.kind === 'workspaces') return { userId, kind: 'workspaces', workspaceIds: r.workspaceIds, rootPageId: null }
  return { userId, kind: 'subtree', workspaceIds: rootWorkspaceId ? [rootWorkspaceId] : [], rootPageId: r.pageId }
}

/** SQL selecting the root page's workspace for a row with a `range_page_id` column. */
export function rootWorkspaceSql(rangePageIdCol: AnyPgColumn): SQL<string | null> {
  return sql<string | null>`(SELECT rw.workspace_id FROM pages rw WHERE rw.id = ${rangePageIdCol})`
}

/**
 * Checks a range the signed-in owner chose (consent screen, token creation, Connections): every
 * workspace must be one they belong to and that is live; a subtree root must be a live page they can
 * see. 400 INVALID_RANGE otherwise. Runs in a browser request, so no range of its own applies.
 */
export async function validateRange(userId: string, range: AccessRange): Promise<void> {
  if (range.kind === 'all') return
  if (range.kind === 'workspaces') {
    const ids = [...new Set(range.workspaceIds)]
    const rows = await db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), inArray(workspaceMembers.workspaceId, ids), isNull(workspaces.deletedAt)))
    if (rows.length !== ids.length) throw invalidRange('Pick workspaces you are a member of')
    return
  }
  const { findVisiblePage } = await import('./pageDto')
  const page = await findVisiblePage(range.pageId, userId)
  if (!page) throw invalidRange('Pick a page you can see')
  const rows = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, page.workspaceId)))
    .limit(1)
  if (!rows.length) throw invalidRange('Pick a page you can see')
}

/** Names for the settings screens. Only what the owner can see now is named. */
export async function rangeView(userId: string, c: StoredRange): Promise<AccessRangeView> {
  const r = columnsToRange(c)
  if (r.kind === 'all') return { kind: 'all' }
  if (r.kind === 'workspaces') {
    const rows = r.workspaceIds.length
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
          .where(and(inArray(workspaces.id, r.workspaceIds), isNull(workspaces.deletedAt)))
      : []
    const names = new Map(rows.map((w) => [w.id, w.name]))
    return { kind: 'workspaces', workspaces: r.workspaceIds.map((id) => ({ id, name: names.get(id) ?? null })) }
  }
  const { findVisiblePage } = await import('./pageDto')
  const page = await findVisiblePage(r.pageId, userId).catch(() => null)
  let workspaceName: string | null = null
  if (page) {
    const [w] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId)))
      .where(eq(workspaces.id, page.workspaceId))
      .limit(1)
    workspaceName = w?.name ?? null
  }
  return {
    kind: 'subtree',
    page: {
      id: r.pageId,
      title: page && workspaceName !== null ? page.title : null,
      workspaceId: page && workspaceName !== null ? page.workspaceId : null,
      workspaceName,
    },
  }
}

/** A short string that differs per range, for result caches keyed by user (query.ts). '' = no range. */
export function rangeCacheKey(userId: string): string {
  const s = currentRange(userId)
  if (!s) return ''
  return s.kind === 'subtree' ? `t:${s.rootPageId}` : `w:${s.workspaceIds.join(',')}`
}

/** One sentence for the MCP server instructions describing the range (null for 'all'). */
export function rangeInstruction(scope: RangeScope | null): string | null {
  if (!scope) return null
  return scope.kind === 'subtree'
    ? 'This connection only sees one page and the pages under it; anything else answers OUT_OF_RANGE or not found. Create new pages under that page.'
    : 'This connection only sees some of your workspaces (list_workspaces shows them); others answer OUT_OF_RANGE.'
}
