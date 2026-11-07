import { index, integer, jsonb, pgTable, text, timestamp, boolean, uuid } from 'drizzle-orm/pg-core'
import { pages, users, workspaces } from './schema'

/**
 * iCal subscription tokens — one per user (docs/adr/0303-ical-subscription-token.md).
 * Only the SHA-256 of the token is stored; the token itself is shown once when issued.
 * Regenerating replaces the row (old URL stops working immediately).
 */
export const icalTokens = pgTable('ical_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** hex sha256(token) — unique lookup key for /ical/<token>.ics */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

/**
 * Google Sheets read sync (experimental `sheets-sync`, docs/adr/0306-sheets-read-sync.md).
 * One sync per collection page. Rows are upserted by `keyColumn`.
 */
export const collectionSheetSyncs = pgTable(
  'collection_sheet_syncs',
  {
    pageId: uuid('page_id')
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Sheet URL (may carry a sharing key). Sealed (`v1.…`, page id as AAD) when APP_SECRET_KEY is set (docs/adr/1111-*). */
    url: text('url').notNull(),
    keyColumn: text('key_column').notNull(),
    titleColumn: text('title_column'),
    intervalMinutes: integer('interval_minutes').notNull().default(15),
    enabled: boolean('enabled').notNull().default(true),
    /** user whose visibility/authorship the sync acts with (rows are created by this user) */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** claim marker — set atomically when a run starts (cross-process re-entry guard) */
    runningSince: timestamp('running_since', { withTimezone: true }),
    lastStatus: text('last_status', { enum: ['ok', 'error', 'running'] }),
    lastError: text('last_error'),
    lastStats: jsonb('last_stats'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('collection_sheet_syncs_due_idx').on(t.enabled, t.lastSyncedAt)],
)
