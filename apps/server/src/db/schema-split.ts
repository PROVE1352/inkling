import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages } from './schema'

/**
 * Growing pages (docs/adr/1141-*): automatic splitting of a log page and the one-time "this page is
 * large" notice to its owner. One row per page that has either; no row = never rotates, never hinted.
 */
export const pageRotations = pgTable('page_rotations', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  /** 'month' = one subpage per calendar month, 'size' = a new subpage once the current one is past max_bytes; null = off. */
  mode: text('mode', { enum: ['month', 'size'] }),
  /** Size mode: V1 bytes of stored state from which the current subpage is full. */
  maxBytes: integer('max_bytes').notNull().default(1024 * 1024),
  /** Subpage appends currently go to (null = none yet; size mode starts with the page itself). */
  currentPageId: uuid('current_page_id').references(() => pages.id, { onDelete: 'set null' }),
  /** Month mode: the `YYYY-MM` the current subpage holds. */
  currentKey: text('current_key'),
  /** When the owner was told the page is large (once per page). */
  hintedAt: timestamp('hinted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
