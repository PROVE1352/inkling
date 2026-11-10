import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/index'
import { bumpIndexEpoch } from '../versions'
import { pageLinks, pages } from '../db/schema'
import { extractInternalLinks, extractLinkSections } from './convert'
import type { AnyBlock } from './convert'

/**
 * Extract internal wikilinks from a document's blocks and resync page_links
 * (delete all then reinsert, distinct, no self-links, targets limited to live pages in the same workspace).
 * A section link `[[Page#Heading]]` is a link to Page; its heading goes into `sections` (docs/adr/2101-*).
 *
 * Swallows every error internally (logs only) so callers (store/import) never fail.
 */
export async function reindexPageLinks(
  sourcePageId: string,
  blocks: AnyBlock[],
): Promise<void> {
  try {
    // The source page must be live (needed to know its workspace)
    const src = (
      await db
        .select({ workspaceId: pages.workspaceId })
        .from(pages)
        .where(and(eq(pages.id, sourcePageId), isNull(pages.deletedAt)))
        .limit(1)
    )[0]
    if (!src) {
      // Deleted or missing page → just clear its links
      await db.delete(pageLinks).where(eq(pageLinks.sourcePageId, sourcePageId))
      bumpIndexEpoch()
      return
    }

    const candidates = extractInternalLinks(blocks).filter((t) => t !== sourcePageId)
    // headings named by section links, per target (docs/adr/2101-*)
    const sections = extractLinkSections(blocks)

    // Valid targets: live pages in the same workspace only
    let validTargets: string[] = []
    if (candidates.length > 0) {
      const rows = await db
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(
            inArray(pages.id, candidates),
            eq(pages.workspaceId, src.workspaceId),
            isNull(pages.deletedAt),
          ),
        )
      validTargets = rows.map((r) => r.id)
    }

    await db.transaction(async (tx) => {
      await tx.delete(pageLinks).where(eq(pageLinks.sourcePageId, sourcePageId))
      if (validTargets.length > 0) {
        await tx
          .insert(pageLinks)
          .values(
            validTargets.map((targetPageId) => ({
              sourcePageId,
              targetPageId,
              sections: sections.get(targetPageId) ?? null,
            })),
          )
          .onConflictDoNothing()
      }
    })
    bumpIndexEpoch()
  } catch (err) {
    console.error('[inkling] page_links reindex failed', sourcePageId, err)
  }
}
