import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

/** Stored full-text vector (section index, docs/adr/0926-*). */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

/** bytea for storing Yjs document snapshots */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  /**
   * Account origin. 'local' = Inkling-only account created with a signup key (password is verified only
   * against the argon2 hash here), 'delegated' = account mirrored from delegated login to an external auth server
   * (DELEGATED_AUTH_URL; no local password, random hash). Login picks the verification path from this value, and
   * a 'local' account's password is never sent to the external auth server.
   */
  origin: text('origin', { enum: ['local', 'delegated'] })
    .notNull()
    .default('local'),
  /** Admin: can issue/revoke signup keys and list users. */
  isAdmin: boolean('is_admin').notNull().default(false),
  /** Signup key used to create this account. For key -> signup tracing; only set when origin='local'. */
  signupKey: text('signup_key'),
  /** When the email was verified. null = unverified (pre-migration accounts are null too, but are not retroactively blocked). */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  /**
   * Whether REQUIRE_EMAIL_VERIFICATION applies to this account. Only local accounts created after email
   * verification was introduced are true; older accounts stay false and keep logging in without verification.
   */
  mustVerifyEmail: boolean('must_verify_email').notNull().default(false),
  /** UI/email language ('en' | 'ko'). null = follow DEFAULT_LOCALE / the browser (docs/adr/0901-*). */
  locale: text('locale'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Inkling's own signup keys. Unrelated to the external auth server used for delegated login; accounts made
 * with these keys work only in Inkling. expiresAt NULL = never expires.
 * A key with maxUses=1 can also serve as a password reset code for the one person who signed up with it.
 */
export const signupKeys = pgTable('signup_keys', {
  key: text('key').primaryKey(),
  note: text('note'),
  maxUses: integer('max_uses').notNull().default(1),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * One-time password reset codes issued by an admin. The raw code is never stored, only SHA-256 (hex).
 * Bound to a specific user, expires after 24 hours, consumed on use via DELETE … RETURNING.
 */
export const passwordResetCodes = pgTable(
  'password_reset_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_reset_codes_user_idx').on(t.userId)],
)

/**
 * Queue of "Forgot password" requests from the login screen. Stored only for accounts that actually exist;
 * a partial unique index keeps at most one pending request per user (re-requesting refreshes it).
 * resolved when an admin issues a reset code/temporary password, dismissed when ignored.
 */
export const passwordResetRequests = pgTable(
  'password_reset_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Note left by the requester (who they are, contact info, etc.) */
    note: text('note'),
    ip: text('ip'),
    status: text('status', { enum: ['pending', 'resolved', 'dismissed'] })
      .notNull()
      .default('pending'),
    resolvedBy: uuid('resolved_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_reset_requests_pending_uidx')
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
    index('password_reset_requests_created_idx').on(t.createdAt),
  ],
)

/** Email verification tokens. The raw token only goes out by email; the DB keeps only SHA-256 (hex). 24 hours, single use. */
export const emailVerifications = pgTable(
  'email_verifications',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Email at send time; valid only if it still matches the account email at verification time */
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_verifications_user_idx').on(t.userId)],
)

/**
 * Brute-force protection: temporary IP bans. The failure counters themselves live in memory (guard.ts);
 * only the fact that a ban was applied is kept here, so it survives restarts and repeat bans continue the escalation (15 min -> 1 h -> …).
 * ip is the IPv4 address as is, or the /64 prefix for IPv6 (e.g. 2001:db8:1:2::/64).
 * Unbanning does not delete the row; it moves banned_until to now (keeps history).
 */
export const ipBans = pgTable(
  'ip_bans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ip: text('ip').notNull(),
    /** An automatic reason such as 'auto:login', or 'manual: <note>' */
    reason: text('reason').notNull(),
    failures: integer('failures').notNull().default(0),
    bannedUntil: timestamp('banned_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ip_bans_ip_idx').on(t.ip, t.createdAt),
    index('ip_bans_until_idx').on(t.bannedUntil),
  ],
)

export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_expires_idx').on(t.expiresAt)])

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  icon: text('icon'),
  inviteCode: text('invite_code').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Soft delete (docs/adr/0910-*). Set = hidden from every member and every read path (REST,
   * public links, iCal, collab, MCP, webhooks, reminders, sheet sync); owners can restore it for
   * 30 days, after which housekeeping deletes the row (FK cascade) and its upload blobs.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** Who deleted it (shown in the restore list). */
  deletedBy: uuid('deleted_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
})

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_idx').on(t.userId),
  ],
)

