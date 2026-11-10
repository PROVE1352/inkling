/**
 * Optional semantic search: query side (docs/adr/1740-*–1743-*).
 *
 * semanticCandidates() is the one entry point for retrieval. Off (no EMBEDDING_URL/MODEL) it
 * returns null before touching the database or the network. On, it
 *   1. keeps only the given workspaces the user is a live member of (agent blocks, connection
 *      range and two-step requirement as in memberWorkspaceIds, retrieve.ts),
 *   2. embeds the query (one request, short timeout, small cache; null while the endpoint backs off),
 *   3. lists the pages the user can see there (live, visibleTo rule incl. connection range/guest scope),
 *   4. scores the stored vectors of those pages only — brute-force dot products over L2-normalised
 *      vectors, from an in-process cache (or SQL when a workspace does not fit the cache),
 *   5. maps the best vectors back to current chunks (vectors of edited text are skipped) and returns
 *      one row per section (page, anchor) with its best score.
 * Any failure returns null: the caller then answers from lexical search alone.
 */
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '../db/index'
import { agentAllowedSql } from '../agentAccess'
import { pageInRangeSql } from '../tokenRange'
import { twoFactorBlockedSql } from '../twoFactorPolicy'
import { BoundedLru } from '../lru'
import { embedTexts, embeddingHealth, inBackoff, recordFailure, recordSuccess } from './embeddings'
import type { SemanticConfig } from './semanticConfig'
import { endpointLabel, semanticConfig } from './semanticConfig'

export interface SemanticCandidate {
  pageId: string
  /** Section anchor (as in page_chunks / find_context). */
  anchor: string | null
  /** Cosine similarity of the section's best chunk, in [-1, 1]. */
  score: number
}

/** Counters for tests and the admin status (process-local). */
export const semanticStats = { calls: 0, dbQueries: 0, cacheLoads: 0, sqlScans: 0 }

// ---------------------------------------------------------------------------
// Embedded text: the same string is hashed in Node and in SQL (md5 over UTF-8 text)
// ---------------------------------------------------------------------------

/** The text a chunk is embedded from (before the length cut): page title, heading path, chunk text. */
export function chunkEmbedText(title: string | null, headingPath: string, text: string): string {
  return `${title ?? ''}\n${headingPath}\n${text}`
}

export function chunkTextHash(title: string | null, headingPath: string, text: string): string {
  return createHash('md5').update(chunkEmbedText(title, headingPath, text), 'utf8').digest('hex')
}

/** SQL twin of chunkTextHash over `p` (pages) and `c` (page_chunks). */
export const TEXT_HASH_SQL = sql`md5(coalesce(p.title, '') || chr(10) || c.heading_path || chr(10) || c.text)`

/** At most `maxChars` code points (never splits a surrogate pair). */
export function cutChars(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return Array.from(s).slice(0, maxChars).join('')
}

// ---------------------------------------------------------------------------
// Permission filters (the same rules as find_context, retrieve.ts)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

/** visibleTo() (pageDto.ts) over the alias `p`, connection range and guest scope included — as retrieve.ts visibleSql. */
function visibleSql(userId: string): SQL {
  return sql`(p.scope = 'shared' OR (p.scope = 'private' AND p.created_by = ${userId})) AND ${pageInRangeSql(sql`p.id`, sql`p.workspace_id`, userId)}`
}

async function run<T>(q: SQL): Promise<T[]> {
  semanticStats.dbQueries++
  return (await db.execute(q)) as unknown as T[]
}

/** Of `ids`: live workspaces the user is a member of and may reach with this connection. */
async function allowedWorkspaces(userId: string, ids: string[]): Promise<string[]> {
  const valid = [...new Set(ids.filter((id) => UUID_RE.test(id)))]
  if (!valid.length || !UUID_RE.test(userId)) return []
  const rows = await run<{ id: string }>(sql`
    SELECT w.id FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ${userId}
     WHERE w.id = ANY(${uuidArray(valid)}::uuid[]) AND w.deleted_at IS NULL
       AND ${agentAllowedSql(sql`w.id`)}
       AND NOT ${twoFactorBlockedSql(sql`w.id`, userId)}
     ORDER BY w.id
  `)
  return rows.map((r) => r.id)
}

/** Live pages of `ws` the user can see and that have at least one stored vector. */
async function visiblePages(userId: string, ws: string[]): Promise<Set<string>> {
  const rows = await run<{ id: string }>(sql`
    SELECT p.id FROM pages p
     WHERE p.workspace_id = ANY(${uuidArray(ws)}::uuid[]) AND p.deleted_at IS NULL AND ${visibleSql(userId)}
       AND EXISTS (SELECT 1 FROM page_chunk_vectors v WHERE v.page_id = p.id)
  `)
  return new Set(rows.map((r) => r.id))
}

