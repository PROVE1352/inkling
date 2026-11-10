import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from './db/index'
import { chunkBlocks } from './context/chunker'
import { reindexPageChunks } from './context/chunkIndex'
import { docToBlocks } from './md/convert'
import { docFromStoredState } from './yState'
import { extractInternalLinks } from './md/convert'
import { reindexPageLinks } from './md/linkIndex'
import { blocksToTagText, extractTags, reindexPageTags } from './md/tagIndex'
import { extractTasks, reindexPageTasks } from './md/taskIndex'
import { blocksToPlainText, reindexPageText } from './md/textIndex'
import { beginIndexWindow, endIndexWindow, indexActor } from './context/attribution'
import { mentionSignature, syncDocMentions } from './notify/producers'

/**
 * Derived-index pipeline for live collaborative documents (docs/adr/0750-*).
 *
 * The Hocuspocus store hook persists the Yjs state every 2–10 s while someone types. Rebuilding
 * the derived indexes (page_links, page_texts, page_tags, page_tasks, page_chunks) on every store meant a
 * full Yjs→BlockNote conversion plus ~30 SQL statements per store. This module:
 *
 *  1. debounces indexing per page (trailing INDEX_DEBOUNCE_MS, at most INDEX_MAX_WAIT_MS behind),
 *     keeping only the newest state buffer per page;
 *  2. indexes immediately when the store came from a server-side DirectConnection (REST/MCP edits
 *     expect fresh indexes when the request returns) or when the last client left the document;
 *  3. skips each index write whose derived value did not change since the last run (signature
 *     cache), so typing only rewrites page_texts and leaves links/tags/tasks alone;
 *  4. serialises runs per page so two runs never interleave their delete+insert.
 *
 * Single-instance assumption (like the rest of the in-memory state): indexes of a page edited on
 * another instance would be rebuilt by that instance.
 */

const INDEX_DEBOUNCE_MS = 8_000
const INDEX_MAX_WAIT_MS = 30_000
/** Signature entries older than this force a full rewrite (self-heals any drift). */
const SIGNATURE_TTL_MS = 10 * 60_000
/** Upper bound of remembered signatures (LRU by insertion order). */
const MAX_SIGNATURES = 2_000
/** Upper bound of pages waiting for a debounced pass (each holds its newest state buffer). */
const MAX_PENDING = 200

interface Pending {
  state: Uint8Array
  /** page_docs.updated_at (text) of the stored state, or null when unknown (docs/adr/1041-*). */
  stamp: string | null
  firstAt: number
  timer: NodeJS.Timeout
}

interface Signature {
  links: string
  text: string
  tags: string
  tasks: string
  chunks: string
  /** Sorted mentioned user ids (docs/adr/1002-*). */
  mentions: string
  at: number
}

const pending = new Map<string, Pending>()
const running = new Map<string, Promise<void>>()
const signatures = new Map<string, Signature>()
/**
 * Freshness record (docs/adr/1041-*): page → stamp (page_docs.updated_at as text) of the stored
 * state whose section index pass completed last. Outline/section reads answer from page_chunks
 * only while this equals the current stored (or live, unchanged) state and no pass is queued.
 */
const indexedStamps = new Map<string, string>()

function digest(s: string): string {
  return createHash('sha1').update(s).digest('base64')
}

/** Test/bench hook: counters of what the pipeline actually did. */
export const docIndexStats = { runs: 0, conversions: 0, links: 0, text: 0, tags: 0, tasks: 0, chunks: 0, mentions: 0 }

function rememberStamp(pageId: string, stamp: string | null): void {
  indexedStamps.delete(pageId)
  if (stamp === null) return
  indexedStamps.set(pageId, stamp)
  if (indexedStamps.size > MAX_SIGNATURES) {
    const oldest = indexedStamps.keys().next().value
    if (oldest !== undefined) indexedStamps.delete(oldest)
  }
}

async function runIndex(pageId: string, state: Uint8Array, stamp: string | null): Promise<void> {
  // Who typed since the last pass (CF-2, docs/adr/1625-*): taken now, read by the change logger.
  beginIndexWindow(pageId)
  try {
    await runIndexPass(pageId, state, stamp)
  } finally {
    endIndexWindow(pageId)
  }
}

