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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { rangeColumns } from './schema-range'

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
   * (DELEGATED_AUTH_URL; no local password, random hash), 'oidc' = account created by an OpenID Connect sign-in
   * (no local password, random hash; docs/adr/1161-*). Login picks the verification path from this value, and
   * a 'local' account's password is never sent to the external auth server. A local account linked to an OIDC
   * identity stays 'local' (user_identities records the link).
   */
  origin: text('origin', { enum: ['local', 'delegated', 'oidc'] })
    .notNull()
    .default('local'),
  /** Admin: can issue/revoke signup keys and list users. */
  isAdmin: boolean('is_admin').notNull().default(false),
  /**
   * SHA-256 (hex) of the signup key used to create this account (docs/adr/1110-*): the same value as
   * `signup_keys.key`, for key -> signup tracing and the single-use recovery check. Only set when
   * origin='local'. Rows written before 1110 are hashed in place at boot (secretsAtRest.ts).
   */
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
  /**
   * Sidebar menu order / hidden menus ({ order, hidden }, docs/adr/1020-*). null = default (every
   * menu, built-in order). Validated by sidebarPrefsSchema; unknown ids are ignored by the client.
   */
  sidebarPrefs: jsonb('sidebar_prefs').$type<{ order: string[]; hidden: string[] }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Inkling's own signup keys. Unrelated to the external auth server used for delegated login; accounts made
 * with these keys work only in Inkling. expiresAt NULL = never expires.
 * A key with maxUses=1 can also serve as a password reset code for the one person who signed up with it.
 */
