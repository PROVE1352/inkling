import { boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sessions, users } from './schema'

/**
 * Web push (docs/adr/2220-* .. 2223-*).
 *
 * One row per browser that turned push on ("this device"). The row belongs to the session that
 * registered it: logging out, "sign out everywhere" (password change, admin revoke), session
 * expiry and account deletion remove it through the foreign keys. The app re-sends the browser's
 * subscription on start, so a new sign-in on the same device binds it to the new session.
 *
 * `endpoint` (a capability URL of the push service) and `auth` (the message encryption secret) are
 * stored protected like webhook URLs (docs/adr/1111-*): sealed with APP_SECRET_KEY when it is set,
 * otherwise as they are. `endpoint_hash` (SHA-256 hex of the endpoint) is the unique lookup key.
 * `p256dh` is the browser's public key.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sessions.token (its SHA-256) of the browser session that registered the subscription. */
    sessionToken: text('session_token')
      .notNull()
      .references(() => sessions.token, { onDelete: 'cascade', onUpdate: 'cascade' }),
    endpointHash: text('endpoint_hash').notNull().unique(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** Fingerprint of the VAPID public key the browser subscribed with (a key change voids the row). */
    vapidKeyId: text('vapid_key_id').notNull(),
    /** Device name shown in Settings (from the user agent, or what the person typed). */
    label: text('label'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    /** Short reason of the last failure (status code or error code; never the endpoint). */
    lastError: text('last_error'),
    /** Failed deliveries in a row; the row is removed at PUSH_MAX_FAILURES. */
    failureCount: integer('failure_count').notNull().default(0),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId), index('push_subscriptions_session_idx').on(t.sessionToken)],
)

/**
 * The server's VAPID key pair when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set: made on first
 * use, one row. `private_key` is protected like the subscription secrets (sealed with
 * APP_SECRET_KEY when it is set).
 */
export const pushVapidKeys = pgTable('push_vapid_keys', {
  id: smallint('id').primaryKey().default(1),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Per-person push choices. A missing row means the defaults (on, default kinds, content shown). */
export const pushSettings = pgTable('push_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  /** Kind groups that push (PushKindGroup[]); null = the defaults. */
  kinds: jsonb('kinds').$type<string[]>(),
  /** Lock-screen privacy: "New notification" without who, where or what. */
  hideContent: boolean('hide_content').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
