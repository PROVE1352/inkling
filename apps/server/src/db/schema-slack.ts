import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users, workspaces } from './schema'

/**
 * Slack app per workspace (docs/adr/1800-* .. 1806-*). Each operator creates their own Slack app
 * (self-hosted: there is no shared Inkling app) and pastes its bot token and signing secret here.
 *
 * Both secrets are stored like webhook URLs (docs/adr/1111-*): sealed with APP_SECRET_KEY
 * (`v1.…`, the workspace id as AAD) when the key is set, else as typed; read them through
 * slack/config.ts. Neither is ever returned by the API or written to a log.
 */
export const slackIntegrations = pgTable('slack_integrations', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Bot User OAuth Token (`xoxb-…`), protected (sealed when APP_SECRET_KEY is set). */
  botToken: text('bot_token').notNull(),
  /** Last four characters of the token, for the masked display. */
  botTokenHint: text('bot_token_hint').notNull(),
  /** Signing secret of the Slack app, protected like the token. */
  signingSecret: text('signing_secret').notNull(),
  /** Slack team of the token (auth.test at save time); requests of other teams are refused. */
  teamId: text('team_id').notNull(),
  teamName: text('team_name'),
  botUserId: text('bot_user_id'),
  /** Channel for notifications (id, not name). */
  channelId: text('channel_id').notNull(),
  channelName: text('channel_name'),
  /** Enabled notification kinds: SlackEventKind[] */
  events: jsonb('events').notNull().default(sql`'[]'::jsonb`),
  /** '1' = posts and commands on. Text boolean like workspace_webhooks.enabled. */
  enabled: text('enabled', { enum: ['0', '1'] }).notNull().default('1'),
  /** Set when Slack refused for good (revoked token, bot out of the channel …): channel posts pause until a save or a passing test. */
  blockedReason: text('blocked_reason'),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  /** Local date of the last daily change summary (claimed before it is queued). */
  digestSentOn: text('digest_sent_on'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Slack account → Inkling account, per workspace. 'link' rows are confirmed by the person with a
 * one-time code (`/inkling link`); 'email' rows remember an address match so later commands need no
 * Slack API call. Membership is checked again on every command.
 */
export const slackUserLinks = pgTable(
  'slack_user_links',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    teamId: text('team_id').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: text('method', { enum: ['email', 'link'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.teamId, t.slackUserId] }),
    uniqueIndex('slack_user_links_user_key').on(t.workspaceId, t.userId),
  ],
)

/** One-time link codes from `/inkling link`: SHA-256 only, 10 minutes, single use. */
export const slackLinkCodes = pgTable(
  'slack_link_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    teamId: text('team_id').notNull(),
    slackUserId: text('slack_user_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('slack_link_codes_expires_idx').on(t.expiresAt)],
)

/**
 * Replay guard for signed Slack requests (docs/adr/1804-*): one row per accepted signature
 * (`sig:<sha256>`) and per Events API event id (`evt:<id>`, Slack re-signs its retries). Kept a little
 * longer than the 5-minute timestamp window, then pruned.
 */
export const slackRequestNonces = pgTable(
  'slack_request_nonces',
  {
    nonce: text('nonce').primaryKey(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('slack_request_nonces_seen_idx').on(t.seenAt)],
)