async function runIndexPass(pageId: string, state: Uint8Array, stamp: string | null): Promise<void> {
  docIndexStats.runs++
  // One decode per pass (docs/adr/1102-*): the mention walk reads the Yjs tree first, then BlockNote
  // reads the same throwaway doc (its read deletes nodes the server schema lacks, mention chips among
  // them). The live document is never read here: copying it costs as much as decoding the state.
  // The throwaway doc is left to the GC, as stateToBlocks always did.
  const decoded = docFromStoredState(state)
  const mention = mentionSignature(state, decoded)
  const blocks = docToBlocks(decoded)
  docIndexStats.conversions++
  const text = blocksToPlainText(blocks)
  const links = extractInternalLinks(blocks).filter((t) => t !== pageId).sort()
  // tags come from a separate walk that skips code (blocks and inline spans)
  const tagText = blocksToTagText(blocks)
  const tags = extractTags(tagText)
  const tasks = extractTasks(blocks)
  const chunks = chunkBlocks(blocks)
  // Captured before any await: the REST/MCP request that caused this pass is still in flight.
  const actor = indexActor(pageId)
  const next: Signature = {
    links: links.join(','),
    text: digest(text),
    tags: tags.join('\u0000'),
    tasks: digest(JSON.stringify(tasks)),
    chunks: digest(chunks.map((c) => c.hash).join(',')),
    mentions: mention.sig,
    at: Date.now(),
  }
  const prev = signatures.get(pageId)
  const fresh = prev && next.at - prev.at < SIGNATURE_TTL_MS ? prev : undefined
  if (!fresh || fresh.links !== next.links) {
    docIndexStats.links++
    await reindexPageLinks(pageId, blocks)
  }
  if (!fresh || fresh.text !== next.text) {
    docIndexStats.text++
    await reindexPageText(pageId, blocks, text)
  }
  if (!fresh || fresh.tags !== next.tags) {
    docIndexStats.tags++
    await reindexPageTags(pageId, blocks, tagText)
  }
  if (!fresh || fresh.tasks !== next.tasks) {
    docIndexStats.tasks++
    await reindexPageTasks(pageId, blocks)
  }
  let chunksOk = true
  if (!fresh || fresh.chunks !== next.chunks) {
    // Section index for agent retrieval + change feed (docs/adr/0926-*, 0932-*); diffed per row inside.
    docIndexStats.chunks++
    chunksOk = await reindexPageChunks(pageId, blocks, { chunks })
    // A failed write must not be remembered as done: the next pass retries it.
    if (!chunksOk) next.chunks = ''
  }
  if (!fresh || fresh.mentions !== next.mentions) {
    // @mentions in the body → notifications for people newly mentioned (docs/adr/1002-*).
    docIndexStats.mentions++
    await syncDocMentions(pageId, blocks, mention.mentions, actor).catch((err) =>
      console.error('[inkling] mention sync failed', pageId, err),
    )
  }
  // Keep the signature's age from the last full rewrite so the TTL really forces one.
  if (fresh) next.at = fresh.at
  signatures.delete(pageId)
  signatures.set(pageId, next)
  if (signatures.size > MAX_SIGNATURES) {
    const oldest = signatures.keys().next().value
    if (oldest !== undefined) signatures.delete(oldest)
  }
  rememberStamp(pageId, chunksOk ? stamp : null)
  // The pass is complete (chunks written last): record which stored state the indexes reflect, so
  // a boot after a crash can tell the pages whose queued pass was lost (docs/adr/1924-*).
  if (chunksOk && stamp !== null) {
    await db
      .execute(sql`UPDATE page_chunk_index SET doc_updated_at = ${stamp}::timestamptz
                    WHERE page_id = ${pageId} AND (doc_updated_at IS NULL OR doc_updated_at < ${stamp}::timestamptz)`)
      .catch((err: unknown) => console.error('[inkling] index stamp write failed', pageId, err))
  }
}

