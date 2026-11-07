import {
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { oauthClients, oauthGrants, pages, users, workspaces } from './schema'

/**
 * Workspace audit log (docs/adr/0946-*): one append-only row per administrative action, written in
 * the same transaction as the action. Content edits are not logged here (page_changes / snapshots
 * keep them). No IP address is stored. Rows are removed only by the per-workspace retention purge.
 */
export const workspaceAuditEvents = pgTable(
  'workspace_audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Actor display name at the time (kept when the account is deleted). */
    actorName: text('actor_name').notNull().default(''),
    /** OAuth client name when the action came through MCP (docs/adr/0936-*). */
    viaClient: text('via_client'),
    /** Dotted action name, e.g. 'member.added', 'settings.updated' (AuditAction in @inkling/shared). */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** Human label of the target at the time (member name, page title, client name). */
    targetLabel: text('target_label'),
    /** Small before/after summaries (changed fields only); never page bodies or secrets. */
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workspace_audit_ws_id_idx').on(t.workspaceId, t.id),
    index('workspace_audit_ws_action_idx').on(t.workspaceId, t.action, t.id),
    index('workspace_audit_created_idx').on(t.createdAt),
    // Hourly retention purge walks each workspace's old rows by range (docs/PERFORMANCE.md).
    index('workspace_audit_ws_created_idx').on(t.workspaceId, t.createdAt),
  ],
)

/**
 * Agent blocks (docs/adr/0947-*): MCP access of `userId`'s OAuth connections to one workspace is
 * refused. clientId null = every client of that user; otherwise only that registered client.
 * The grants themselves are untouched (they keep working in the user's other workspaces).
 */
export const workspaceAgentBlocks = pgTable(
  'workspace_agent_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
    /** Client display name when the block was made (the client row may be re-registered later). */
    clientName: text('client_name'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('workspace_agent_blocks_uniq').on(t.workspaceId, t.userId, t.clientId).nullsNotDistinct(),
  ],
)

/**
 * Per-workspace agent access record (docs/adr/0947-*): which OAuth connection reached which
 * workspace and when last, updated at most once a minute per (workspace, grant). Rows go away with
 * the grant (revoked or expired).
 */
export const workspaceAgentAccess = pgTable(
  'workspace_agent_access',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    firstUsedAt: timestamp('first_used_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.grantId] })],
)

/**
 * Page read counters (docs/adr/0953-*): web views and agent reads per page per server-local day.
 * Totals only, never who read: there is no user column on purpose. Buffered in memory and flushed
 * periodically; rows older than 90 days are purged.
 */
export const pageReads = pgTable(
  'page_reads',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.day] }), index('page_reads_day_idx').on(t.day)],
)

/**
 * Review priority cache (docs/adr/0953-*), rebuilt once a day per workspace by housekeeping (and
 * for one page after "Mark reviewed"): importance × probability of being out of date.
 */
export const pageReviewScores = pgTable(
  'page_review_scores',
  {
    pageId: uuid('page_id')
      .primaryKey()
      .references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Reads in the last 30 days (web + agents). */
    reads30: integer('reads30').notNull().default(0),
    /** Estimated rate (per day) at which the page drifts from reality. */
    lambda: doublePrecision('lambda').notNull(),
    /** Probability the page is out of date now: 1 − exp(−λ·t). */
    pStale: doublePrecision('p_stale').notNull(),
    /** max(reads30, floor) × pStale. */
    score: doublePrecision('score').notNull(),
    /** 'YYYY-MM-DD' when pStale crosses 0.5 (baseline + ln2/λ days). */
    dueOn: text('due_on').notNull(),
    /** Estimated minutes to review (from the body length). */
    estMinutes: integer('est_minutes').notNull().default(1),
    living: boolean('living').notNull().default(false),
    archiveCandidate: boolean('archive_candidate').notNull().default(false),
    computedOn: text('computed_on').notNull(),
  },
  (t) => [index('page_review_scores_ws_score_idx').on(t.workspaceId, t.score)],
)
