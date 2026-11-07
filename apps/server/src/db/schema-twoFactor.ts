import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

/**
 * Two-step verification (TOTP, RFC 6238) — docs/adr/1061-*.
 *
 * One row per account that started or finished setup. The secret is never stored in plaintext:
 * `secret_enc` is AES-256-GCM under a key derived from APP_SECRET_KEY, bound to the user id
 * (secretBox.ts). `enabled_at` null = setup started but not confirmed with a code yet (login is not
 * affected). `last_used_step` is the newest 30-second step accepted, so a code (and older ones)
 * cannot be replayed.
 */
export const userTotp = pgTable('user_totp', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEnc: text('secret_enc').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Single-use recovery codes (10 per setup). Only SHA-256 (hex) of the normalized code is stored;
 * a code is consumed with DELETE … RETURNING. Regenerating or turning 2FA off deletes the rest.
 */
export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_recovery_codes_user_idx').on(t.userId)],
)

/**
 * The step between "password correct" and "code correct" at sign-in. The browser holds the raw
 * challenge token; only its SHA-256 is stored. Five minutes, at most five wrong codes, then the
 * password has to be entered again. `password_hash` is the hash verified in step one: the session
 * is only created while it is still the account's hash (a reset in between voids the challenge).
 */
export const totpLoginChallenges = pgTable(
  'totp_login_challenges',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('totp_login_challenges_user_idx').on(t.userId),
    index('totp_login_challenges_expires_idx').on(t.expiresAt),
  ],
)
