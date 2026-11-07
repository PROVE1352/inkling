import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { recordAudit } from '../workspaceAdmin'
import { db } from '../db/index'
import { pageChunkIndex, pageChunks, pageDocs, pages } from '../db/schema'
import type { AnyBlock } from '../md/convert'
import { stateToBlocks } from '../md/convert'
import { blocksToPlainText, reindexPageText, TEXT_CUT_MARK } from '../md/textIndex'
import { bumpIndexEpoch } from '../versions'
import { kickOutbox } from '../outbox'
import { recordSectionChanges } from './changeLog'
import type { PageSectionDelta, SectionState } from './changeLog'
import type { Chunk } from './chunker'
import { CHUNKER_VERSION, chunkBlocks } from './chunker'

/**
 * Section index maintenance (docs/adr/0926-*).
 *
 * reindexPageChunks diffs the new chunk list against the stored rows by position and writes only
 * rows whose hash changed (typing in one section rewrites one row and its GIN entries), deletes
 * rows past the new end, and stamps the marker. It never throws (logs only), like the other
 * derived indexes, so a store or import never fails because of it.
 */

const UPSERT_BATCH = 400
/** Caps of CHUNKER_VERSION 2 (a version-2 index under both was complete). */
const V2_TEXT_CAP_BYTES = 200 * 1024
const V2_MAX_CHUNKS = 2_000

interface ExistingRow {
  ord: number
  hash: string
  anchor: string
  sectionHash: string
  headingPath: string
  blockId: string | null
}

export interface ReindexOptions {
  /** false for the boot backfill: re-indexing old pages must not flood the change feed. */
  log?: boolean
  /** Chunks already computed by the caller (docIndexer computes them for its signature). */
  chunks?: Chunk[]
}

/** Test/bench hook. */
export const chunkIndexStats = { runs: 0, rowsWritten: 0, rowsDeleted: 0, skipped: 0 }

function sectionsOfRows(rows: { anchor: string; headingPath: string; blockId: string | null; sectionHash: string }[]) {
  const out: { anchor: string; headingPath: string; blockId: string | null; version: string }[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.anchor === r.anchor) continue
    out.push({ anchor: r.anchor, headingPath: r.headingPath, blockId: r.blockId, version: r.sectionHash })
  }
  return out
}

function sectionsOfChunks(chunks: Chunk[]): SectionState[] {
  const out: SectionState[] = []
  for (const c of chunks) {
    const last = out[out.length - 1]
    if (last && last.anchor === c.anchor) {
      last.text += `\n${c.text}`
      continue
    }
    out.push({
      anchor: c.anchor,
      headingPath: c.headingPath,
      blockId: c.blockId,
      text: c.text,
      version: c.sectionHash,
      order: out.length,
    })
  }
  return out
}

/**
 * Returns true when page_chunks matches `blocks` afterwards (written or already equal), false when
 * the page is gone or the write failed (the outline/section freshness record relies on it,
 * docs/adr/1041-*).
 */
