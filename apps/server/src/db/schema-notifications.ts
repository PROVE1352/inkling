import { sql } from 'drizzle-orm'
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { pages, users, workspaces } from './schema'

/**
 * Notification subscriptions (docs/adr/1001-*): one row per (user, workspace, root page). A null
 * root is the user's default for the whole workspace. The nearest row wins: a row on the page
 * itself, then the closest ancestor whose row covers its subtree, then the workspace row, then the
 * built-in default ('mentions'). "Follow" is a row with level 'all'.
 */
export const notificationPrefs = pgTable(
  'notification_prefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    rootPageId: uuid('root_page_id').references(() => pages.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ['all', 'mentions', 'nothing', 'mute'] }).notNull(),
    /** false = this page only; true = the page and everything under it. */
    subtree: boolean('subtree').notNull().default(true),
    /** Daily summary of agent edits under this root (docs/adr/1004-*). */
    agentDigest: boolean('agent_digest').notNull().default(false),
    /** End of the window the last AI summary of this row covered. */
    agentDigestSentAt: timestamp('agent_digest_sent_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('notification_prefs_user_root_key').on(t.userId, t.workspaceId, t.rootPageId).nullsNotDistinct(),
    index('notification_prefs_root_idx').on(t.rootPageId),
    index('notification_prefs_digest_idx').on(t.workspaceId).where(sql`agent_digest`),
  ],
)

/** Per-user delivery settings (docs/adr/1004-*). A missing row means the defaults. */
export const userNotificationSettings = pgTable('user_notification_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Mail right away for direct items (mentions, replies, assignments). */
  emailInstant: boolean('email_instant').notNull().default(true),
  /** Summary mail: 'off' | 'daily' | 'weekly'. */
  emailDigest: text('email_digest', { enum: ['off', 'daily', 'weekly'] }).notNull().default('daily'),
  /** End of the window the last digest covered (mail or in-app AI summary). */
  digestSentAt: timestamp('digest_sent_at', { withTimezone: true }),
  /** Follow a comment thread when starting it or replying (docs/adr/1412-*). */
  threadAutoFollow: boolean('thread_auto_follow').notNull().default(true),
  /** Notify (bell, mail) about replies in followed threads; the Threads view lists them either way. */
  threadReplies: boolean('thread_replies').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Users @mentioned in a document body (derived index, rebuilt on every index pass; docs/adr/1002-*).
 * `user_ids` null = baseline unknown (pages that existed before this table): the first pass records
 * the set without notifying, so an upgrade does not replay every old mention.
 */
export const pageMentions = pgTable('page_mentions', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  userIds: jsonb('user_ids'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
