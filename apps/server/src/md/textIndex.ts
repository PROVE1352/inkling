import { eq, isNull } from 'drizzle-orm'
import { db } from '../db/index'
import { bumpIndexEpoch } from '../versions'
import { pageDocs, pageTexts } from '../db/schema'
import { stateToBlocks } from './convert'
import type { AnyBlock } from './convert'

/** Max indexed body text (bytes). Anything beyond is truncated. */
const MAX_TEXT_BYTES = 200 * 1024

interface InlineLike {
  type?: string
  text?: unknown
  href?: unknown
  content?: unknown
}

/** Extract the display text of one inline (links use their display content). */
function inlineText(inl: InlineLike): string {
  if (!inl || typeof inl !== 'object') return ''
  if (inl.type === 'link' && Array.isArray(inl.content)) {
    return (inl.content as InlineLike[]).map(inlineText).join('')
  }
  if (typeof inl.text === 'string') return inl.text
  return ''
}

/** Join an inline array into one string (styled runs are contiguous text). */
function inlinesText(inlines: unknown): string {
  if (!Array.isArray(inlines)) return ''
  return (inlines as InlineLike[]).map(inlineText).join('')
}

function isTableContent(c: unknown): c is { rows: { cells: unknown[] }[] } {
  return (
    !!c &&
    typeof c === 'object' &&
    !Array.isArray(c) &&
    (c as { type?: string }).type === 'tableContent' &&
    Array.isArray((c as { rows?: unknown }).rows)
  )
}

/** Walk blocks, children and table cells recursively, collecting text line by line. */
function collectBlockText(blocks: AnyBlock[], out: string[]): void {
  for (const b of blocks) {
    const c = b.content
    if (Array.isArray(c)) {
      const t = inlinesText(c)
      if (t) out.push(t)
    } else if (isTableContent(c)) {
      for (const row of c.rows) {
        const cells = row?.cells
        if (!Array.isArray(cells)) continue
        const cellTexts: string[] = []
        for (const cell of cells) {
          if (Array.isArray(cell)) {
            cellTexts.push(inlinesText(cell))
          } else if (
            cell &&
            typeof cell === 'object' &&
            Array.isArray((cell as { content?: unknown }).content)
          ) {
            cellTexts.push(inlinesText((cell as { content?: unknown }).content))
          }
        }
        const rowText = cellTexts.filter(Boolean).join(' ')
        if (rowText) out.push(rowText)
      }
    }
    if (Array.isArray(b.children)) collectBlockText(b.children, out)
  }
}

/**
 * Build plain text by joining the inline text of every block, child and table cell with newlines.
 * Links contribute their display text; code block contents are included. Truncated beyond 200KB.
 */
export function blocksToPlainText(blocks: AnyBlock[]): string {
  const out: string[] = []
  collectBlockText(blocks, out)
  let text = out.join('\n')
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    // Truncate by bytes (a multibyte char split at the edge becomes U+FFFD — harmless for an index)
    text = Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8')
  }
  return text
}

/**
 * Reindex (upsert) page_texts from blocks.
 * Swallows every error internally (logs only) so callers (store/import) never fail.
 */
export async function reindexPageText(
  pageId: string,
  blocks: AnyBlock[],
  precomputedText?: string,
): Promise<void> {
  try {
    const text = precomputedText ?? blocksToPlainText(blocks)
    await db
      .insert(pageTexts)
      .values({ pageId, text })
      .onConflictDoUpdate({
        target: pageTexts.pageId,
        set: { text, updatedAt: new Date() },
      })
    bumpIndexEpoch()
  } catch (err) {
    console.error('[inkling] page_texts reindex failed', pageId, err)
  }
}

/**
 * Boot backfill: convert pages that have page_docs but no page_texts to plain text, 50 per batch.
 * Runs sequentially in small batches so server responsiveness is unaffected.
 * A page whose conversion fails is marked with empty text so it is not reselected forever.
 */
export async function backfillPageTexts(
  log: (msg: string) => void = console.log,
): Promise<void> {
  const BATCH = 50
  let total = 0
  try {
    for (;;) {
      const rows = await db
        .select({ pageId: pageDocs.pageId, state: pageDocs.state })
        .from(pageDocs)
        .leftJoin(pageTexts, eq(pageTexts.pageId, pageDocs.pageId))
        .where(isNull(pageTexts.pageId))
        .limit(BATCH)
      if (rows.length === 0) break

      for (const row of rows) {
        try {
          const blocks = stateToBlocks(row.state)
          const text = blocksToPlainText(blocks)
          await db
            .insert(pageTexts)
            .values({ pageId: row.pageId, text })
            .onConflictDoUpdate({
              target: pageTexts.pageId,
              set: { text, updatedAt: new Date() },
            })
        } catch (err) {
          console.error('[inkling] page_texts backfill failed for page', row.pageId, err)
          // Avoid an infinite loop: mark the failed page with empty text so the next batch skips it
          try {
            await db
              .insert(pageTexts)
              .values({ pageId: row.pageId, text: '' })
              .onConflictDoNothing()
          } catch {
            // If even marking fails (e.g. page FK gone), skip — it is retried in the next batch
          }
        }
      }

      total += rows.length
      if (rows.length < BATCH) break
      // Yield to the event loop — keep serving requests during a large backfill
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (total > 0) log(`[inkling] page_texts backfill done — ${total} pages`)
  } catch (err) {
    console.error('[inkling] page_texts backfill failed', err)
  }
}
