import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

/**
 * OpenID Connect sign-in (docs/adr/1160-*, 1161-*).
 *
 * `user_identities`: an external identity is the pair (issuer, subject) of the provider's id_token
 * (`iss`, `sub`), never the email. One identity belongs to one account, and an account has at most
 * one identity per issuer. `email` is what the provider said at the last sign-in, for display only;
 * it never changes `users.email`.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.issuer, t.subject] }),
    uniqueIndex('user_identities_user_issuer_uq').on(t.userId, t.issuer),
  ],
)

/**
 * A sign-in that went to the provider and has not come back yet (10 minutes). Keyed by the SHA-256
 * of the `state` parameter; `browser_hash` is the SHA-256 of the cookie set on the browser that
 * started it, so a callback URL handed to someone else does not sign them in (login CSRF).
 * Consumed with DELETE … RETURNING (single use). `link_user_id` set = "connect to my account"
 * started from Settings by that signed-in user.
 */
export const oidcLoginStates = pgTable(
  'oidc_login_states',
  {
    stateHash: text('state_hash').primaryKey(),
    browserHash: text('browser_hash').notNull(),
    nonce: text('nonce').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    returnTo: text('return_to').notNull(),
    linkUserId: uuid('link_user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oidc_login_states_expires_idx').on(t.expiresAt)],
)