export const signupKeys = pgTable('signup_keys', {
  /**
   * SHA-256 (hex) of the canonical key (trimmed, upper case) — the lookup key (docs/adr/1110-*).
   * The key itself is never stored in this column; rows from before 1110 are hashed at boot.
   */
  key: text('key').primaryKey(),
  /**
   * The key for showing it again in the admin screen: sealed with APP_SECRET_KEY (`v1.…`), or the
   * raw key when APP_SECRET_KEY is unset. Cleared once the key is used up (a used single-use key is
   * that person's recovery code and is never shown again).
   */
  keyEnc: text('key_enc'),
  /** Last four characters of the key, for telling keys apart once `key_enc` is gone. */
  keyHint: text('key_hint'),
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
  /** SHA-256 (hex) of the canonical invite code (trimmed, upper case) — the lookup key (docs/adr/1110-*). */
  inviteCode: text('invite_code').notNull().unique(),
  /** The invite code for "copy invite link": sealed (`v1.…`), or raw when APP_SECRET_KEY is unset (docs/adr/1110-*). */
  inviteCodeEnc: text('invite_code_enc'),
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
  // --- Workspace settings (docs/adr/0945-* .. 0952-*) -------------------------------------
  /** Joining with the invite code is allowed (docs/adr/0948-*). Off = join and preview answer INVALID_CODE. */
  inviteLinkEnabled: boolean('invite_link_enabled').notNull().default(true),
  /** Lowest role that may add existing users directly: 'owners' | 'admins' | 'members' (docs/adr/0948-*). */
  memberAddPolicy: text('member_add_policy', { enum: ['owners', 'admins', 'members'] })
    .notNull()
    .default('admins'),
  /** Lowest role that may download the whole-workspace zip export (docs/adr/0950-*). */
  exportPolicy: text('export_policy', { enum: ['owners', 'admins', 'members'] })
    .notNull()
    .default('members'),
  /** "No public web links": new public shares are refused (docs/adr/0949-*). Existing links are kept unless bulk-unshared. */
  publicSharingDisabled: boolean('public_sharing_disabled').notNull().default(false),
  /** Days a trashed page stays restorable before housekeeping purges it (docs/adr/0950-*). */
  trashRetentionDays: integer('trash_retention_days').notNull().default(30),
  /** Days audit events are kept (docs/adr/0946-*). */
  auditRetentionDays: integer('audit_retention_days').notNull().default(90),
  /** Default review interval for document owners; null = review reminders off (docs/adr/0951-*). */
  reviewIntervalDays: integer('review_interval_days'),
  /** Server-local 'YYYY-MM-DD' of the last review_due webhook digest (once a day, docs/adr/0952-*). */
  reviewDigestSentOn: text('review_digest_sent_on'),
  /** Server-local 'YYYY-MM-DD' of the last review priority batch (page_review_scores, docs/adr/0953-*). */
  reviewScoredOn: text('review_scored_on'),
  /** Server-local 'YYYY-MM-DD' of the last agent_digest webhook (once a day, docs/adr/1004-*). */
  agentDigestSentOn: text('agent_digest_sent_on'),
  /**
   * "Require two-step verification" (docs/adr/1112-*): when it was turned on, null = off. Members
   * without 2FA get 403 TWO_FACTOR_REQUIRED once `two_factor_grace_days` have passed since then.
   */
  twoFactorRequiredAt: timestamp('two_factor_required_at', { withTimezone: true }),
  /** Grace period after turning the requirement on, in days (0..30). */
  twoFactorGraceDays: integer('two_factor_grace_days').notNull().default(7),
  /** New public links expire after this many days unless the publisher picks otherwise; null = none (docs/adr/1172-*). */
  shareDefaultExpiryDays: integer('share_default_expiry_days'),
  /** New public links need a password, and a link's password cannot be removed (docs/adr/1172-*). */
  sharePasswordRequired: boolean('share_password_required').notNull().default(false),
  /**
   * Lowest role that may invite people from outside the workspace (guests) to a page
   * (docs/adr/1250-*): 'off' = nobody, 'owners', 'admins' (default; owners and admins), 'members'
   * (any member who can edit the page). Existing guests are kept when it is tightened.
   */
  guestInvitePolicy: text('guest_invite_policy', { enum: ['off', 'owners', 'admins', 'members'] })
    .notNull()
    .default('admins'),
  /**
   * "Agents can read handwriting" (docs/adr/1510-*): off (default) = MCP connections get no ink at
   * all (read_ink refuses, page headers do not mention it). Owners and admins turn it on.
   */
  agentInkRead: boolean('agent_ink_read').notNull().default(false),
  /**
   * "Suggest only after flagged content" (docs/adr/2040-*, 2043-*): on (default) = a connection that
   * was handed injection-like content writes here only as suggestions for a while. Owners and admins
   * switch it off when the heuristics misfire on this workspace's pages.
   */
  agentTaintDemote: boolean('agent_taint_demote').notNull().default(true),
  /**
   * Uploads through connections (docs/adr/2065-*): null = the server's AGENT_UPLOADS default, 'on' /
   * 'off' = this workspace's choice. AGENT_UPLOADS=never wins over 'on'. Owners and admins set it.
   */
  agentUploads: text('agent_uploads', { enum: ['on', 'off'] }),
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
    /** owner > admin > member (docs/adr/0945-*). No DB check constraint: the enum is TypeScript-only. */
    role: text('role', { enum: ['owner', 'admin', 'member'] })
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
  /**
   * Public web share: SHA-256 (hex) of the token in /s/<token> (docs/adr/1110-*). Set = shared;
   * lookups hash the presented token. Rows from before 1110 are hashed at boot.
   */
  shareToken: text('share_token').unique(),
  /** The token for "copy link": sealed (`v1.…`), or raw when APP_SECRET_KEY is unset (docs/adr/1110-*). */
  shareTokenEnc: text('share_token_enc'),
  /** The public link stops working at this instant (server clock); null = never (docs/adr/1170-*). Cleared on unpublish. */
  shareExpiresAt: timestamp('share_expires_at', { withTimezone: true }),
  /** The public link opens at this instant (server clock); null = at once (docs/adr/1844-*). Cleared on unpublish. */
  shareStartsAt: timestamp('share_starts_at', { withTimezone: true }),
  /**
   * argon2 hash of the link password; null = no password (docs/adr/1171-*). Unlock cookies are bound
   * to this string, so setting, changing or removing it ends every visitor's unlock. Cleared on unpublish.
   */
  sharePasswordHash: text('share_password_hash'),
  icon: text('icon'),
  /** Notion-style cover image URL (/files/<id> or external) */
  coverUrl: text('cover_url'),
  sortOrder: doublePrecision('sort_order').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Trash (soft delete). In M1 it is only hidden, with no restore UI */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** Document owner: the member responsible for keeping it current (docs/adr/0951-*). */
  ownerId: uuid('owner_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /** Last "Mark reviewed" (docs/adr/0951-*); null = never reviewed (created_at is the baseline). */
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /**
   * "Living document" override (docs/adr/0953-*): null = classify automatically from its edit rate,
   * true = always living (never in the review list), false = never living.
   */
  livingOverride: boolean('living_override'),
  /**
   * Edit lock (docs/adr/0970-*): this page and its subtree are editable only by the page owner, the
   * workspace owners/admins and page_lock_editors. Off by default; the nearest locked ancestor governs.
   */
  editLocked: boolean('edit_locked').notNull().default(false),
  /**
   * OAuth client name when the page was created through an agent connection (MCP create_page,
   * import_folder, create_from_template); null = created in the app (docs/adr/1005-*).
   */
  createdVia: text('created_via'),
  /**
   * Unique ID number of a collection row (docs/adr/2140-*): handed out by the pages_row_number
   * trigger (migration 0051) from collections.row_seq when the row enters a collection that has a
   * uniqueId field; never reused within the collection. Null for other pages.
   */
  rowNumber: integer('row_number'),
  /**
   * Last editor of the page as the change log saw it (docs/adr/2141-*): written with every logged
   * property, title or body change, so it is the actor of the newest page_changes row and outlives
   * the feed's retention. Null = never edited since 0.17 (the creator counts).
   */
  editedBy: uuid('edited_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /** OAuth client name of that edit when it came through an agent connection (as page_changes.via_client). */
  editedVia: text('edited_via'),
}, (t) => [
  // Declared here (docs/adr/0755-*) so `drizzle-kit push` no longer drops them: they were
  // created by hand-written migrations 0007/0009 and a push against production removed them.
  index('pages_workspace_deleted_idx').on(t.workspaceId, t.deletedAt),
  index('pages_parent_idx').on(t.parentId),
  index('pages_created_by_idx').on(t.createdBy),
  index('pages_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  index('pages_owner_idx').on(t.ownerId),
  // Lock pages of a workspace (recount of workspace_acl_versions.locked_pages, docs/adr/1071-*).
  index('pages_ws_locked_idx').on(t.workspaceId).where(sql`${t.editLocked}`),
  // Backstop for the unique ID counter (docs/adr/2140-*): a number appears once per collection.
  uniqueIndex('pages_row_number_uq').on(t.parentId, t.rowNumber).where(sql`${t.rowNumber} IS NOT NULL`),
])

export const pageDocs = pgTable('page_docs', {
  pageId: uuid('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  /**
   * 1 = Yjs V1 update, 2 = V2 (docs/adr/1101-*). Mirrors the bytes (a whole-document state is
   * self-describing; readers sniff it, never trust this over the bytes). Used by SQL that cannot
   * sniff cheaply (large-page threshold) and to watch the gradual conversion. Writers that do not
   * set it write V1.
   */
  stateFormat: smallint('state_format').notNull().default(1),
  /** Y.encodeStateVector of `state`, written by the collab store; null for rows other writers made. */
  stateVector: bytea('state_vector'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Version history: Yjs state snapshots (automatic with a 10-minute throttle + manual).
 * Incremental since docs/adr/1100-*: a row is either a whole state (`base_id` null) or the Yjs diff
 * from its base row's state (`base_id` set), chained up to SNAPSHOT_CHAIN_MAX deep.
 */
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
    /** Encoding of `state`: 1 = Yjs V1, 2 = V2 (a diff is not self-describing; docs/adr/1101-*). */
    stateFormat: smallint('state_format').notNull().default(1),
    /** Null = `state` is the whole document; else `state` is the diff from this row's state (docs/adr/1100-*). */
    baseId: uuid('base_id'),
    /** Rows between this one and its whole-state ancestor (0 for a whole state). */
    depth: smallint('depth').notNull().default(0),
    /** State vector of the document this row represents; null on rows written before docs/adr/1100-*. */
    stateVector: bytea('state_vector'),
    /**
     * Content digest of the document this row represents: sha256 of the state vector and the delete
     * set (equal digests = the same document). Null on rows written before docs/adr/2180-*.
     */
    digest: text('digest'),
    /** Set on AI step rows (the page right after one agent write) — what the write changed (docs/adr/2180-*). */
    step: jsonb('step').$type<{ tool: string; mode?: string; sections?: string[]; more?: number; added?: number; removed?: number; restoredFrom?: string }>(),
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
  /** Last unique ID number handed out in this collection (docs/adr/2140-*); only grows. */
  rowSeq: integer('row_seq').notNull().default(0),
})

export const collectionViews = pgTable('collection_views', {
  id: uuid('id').primaryKey().defaultRandom(),
  pageId: uuid('page_id')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // TS-only enum (no CHECK in the database): 'chart' (0.13, docs/adr/1603-*) and 'list' (0.17, docs/adr/2145-*) needed no migration
  type: text('type', { enum: ['table', 'board', 'calendar', 'gallery', 'timeline', 'chart', 'form', 'list'] }).notNull(),
  /** ViewConfig — sorts/filters/groupByFieldId/columnOrder/hiddenFields */
  config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
  sortOrder: doublePrecision('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Row templates of a collection (docs/adr/1180-*): never pages, so no index or list sees them. */
export const collectionRowTemplates = pgTable(
  'collection_row_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    /** Title pattern with template variables */
    title: text('title').notNull().default(''),
    /** Property defaults by field id (relative forms: today+7, me) */
    props: jsonb('props').notNull().default(sql`'{}'::jsonb`),
    /** Body: Yjs V1 update of the 'document' fragment; null = empty */
    state: bytea('state'),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collection_row_templates_coll_idx').on(t.collectionId, t.sortOrder),
    uniqueIndex('collection_row_templates_default_uq').on(t.collectionId).where(sql`${t.isDefault}`),
  ],
)

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

/**
 * Notifications: @mention / comment inbox, assignments, followed-page updates (docs/adr/1000-*).
 * The `type` enum is TypeScript-only (no DB check), like workspace_members.role.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Monotonic order: the agent inbox cursor (docs/adr/1003-*). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        'comment', 'comment_mention', 'doc_mention', 'reminder', 'workspace_added', 'webhook_disabled', 'backup_failed', 'workspace_deleted',
        'comment_reply', 'page_owner', 'task_assigned', 'page_update', 'agent_digest', 'approval_request', 'approval_result',
        'large_page', 'later_reminder',
      ],
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
    /** OAuth client name when an agent caused it (docs/adr/0936-*). */
    viaClient: text('via_client'),
    /** 'now' = badge + instant mail; 'quiet' = listed without a badge (agent mentions, level "nothing"). */
    delivery: text('delivery', { enum: ['now', 'quiet'] }).notNull().default('now'),
    /** Mail state: null = never mailed, 'instant' = queued for the instant mail, 'digest' = waits for the digest, 'sent'. */
    mailState: text('mail_state', { enum: ['instant', 'digest', 'sent'] }),
    /** Collapse key: an unread row with the same key absorbs repeats (count + 1) instead of a new row. */
    groupKey: text('group_key'),
    count: integer('count').notNull().default(1),
    /** Short plain excerpt (comment text, mentioning line, field name), capped. */
    excerpt: text('excerpt'),
    /** Section anchor or block id inside the page. */
    anchor: text('anchor'),
    /** When the user's agent acknowledged it in the MCP inbox (separate from `read`). */
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    /**
     * Handed to one of the user's agent connections ('grant:<id>' / 'token:<id>', docs/adr/1863-*):
     * only that connection's inbox lists it. NULL = for the person (and all their connections).
     * Set back to NULL when the connection goes away, so the item falls to the person.
     */
    connection: text('connection'),
    /** A connection row the person also sees in the bell (their "copies of hand-offs" setting). */
    personToo: boolean('person_too').notNull().default(false),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.read),
    // Newest-first list per user stops after 50 rows instead of sorting all of them (ADR 0755).
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_user_seq_idx').on(t.userId, t.seq),
    uniqueIndex('notifications_group_unread_idx').on(t.userId, t.groupKey).where(sql`read = '0' AND group_key IS NOT NULL`),
    index('notifications_mail_idx').on(t.mailState).where(sql`mail_state IN ('instant', 'digest')`),
    index('notifications_connection_idx').on(t.connection).where(sql`connection IS NOT NULL`),
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
    /**
     * Headings of the target that the source's section links name (docs/adr/2101-*): `h` the heading
     * text in the link, `b` its block id when known. Null when the source only links the page.
     */
    sections: jsonb('sections').$type<{ h: string; b?: string }[]>(),
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
    /** Injection-like heuristics this chunk matched (docs/adr/0977-*); computed at index time. */
    suspicious: text('suspicious').array().notNull().default(sql`'{}'::text[]`),
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
  /**
   * page_docs.updated_at of the stored state the docIndexer's last complete pass reflected (all
   * derived indexes, chunks last). Differs from page_docs.updated_at after a crash that dropped a
   * queued pass: the boot pass re-indexes those pages (docs/adr/1924-*). Null = written by a path
   * that does not know the stored state (out-of-band reindex, copies): indexed_at is used then.
   */
  docUpdatedAt: timestamp('doc_updated_at', { withTimezone: true }),
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
    /** added | modified | removed | moved | renamed | page_added | page_renamed | page_moved | page_trashed | page_restored | page_visibility | page_props */
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
    // Latest (agent) change of one page: provenance badge, activity filters (docs/adr/1005-*).
    index('page_changes_page_seq_idx').on(t.pageId, t.seq),
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
  /**
   * The connection that uploaded it ('grant:<id>' / 'token:<id>'; docs/adr/2065-*), null for a person's
   * upload in the browser. The daily budget of agent uploads sums these rows only.
   */
  uploadedVia: text('uploaded_via'),
}, (t) => [
  index('files_workspace_idx').on(t.workspaceId),
  index('files_page_idx').on(t.pageId),
  index('files_agent_uploads_idx').on(t.createdBy, t.createdAt).where(sql`${t.uploadedVia} IS NOT NULL`),
])

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
  // Connection range chosen on the consent screen, copied to the grant (docs/adr/1200-*).
  ...rangeColumns(),
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
    // What this connection may see (docs/adr/1200-*); range_kind null = 'all' (grants made before it).
    ...rangeColumns(),
    accessHash: text('access_hash').notNull().unique(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    refreshHash: text('refresh_hash').notNull().unique(),
    prevRefreshHash: text('prev_refresh_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /**
     * Last time this connection was handed content flagged injection-like (docs/adr/0977-*).
     * Recorded only (throttled); nothing reads it for decisions yet — the hook for taint tracking.
     */
    taintedAt: timestamp('tainted_at', { withTimezone: true }),
    /**
     * 'oauth' = made by the OAuth flow (rotating access + refresh tokens). 'token' = an agent connection
     * token a person made in Settings › Connections (docs/adr/2060-*): one long-lived access token, no
     * usable refresh token, access_expires_at = refresh_expires_at = the chosen expiry, and its own
     * oauth_clients row whose name is the name the person gave.
     */
    kind: text('kind').notNull().default('oauth'),
    /** kind 'token' only: `ink_agt_` + 4 characters, to recognise the token in the list (docs/adr/2061-*). */
    tokenPrefix: text('token_prefix'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oauth_grants_user_idx').on(t.userId),
    index('oauth_grants_prev_refresh_idx').on(t.prevRefreshHash),
  ],
)

export * from './schema-workspaceAdmin'
export * from './schema-plugins'
export * from './schema-collections'
export * from './schema-sync'
export * from './schema-webhooks'
export * from './schema-editLock'
export * from './schema-notifications'
export * from './schema-twoFactor'
export * from './schema-outbox'
// Former page titles for [[old title]] links after a rename (docs/adr/1121-*)
export * from './schema-titles'
export * from './schema-split'
// OpenID Connect identities and pending sign-ins (docs/adr/1160-*, 1161-*)
export * from './schema-identities'
// Personal API tokens (docs/adr/1201-*)
export * from './schema-apiTokens'
// People with access to a page tree, guests and page invitations (docs/adr/1250-*)
export * from './schema-guests'
// Later list with reminders and followed comment threads (docs/adr/1410-*, 1412-*)
export * from './schema-later'
// Suggested section edits, section claims and catch_up markers (docs/adr/1530-*, 1535-*, 1537-*)
export * from './schema-collab'
// Optional semantic search: chunk embeddings, written only when an embedding endpoint is set (docs/adr/1740-*)
export * from './schema-semantic'
// Page verification with an expiry (docs/adr/1840-*)
export * from './schema-verify'
// Member status with an automatic clear time (docs/adr/1845-*)
export * from './schema-memberStatus'
// Slack app per workspace: secrets, account links, link codes, replay guard (docs/adr/1800-*)
export * from './schema-slack'
// Public links of form views (docs/adr/1821-*)
export * from './schema-forms'
// Connections handed flagged content: suggest-only window and releases (docs/adr/2040-*)
export * from './schema-taint'