// ---------------------------------------------------------------------------
// Query embedding (cached per text; a failed or backed-off endpoint answers null)
// ---------------------------------------------------------------------------

const queryVectors = new BoundedLru<Float32Array>(256, 10 * 60_000)

async function queryVector(cfg: SemanticConfig, query: string): Promise<Float32Array | null> {
  const text = cutChars(query.normalize('NFKC').replace(/\s+/g, ' ').trim(), cfg.maxChars)
  const key = `${cfg.model}\u0000${cfg.dimensions ?? ''}\u0000${text}`
  const hit = queryVectors.get(key)
  if (hit) return hit
  if (inBackoff()) return null
  try {
    const [v] = await embedTexts(cfg, [text], cfg.queryTimeoutMs)
    recordSuccess(v.length)
    queryVectors.set(key, v)
    return v
  } catch (err) {
    recordFailure(err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Vector cache per workspace
// ---------------------------------------------------------------------------

interface CachedVector {
  pageId: string
  hash: string
  vec: Float32Array
}

interface WsCache {
  model: string
  entries: Map<string, CachedVector>
  /** Newest updated_at loaded (ISO), for incremental loads. */
  since: string | null
  /** vectorEpoch() the cache reflects. */
  epoch: number
  bytes: number
  lastUsed: number
}

const caches = new Map<string, WsCache>()
const loading = new Map<string, Promise<WsCache | null>>()
const vectorEpochs = new Map<string, { n: number; full: boolean }>()
/** Workspaces whose vectors do not fit the cache: scored in SQL. */
const tooBig = new Map<string, number>()

/** Called by the indexer after writing (full = rows were deleted, reload instead of adding). */
export function bumpVectorEpoch(workspaceId: string, full = false): void {
  const e = vectorEpochs.get(workspaceId) ?? { n: 0, full: false }
  vectorEpochs.set(workspaceId, { n: e.n + 1, full: e.full || full })
}

function epochOf(ws: string): number {
  return vectorEpochs.get(ws)?.n ?? 0
}

/**
 * Marker for result caches that fuse semantic candidates (find_context cache, docs/adr/1550-*):
 * changes when the indexer wrote or deleted vectors of the workspace in this process. '' when off.
 */
export function semanticEpoch(workspaceId: string): string {
  const cfg = semanticConfig()
  return cfg ? `${cfg.model}:${epochOf(workspaceId)}` : ''
}

function cacheBytes(): number {
  let n = 0
  for (const c of caches.values()) n += c.bytes
  return n
}

/** Overlap of incremental loads: rows written by a transaction that started before the last load. */
const LOAD_OVERLAP = '60 seconds'

async function loadWorkspace(cfg: SemanticConfig, ws: string, dims: number): Promise<WsCache | null> {
  const epoch = epochOf(ws)
  let c = caches.get(ws)
  const full = !c || c.model !== cfg.model || vectorEpochs.get(ws)?.full === true
  if (full) {
    const [size] = await run<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM page_chunk_vectors WHERE workspace_id = ${ws} AND model = ${cfg.model} AND dims = ${dims}
    `)
    const need = (size?.n ?? 0) * (dims * 4 + 160)
    if (need > cfg.cacheBytes) {
      caches.delete(ws)
      tooBig.set(ws, epoch)
      return null
    }
    // make room: least recently used workspaces go first
    let total = cacheBytes() - (c?.bytes ?? 0)
    for (const [id, other] of [...caches.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (total + need <= cfg.cacheBytes) break
      if (id === ws) continue
      caches.delete(id)
      total -= other.bytes
    }
    c = { model: cfg.model, entries: new Map(), since: null, epoch, bytes: 0, lastUsed: Date.now() }
    const e = vectorEpochs.get(ws)
    if (e) e.full = false
  }
  const cache = c!
  semanticStats.cacheLoads++
  const rows = await run<{ pageId: string; hash: string; embedding: number[]; at: string }>(sql`
    SELECT page_id AS "pageId", text_hash AS hash, embedding, updated_at::text AS at
      FROM page_chunk_vectors
     WHERE workspace_id = ${ws} AND model = ${cfg.model} AND dims = ${dims}
       ${cache.since ? sql`AND updated_at > ${cache.since}::timestamptz - interval '${sql.raw(LOAD_OVERLAP)}'` : sql``}
  `)
  for (const r of rows) {
    const key = `${r.pageId}\u0000${r.hash}`
    if (!cache.entries.has(key)) cache.bytes += dims * 4 + 160
    cache.entries.set(key, { pageId: r.pageId, hash: r.hash, vec: Float32Array.from(r.embedding) })
    if (!cache.since || r.at > cache.since) cache.since = r.at
  }
  cache.epoch = epoch
  caches.set(ws, cache)
  if (cache.bytes > cfg.cacheBytes) {
    // grew past the budget through incremental loads
    caches.delete(ws)
    tooBig.set(ws, epoch)
    return null
  }
  tooBig.delete(ws)
  return cache
}

async function workspaceCache(cfg: SemanticConfig, ws: string, dims: number): Promise<WsCache | null> {
  const c = caches.get(ws)
  const epoch = epochOf(ws)
  if (c && c.epoch === epoch && c.model === cfg.model) {
    c.lastUsed = Date.now()
    return c
  }
  if (!c && tooBig.get(ws) === epoch) return null
  const key = `${ws}:${epoch}`
  let p = loading.get(key)
  if (!p) {
    p = loadWorkspace(cfg, ws, dims).finally(() => loading.delete(key))
    loading.set(key, p)
  }
  return p
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

interface Scored {
  pageId: string
  hash: string
  score: number
}

function byScore(a: Scored, b: Scored): number {
  return b.score - a.score || (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
}

/** SQL scoring for a workspace that does not fit the cache (same visibility, ordered, bounded). */
async function scoreInSql(cfg: SemanticConfig, ws: string, userId: string, q: Float32Array, n: number): Promise<Scored[]> {
  semanticStats.sqlScans++
  const lit = `{${Array.from(q).join(',')}}`
  const rows = await run<{ pageId: string; hash: string; score: number }>(sql`
    SELECT v.page_id AS "pageId", v.text_hash AS hash,
           (SELECT sum(a * b) FROM unnest(v.embedding, ${lit}::real[]) t(a, b))::float8 AS score
      FROM page_chunk_vectors v JOIN pages p ON p.id = v.page_id
     WHERE v.workspace_id = ${ws} AND v.model = ${cfg.model} AND v.dims = ${q.length}
       AND p.deleted_at IS NULL AND ${visibleSql(userId)}
     ORDER BY score DESC, v.page_id, v.text_hash
     LIMIT ${n}
  `)
  return rows.map((r) => ({ pageId: r.pageId, hash: r.hash, score: Number(r.score) }))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Scored vectors looked at per round when mapping back to sections. */
const WINDOW = 200
const MAX_ROUNDS = 5

export async function semanticCandidates(args: {
  workspaceIds: string[]
  query: string
  limit: number
  userId: string
}): Promise<Array<{ pageId: string; anchor: string | null; score: number }> | null> {
  const cfg = semanticConfig()
  if (!cfg) return null
  semanticStats.calls++
  try {
    const limit = Math.min(200, Math.max(0, Math.floor(args.limit)))
    if (limit === 0 || !args.query.trim() || args.workspaceIds.length === 0) return []
    const ws = await allowedWorkspaces(args.userId, args.workspaceIds)
    if (!ws.length) return []
    const q = await queryVector(cfg, args.query)
    if (!q) return null
    const visible = await visiblePages(args.userId, ws)
    if (!visible.size) return []

    // score every visible vector (cache), or the best ones per workspace (SQL fallback)
    const scored: Scored[] = []
    for (const id of ws) {
      const cache = cfg.cacheBytes > 0 ? await workspaceCache(cfg, id, q.length) : null
      if (cache) {
        for (const e of cache.entries.values()) {
          if (e.vec.length !== q.length || !visible.has(e.pageId)) continue
          scored.push({ pageId: e.pageId, hash: e.hash, score: dot(q, e.vec) })
        }
      } else {
        scored.push(...(await scoreInSql(cfg, id, args.userId, q, WINDOW * MAX_ROUNDS)))
      }
    }
    scored.sort(byScore)

    // back to current chunks and sections; visibility checked again in the same statement
    const out: SemanticCandidate[] = []
    const seen = new Set<string>()
    for (let round = 0; round < MAX_ROUNDS && out.length < limit; round++) {
      const slice = scored.slice(round * WINDOW, (round + 1) * WINDOW)
      if (!slice.length) break
      const pageIds = [...new Set(slice.map((s) => s.pageId))]
      const hashes = [...new Set(slice.map((s) => s.hash))]
      const rows = await run<{ pageId: string; anchor: string; ord: number; hash: string }>(sql`
        SELECT c.page_id AS "pageId", c.anchor, c.ord, ${TEXT_HASH_SQL} AS hash
          FROM page_chunks c JOIN pages p ON p.id = c.page_id
         WHERE c.page_id = ANY(${uuidArray(pageIds)}::uuid[])
           AND p.workspace_id = ANY(${uuidArray(ws)}::uuid[]) AND p.deleted_at IS NULL AND ${visibleSql(args.userId)}
           AND ${TEXT_HASH_SQL} = ANY(${`{${hashes.join(',')}}`}::text[])
         ORDER BY c.page_id, c.ord
      `)
      const anchorsOf = new Map<string, string[]>()
      for (const r of rows) {
        const key = `${r.pageId}\u0000${r.hash}`
        const list = anchorsOf.get(key) ?? []
        if (!list.includes(r.anchor)) list.push(r.anchor)
        anchorsOf.set(key, list)
      }
      for (const s of slice) {
        for (const anchor of anchorsOf.get(`${s.pageId}\u0000${s.hash}`) ?? []) {
          const key = `${s.pageId}#${anchor}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ pageId: s.pageId, anchor, score: s.score })
          if (out.length >= limit) break
        }
        if (out.length >= limit) break
      }
    }
    return out
  } catch (err) {
    console.error('[inkling] semantic search failed; lexical results only', err instanceof Error ? err.message : err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Admin status (GET /api/admin/status → `semantic`, only while the feature is on)
// ---------------------------------------------------------------------------

export interface SemanticStatusDTO {
  enabled: true
  model: string
  /** Host and path only: never credentials, query strings or the API key. */
  endpoint: string
  dims: number | null
  sections: { indexed: number; pending: number }
  chunks: { indexed: number; pending: number; rejected: number }
  lastError: { at: string; message: string } | null
  lastSuccessAt: string | null
  backoffUntil: string | null
  cache: { workspaces: number; bytes: number }
}

let statusCache: { at: number; counts: { si: number; sp: number; ci: number; cp: number } } | null = null
const STATUS_TTL_MS = 30_000

/** Rejected chunk count is owned by the indexer; it registers a getter (no import cycle). */
let rejectedCount: () => number = () => 0
export function registerRejectedCount(fn: () => number): void {
  rejectedCount = fn
}

export async function semanticStatus(now = Date.now()): Promise<SemanticStatusDTO | null> {
  const cfg = semanticConfig()
  if (!cfg) return null
  if (!statusCache || now - statusCache.at > STATUS_TTL_MS) {
    const dims = embeddingHealth.dims
    const [r] = await run<{ si: number; sp: number; ci: number; cp: number }>(sql`
      WITH cur AS (
        SELECT c.page_id, c.anchor,
               EXISTS (SELECT 1 FROM page_chunk_vectors v
                        WHERE v.page_id = c.page_id AND v.text_hash = ${TEXT_HASH_SQL} AND v.model = ${cfg.model}
                          ${dims ? sql`AND v.dims = ${dims}` : sql``}) AS ok
          FROM page_chunks c JOIN pages p ON p.id = c.page_id JOIN workspaces w ON w.id = c.workspace_id
         WHERE p.deleted_at IS NULL AND w.deleted_at IS NULL
      ),
      s AS (SELECT page_id, anchor, bool_and(ok) AS done FROM cur GROUP BY page_id, anchor)
      SELECT (SELECT count(*) FROM s WHERE done)::int AS si, (SELECT count(*) FROM s WHERE NOT done)::int AS sp,
             (SELECT count(*) FROM cur WHERE ok)::int AS ci, (SELECT count(*) FROM cur WHERE NOT ok)::int AS cp
    `)
    statusCache = { at: now, counts: r ?? { si: 0, sp: 0, ci: 0, cp: 0 } }
  }
  const c = statusCache.counts
  return {
    enabled: true,
    model: cfg.model,
    endpoint: endpointLabel(cfg.endpoint),
    dims: embeddingHealth.dims,
    sections: { indexed: c.si, pending: c.sp },
    chunks: { indexed: c.ci, pending: c.cp, rejected: rejectedCount() },
    lastError: embeddingHealth.lastError,
    lastSuccessAt: embeddingHealth.lastSuccessAt,
    backoffUntil: embeddingHealth.backoffUntil > now ? new Date(embeddingHealth.backoffUntil).toISOString() : null,
    cache: { workspaces: caches.size, bytes: cacheBytes() },
  }
}

/** Tests only: forget cached vectors, query embeddings and status counts. */
export function resetSemanticCachesForTests(): void {
  caches.clear()
  loading.clear()
  tooBig.clear()
  vectorEpochs.clear()
  queryVectors.clear()
  statusCache = null
}
