import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

/**
 * Member status (docs/adr/1845-*): a short message with an emoji that a person sets for everyone who
 * shares a workspace with them ("Exam week, back Friday"). One per account, not per workspace.
 * `clear_at` = the status disappears at this instant (server clock, compared at read time; nothing
 * deletes the row until the person sets or clears it again). null = until cleared by hand.
 */
export const userStatuses = pgTable('user_statuses', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji'),
  text: text('text').notNull().default(''),
  clearAt: timestamp('clear_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
