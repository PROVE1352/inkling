import { createHash } from 'node:crypto'
import { stateToBlocks } from './md/convert'
import { extractInternalLinks } from './md/convert'
import { reindexPageLinks } from './md/linkIndex'
import { blocksToTagText, extractTags, reindexPageTags } from './md/tagIndex'
import { extractTasks, reindexPageTasks } from './md/taskIndex'
import { blocksToPlainText, reindexPageText } from './md/textIndex'

/**
 * Derived-index pipeline for live collaborative documents (docs/adr/0750-*).
 *
 * The Hocuspocus store hook persists the Yjs state every 2–10 s while someone types. Rebuilding
 * the four derived indexes (page_links, page_texts, page_tags, page_tasks) on every store meant a
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
  firstAt: number
  timer: NodeJS.Timeout
}

interface Signature {
  links: string
  text: string
  tags: string
  tasks: string
  at: number
}

const pending = new Map<string, Pending>()
const running = new Map<string, Promise<void>>()
const signatures = new Map<string, Signature>()

function digest(s: string): string {
  return createHash('sha1').update(s).digest('base64')
}

/** Test/bench hook: counters of what the pipeline actually did. */
export const docIndexStats = { runs: 0, conversions: 0, links: 0, text: 0, tags: 0, tasks: 0 }

async function runIndex(pageId: string, state: Uint8Array): Promise<void> {
  docIndexStats.runs++
  const blocks = stateToBlocks(state)
  docIndexStats.conversions++
  const text = blocksToPlainText(blocks)
  const links = extractInternalLinks(blocks).filter((t) => t !== pageId).sort()
  // tags come from a separate walk that skips code (blocks and inline spans)
  const tagText = blocksToTagText(blocks)
  const tags = extractTags(tagText)
  const tasks = extractTasks(blocks)
  const next: Signature = {
    links: links.join(','),
    text: digest(text),
    tags: tags.join('\u0000'),
    tasks: digest(JSON.stringify(tasks)),
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
  // Keep the signature's age from the last full rewrite so the TTL really forces one.
  if (fresh) next.at = fresh.at
  signatures.delete(pageId)
  signatures.set(pageId, next)
  if (signatures.size > MAX_SIGNATURES) {
    const oldest = signatures.keys().next().value
    if (oldest !== undefined) signatures.delete(oldest)
  }
}

/** Runs one index pass for the page, chained after any pass already in flight for it. */
function runSerial(pageId: string, state: Uint8Array): Promise<void> {
  const before = running.get(pageId) ?? Promise.resolve()
  const job = before
    .catch(() => {})
    .then(() => runIndex(pageId, state))
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
 */
export function scheduleDocIndex(
  pageId: string,
  state: Uint8Array,
  immediate: boolean,
): Promise<void> {
  const p = pending.get(pageId)
  if (immediate) {
    if (p) {
      clearTimeout(p.timer)
      pending.delete(pageId)
    }
    return runSerial(pageId, state)
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
      void runSerial(oldest, o.state)
    }
  }
  const timer = setTimeout(() => {
    const cur = pending.get(pageId)
    if (!cur) return
    pending.delete(pageId)
    void runSerial(pageId, cur.state)
  }, wait)
  timer.unref?.()
  pending.set(pageId, { state, firstAt, timer })
  return Promise.resolve()
}

/** Drops cached signatures (e.g. after an out-of-band reindex) so the next run rewrites all. */
export function forgetDocIndex(pageId: string): void {
  signatures.delete(pageId)
}

/** Runs every pending index pass now and waits for all in-flight passes (shutdown / tests). */
export async function flushDocIndexes(): Promise<void> {
  for (const [pageId, p] of [...pending]) {
    clearTimeout(p.timer)
    pending.delete(pageId)
    void runSerial(pageId, p.state)
  }
  await Promise.all([...running.values()])
}

/** Introspection for the memory-cache inventory (docs/OPERATIONS.md). */
export function docIndexerSizes(): { pending: number; running: number; signatures: number } {
  return { pending: pending.size, running: running.size, signatures: signatures.size }
}
