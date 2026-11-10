/**
 * Optional semantic search: background indexer (docs/adr/1742-*). Started from index.ts only when
 * EMBEDDING_URL and EMBEDDING_MODEL are set; nothing here runs otherwise.
 *
 * Not a hook in the section-index writer: a polling loop compares page_chunks with the stored
 * vectors (text hash + model + dims) and embeds what is missing, newest pages first. Saves and
 * reindexing never wait for it, and it never holds a transaction across a request.
 *
 * - Rate: at most EMBEDDING_REQUESTS_PER_MINUTE requests, EMBEDDING_BATCH_SIZE chunks each, one in flight.
 * - Idle: when the last pass found nothing and no index changed since (indexEpoch), no query runs;
 *   a full check still runs every 5 minutes (restored pages, a model change).
 * - Failure: the endpoint backs off exponentially (5 s → 10 min, Retry-After honoured) for
 *   searches and the indexer alike. A chunk the endpoint refuses (400/413/422) is retried alone
 *   once, then skipped until restart (counted in the admin status).
 * - Clean-up: every 10 minutes, vectors whose text no longer matches any chunk of their page, or of
 *   another model, are deleted in bounded batches.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { indexEpoch } from '../versions'
import { EmbeddingError, embedTexts, embeddingHealth, inBackoff, recordFailure, recordSuccess } from './embeddings'
import type { SemanticConfig } from './semanticConfig'
import { endpointLabel, semanticConfig } from './semanticConfig'
import { bumpVectorEpoch, chunkEmbedText, chunkTextHash, cutChars, registerRejectedCount, TEXT_HASH_SQL } from './semantic'

const IDLE_MS = 5_000
const FULL_CHECK_MS = 5 * 60_000
const GC_EVERY_MS = 10 * 60_000
const GC_BATCH = 2_000
/** Pending rows read per scan (several requests' worth). */
const SCAN_BATCHES = 8
const MAX_REJECTED = 10_000

/** Hashes the endpoint refused alone (skipped until restart) and ones to retry alone first. */
const rejected = new Set<string>()
const suspect = new Set<string>()
registerRejectedCount(() => rejected.size)

export const indexerStats = { passes: 0, scans: 0, requests: 0, embedded: 0, deleted: 0 }

let lastRequestAt = 0

