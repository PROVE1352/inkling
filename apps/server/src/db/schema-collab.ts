import { sql } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { pages, users, workspaces } from './schema'

/**
 * Suggested section edits (docs/adr/1530-*, 1531-*, 1533-*). An agent write that should not land
 * directly (patch_section with suggest=true, or any write under the "agents: suggestions only" lock
 * level, docs/adr/1532-*) is kept here instead of in the document, one row per section and author
 * connection, until a person with edit access accepts or rejects it.
 *
 *  - anchor:       the section's anchor when suggested; '' = the whole body (update_page).
 *  - block_id:     the heading block id (stable across renames; accept resolves it first).
 *  - base_version: the section version the agent read (v=…), or the section version at suggestion
 *                  time when the agent gave none; for '' the page's update stamp. Accept warns when
 *                  the section has changed since.
 *  - markdown:     the agent's Markdown (agent notation, docs/adr/1500-*), applied as written.
 *  - mode:         what the write meant to do (patch_section modes; page_replace / page_append
 *                  for update_page).
 *  - origin:       'asked' (suggest=true) or 'lock' (the lock turned a write into a suggestion).
 *  - connection:   'grant:<id>' / 'token:<id>' of the author's connection ('' = browser). A new
 *                  suggestion of the same author connection for the same section supersedes the
 *                  open one (the partial unique index keeps at most one open row per triple).
 */
export const sectionSuggestions = pgTable(
  'section_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    anchor: text('anchor').notNull(),
    blockId: text('block_id'),
    headingPath: text('heading_path').notNull().default(''),
    baseVersion: text('base_version'),
    markdown: text('markdown').notNull(),
    mode: text('mode', {
      enum: ['replace', 'append', 'prepend', 'insert_after', 'delete', 'page_replace', 'page_append'],
    }).notNull(),
    /** asked (suggest=true) / lock (a suggestions-only lock) / policy (the agent edit policy, docs/adr/1544-*). */
    origin: text('origin', { enum: ['asked', 'lock', 'policy'] }).notNull(),
    status: text('status', { enum: ['open', 'accepted', 'rejected', 'superseded', 'withdrawn'] })
      .notNull()
      .default('open'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    via: text('via'),
    connection: text('connection').notNull().default(''),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Auto-accept (docs/adr/1544-*): the rule that accepted it ('workspace' or 'page:<id>'). */
    rule: text('rule'),
    /** Why an auto-accept policy left it for a person (shown to the agent and in the web view). */
    reviewReason: text('review_reason'),
    /** Grace period: accepted by the rule at this time unless a person decides first. */
    autoAt: timestamp('auto_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('section_suggestions_auto_idx').on(t.autoAt).where(sql`status = 'open' AND auto_at IS NOT NULL`),
    index('section_suggestions_page_open_idx').on(t.pageId, t.createdAt).where(sql`status = 'open'`),
    index('section_suggestions_author_idx').on(t.authorId, t.createdAt),
    uniqueIndex('section_suggestions_open_key').on(t.pageId, t.anchor, t.authorId, t.connection).where(sql`status = 'open'`),
  ],
)

/**
 * Section claims (docs/adr/1535-*, 1536-*): "this connection is working on this section until …".
 * Short-lived, but kept in the database so every server process sees the same claim. A row whose
 * `expires_at` has passed is free: claims overwrite it, reads ignore it, housekeeping deletes it.
 * One claim per (page, anchor); `connection` is 'grant:<id>' / 'token:<id>'.
 */
export const sectionLeases = pgTable(
  'section_leases',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    anchor: text('anchor').notNull(),
    blockId: text('block_id'),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connection: text('connection').notNull(),
    via: text('via'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.anchor] }), index('section_leases_expires_idx').on(t.expiresAt)],
)

/**
 * "Last catch_up" markers (docs/adr/1537-*, replacing the plugin_storage rows of ADR 1522).
 * key: 'grant:<id>' / 'token:<id>' for a connection, 'person' for the person, each with
 * ':<workspaceId>' when the call was limited to a workspace. `at` (ms) never moves backwards.
 */
export const catchUpMarkers = pgTable(
  'catch_up_markers',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    cursor: text('cursor').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
)

/**
 * Agent edit policy and auto-accept rules (docs/adr/1544-*, 1545-*). One row per workspace with
 * page_id NULL: the workspace default level (direct / auto / review) and its rules. One row per lock
 * node whose agents preset is 'auto': that node's rules (`level` is then always 'auto').
 *  - modes:       patch modes accepted without a person (default append, insert_after, prepend)
 *  - connections: 'grant:<id>' / 'token:<id>' allowed; [] = every connection in the workspace
 *  - max_lines / max_chars: size limit of the change (diff lines / characters); NULL = none
 *  - grace_minutes: 0 = accept at once; N = accept after N minutes unless a person decides first
 */
export const agentEditPolicies = pgTable(
  'agent_edit_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ['direct', 'auto', 'review'] }).notNull().default('direct'),
    modes: jsonb('modes').notNull().default(sql`'["append","insert_after","prepend"]'::jsonb`),
    connections: jsonb('connections').notNull().default(sql`'[]'::jsonb`),
    maxLines: integer('max_lines'),
    maxChars: integer('max_chars'),
    graceMinutes: integer('grace_minutes').notNull().default(0),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_edit_policies_ws_key').on(t.workspaceId).where(sql`page_id IS NULL`),
    uniqueIndex('agent_edit_policies_page_key').on(t.pageId).where(sql`page_id IS NOT NULL`),
  ],
)
