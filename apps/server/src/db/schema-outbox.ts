import { sql } from 'drizzle-orm'
import { bigint, bigserial, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { workspaces } from './schema'

/**
 * Transactional outbox (docs/adr/1080-*, 1081-*).
 *
 * Writers insert one row in (or right after) the transaction of the change; consumers in
 * `apps/server/src/outbox.ts` turn committed rows into their effect and remove or finish them in the
 * same transaction as the effect (page_changes, notifications) or after a delivery (webhooks).
 *
 * topic:
 *  - 'change'  change-log input (section deltas, page events, created_via relabels). One writer
 *              at a time under an advisory lock assigns page_changes.seq, so seq order = commit order.
 *  - 'notify'  one notification event (NotifyInput). Deleted in the transaction that writes the
 *              notification rows: exactly once.
 *  - 'webhook' one delivery (event × hook). Leased while the HTTP call is in flight; kept as 'done'
 *              for the dedupe window so a re-emitted event with the same key is a no-op.
 *  - 'slack'   one Slack channel post or link unfurl of a workspace's Slack app (docs/adr/1802-*), leased
 *              like a webhook delivery.
 *
 * state: 'pending' → (deleted) | 'done' | 'dead' (gave up after OUTBOX_MAX_ATTEMPTS, kept for
 * inspection until purged).
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    topic: text('topic', { enum: ['change', 'notify', 'webhook', 'slack'] }).notNull(),
    /** Idempotency key (webhook deliveries: event key + hook id). Unique while the row exists. */
    dedupeKey: text('dedupe_key'),
    /**
     * Process instance that wrote the row. 'notify' and 'webhook' rows are taken by that instance
     * (it has the sockets and timers the side effects need); others take them over 10 s after they
     * became due (crash recovery, outbox.ts). 'change' rows go to whoever holds the lock.
     */
    origin: text('origin'),
    /** Owning workspace: rows of a purged workspace go with it. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    state: text('state', { enum: ['pending', 'done', 'dead'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Not processed before this time (retry backoff, delayed webhook events). */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    /** Webhook lease: another consumer may take the row only after this time. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    // Consumers scan pending rows of one topic in id order.
    index('outbox_pending_idx').on(t.topic, t.id).where(sql`state = 'pending'`),
    // Purge of finished rows.
    index('outbox_finished_idx').on(t.finishedAt).where(sql`state <> 'pending'`),
    uniqueIndex('outbox_dedupe_key').on(t.dedupeKey),
  ],
)

/**
 * Change feed bookkeeping (docs/adr/1080-*): one row. `high_water` is the highest page_changes.seq
 * ever handed out in a cursor; the change-log consumer never merges into a row at or below it.
 * Read and written only under the change-log advisory lock.
 */
export const changeFeedState = pgTable('change_feed_state', {
  id: smallint('id').primaryKey().default(1),
  highWater: bigint('high_water', { mode: 'number' }).notNull().default(0),
})
