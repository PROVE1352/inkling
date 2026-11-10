import { sql } from 'drizzle-orm'
import { bigserial, boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages, users, workspaces } from './schema'

/**
 * Database automations (docs/adr/2240-* .. 2243-*): rules of a collection — a trigger, an optional
 * condition (the view filter tree) and actions. Run by the 'automation' outbox consumer
 * (automations/runner.ts) as `created_by`, after the row write that triggered them committed.
 */
export const collectionAutomations = pgTable(
  'collection_automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** AutomationTrigger (packages/shared automations.ts) */
    trigger: jsonb('trigger').notNull(),
    /** ViewFilter or null */
    condition: jsonb('condition'),
    /** AutomationAction[] */
    actions: jsonb('actions').notNull().default(sql`'[]'::jsonb`),
    /** The author: the rule runs as this account (null after the account is deleted: the rule cannot run). */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Failed runs in a row; AUTOMATION_DISABLE_AFTER turns the rule off. */
    failureCount: integer('failure_count').notNull().default(0),
    autoDisabledAt: timestamp('auto_disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The change-log consumer's lookup: enabled rules of the collections a batch touched.
    index('collection_automations_coll_idx').on(t.collectionId).where(sql`${t.enabled}`),
  ],
)

/** Recent runs of a rule (AUTOMATION_RUNS_KEPT per rule), for the settings screen. */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => collectionAutomations.id, { onDelete: 'cascade' }),
    /** The triggering row; no FK, a run outlives a purged row. */
    rowId: uuid('row_id'),
    /** ok | failed | skipped */
    status: text('status', { enum: ['ok', 'failed', 'skipped'] }).notNull(),
    failedAction: smallint('failed_action'),
    error: text('error'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    depth: smallint('depth').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('automation_runs_rule_idx').on(t.automationId, t.id)],
)
