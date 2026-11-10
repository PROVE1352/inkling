import { jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

/**
 * Onboarding state per person (docs/adr/2380-*): one row, created the first time the web app asks
 * for it. No row = an account made after this table (a new account: the intro plays once by itself).
 * Migration 0060 gives every account that existed before it a row with `{"legacy": true}`, so people
 * who already use the app are never shown the intro or the checklist unless they ask for them.
 *
 * `state` (OnboardingState in onboarding/state.ts): when the intro was closed, the checklist's
 * dismissed/collapsed flags, items done (sticky: an item stays done once seen), the browser-only
 * events, and the sample pages made for this person (root id and every page id, per workspace).
 */
export const userOnboarding = pgTable('user_onboarding', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  state: jsonb('state').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
