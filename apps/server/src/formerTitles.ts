import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from './db/index'
import { pageFormerTitles, pages } from './db/schema'
import { visibleTo } from './pageDto'
import type { Tx } from './pageTree'

/**
 * Former page titles (docs/adr/1121-*). `[[A]]` written after page A was renamed to B (and then C)
 * still resolves to that page.
 *
 * Why no union-find here although renames form chains: the chain A → B → C only exists in the
 * change log. What is stored is A → page and B → page, the page id being the root that never
 * changes — every path is compressed at write time, so a lookup is one hop. A union-find over the
 * *names* would be wrong, not just slower: when another page later takes the name A, A would have
 * to leave the first page's set, and union-find has no split (see unionFind.test.ts and
 * formerTitles.db.test.ts for the case it gets wrong).
 */

/** Key of a title in the resolver maps (same rule as buildTitleResolver's titleMap). */
export const titleKey = (title: string): string => title.toLowerCase()

/**
 * Records a rename inside the renaming transaction: this page's row for the old name (re)stamped
 * now, and its row for the new name, if it once had that name, dropped (renamed back to A: the
 * current title answers again). Rows belong to one page each, so renames of different pages never
 * touch the same row; renames of one page are serialised by the page row lock of the PATCH.
 */
export async function recordRename(
  tx: Pick<Tx, 'insert' | 'delete'>,
  workspaceId: string,
  pageId: string,
  oldTitle: string,
  newTitle: string,
): Promise<void> {
  const oldKey = titleKey(oldTitle)
  const newKey = titleKey(newTitle)
  if (oldKey === newKey) return // case-only change: the resolver ignores case anyway
  if (oldTitle.trim()) {
    await tx
      .insert(pageFormerTitles)
      .values({ workspaceId, titleKey: oldKey, pageId, title: oldTitle })
      .onConflictDoUpdate({
        target: [pageFormerTitles.workspaceId, pageFormerTitles.titleKey, pageFormerTitles.pageId],
        set: { title: oldTitle, renamedAt: sql`now()` },
      })
  }
  await tx
    .delete(pageFormerTitles)
    .where(
      and(
        eq(pageFormerTitles.workspaceId, workspaceId),
        eq(pageFormerTitles.titleKey, newKey),
        eq(pageFormerTitles.pageId, pageId),
      ),
    )
}

/**
 * Former title → page id for the pages `userId` may see (live pages only), the most recent holder
 * of each name winning. Same visibility rule as the current titles in buildTitleResolver (ADR
 * 0756): a private page's old name is not a link target for anyone else, and a private page that
 * held a shared page's old name later does not take that name away from other readers.
 */
export async function formerTitleMap(workspaceId: string, userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: pageFormerTitles.titleKey, pageId: pageFormerTitles.pageId })
    .from(pageFormerTitles)
    .innerJoin(pages, eq(pages.id, pageFormerTitles.pageId))
    .where(and(eq(pageFormerTitles.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)))
    .orderBy(asc(pageFormerTitles.renamedAt)) // asc → the newest holder stays in the map
  return new Map(rows.map((r) => [r.key, r.pageId]))
}
