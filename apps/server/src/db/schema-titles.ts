import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages, workspaces } from './schema'

/**
 * Former page titles (docs/adr/1121-*): `[[Old title]]` written after a rename still finds the page.
 *
 * One row per (workspace, lower-cased former title, page). The row points at the page id, never at
 * the next title: ids do not change, so a chain A → B → C is stored as A → page and B → page (the
 * union-find picture with every path already compressed to the root). When several pages once held
 * the same name, the resolver takes the most recent holder *the reader may see* (renamed_at), so a
 * private page's rename never changes what a shared name means for anyone else. Current titles and
 * aliases win over these rows (md/importer.ts buildTitleResolver).
 */
export const pageFormerTitles = pgTable(
  'page_former_titles',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `title.toLowerCase()` in JavaScript — the same key the resolver builds for current titles. */
    titleKey: text('title_key').notNull(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** The former title as it was spelled. */
    title: text('title').notNull(),
    renamedAt: timestamp('renamed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.titleKey, t.pageId] }),
    index('page_former_titles_page_idx').on(t.pageId),
  ],
)
