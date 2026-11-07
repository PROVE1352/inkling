import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'
import { rangeColumns } from './schema-range'

/**
 * Personal API tokens for the REST API (docs/adr/1201-*).
 *
 * `token_hash` is the SHA-256 (hex) of the whole token (`ink_pat_` + 43 base64url characters); the
 * raw token is shown once when it is made and never stored, like sessions (docs/adr/1060-*).
 * `prefix` keeps the first 12 characters for the list. `scope` holds the same strings as OAuth
 * grants ('read' or 'read write', docs/adr/0935-*). Revoking deletes the row.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    scope: text('scope').notNull(),
    ...rangeColumns(),
    /** null = never expires */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
)
