import { sql } from 'drizzle-orm'
import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages, users, workspaces } from './schema'

/**
 * Tainted connections (docs/adr/2040-* .. 2042-*): which flagged content an agent connection was handed,
 * and when. One row per (connection, source); `source` is 'page:<id>' (sections flagged at indexing
 * time, page_chunks.suspicious, docs/adr/0977-*) or 'file:<id>' (attachment text scanned when
 * read_file returns it, docs/adr/2046-*).
 *
 * - `connection`: the connection key used since 0.12, 'grant:<id>' (OAuth/MCP) or 'token:<id>'
 *   (personal API token). Not a foreign key: it names a row of either table; a revoked connection's
 *   rows are dropped by housekeeping with the old ones.
 * - `page_id`: the page (or the file's page; null for a legacy file without one), for display only.
 * - `fingerprint`: md5 over the flagged sections (anchor + section version) or over the whole file. A
 *   person's release keeps the row with `released_at`; reading the same flagged content again does
 *   not taint the connection again, changed flagged content does (new fingerprint → released_at cleared).
 * - A connection is "suggest only" while it has a row with `released_at IS NULL` and `tainted_at`
 *   inside the window (TAINT_WINDOW_MINUTES), in every workspace that has not switched the rule off.
 * No content is stored here: page id, rule ids and a hash only.
 */
export const connectionTaints = pgTable(
  'connection_taints',
  {
    connection: text('connection').notNull(),
    source: text('source').notNull(),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    rules: text('rules').array().notNull().default(sql`'{}'::text[]`),
    fingerprint: text('fingerprint').notNull(),
    taintedAt: timestamp('tainted_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    primaryKey({ columns: [t.connection, t.source] }),
    index('connection_taints_workspace_idx').on(t.workspaceId),
  ],
)
