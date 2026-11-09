import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { comments, notifications, pages, users, workspaces } from './schema'

/**
 * "Later" list (docs/adr/1410-*, 1411-*): pages, comment threads and notifications a person put
 * aside, with an optional reminder. Nothing about the target is copied (no title, no excerpt): the
 * list joins the live rows and shows a title only while the person can still see the page, so a
 * page made private, a workspace left or a 2FA block hides it without touching these rows.
 *
 * kind:
 *  - 'page'          page_id (+ anchor)
 *  - 'thread'        page_id + thread_id (comment thread root)
 *  - 'notification'  page_id (+ thread_id, anchor) + notification_id; the label comes from the
 *                    notification while it exists, the target from the copied ids afterwards.
 *
 * `target_key` ('page:<id>', 'thread:<id>', 'notification:<id>') makes saving twice an upsert.
 * Reminders: `remind_at` is an absolute instant (UTC); `remind_tz` is the device time zone it was
 * picked in (stored for wording; nothing reads it yet). The sweep (apps/server/src/later.ts) claims due rows by setting
 * `reminded_at` in the transaction that queues the notification.
 */
export const laterItems = pgTable(
  'later_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['page', 'thread', 'notification'] }).notNull(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => comments.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id').references(() => notifications.id, { onDelete: 'set null' }),
    anchor: text('anchor'),
    targetKey: text('target_key').notNull(),
    /** Marked done (kept in the "done" tab until deleted). */
    doneAt: timestamp('done_at', { withTimezone: true }),
    remindAt: timestamp('remind_at', { withTimezone: true }),
    remindTz: text('remind_tz'),
    /** Set when the reminder was queued (claim); cleared when a new reminder is set. */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('later_items_user_target_key').on(t.userId, t.targetKey),
    index('later_items_user_created_idx').on(t.userId, t.createdAt),
    // The reminder sweep reads only due, unclaimed, open rows (docs/PERFORMANCE.md).
    index('later_items_due_idx').on(t.remindAt).where(sql`remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL`),
    index('later_items_page_idx').on(t.pageId),
  ],
)

/**
 * Followed comment threads (docs/adr/1412-*). One row per (person, thread). `following = false` is
 * an explicit unfollow: auto-follow (`INSERT … ON CONFLICT DO NOTHING` on posting) never turns it
 * back on. Followers of a thread are the recipients of `comment_reply`; the Threads view lists
 * followed threads with replies newer than `last_read_at` by someone else.
 */
export const threadFollows = pgTable(
  'thread_follows',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    following: boolean('following').notNull().default(true),
    /** 'auto' = started or replied; 'manual' = the follow button. */
    source: text('source', { enum: ['auto', 'manual'] }).notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.threadId] }),
    // Recipients of a reply.
    index('thread_follows_thread_idx').on(t.threadId).where(sql`following`),
    // The Threads view of one person in one workspace.
    index('thread_follows_user_ws_idx').on(t.userId, t.workspaceId).where(sql`following`),
  ],
)