export const pages = pgTable('pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => pages.id, {
    onDelete: 'cascade',
  }),
  /** doc = document, folder = organizing folder (no document), canvas = whiteboard, collection = database */
  kind: text('kind', { enum: ['doc', 'folder', 'canvas', 'collection'] })
    .notNull()
    .default('doc'),
  /** shared = whole workspace, private = author only (children inherit the parent's scope) */
  scope: text('scope', { enum: ['shared', 'private'] })
    .notNull()
    .default('shared'),
  title: text('title').notNull().default(''),
  /** Property values of a collection row (a page whose parent is a collection) { fieldId: value } */
  props: jsonb('props').notNull().default(sql`'{}'::jsonb`),
  /** Obsidian-style page properties (frontmatter): PageProperty[] { name, type, value } */
  properties: jsonb('properties').notNull().default(sql`'[]'::jsonb`),
  /** Wiki-link aliases: [[alias]] also links to / finds this page (string[]) */
  aliases: jsonb('aliases').notNull().default(sql`'[]'::jsonb`),
  /** Public web share token: when set, /s/<token> allows unauthenticated read-only access */
  shareToken: text('share_token').unique(),
  icon: text('icon'),
  /** Notion-style cover image URL (/files/<id> or external) */
  coverUrl: text('cover_url'),
  /** Whether this is a template page (shown in the workspace template gallery) */
  isTemplate: text('is_template', { enum: ['0', '1'] }).notNull().default('0'),
  sortOrder: doublePrecision('sort_order').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Trash (soft delete). In M1 it is only hidden, with no restore UI */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  // Declared here (docs/adr/0755-*) so `drizzle-kit push` no longer drops them: they were
  // created by hand-written migrations 0007/0009 and a push against production removed them.
  index('pages_workspace_deleted_idx').on(t.workspaceId, t.deletedAt),
  index('pages_parent_idx').on(t.parentId),
  index('pages_created_by_idx').on(t.createdBy),
  index('pages_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
])

export const pageDocs = pgTable('page_docs', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Version history: Yjs state snapshots (automatic with a 10-minute throttle + manual) */
export const pageSnapshots = pgTable(
  'page_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    state: bytea('state').notNull(),
    label: text('label'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** OAuth client name when the snapshot was taken for an agent (MCP) edit (docs/adr/0936-*). */
    viaClient: text('via_client'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('page_snapshots_page_idx').on(t.pageId, t.createdAt)],
)

/** Collection (database) definition: field schema. Views live in collection_views */
export const collections = pgTable('collections', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  /** CollectionField[] — { id, name, type, options? } */
  fields: jsonb('fields').notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const collectionViews = pgTable('collection_views', {
  id: uuid('id').primaryKey().defaultRandom(),
  pageId: uuid('page_id')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['table', 'board', 'calendar', 'gallery', 'timeline'] }).notNull(),
  /** ViewConfig — sorts/filters/groupByFieldId/columnOrder/hiddenFields */
  config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
  sortOrder: doublePrecision('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Inline comments: threads anchored to a block. parentId=null is a thread root, otherwise a reply */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** BlockNote block id (anchor). If the block is deleted the comment stays, marked orphan */
    blockId: text('block_id').notNull(),
    /** Thread root comment id (replies point to the root). A root points to itself */
    threadId: uuid('thread_id').notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    /** OAuth client name when written through MCP (docs/adr/0936-*). */
    viaClient: text('via_client'),
    resolved: text('resolved', { enum: ['0', '1'] }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comments_page_idx').on(t.pageId), index('comments_thread_idx').on(t.threadId)],
)

/** Notifications: @mention / comment inbox */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['comment', 'comment_mention', 'doc_mention', 'reminder', 'workspace_added', 'webhook_disabled', 'backup_failed', 'workspace_deleted'],
    }).notNull(),
    pageId: uuid('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    // For notifications that point at a workspace rather than a page, such as workspace_added
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    commentId: uuid('comment_id').references((): AnyPgColumn => comments.id, {
      onDelete: 'cascade',
    }),
    read: text('read', { enum: ['0', '1'] }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.read),
    // Newest-first list per user stops after 50 rows instead of sorting all of them (ADR 0755).
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
  ],
)

/** Favorites (bookmarks): pages pinned per user */
export const bookmarks = pgTable(
  'bookmarks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.pageId] })],
)

/** Global tag index: #tags extracted from document text at store time */
export const pageTags = pgTable(
  'page_tags',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.tag] }), index('page_tags_tag_idx').on(t.tag)],
)

