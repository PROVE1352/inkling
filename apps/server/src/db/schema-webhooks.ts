import { sql } from 'drizzle-orm'
import { bigint, bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users, workspaces } from './schema'

/**
 * Workspace outgoing webhooks: Slack / Discord incoming-webhook URLs, or any https endpoint that
 * takes signed JSON events ('generic', docs/adr/1190-*).
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
    kind: text('kind', { enum: ['slack', 'discord', 'generic'] }).notNull(),
    /**
     * Full incoming-webhook URL (secret). Sealed with APP_SECRET_KEY (`v1.…`, row id as AAD) when the
     * key is set, else plaintext; read it through openStoredUrl (docs/adr/1111-*).
     */
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
    /** First failed event of the current failure streak (cleared on success): the 24 h auto-disable rule (docs/adr/1192-*). */
    failingSince: timestamp('failing_since', { withTimezone: true }),
    /**
     * Signing secret of a 'generic' hook (`whsec_…`, docs/adr/1190-*). Stored like `url`: sealed with
     * APP_SECRET_KEY (row id as AAD) when the key is set. Shown once on create and on rotation.
     */
    secret: text('secret'),
    /** The secret before the last rotation, still signed with until `previousSecretUntil`. */
    previousSecret: text('previous_secret'),
    previousSecretUntil: timestamp('previous_secret_until', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_webhooks_ws_idx').on(t.workspaceId)],
)

/**
 * Recent deliveries of a hook (docs/adr/1191-*): one row per outbox delivery, rewritten by every
 * attempt in the statement that finishes or reschedules the outbox row, plus one row per test event
 * (`outboxId` null). Pruned to the newest WEBHOOK_DELIVERY_KEEP per hook. Events that were skipped at
 * delivery (private page, hook disabled) are not recorded.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    hookId: uuid('hook_id')
      .notNull()
      .references(() => workspaceWebhooks.id, { onDelete: 'cascade' }),
    /** outbox.id = X-Inkling-Delivery. No foreign key: outbox rows are purged before these. */
    outboxId: bigint('outbox_id', { mode: 'number' }),
    /** WebhookEvent, or 'test'. */
    event: text('event').notNull(),
    /** 'ok' | 'retrying' | 'failed' */
    status: text('status', { enum: ['ok', 'retrying', 'failed'] }).notNull(),
    attempts: integer('attempts').notNull().default(1),
    /** HTTP status of the last attempt (null: no response). */
    statusCode: integer('status_code'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    /** Start of a non-2xx response body, ≤ 200 printable characters; never stored for 2xx. */
    responseExcerpt: text('response_excerpt'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_hook_idx').on(t.hookId, t.id),
    uniqueIndex('webhook_deliveries_outbox_key').on(t.outboxId),
  ],
)