export async function reindexPageChunks(
  pageId: string,
  blocks: AnyBlock[],
  opts: ReindexOptions = {},
): Promise<boolean> {
  try {
    chunkIndexStats.runs++
    const chunks = opts.chunks ?? chunkBlocks(blocks)
    const [page] = await db
      .select({
        workspaceId: pages.workspaceId,
        scope: pages.scope,
        createdBy: pages.createdBy,
        version: pageChunkIndex.version,
      })
      .from(pages)
      .leftJoin(pageChunkIndex, eq(pageChunkIndex.pageId, pages.id))
      .where(eq(pages.id, pageId))
      .limit(1)
    if (!page) return false // page gone (purged meanwhile)
    const existing: ExistingRow[] = await db
      .select({
        ord: pageChunks.ord,
        hash: pageChunks.hash,
        anchor: pageChunks.anchor,
        sectionHash: pageChunks.sectionHash,
        headingPath: pageChunks.headingPath,
        blockId: pageChunks.blockId,
      })
      .from(pageChunks)
      .where(eq(pageChunks.pageId, pageId))
      .orderBy(asc(pageChunks.ord))

    const changed = chunks.filter((c) => existing[c.ord]?.hash !== c.hash)
    const removedFrom = chunks.length
    const hasRemoved = existing.length > removedFrom
    if (changed.length === 0 && !hasRemoved && page.version === CHUNKER_VERSION) {
      chunkIndexStats.skipped++
      return true
    }

    // Old text of sections whose version changed or that disappeared (for the change feed).
    const logIt = opts.log !== false
    const after = sectionsOfChunks(chunks)
    const afterByAnchor = new Map(after.map((s) => [s.anchor, s]))
    const oldSections = sectionsOfRows(existing)
    const staleAnchors = oldSections
      .filter((s) => afterByAnchor.get(s.anchor)?.version !== s.version)
      .map((s) => s.anchor)
    const oldText = new Map<string, string>()
    if (logIt && staleAnchors.length) {
      const rows = await db
        .select({ anchor: pageChunks.anchor, text: pageChunks.text })
        .from(pageChunks)
        .where(and(eq(pageChunks.pageId, pageId), inArray(pageChunks.anchor, staleAnchors)))
        .orderBy(asc(pageChunks.ord))
      for (const r of rows) oldText.set(r.anchor, oldText.has(r.anchor) ? `${oldText.get(r.anchor)}\n${r.text}` : r.text)
    }

    // Change-feed entry (docs/adr/0932-*, 1080-*): computed before, queued in the same transaction
    // as the chunk rows, so a crash can never keep the new index and lose the change.
    const delta: PageSectionDelta | null = logIt
      ? {
          pageId,
          workspaceId: page.workspaceId,
          scope: page.scope,
          ownerId: page.createdBy,
          firstIndex: page.version === null,
          before: oldSections.map((s, i) => ({
            anchor: s.anchor,
            headingPath: s.headingPath,
            blockId: s.blockId,
            text: oldText.get(s.anchor) ?? afterByAnchor.get(s.anchor)?.text ?? '',
            version: s.version,
            order: i,
          })),
          after,
        }
      : null
    await db.transaction(async (tx) => {
      for (let i = 0; i < changed.length; i += UPSERT_BATCH) {
        const batch = changed.slice(i, i + UPSERT_BATCH)
        await tx
          .insert(pageChunks)
          .values(
            batch.map((c) => ({
              pageId,
              ord: c.ord,
              workspaceId: page.workspaceId,
              anchor: c.anchor,
              blockId: c.blockId,
              headingPath: c.headingPath,
              level: c.level,
              part: c.part,
              text: c.text,
              grams: c.grams,
              tokenEstimate: c.tokens,
              suspicious: c.suspicious,
              hash: c.hash,
              sectionHash: c.sectionHash,
            })),
          )
          .onConflictDoUpdate({
            target: [pageChunks.pageId, pageChunks.ord],
            set: {
              anchor: sql`excluded.anchor`,
              blockId: sql`excluded.block_id`,
              headingPath: sql`excluded.heading_path`,
              level: sql`excluded.level`,
              part: sql`excluded.part`,
              text: sql`excluded.text`,
              grams: sql`excluded.grams`,
              tokenEstimate: sql`excluded.token_estimate`,
              suspicious: sql`excluded.suspicious`,
              hash: sql`excluded.hash`,
              sectionHash: sql`excluded.section_hash`,
              updatedAt: sql`now()`,
            },
          })
      }
      if (hasRemoved) {
        await tx.delete(pageChunks).where(and(eq(pageChunks.pageId, pageId), gte(pageChunks.ord, removedFrom)))
      }
      await tx
        .insert(pageChunkIndex)
        .values({ pageId, version: CHUNKER_VERSION })
        .onConflictDoUpdate({
          target: pageChunkIndex.pageId,
          set: { version: CHUNKER_VERSION, indexedAt: sql`now()` },
        })
      if (delta) {
        // In a savepoint: a failed log write never fails the index (it is logged, like before).
        try {
          await tx.transaction((sp) => recordSectionChanges(delta, sp))
        } catch (err) {
          console.error('[inkling] change feed write failed', pageId, err)
        }
      }
    })
    if (delta) kickOutbox('change')
    // First detection per page and rule goes to the audit log (docs/adr/0977-*); best effort.
    const flagged = [...new Set(chunks.flatMap((c) => c.suspicious))]
    if (flagged.length) await auditSuspicious(pageId, page.workspaceId, flagged, chunks)
    chunkIndexStats.rowsWritten += changed.length
    chunkIndexStats.rowsDeleted += Math.max(0, existing.length - removedFrom)
    bumpIndexEpoch()

    return true
  } catch (err) {
    console.error('[inkling] page_chunks reindex failed', pageId, err)
    return false
  }
}