interface PendingRow {
  pageId: string
  workspaceId: string
  title: string | null
  headingPath: string
  text: string
  hash: string
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve()
    const t = setTimeout(done, ms)
    t.unref?.()
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

async function pendingChunks(cfg: SemanticConfig, limit: number, workspaceIds?: string[]): Promise<PendingRow[]> {
  const dims = cfg.dimensions ?? embeddingHealth.dims
  const skip = [...rejected]
  indexerStats.scans++
  return (await db.execute(sql`
    WITH cur AS (
      SELECT c.page_id, c.ord, c.workspace_id, p.updated_at, ${TEXT_HASH_SQL} AS h
        FROM page_chunks c JOIN pages p ON p.id = c.page_id JOIN workspaces w ON w.id = c.workspace_id
       WHERE p.deleted_at IS NULL AND w.deleted_at IS NULL
         ${workspaceIds ? sql`AND c.workspace_id = ANY(${`{${workspaceIds.join(',')}}`}::uuid[])` : sql``}
    ),
    todo AS (
      SELECT cur.* FROM cur
       WHERE NOT EXISTS (SELECT 1 FROM page_chunk_vectors v
                          WHERE v.page_id = cur.page_id AND v.text_hash = cur.h AND v.model = ${cfg.model}
                            ${dims ? sql`AND v.dims = ${dims}` : sql``})
         ${skip.length ? sql`AND NOT (cur.h = ANY(${`{${skip.join(',')}}`}::text[]))` : sql``}
       ORDER BY cur.updated_at DESC, cur.page_id, cur.ord
       LIMIT ${limit}
    )
    SELECT todo.page_id AS "pageId", todo.workspace_id AS "workspaceId", p.title,
           c.heading_path AS "headingPath", c.text, todo.h AS hash
      FROM todo JOIN page_chunks c ON c.page_id = todo.page_id AND c.ord = todo.ord
      JOIN pages p ON p.id = todo.page_id
     ORDER BY todo.updated_at DESC, todo.page_id, todo.ord
  `)) as unknown as PendingRow[]
}

async function writeVectors(cfg: SemanticConfig, rows: PendingRow[], vectors: Float32Array[]): Promise<void> {
  const byKey = new Map<string, { row: PendingRow; vec: Float32Array }>()
  rows.forEach((row, i) => byKey.set(`${row.pageId}\u0000${row.hash}`, { row, vec: vectors[i] }))
  const values = [...byKey.values()]
  if (!values.length) return
  const tuples = sql.join(
    values.map(
      ({ row, vec }) =>
        sql`(${row.pageId}::uuid, ${row.hash}::text, ${row.workspaceId}::uuid, ${cfg.model}::text, ${vec.length}::int, ${`{${Array.from(vec).join(',')}}`}::real[], now())`,
    ),
    sql`, `,
  )
  // the page may have been purged since the scan: insert only rows whose page still exists
  await db.execute(sql`
    INSERT INTO page_chunk_vectors (page_id, text_hash, workspace_id, model, dims, embedding, updated_at)
    SELECT t.page_id, t.text_hash, t.workspace_id, t.model, t.dims, t.embedding, t.updated_at
      FROM (VALUES ${tuples}) AS t(page_id, text_hash, workspace_id, model, dims, embedding, updated_at)
      JOIN pages p ON p.id = t.page_id AND p.workspace_id = t.workspace_id
    ON CONFLICT (page_id, text_hash) DO UPDATE
      SET workspace_id = excluded.workspace_id, model = excluded.model, dims = excluded.dims,
          embedding = excluded.embedding, updated_at = excluded.updated_at
  `)
  for (const ws of new Set(values.map((v) => v.row.workspaceId))) bumpVectorEpoch(ws)
}

async function rateLimit(cfg: SemanticConfig, signal?: AbortSignal): Promise<void> {
  const gap = 60_000 / cfg.requestsPerMinute
  const wait = lastRequestAt + gap - Date.now()
  if (wait > 0) await sleep(wait, signal)
  lastRequestAt = Date.now()
}

/**
 * One pass: reads pending chunks (up to SCAN_BATCHES requests' worth) and embeds them batch by
 * batch at the configured rate. Stops at the first failure (backoff). `more` = work may remain.
 */
export async function runSemanticIndexPass(
  signal?: AbortSignal,
  /** Tests only: limit the pass to these workspaces (the database is shared with other suites). */
  workspaceIds?: string[],
): Promise<{ embedded: number; more: boolean }> {
  const cfg = semanticConfig()
  if (!cfg) return { embedded: 0, more: false }
  indexerStats.passes++
  if (inBackoff()) return { embedded: 0, more: true }
  const scanLimit = cfg.batchSize * SCAN_BATCHES
  const rows = await pendingChunks(cfg, scanLimit, workspaceIds)
  let embedded = 0
  let i = 0
  while (i < rows.length) {
    if (signal?.aborted) return { embedded, more: true }
    // a chunk under suspicion goes alone, so one bad input cannot block its neighbours
    const batch = suspect.has(rows[i].hash) ? [rows[i]] : takeBatch(rows, i, cfg.batchSize)
    await rateLimit(cfg, signal)
    if (signal?.aborted) return { embedded, more: true }
    try {
      indexerStats.requests++
      const inputs = batch.map((r) => cutChars(chunkEmbedText(r.title, r.headingPath, r.text), cfg.maxChars))
      const vectors = await embedTexts(cfg, inputs, cfg.timeoutMs)
      // the hash is of the text actually sent (the chunk may have changed since the scan)
      const sent = batch.map((r) => ({ ...r, hash: chunkTextHash(r.title, r.headingPath, r.text) }))
      await writeVectors(cfg, sent, vectors)
      recordSuccess(vectors[0]?.length ?? embeddingHealth.dims ?? 0)
      for (const r of batch) suspect.delete(r.hash)
      embedded += batch.length
      indexerStats.embedded += batch.length
    } catch (err) {
      recordFailure(err)
      if (err instanceof EmbeddingError && err.inputRejected) {
        if (batch.length === 1) {
          suspect.delete(batch[0].hash)
          if (rejected.size < MAX_REJECTED) rejected.add(batch[0].hash)
        } else {
          for (const r of batch) suspect.add(r.hash)
        }
        return { embedded, more: true }
      }
      if (!(err instanceof EmbeddingError)) {
        console.error('[inkling] semantic index pass failed', err instanceof Error ? err.message : err)
      }
      return { embedded, more: true }
    }
    i += batch.length
  }
  return { embedded, more: rows.length >= scanLimit }
}

/** Next batch from `i`, leaving out suspects (they go alone). */
function takeBatch(rows: PendingRow[], i: number, size: number): PendingRow[] {
  const out: PendingRow[] = []
  for (let j = i; j < rows.length && out.length < size; j++) {
    if (suspect.has(rows[j].hash)) break
    out.push(rows[j])
  }
  return out
}

/** Deletes vectors of other models and vectors whose text matches no current chunk of their page. */
export async function collectStaleVectors(batch = GC_BATCH): Promise<number> {
  const cfg = semanticConfig()
  if (!cfg) return 0
  let total = 0
  for (let round = 0; round < 50; round++) {
    const rows = (await db.execute(sql`
      WITH cur AS (
        -- DISTINCT: two chunks of one page with the same text share a vector; without it the join
        -- below repeats that vector and a batch deletes fewer rows than it selected
        SELECT DISTINCT c.page_id, ${TEXT_HASH_SQL} AS h FROM page_chunks c JOIN pages p ON p.id = c.page_id
      ),
      gone AS (
        SELECT v.page_id, v.text_hash FROM page_chunk_vectors v
          LEFT JOIN cur ON cur.page_id = v.page_id AND cur.h = v.text_hash
         WHERE cur.page_id IS NULL OR v.model <> ${cfg.model}
         LIMIT ${batch}
      )
      DELETE FROM page_chunk_vectors v USING gone
       WHERE v.page_id = gone.page_id AND v.text_hash = gone.text_hash
      RETURNING v.workspace_id AS "workspaceId"
    `)) as unknown as { workspaceId: string }[]
    total += rows.length
    for (const ws of new Set(rows.map((r) => r.workspaceId))) bumpVectorEpoch(ws, true)
    // until a round finds nothing (a short round is not proof: rows may vanish concurrently)
    if (rows.length === 0) break
    await new Promise((r) => setImmediate(r))
  }
  indexerStats.deleted += total
  return total
}

/**
 * Starts the loop; returns stop(). A no-op (and no timer) when semantic search is off, so callers
 * may call it unconditionally — index.ts still only imports this module when it is on.
 */
export function startSemanticIndexer(log: (msg: string) => void = console.log): () => Promise<void> {
  const cfg = semanticConfig()
  if (!cfg) return async () => {}
  const ctrl = new AbortController()
  log(
    `[inkling] semantic search: on — model ${cfg.model} at ${endpointLabel(cfg.endpoint)}, ` +
      `${cfg.batchSize} chunks/request, ${cfg.requestsPerMinute} requests/min`,
  )
  const loop = (async () => {
    // let the boot backfills of the section index go first
    await sleep(5_000, ctrl.signal)
    let lastEpoch = ''
    let idle = false
    let lastFull = 0
    let lastGc = Date.now()
    let reportedError: string | null = null
    while (!ctrl.signal.aborted) {
      try {
        if (inBackoff()) {
          const err = embeddingHealth.lastError?.message ?? null
          if (err && err !== reportedError) log(`[inkling] semantic index: ${err}; retrying later`)
          reportedError = err
          await sleep(Math.min(30_000, embeddingHealth.backoffUntil - Date.now()), ctrl.signal)
          continue
        }
        const epoch = indexEpoch()
        const now = Date.now()
        if (idle && epoch === lastEpoch && now - lastFull < FULL_CHECK_MS) {
          await sleep(IDLE_MS, ctrl.signal)
          continue
        }
        const r = await runSemanticIndexPass(ctrl.signal)
        if (r.embedded > 0) reportedError = null
        lastEpoch = epoch
        idle = !r.more
        if (idle) lastFull = now
        if (Date.now() - lastGc > GC_EVERY_MS) {
          lastGc = Date.now()
          await collectStaleVectors()
        }
        if (idle) await sleep(IDLE_MS, ctrl.signal)
      } catch (err) {
        // database trouble: wait and try again; searches and saves are not affected
        console.error('[inkling] semantic indexer error', err instanceof Error ? err.message : err)
        await sleep(30_000, ctrl.signal)
      }
    }
  })()
  return async () => {
    ctrl.abort()
    await loop
  }
}

/** Tests only. */
export function resetIndexerForTests(): void {
  rejected.clear()
  suspect.clear()
  lastRequestAt = 0
}
