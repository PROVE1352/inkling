import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages, users, workspaces } from './schema'

/**
 * Page verification (docs/adr/1840-*): someone responsible for a page says "this is correct" until
 * a date. One row per verified page; no row = never verified (or the verification was removed).
 * Past `expires_at` the page reads as "needs verification again" — nothing rewrites the row, the
 * comparison is made at read time with the server clock.
 *
 * `base_seq` is the page's highest change-feed sequence (page_changes.seq) when it was verified:
 * sections logged after it are "changed since verification" (docs/adr/1841-*). Change-feed
 * retention purges old rows, so the count is a lower bound for verifications older than it.
 */
export const pageVerifications = pgTable(
  'page_verifications',
  {
    pageId: uuid('page_id')
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
    /** The verification lapses at this instant (server clock). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** page_changes.seq high-water mark of the page at verification time (0 = none logged). */
    baseSeq: bigint('base_seq', { mode: 'number' }).notNull().default(0),
    /** Optional short note shown with the badge ("checked against the 2026 policy"). */
    note: text('note'),
  },
  (t) => [index('page_verifications_ws_expires_idx').on(t.workspaceId, t.expiresAt)],
)
