import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/index'
import { bumpIndexEpoch } from '../versions'
import { pageDocs, pageTags } from '../db/schema'
import { stateToBlocks } from './convert'
import type { AnyBlock } from './convert'

/** Max tags per page (runaway guard) + max tag length (kept in line with page_tags.tag / the route parameter). */
const MAX_TAGS_PER_PAGE = 200
const MAX_TAG_LEN = 80

/**
 * Extract `#tags` from plain text.
 *   Pattern: `#` at line start or after whitespace, followed by a run of [letters, digits, _ / -].
 *   Stored as written (case preserved), but distinct per page by lowercase
 *   (kept once per page so counts mean "number of pages with that tag").
 */
export function extractTags(text: string): string[] {
  const re = /(^|\s)#([\p{L}\p{N}_/-]+)/gu
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    let tag = m[2]
    if (!tag) continue
    if (tag.length > MAX_TAG_LEN) tag = tag.slice(0, MAX_TAG_LEN)
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS_PER_PAGE) break
  }
  return out
}

/** Inline run text for tag scanning: `code`-styled runs are skipped (a `#rrggbb` there is not a tag). */
function inlineTagText(inl: unknown): string {
  if (!inl || typeof inl !== 'object') return ''
  const o = inl as { type?: string; text?: unknown; content?: unknown; styles?: Record<string, unknown> }
  if (o.type === 'link' && Array.isArray(o.content)) return o.content.map(inlineTagText).join('')
  if (typeof o.text !== 'string') return ''
  return o.styles?.code ? ' ' : o.text
}

function inlinesTagText(inlines: unknown): string {
  return Array.isArray(inlines) ? inlines.map(inlineTagText).join('') : ''
}

function collectTagText(blocks: AnyBlock[], out: string[]): void {
  for (const b of blocks) {
    // Code blocks (including query blocks: `FROM #project`) never contribute tags.
    if (b.type !== 'codeBlock') {
      const c = b.content as unknown
      if (Array.isArray(c)) {
        out.push(inlinesTagText(c))
      } else if (c && typeof c === 'object' && Array.isArray((c as { rows?: unknown }).rows)) {
        for (const row of (c as { rows: { cells?: unknown }[] }).rows) {
          if (!Array.isArray(row?.cells)) continue
          for (const cell of row.cells) {
            out.push(inlinesTagText(Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content))
          }
        }
      }
    }
    if (Array.isArray(b.children)) collectTagText(b.children, out)
  }
}

/**
 * Text that tags are extracted from: like the search text (textIndex.ts) but without code blocks
 * and inline code spans, so colors such as `#1e66f5` and query sources are not tags.
 */
export function blocksToTagText(blocks: AnyBlock[]): string {
  const out: string[] = []
  collectTagText(blocks, out)
  return out.join('\n')
}

/**
 * Resync page_tags from blocks (delete all, then reinsert).
 * Swallows every error internally (logs only) so callers (store/import) never fail.
 */
export async function reindexPageTags(
  pageId: string,
  blocks: AnyBlock[],
  precomputedTagText?: string,
): Promise<void> {
  try {
    const tags = extractTags(precomputedTagText ?? blocksToTagText(blocks))
    await db.transaction(async (tx) => {
      await tx.delete(pageTags).where(eq(pageTags.pageId, pageId))
      if (tags.length > 0) {
        await tx
          .insert(pageTags)
          .values(tags.map((tag) => ({ pageId, tag })))
          .onConflictDoNothing()
      }
    })
    bumpIndexEpoch()
  } catch (err) {
    console.error('[inkling] page_tags reindex failed', pageId, err)
  }
}

/**
 * Boot backfill: one pass over page_docs with no tag rows, using pageId keyset pagination, to fill
 * tags. Keyset always moves forward, so it finishes in one pass even when pages have zero tags
 * (tagless pages are rechecked on the next boot but nothing is inserted — harmless).
 * Yields to the event loop between batches so the server stays responsive.
 */
export async function backfillPageTags(
  log: (msg: string) => void = console.log,
): Promise<void> {
  const BATCH = 100
  let cursor: string | null = null
  let filled = 0
  try {
    for (;;) {
      const rows = await db
        .select({ pageId: pageDocs.pageId, state: pageDocs.state })
        .from(pageDocs)
        .leftJoin(pageTags, eq(pageTags.pageId, pageDocs.pageId))
        .where(
          and(
            isNull(pageTags.pageId),
            cursor ? gt(pageDocs.pageId, cursor) : undefined,
          ),
        )
        .orderBy(asc(pageDocs.pageId))
        .limit(BATCH)
      if (rows.length === 0) break

      for (const row of rows) {
        cursor = row.pageId
        try {
          const tags = extractTags(blocksToTagText(stateToBlocks(row.state)))
          if (tags.length > 0) {
            await db
              .insert(pageTags)
              .values(tags.map((tag) => ({ pageId: row.pageId, tag })))
              .onConflictDoNothing()
            filled++
          }
        } catch (err) {
          console.error('[inkling] page_tags backfill failed for page', row.pageId, err)
        }
      }

      if (rows.length < BATCH) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (filled > 0) log(`[inkling] page_tags backfill done — ${filled} pages`)
  } catch (err) {
    console.error('[inkling] page_tags backfill failed', err)
  }
}
