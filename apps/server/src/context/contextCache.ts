import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { agentAllowedSql, currentAgent } from '../agentAccess'
import { db } from '../db/index'
import { BoundedLru } from '../lru'
import { currentGuest } from '../pageGrants'
import { currentRange } from '../tokenRange'
import { twoFactorBlockedSql } from '../twoFactorPolicy'
import { chunkEpoch } from '../versions'
import { noteCacheHit, noteWorkspaces } from '../connectionUsage'
import { findContext } from './retrieve'
import type { FindContextResult } from './retrieve'
import { fuseContextResults, isMultiResult, RRF_K } from './multiQuery'
import type { ExtraList, MultiFindContextResult } from './multiQuery'
import { semanticEpoch } from './semantic'
import { archivedSql, defaultSearchScope, splitArchived } from '../workspaceListing'
import type { ArchivedWorkspace } from '../workspaceListing'

/**
 * find_context result cache (docs/adr/1550-*). Several agents of one person asking the same thing
 * within minutes is the common case; the retrieval statement is the expensive part of the call.
 *
 * What is cached: the route's FindContextResult (ranked, packed fragments). Everything per call and
 * per connection — `can:` lines, lock and instruction state, review facts, ink markers, read counters
 * — is added by the MCP layer on every call, hit or miss.
 *
 * Key: the person, every input of the permission filter, and markers of the data read:
 *   - user id; token or browser (guest workspaces are hidden from tokens, docs/adr/1253-*); the
 *     connection range (docs/adr/1200-*); the guest scope's workspaces (docs/adr/1252-*);
 *   - the searched workspaces after membership, agent blocks (0947), the 2FA rule (1112, 1300) and
 *     the range — read fresh on every call, so a removal, block or 2FA deadline is a new key;
 *   - per workspace: the access version (1071: locks, owners, moves, roles, blocks, page grants),
 *     max(updated_at, deleted_at) and the live page count (titles, privacy, trash, new pages), and
 *     the section index epoch (reindex after an edit);
 *   - the normalised query (NFKC, lower case, collapsed spaces: what retrieval itself sees) and the
 *     clamped budget.
 * The markers are read BEFORE the retrieval (version before data, as in ADR 1071): a change in
 * between can only cost a miss, never label old data with a new version.
 *
 * Sharing: never between people. Connections of one person share an entry when every input above
 * is equal — the retrieval is a function of exactly these inputs, so equal keys are equal answers.
 *
 * Per process: the section index epoch is process-local (versions.ts); Inkling runs one process.
 *
 * Several queries (docs/adr/1721-*): one marker statement for the bundle; each query is looked up
 * under exactly the key a single call with the same budget uses (so bundles and single calls share
 * entries), and the fused result is stored under a bundle key (the same inputs, the ordered query
 * list, k, a digest of any extra ranked lists and, while semantic search is on, each workspace's
 * semanticEpoch — vectors written since, docs/adr/1723-*).
 */

export const CONTEXT_CACHE_MAX_ENTRIES = 1_000
export const CONTEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024
/** Memory bound only: correctness comes from the key, not from expiry. */
export const CONTEXT_CACHE_TTL_MS = 5 * 60_000

/** Rough heap size of a result: strings count twice (UTF-16), plus a fixed overhead per item. */
function sizeOf(r: FindContextResult): number {
  let n = 256
  for (const f of r.fragments) {
    n += 256 + 2 * (f.text.length + f.title.length + f.headingPath.length)
    for (const s of f.sections) n += 128 + 2 * (s.anchor.length + s.headingPath.length + s.heading.length + s.short.length)
  }
  for (const m of r.more) n += 128 + 2 * (m.title.length + m.anchor.length + m.headingPath.length)
  for (const t of r.titleOnly) n += 96 + 2 * t.title.length
  if (isMultiResult(r)) {
    for (const q of r.queries) n += 64 + 2 * q.length
    for (const f of r.fragments) n += 32 * f.matched.length
  }
  return n
}

const cache = new BoundedLru<FindContextResult>(CONTEXT_CACHE_MAX_ENTRIES, CONTEXT_CACHE_TTL_MS, CONTEXT_CACHE_MAX_BYTES, sizeOf)

/** hits/misses: per-query entries (single calls and the queries of a bundle); batch*: bundle entries. */
export const contextCacheStats = { hits: 0, misses: 0, batchHits: 0, batchMisses: 0 }

