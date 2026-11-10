import { eq, isNull } from 'drizzle-orm'
import { INLINE_MATH_TYPE, MATH_BLOCK_TYPE } from '@inkling/shared'
import { db } from '../db/index'
import { bumpIndexEpoch } from '../versions'
import { pageDocs, pageTexts } from '../db/schema'
import { stateToBlocks } from './convert'
import type { AnyBlock } from './convert'

/**
 * Max indexed body text (bytes). A longer body keeps its first and last halves (docs/adr/1040-*):
 * the head says what the page is, the tail holds the newest entries of a growing log. The middle
 * stays searchable through the section index (find_context), which covers the whole document.
 */
export const MAX_TEXT_BYTES = 200 * 1024
/** Marks the cut between head and tail in page_texts. */
export const TEXT_CUT_MARK = '\n…\n'

interface InlineLike {
  type?: string
  text?: unknown
  href?: unknown
  content?: unknown
  props?: { latex?: unknown }
}

/** Extract the display text of one inline (links use their display content, inline math its LaTeX). */
function inlineText(inl: InlineLike): string {
  if (!inl || typeof inl !== 'object') return ''
  if (inl.type === INLINE_MATH_TYPE) return typeof inl.props?.latex === 'string' ? inl.props.latex : ''
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
    if (b.type === MATH_BLOCK_TYPE && typeof b.props?.latex === 'string' && b.props.latex) out.push(b.props.latex)
    // a button's label is searchable text; its actions are not (docs/adr/2244-*)
    if (b.type === 'button' && typeof b.props?.label === 'string' && b.props.label.trim()) out.push(b.props.label.trim())
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

/** True for a UTF-8 continuation byte (10xxxxxx). */
function isCont(b: number | undefined): boolean {
  return b !== undefined && (b & 0xc0) === 0x80
}

/**
 * Head + tail of a text longer than MAX_TEXT_BYTES, cut on character boundaries: the first and the
 * last (MAX_TEXT_BYTES − mark) / 2 bytes joined by TEXT_CUT_MARK. Shorter text is returned as is.
 */
export function capPlainText(text: string): string {
  if (text.length * 3 <= MAX_TEXT_BYTES) return text // cheap exit: at most 3 bytes per UTF-16 unit
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= MAX_TEXT_BYTES) return text
  const half = Math.floor((MAX_TEXT_BYTES - Buffer.byteLength(TEXT_CUT_MARK)) / 2)
  let headEnd = half
  while (headEnd > 0 && isCont(buf[headEnd])) headEnd--
  let tailStart = buf.length - half
  while (tailStart < buf.length && isCont(buf[tailStart])) tailStart++
  return buf.subarray(0, headEnd).toString('utf8') + TEXT_CUT_MARK + buf.subarray(tailStart).toString('utf8')
}

/**
 * Build plain text by joining the inline text of every block, child and table cell with newlines.
 * Links contribute their display text; code block contents are included. Beyond MAX_TEXT_BYTES only
 * the head and the tail are kept (capPlainText).
 */
export function blocksToPlainText(blocks: AnyBlock[]): string {
  const out: string[] = []
  collectBlockText(blocks, out)
  return capPlainText(out.join('\n'))
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