/** Wiki-link index: internal links extracted from documents at store time (for backlink lookups) */
export const pageLinks = pgTable(
  'page_links',
  {
    sourcePageId: uuid('source_page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    targetPageId: uuid('target_page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.sourcePageId, t.targetPageId] }),
    index('page_links_target_idx').on(t.targetPageId),
  ],
)

/** Plain body text for full-text search: blocks flattened to plain text in the document store hook */
export const pageTexts = pgTable('page_texts', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  text: text('text').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('page_texts_text_trgm_idx').using('gin', sql`${t.text} gin_trgm_ops`)])

/**
 * Task index for documents: the store hook extracts only BlockNote checkListItems that carry a date.
 * (Yjs is the source of truth for documents; this table is a derived index for calendar/due-date queries, replaced per page.)
 */
export const pageTasks = pgTable(
  'page_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** BlockNote block id (the blockContainer's id attribute) */
    blockId: text('block_id').notNull(),
    /** Display text with the date token removed */
    text: text('text').notNull().default(''),
    /** 'YYYY-MM-DD' (local string, same convention as collection date fields) */
    due: text('due').notNull(),
    checked: boolean('checked').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('page_tasks_ws_due_idx').on(t.workspaceId, t.due),
    index('page_tasks_page_idx').on(t.pageId),
  ],
)