let contextCacheEnabled = true
/** Benchmarks only: false runs the uncached path (docs/PERFORMANCE.md "before" column). */
export function setContextCacheEnabled(on: boolean): void {
  contextCacheEnabled = on
}

export function contextCacheSize(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cache.byteSize }
}

/** Tests and benchmarks: empty the cache and zero the counters. */
export function _resetContextCache(): void {
  cache.clear()
  contextCacheStats.hits = 0
  contextCacheStats.misses = 0
  contextCacheStats.batchHits = 0
  contextCacheStats.batchMisses = 0
}

/** The query as retrieval sees it (rank.ts queryGroups + phrase): two spellings, one entry. */
export function normalizeContextQuery(q: string): string {
  return q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

interface WorkspaceMarker {
  id: string
  name: string
  archived: boolean
  acl: string
  pages: string
}

/**
 * The workspaces find_context searches for `userId` (the rules of memberWorkspaceIds, retrieve.ts)
 * with their markers, in one statement. `only` = one workspace the route already checked.
 */
async function searchScope(userId: string, only: string | null): Promise<WorkspaceMarker[]> {
  const rows = (await db.execute(sql`
    SELECT wm.workspace_id AS id, w.name, ${only ? sql`false` : archivedSql(sql`wm.workspace_id`, userId)} AS archived,
           coalesce(a.version, 0)::text AS acl,
           (SELECT coalesce(max(greatest(p.updated_at, coalesce(p.deleted_at, p.updated_at)))::text, '') || '/' ||
                   count(*) FILTER (WHERE p.deleted_at IS NULL)::text
              FROM pages p WHERE p.workspace_id = wm.workspace_id) AS pages
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      LEFT JOIN workspace_acl_versions a ON a.workspace_id = wm.workspace_id
     WHERE wm.user_id = ${userId} AND w.deleted_at IS NULL AND ${agentAllowedSql(sql`wm.workspace_id`)}
       AND NOT ${twoFactorBlockedSql(sql`wm.workspace_id`, userId)}
       ${only ? sql`AND wm.workspace_id = ${only}` : sql``}
     ORDER BY wm.workspace_id
  `)) as unknown as WorkspaceMarker[]
  return rows
}

/** The permission part of the key that does not come from the database (request scopes). */
function scopeKey(userId: string): string {
  const range = currentRange(userId)
  const guest = currentGuest(userId)
  const agent = currentAgent()
  return [
    // a token request hides guest workspaces (docs/adr/1253-*); agent blocks are in the workspace list
    guest?.token || agent ? 'token' : 'browser',
    range ? `${range.kind}:${range.rootPageId ?? ''}:${[...range.workspaceIds].sort().join(',')}` : 'all',
    guest?.hasRows ? [...guest.workspaces.keys()].sort().join(',') : '',
  ].join('|')
}

/**
 * find_context through the cache. The caller has checked membership of `only` (when given).
 * Records the searched workspaces and a hit on the current connection's usage (docs/adr/1552-*).
 */
/** The searched workspaces and their markers (database first, then the in-process epochs). */
async function markersFor(userId: string, only: string | null): Promise<{ workspaceIds: string[]; markers: string[]; archived: ArchivedWorkspace[] }> {
  // Without a workspace, the ones this person archived are left out (docs/adr/2303-*); the key then
  // names fewer workspaces, so an archive change is a different entry at once.
  const { kept: scope, archived } = splitArchived(userId, await searchScope(userId, only))
  // In-process epochs after the database markers and before the retrieval (version before data).
  const markers = scope.map((w) => `${w.id}:${w.acl}:${w.pages}:${chunkEpoch(w.id)}`)
  return { workspaceIds: scope.map((w) => w.id), markers, archived }
}

/** The archived workspaces a default search left out, beside the (shared, cached) result object. */
function withArchived<T extends FindContextResult>(result: T, archived: ArchivedWorkspace[]): T {
  return archived.length ? { ...result, archived } : result
}

/** Key of one query's entry; bundles look their queries up under this same key. */
function queryKey(userId: string, budget: number, query: string, markers: string[]): string {
  const digest = createHash('sha256')
    .update([scopeKey(userId), String(budget), normalizeContextQuery(query), ...markers].join('\n'))
    .digest('base64url')
  // The person comes first and in clear, so nothing can ever match across people.
  return `${userId}|${digest}`
}

export async function cachedFindContext(userId: string, query: string, only: string | null, budget: number): Promise<FindContextResult> {
  if (!contextCacheEnabled) {
    // the path before the cache (benchmarks): membership list, then retrieval
    const { ids: workspaceIds, archived } = only ? { ids: [only], archived: [] } : await defaultSearchScope(userId)
    noteWorkspaces(workspaceIds)
    return withArchived(await findContext({ userId, query, workspaceIds, budget }), archived)
  }
  const { workspaceIds, markers, archived } = await markersFor(userId, only)
  noteWorkspaces(workspaceIds)
  const key = queryKey(userId, budget, query, markers)
  const hit = cache.get(key)
  if (hit) {
    contextCacheStats.hits++
    noteCacheHit()
    return withArchived(hit, archived)
  }
  contextCacheStats.misses++
  const result = await findContext({ userId, query, workspaceIds, budget })
  cache.set(key, result)
  return withArchived(result, archived)
}

export interface MultiContextOptions {
  k?: number
  /**
   * Extra ranked lists fused with the per-query lists (docs/adr/1722-*), e.g. semanticCandidates()
   * of context/semantic.ts for each query. Called once per bundle after the markers are read, with
   * the workspaces this person may search; return [] when the feature is off.
   */
  extraLists?: (scope: { userId: string; workspaceIds: string[]; queries: string[] }) => Promise<ExtraList[]>
}

/**
 * find_context for several queries (docs/adr/1720-*, 1721-*): each query through the per-query
 * cache entries (shared with single calls of the same budget), merged by RRF under one budget, the
 * merged result cached under a bundle key. `queries` are already de-duplicated (2..MAX_QUERIES).
 */
export async function cachedFindContextMulti(
  userId: string,
  queries: string[],
  only: string | null,
  budget: number,
  opts: MultiContextOptions = {},
): Promise<MultiFindContextResult> {
  const k = opts.k ?? RRF_K
  if (!contextCacheEnabled) {
    const { ids: workspaceIds, archived } = only ? { ids: [only], archived: [] } : await defaultSearchScope(userId)
    noteWorkspaces(workspaceIds)
    const perQuery = await Promise.all(queries.map((query) => findContext({ userId, query, workspaceIds, budget })))
    const extra = (await opts.extraLists?.({ userId, workspaceIds, queries })) ?? []
    return withArchived(fuseContextResults(perQuery, { queries, budget: perQuery[0].budget, k, extra }), archived)
  }
  const { workspaceIds, markers, archived } = await markersFor(userId, only)
  noteWorkspaces(workspaceIds)
  // Vectors written in this process (docs/adr/1723-*); none while semantic search is off.
  const semMarkers = workspaceIds.flatMap((w) => (semanticEpoch(w) ? [`sem ${w}:${semanticEpoch(w)}`] : []))
  // Extra lists after the markers (version before data); their content is part of the bundle key.
  const extra = (await opts.extraLists?.({ userId, workspaceIds, queries })) ?? []
  const digest = createHash('sha256')
    .update(
      [
        scopeKey(userId),
        String(budget),
        `multi k=${k}`,
        JSON.stringify(queries.map(normalizeContextQuery)),
        extra.length ? createHash('sha256').update(JSON.stringify(extra)).digest('base64url') : '',
        ...markers,
        ...semMarkers,
      ].join('\n'),
    )
    .digest('base64url')
  const bundleKey = `${userId}|m|${digest}`
  const hit = cache.get(bundleKey)
  if (hit && isMultiResult(hit)) {
    contextCacheStats.batchHits++
    noteCacheHit()
    return withArchived(hit, archived)
  }
  contextCacheStats.batchMisses++
  let computed = 0
  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const key = queryKey(userId, budget, query, markers)
      const one = cache.get(key)
      if (one) {
        contextCacheStats.hits++
        return one
      }
      contextCacheStats.misses++
      computed++
      const result = await findContext({ userId, query, workspaceIds, budget })
      cache.set(key, result)
      return result
    }),
  )
  // No retrieval statement ran: the connection's usage counts the call as a cache hit.
  if (computed === 0) noteCacheHit()
  const result = fuseContextResults(perQuery, { queries, budget: perQuery[0].budget, k, extra })
  cache.set(bundleKey, result)
  return withArchived(result, archived)
}
