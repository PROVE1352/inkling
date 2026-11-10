// Document generation (docs/adr/2201-*).
//
// Every server write to a page body edits the same Y.Doc (openDirectConnection + transact), so a
// device copy merged later can neither bring deleted text back nor double the body. What it can do is
// lose silently: an edit made offline inside a block that a restore, a revert or a split removed
// lands in a deleted block and is never seen. Those writes bump `pages.doc_gen`; a browser whose
// unsent edits descend from an older generation keeps them as a recovery item instead of merging.
//
// Order matters (ADR 2201): the bump happens AFTER the content transact. A client that reads the new
// generation therefore already gets the new content; a client that read the old generation and then
// synced the new content only produces a spurious recovery copy, never a silent merge.
import { eq, sql } from 'drizzle-orm'
import { db } from './db/index'
import { pages } from './db/schema'
import { broadcastToPage } from './collab'

/** Bumps the page's generation and tells the open clients. Never throws (the content write already happened). */
export async function bumpDocGen(pageId: string): Promise<number | null> {
  try {
    const [row] = await db
      .update(pages)
      .set({ docGen: sql`${pages.docGen} + 1` })
      .where(eq(pages.id, pageId))
      .returning({ docGen: pages.docGen })
    if (!row) return null
    // Older clients ignore stateless payloads they do not know (CollabEditor only reacts to t:'comments').
    broadcastToPage(pageId, { t: 'gen', gen: row.docGen })
    return row.docGen
  } catch (err) {
    console.error('[inkling] doc generation bump failed', pageId, err)
    return null
  }
}

/** Current generation (null when the page does not exist). */
export async function readDocGen(pageId: string): Promise<number | null> {
  const [row] = await db.select({ docGen: pages.docGen }).from(pages).where(eq(pages.id, pageId)).limit(1)
  return row ? row.docGen : null
}
