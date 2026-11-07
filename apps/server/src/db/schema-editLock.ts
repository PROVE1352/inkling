import { sql } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages, users, workspaces } from './schema'

/**
 * Access overrides of a locked page (docs/adr/0970-*): per subject, bits removed (deny) and added
 * (allow) on top of what the layers above granted. Bits: 1 = edit, 2 = comment. Subjects:
 * 'everyone' (people), 'agents' (any MCP / OAuth request) and 'user:<id>' (one member, user_id
 * set). Rows only count while the page's `edit_locked` is true; the API writes them from the
 * people/agents/editors presets, so the generic shape is what the evaluation reads.
 */
export const pageAccessOverrides = pgTable(
  'page_access_overrides',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    allow: smallint('allow').notNull().default(0),
    deny: smallint('deny').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.subject] }), index('page_access_overrides_user_idx').on(t.userId)],
)

/**
 * Agent instruction pages (docs/adr/0975-*): a locked shared doc page designated as instructions for
 * agents working in the workspace. mode: always | match | manual; apply_to: `page:<id>` subtree
 * roots or title-path globs (match only).
 */
export const agentInstructions = pgTable(
  'agent_instructions',
  {
    pageId: uuid('page_id')
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['always', 'match', 'manual'] }).notNull(),
    applyTo: jsonb('apply_to').notNull().default(sql`'[]'::jsonb`),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_instructions_ws_idx').on(t.workspaceId)],
)

/**
 * Access version of a workspace (docs/adr/1071-*): one row per workspace, bumped in the same
 * transaction as every change that can alter a write decision there (edit locks and their rules,
 * agent instruction designations, agent blocks, page owners, parent_id moves). In-process caches
 * (lock chains, agent blocks, "has instructions") are keyed by `version`, never by time.
 *
 * It is also the workspace's write gate: transactional writers read it `FOR SHARE` (fresh `version`
 * and `locked_pages` even after waiting), bumpers take it with an upsert (row lock that conflicts
 * with FOR SHARE) right after the tree / member advisory locks and before touching any page row.
 * `locked_pages` = number of pages with edit_locked (recounted by every lock change and at boot);
 * 0 lets writers skip the lock walk. A missing row means version 0 and is created on first use.
 */
export const workspaceAclVersions = pgTable('workspace_acl_versions', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  lockedPages: integer('locked_pages').notNull().default(0),
})
