import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users, workspaces } from './schema'

/**
 * Workspace outgoing webhooks (Slack / Discord incoming-webhook URLs).
 * The URL embeds a bearer secret: it is stored server-side only and never returned in full.
 * See docs/adr/0504-workspace-webhooks.md.
 */
export const workspaceWebhooks = pgTable(
  'workspace_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['slack', 'discord'] }).notNull(),
    /** Full incoming-webhook URL (secret). */
    url: text('url').notNull(),
    /** Subscribed events: WebhookEvent[] */
    events: jsonb('events').notNull().default(sql`'[]'::jsonb`),
    /** '1' = active. Text boolean ('0'/'1'). */
    enabled: text('enabled', { enum: ['0', '1'] }).notNull().default('1'),
    /** Consecutive failed deliveries (reset on success). */
    failureCount: integer('failure_count').notNull().default(0),
    lastError: text('last_error'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Set when disabled automatically after too many consecutive failures. */
    autoDisabledAt: timestamp('auto_disabled_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_webhooks_ws_idx').on(t.workspaceId)],
)
