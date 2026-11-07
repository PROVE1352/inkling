import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages } from './schema'

/**
 * Vault sync (experimental `vault-sync`) — per-page cache of the canonical markdown hash for a
 * given revision token. Written by the sync read/write routes; the change feed returns the cached
 * `contentHash` only while `revision` still matches the page's current revision, so a stale row is
 * harmless (the client then fetches the markdown). See docs/adr/0200-vault-sync-protocol.md.
 */
export const pageSyncHashes = pgTable('page_sync_hashes', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  revision: text('revision').notNull(),
  contentHash: text('content_hash').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
