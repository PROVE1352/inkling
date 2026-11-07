import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
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