/**
 * Version 2 → 3 only lifted the 200 KB text cap (docs/adr/1040-*). A version-2 index whose rows
 * stay under that cap was never cut, so it equals what version 3 would write: stamp it as current
 * instead of decoding every page again at boot. Only pages that may have been cut are re-indexed.
 */
async function promoteUncutIndexes(): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE page_chunk_index m SET version = ${CHUNKER_VERSION}
     WHERE m.version = 2
       AND NOT EXISTS (
         SELECT 1 FROM page_chunks c WHERE c.page_id = m.page_id
          GROUP BY c.page_id HAVING sum(octet_length(c.text)) > ${V2_TEXT_CAP_BYTES} OR count(*) >= ${V2_MAX_CHUNKS}
       )
    RETURNING m.page_id
  `)) as unknown as unknown[]
  return rows.length
}

/**
 * Boot backfill: pages with a document but no current section-index marker, 50 per batch, yielding
 * to the event loop between batches and stopping after `maxPages` (the rest continue next boot or
 * on their next edit). Failed pages are still stamped so they are not reselected forever.
 */
export async function backfillPageChunks(
  log: (msg: string) => void = console.log,
  maxPages = 50_000,
): Promise<number> {
  const BATCH = 50
  let total = 0
  try {
    if (CHUNKER_VERSION === 3) {
      const promoted = await promoteUncutIndexes()
      if (promoted > 0) log(`[inkling] page_chunks: ${promoted} complete version-2 indexes kept as version 3`)
    }
    while (total < maxPages) {
      const rows = await db
        .select({ pageId: pageDocs.pageId, state: pageDocs.state })
        .from(pageDocs)
        .leftJoin(pageChunkIndex, eq(pageChunkIndex.pageId, pageDocs.pageId))
        .where(or(isNull(pageChunkIndex.pageId), lt(pageChunkIndex.version, CHUNKER_VERSION)))
        .limit(BATCH)
      if (rows.length === 0) break
      for (const row of rows) {
        try {
          const blocks = stateToBlocks(row.state)
          await reindexPageChunks(row.pageId, blocks, { log: false })
          // A page cut by the old 200 KB cap also gets the head + tail body text (docs/adr/1040-*).
          const text = blocksToPlainText(blocks)
          if (text.includes(TEXT_CUT_MARK)) await reindexPageText(row.pageId, blocks, text)
        } catch (err) {
          console.error('[inkling] page_chunks backfill failed for page', row.pageId, err)
        }
        // reindexPageChunks swallows its own errors; make sure the page is not picked again
        await db
          .insert(pageChunkIndex)
          .values({ pageId: row.pageId, version: CHUNKER_VERSION })
          .onConflictDoUpdate({ target: pageChunkIndex.pageId, set: { version: CHUNKER_VERSION } })
          .catch(() => {})
      }
      total += rows.length
      if (rows.length < BATCH) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (total > 0) log(`[inkling] page_chunks backfill done — ${total} pages`)
  } catch (err) {
    console.error('[inkling] page_chunks backfill failed', err)
  }
  return total
}

/** Records `content.suspicious` once per (page, rule); later detections of the same rule are not repeated. */
async function auditSuspicious(pageId: string, workspaceId: string, rules: string[], chunks: { anchor: string; suspicious: string[] }[]) {
  try {
    const seen = (await db.execute(sql`
      SELECT DISTINCT after->>'rule' AS rule FROM workspace_audit_events
       WHERE workspace_id = ${workspaceId} AND action = 'content.suspicious' AND target_id = ${pageId}
    `)) as unknown as { rule: string | null }[]
    const known = new Set(seen.map((r) => r.rule))
    const fresh = rules.filter((r) => !known.has(r)).sort()
    if (!fresh.length) return
    const [p] = await db.select({ title: pages.title }).from(pages).where(eq(pages.id, pageId)).limit(1)
    for (const rule of fresh) {
      const anchors = [...new Set(chunks.filter((c) => c.suspicious.includes(rule)).map((c) => c.anchor))].slice(0, 10)
      await recordAudit(db, {
        workspaceId,
        actor: null,
        action: 'content.suspicious',
        target: { type: 'page', id: pageId, label: p?.title || 'Untitled' },
        after: { rule, sections: anchors },
      })
    }
  } catch (err) {
    console.error('[inkling] suspicious-content audit failed', pageId, err)
  }
}
