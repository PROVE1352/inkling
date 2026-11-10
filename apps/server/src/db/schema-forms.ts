import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { collectionViews, users } from './schema'

/**
 * Public links of form views (docs/adr/1821-*): one row per form view that anyone with the link may
 * submit. The token is stored like a page's share token (docs/adr/1110-*): its SHA-256 for lookups and
 * a sealed copy for "copy link". Turning the link off deletes the row, so the old link stops at once
 * and a new link is a new token.
 *
 * `published_by` is the member who turned the link on: public submissions are made as that member
 * (via "form"), so their edit rights decide whether the form still accepts answers (docs/adr/1822-*).
 */
export const collectionFormLinks = pgTable('collection_form_links', {
  viewId: uuid('view_id')
    .primaryKey()
    .references(() => collectionViews.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  tokenEnc: text('token_enc'),
  publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
