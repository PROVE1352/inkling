import { sql } from 'drizzle-orm'
import { db } from './db/index'

/**
 * Page read counters (docs/adr/0953-*): how often a page is read, per server-local day, by people
 * (web views) and agents (read_page / read_pages / find_context results). Only page totals are
 * kept — never who read what. Reads are counted in memory and written in one upsert per flush,
 * so a busy page costs one row update a minute instead of one per view.
 */

/** Buffered keys before new pages are dropped until the next flush (memory bound). */
const MAX_BUFFERED_KEYS = 50_000
/** Upper bound of one page's count for one day (a loop cannot grow it without limit). */
export const DAILY_READ_CAP = 100_000
export const READ_RETENTION_DAYS = 90
const FLUSH_INTERVAL_MS = 60_000
const FLUSH_CHUNK = 1_000

const pad = (n: number): string => String(n).padStart(2, '0')
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

let buffer = new Map<string, number>()
let dropped = 0

/** Count one read of each page (duplicates in one call count once). Never throws, never waits. */
export function countReads(pageIds: Iterable<string>, now = new Date()): void {
  const day = localDay(now)
  for (const id of new Set(pageIds)) {
    const key = `${id}|${day}`
    const cur = buffer.get(key)
    if (cur === undefined && buffer.size >= MAX_BUFFERED_KEYS) {
      dropped++
      continue
    }
    buffer.set(key, Math.min((cur ?? 0) + 1, DAILY_READ_CAP))
  }
}

/** Buffered (not yet written) counts — for tests and diagnostics. */
export function _bufferedReads(): number {
  return buffer.size
}

/**
 * Write the buffer: one upsert per chunk, capped per day; reads of pages deleted meanwhile are
 * skipped by the join. On failure the counts go back into the buffer. Returns rows written.
 */
export async function flushReads(log: (msg: string) => void = () => {}): Promise<number> {
  if (buffer.size === 0) return 0
  const batch = buffer
  buffer = new Map()
  if (dropped > 0) {
    log(`[inkling] page read counter: ${dropped} reads dropped (buffer full)`)
    dropped = 0
  }
  const rows = [...batch.entries()].map(([k, n]) => {
    const [pageId, day] = k.split('|')
    return { pageId, day, n }
  })
  let written = 0
  try {
    for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
      const chunk = rows.slice(i, i + FLUSH_CHUNK)
      const values = sql.join(
        chunk.map((r) => sql`(${r.pageId}::uuid, ${r.day}::date, ${r.n}::int)`),
        sql`, `,
      )
      const res = (await db.execute(sql`
        INSERT INTO page_reads (page_id, day, count)
        SELECT v.page_id, v.day, v.n FROM (VALUES ${values}) AS v(page_id, day, n)
          JOIN pages p ON p.id = v.page_id
        ON CONFLICT (page_id, day) DO UPDATE
          SET count = least(page_reads.count + excluded.count, ${DAILY_READ_CAP})
        RETURNING page_id
      `)) as unknown as unknown[]
      written += res.length
    }
  } catch (err) {
    // put them back (bounded like any other count)
    for (const r of rows) {
      const key = `${r.pageId}|${r.day}`
      if (buffer.size < MAX_BUFFERED_KEYS || buffer.has(key)) {
        buffer.set(key, Math.min((buffer.get(key) ?? 0) + r.n, DAILY_READ_CAP))
      }
    }
    log(`[inkling] page read counter flush failed: ${String(err)}`)
  }
  return written
}

/** Delete counters older than READ_RETENTION_DAYS. */
export async function purgeOldReads(now = new Date()): Promise<number> {
  const cutoff = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - READ_RETENTION_DAYS))
  const res = (await db.execute(sql`DELETE FROM page_reads WHERE day < ${cutoff}::date RETURNING page_id`)) as unknown as unknown[]
  return res.length
}

/** Flush every minute (timer unref'd so it never keeps the process alive). Returns a stop function. */
export function startReadFlusher(log: (msg: string) => void): () => Promise<void> {
  const timer = setInterval(() => void flushReads(log), FLUSH_INTERVAL_MS)
  timer.unref?.()
  return async () => {
    clearInterval(timer)
    await flushReads(log)
  }
}