/** Task-index done marker: lets the boot backfill pick only documents that were never indexed. */
export const pageTaskIndex = pgTable('page_task_index', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Section index for agent retrieval (docs/adr/0926-*): each doc page split at its top-level
 * headings; long sections are split into parts that share one anchor. A derived index rebuilt
 * from page_docs (docIndexer / importer / sync / templates), diffed per row so typing rewrites
 * only the rows that changed. `tsv` is a stored generated column over heading path, text and grams.
 */
export const pageChunks = pgTable(
  'page_chunks',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** Position of the chunk in the page (0-based, dense). */
    ord: integer('ord').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Stable section anchor: slugged heading path (`setup/backups`), `_intro` before the first heading. */
    anchor: text('anchor').notNull(),
    /** BlockNote id of the section's heading block (fallback anchor), null for `_intro`. */
    blockId: text('block_id'),
    /** Heading texts from the outermost to this section, joined with ' › '. */
    headingPath: text('heading_path').notNull().default(''),
    /** Heading level of the section (0 for `_intro`). */
    level: integer('level').notNull().default(0),
    /** Part number inside a long section (0-based). */
    part: integer('part').notNull().default(0),
    /** Section body as light Markdown (heading line excluded). */
    text: text('text').notNull().default(''),
    /** CJK character bigrams of long CJK words, so 2-character Korean terms match inside compounds. */
    grams: text('grams').notNull().default(''),
    tokenEstimate: integer('token_estimate').notNull().default(0),
    /** sha1 of this row's derived values (diffing). */
    hash: text('hash').notNull(),
    /** Version of the whole section (all parts): patch_section's baseVersion. */
    sectionHash: text('section_hash').notNull(),
    /**
     * Stored (generated) so ranking reads it instead of re-parsing every candidate's text: an
     * expression index alone made ts_rank recompute to_tsvector per row (p95 1.1 s on 15k chunks).
     */
    tsv: tsvector('tsv')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, heading_path || ' ' || text || ' ' || grams)`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.ord] }),
    index('page_chunks_workspace_idx').on(t.workspaceId),
    index('page_chunks_tsv_idx').using('gin', t.tsv),
    index('page_chunks_text_trgm_idx').using('gin', sql`${t.text} gin_trgm_ops`),
  ],
)

/** Section-index done marker + chunker version: the boot backfill picks pages without a current marker. */
export const pageChunkIndex = pgTable('page_chunk_index', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Change feed for agents (docs/adr/0932-*): one row per changed section (anchor set) or page-level
 * event (anchor null). Visibility at write time is kept (`scope`, `owner_id`) so a reader is only
 * told about pages they could see. No FK on page_id: rows outlive purged pages until retention.
 */
export const pageChanges = pgTable(
  'page_changes',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id').notNull(),
    /** Section anchor; null for a page-level event. */
    anchor: text('anchor'),
    /** Previous anchor (renamed sections). */
    prevAnchor: text('prev_anchor'),
    headingPath: text('heading_path').notNull().default(''),
    /** added | modified | removed | moved | renamed | page_added | page_renamed | page_moved | page_trashed | page_restored | page_visibility */
    kind: text('kind').notNull(),
    /** Section text (or page-level value) before / after, capped; null when absent or too large. */
    beforeText: text('before_text'),
    afterText: text('after_text'),
    /** The change was too large to keep a diff ("large change, read section"). */
    large: boolean('large').notNull().default(false),
    /** Page visibility when the change was logged: 'shared' or 'private' (owner only). */
    scope: text('scope').notNull(),
    ownerId: uuid('owner_id'),
    actorId: uuid('actor_id'),
    /** OAuth client name when the change came through MCP (docs/adr/0936-*). */
    viaClient: text('via_client'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('page_changes_ws_seq_idx').on(t.workspaceId, t.seq),
    index('page_changes_page_idx').on(t.pageId, t.anchor, t.seq),
    index('page_changes_changed_idx').on(t.changedAt),
  ],
)

/** Page templates (M12): stores workspace custom templates only. The 5 built-ins are code constants, not in the DB. */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Emoji icon */
    icon: text('icon'),
    /** Template body: BlockNote blocks snapshot (from-template creates the new document from these blocks) */
    content: jsonb('content').notNull().default(sql`'[]'::jsonb`),
    /** Default property hints, e.g. { "withDate": true } (meeting notes/standups set a date property) */
    defaultProps: jsonb('default_props').notNull().default(sql`'{}'::jsonb`),
    /** Built-in flag: built-ins are code constants, so real DB rows are always '0' (custom) */
    builtin: text('builtin', { enum: ['0', '1'] }).notNull().default('0'),
    /**
     * private = saved from a private page: listed/usable only by its creator (C-L11). Templates
     * saved before this column existed stay 'shared'.
     */
    scope: text('scope', { enum: ['shared', 'private'] }).notNull().default('shared'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('templates_workspace_idx').on(t.workspaceId, t.createdAt)],
)

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Page it was uploaded to: used to decide download visibility (protects private attachments). null for legacy/unlinked */
  pageId: uuid('page_id').references((): AnyPgColumn => pages.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('files_workspace_idx').on(t.workspaceId), index('files_page_idx').on(t.pageId)])

/**
 * Per-page handwriting layer (pen annotations), stored separately from the body Yjs document.
 * Same idea as PDF annotations, so there is no block anchor. Coordinates are logical px relative to
 * shared's INK_CANVAS_WIDTH. Why not in the body Yjs doc: eraser tombstones would make the document state grow monotonically,
 * and handwriting must be left out of the .md export round trip (user requirement: keep the md clean).
 * Saved by full replacement (PUT): it assumes a single tablet, so the last save wins.
 */
export const pageInk = pgTable('page_ink', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  /** InkStroke[]: [{ id, color, size, points: [x, y, pressure, ...] }] */
  strokes: jsonb('strokes').notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
})

// ---------------------------------------------------------------------------
// OAuth 2.1 for the MCP remote connector (Claude Code / claude.ai custom connectors)
//   Codes and tokens are never stored raw, only their SHA-256 hash (hex).
// ---------------------------------------------------------------------------

/** Public clients created through dynamic client registration (RFC 7591): no secret, PKCE required. */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Registered redirect_uri list (string[]): only https or loopback http */
  redirectUris: jsonb('redirect_uris').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Authorization codes: 5-minute TTL, single use (consumed via DELETE … RETURNING on exchange). */
export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope'),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A connection (grant) = an access token + refresh token pair. On refresh both hashes are replaced (rotation) and
 * the previous refresh hash is kept as prev; if a revoked refresh token is reused, the whole connection is cut.
 * The "Connected apps" list/revoke works per row.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope'),
    accessHash: text('access_hash').notNull().unique(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    refreshHash: text('refresh_hash').notNull().unique(),
    prevRefreshHash: text('prev_refresh_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oauth_grants_user_idx').on(t.userId),
    index('oauth_grants_prev_refresh_idx').on(t.prevRefreshHash),
  ],
)

export * from './schema-plugins'
export * from './schema-collections'
export * from './schema-sync'
export * from './schema-webhooks'
