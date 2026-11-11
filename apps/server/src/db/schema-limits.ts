import { bigserial, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

/**
 * Restricted mode (0.22, docs/adr/2500-*).
 *
 * user_consents: what a person agreed to on sign-up or on the consent screen (LEGAL_DIR): one row per
 * ticked item and document version, written in the transaction that creates the account or records
 * the consent. Deleted with the account.
 */
export const userConsents = pgTable(
  'user_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The item id in signup.json (e.g. 'terms', 'privacy', 'age_14'). */
    itemId: text('item_id').notNull(),
    /** The document version the person saw (sha256 prefix of LEGAL_DIR's files). */
    version: text('version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
  },
  (t) => [index('user_consents_user_idx').on(t.userId, t.version)],
)

/**
 * signup_events: the IP of each sign-up, for SIGNUP_PER_IP_PER_DAY. No link to the account (the row
 * outlives it and says nothing about who signed up); housekeeping deletes rows after 30 days.
 */
export const signupEvents = pgTable(
  'signup_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ip: text('ip').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('signup_events_ip_idx').on(t.ip, t.createdAt), index('signup_events_created_idx').on(t.createdAt)],
)