/** Runs one index pass for the page, chained after any pass already in flight for it. */
function runSerial(pageId: string, state: Uint8Array, stamp: string | null): Promise<void> {
  const before = running.get(pageId) ?? Promise.resolve()
  const job = before
    .catch(() => {})
    .then(() => runIndex(pageId, state, stamp))
    .catch((err) => console.error('[inkling] store indexing failed', pageId, err))
  running.set(pageId, job)
  void job.finally(() => {
    if (running.get(pageId) === job) running.delete(pageId)
  })
  return job
}

/**
 * Schedules (or, with immediate=true, runs and awaits) derived-index maintenance for a page.
 * The newest state always wins; an immediate run supersedes a pending debounced one.
 * `stamp` identifies the stored state (page_docs.updated_at as text) for the freshness record.
 */
export function scheduleDocIndex(
  pageId: string,
  state: Uint8Array,
  immediate: boolean,
  stamp: string | null = null,
): Promise<void> {
  const p = pending.get(pageId)
  // Until a pass for this state completes, the section index may trail the document.
  indexedStamps.delete(pageId)
  if (immediate) {
    if (p) {
      clearTimeout(p.timer)
      pending.delete(pageId)
    }
    return runSerial(pageId, state, stamp)
  }
  const now = Date.now()
  const firstAt = p?.firstAt ?? now
  if (p) clearTimeout(p.timer)
  const wait = Math.max(0, Math.min(INDEX_DEBOUNCE_MS, firstAt + INDEX_MAX_WAIT_MS - now))
  if (!p && pending.size >= MAX_PENDING) {
    // Bound memory (one state buffer per pending page): run the oldest pending pass now.
    const oldest = pending.keys().next().value
    if (oldest !== undefined) {
      const o = pending.get(oldest)!
      clearTimeout(o.timer)
      pending.delete(oldest)
      void runSerial(oldest, o.state, o.stamp)
    }
  }
  const timer = setTimeout(() => {
    const cur = pending.get(pageId)
    if (!cur) return
    pending.delete(pageId)
    void runSerial(pageId, cur.state, cur.stamp)
  }, wait)
  timer.unref?.()
  pending.set(pageId, { state, stamp, firstAt, timer })
  return Promise.resolve()
}

/**
 * Runs the page's pending (debounced) pass now, if there is one, and waits for the page's passes.
 * The store hook calls it when it skips an unchanged state that would have indexed immediately.
 */
export function flushDocIndex(pageId: string): Promise<void> {
  const p = pending.get(pageId)
  if (p) {
    clearTimeout(p.timer)
    pending.delete(pageId)
    return runSerial(pageId, p.state, p.stamp)
  }
  return running.get(pageId) ?? Promise.resolve()
}

/** Drops cached signatures (e.g. after an out-of-band reindex) so the next run rewrites all. */
export function forgetDocIndex(pageId: string): void {
  signatures.delete(pageId)
  indexedStamps.delete(pageId)
}

/**
 * Stamp of the stored state the page's section index reflects, or null when unknown or when a
 * pass is queued or running (the index may trail the document then). docs/adr/1041-*.
 */
export function indexedStamp(pageId: string): string | null {
  if (pending.has(pageId) || running.has(pageId)) return null
  return indexedStamps.get(pageId) ?? null
}

/** No index pass queued or running for the page. */
export function docIndexIdle(pageId: string): boolean {
  return !pending.has(pageId) && !running.has(pageId)
}

/**
 * Records that page_chunks was verified equal to the stored state `stamp` (a read decoded that
 * state and compared chunk hashes). Ignored while a pass is queued or running.
 */
export function adoptIndexedStamp(pageId: string, stamp: string): void {
  if (pending.has(pageId) || running.has(pageId)) return
  rememberStamp(pageId, stamp)
}

/** Runs every pending index pass now and waits for all in-flight passes (shutdown / tests). */
export async function flushDocIndexes(): Promise<void> {
  for (const [pageId, p] of [...pending]) {
    clearTimeout(p.timer)
    pending.delete(pageId)
    void runSerial(pageId, p.state, p.stamp)
  }
  await Promise.all([...running.values()])
}

/** Introspection for the memory-cache inventory (docs/OPERATIONS.md). */
export function docIndexerSizes(): { pending: number; running: number; signatures: number; indexedStamps: number } {
  return { pending: pending.size, running: running.size, signatures: signatures.size, indexedStamps: indexedStamps.size }
}
