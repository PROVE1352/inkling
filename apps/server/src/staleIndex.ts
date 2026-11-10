import { sql } from 'drizzle-orm'
import { CHUNKER_VERSION } from './context/chunker'
import { db } from './db/index'
import { docIndexIdle, scheduleDocIndex } from './docIndexer'

/**
 * Boot pass for derived indexes a crash left behind (docs/adr/1924-*).
 *
 * The docIndexer queues index passes in memory (8–30 s behind the store). A process that dies in
 * that window has stored the new state but never indexed it, and nothing would index it again until
 * the page is edited: find_context, search, backlinks, tags and tasks keep answering from the old
 * state. Each complete pass records the stored state it reflected (page_chunk_index.doc_updated_at,
 * written after the chunks); a page whose page_docs.updated_at differs gets a full pass here.
 *
 * Runs in the background after listen: one page at a time with a pause between pages, at most
 * MAX_PAGES per boot (the rest the next boot), skipping pages that already have a pass queued or
 * running in this process (a store since boot indexes them anyway). Pages without an index or with
 * an older chunker version belong to backfillPageChunks.
 */

const BATCH = 100
const MAX_PAGES = 20_000
/** Pause between two pages: at most ~10 passes a second on a large instance. */
const DEFAULT_PAUSE_MS = 100

interface Candidate {
  pageId: string
}

/** Stale pages after `after` (page id order), or among `pageIds` when given (tests). */
async function candidates(after: string | null, pageIds?: string[]): Promise<Candidate[]> {
  const scope = pageIds ? sql`AND d.page_id = ANY(${`{${pageIds.join(',')}}`}::uuid[])` : sql``
  return (await db.execute(sql`
    SELECT d.page_id AS "pageId"
      FROM page_docs d
      JOIN page_chunk_index ci ON ci.page_id = d.page_id
     WHERE ci.version = ${CHUNKER_VERSION}
       AND CASE WHEN ci.doc_updated_at IS NULL THEN d.updated_at > ci.indexed_at
                ELSE d.updated_at <> ci.doc_updated_at END
       ${after ? sql`AND d.page_id > ${after}::uuid` : sql``}
       ${scope}
     ORDER BY d.page_id
     LIMIT ${BATCH}
  `)) as unknown as Candidate[]
}

/** Re-indexes stale pages; returns how many passes it ran. `shouldStop` ends it between two pages. */
export async function reindexStalePages(
  log: (msg: string) => void,
  opts: { pageIds?: string[]; pauseMs?: number; shouldStop?: () => boolean } = {},
): Promise<number> {
  const pause = opts.pauseMs ?? DEFAULT_PAUSE_MS
  let after: string | null = null
  let done = 0
  try {
    while (done < MAX_PAGES && !opts.shouldStop?.()) {
      const batch = await candidates(after, opts.pageIds)
      if (!batch.length) break
      for (const c of batch) {
        after = c.pageId
        if (opts.shouldStop?.() || done >= MAX_PAGES) break
        if (!docIndexIdle(c.pageId)) continue
        // Re-read the state with its stamp right before the pass, so it never indexes an older state
        // than one a store committed meanwhile (that store schedules its own pass).
        const [row] = (await db.execute(sql`
          SELECT d.state, d.updated_at::text AS stamp
            FROM page_docs d JOIN page_chunk_index ci ON ci.page_id = d.page_id
           WHERE d.page_id = ${c.pageId}
             AND CASE WHEN ci.doc_updated_at IS NULL THEN d.updated_at > ci.indexed_at
                      ELSE d.updated_at <> ci.doc_updated_at END
        `)) as unknown as { state: Buffer; stamp: string }[]
        if (!row || !docIndexIdle(c.pageId)) continue
        await scheduleDocIndex(c.pageId, row.state, true, row.stamp)
        done++
        if (pause > 0) await new Promise((r) => setTimeout(r, pause).unref?.())
        else await new Promise((r) => setImmediate(r))
      }
      if (batch.length < BATCH) break
    }
    if (done > 0) log(`[inkling] re-indexed ${done} page(s) whose last index pass was lost (crash or kill)`)
  } catch (err) {
    console.error('[inkling] stale index pass failed', err)
  }
  return done
}

/** Boot hook: starts the pass after `delayMs`; the returned function stops it (shutdown). */
export function startStaleIndexPass(log: (msg: string) => void, delayMs = 10_000): () => void {
  let stopped = false
  const timer = setTimeout(() => {
    void reindexStalePages(log, { shouldStop: () => stopped })
  }, delayMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
