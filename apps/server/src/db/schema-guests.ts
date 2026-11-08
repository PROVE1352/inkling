import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pages, users } from './schema'

/**
 * People with explicit access to a page and its subtree (docs/adr/1250-*, 1251-*).
 *
 * One row per (page, person). The nearest row on a page's ancestor-or-self path decides the
 * person's level there:
 *   - for someone who is not a member of the page's workspace (a guest) it is the only way in:
 *     no row on the path = the page does not exist for them;
 *   - for a member it replaces the member default (edit) for that subtree: lower (view, comment)
 *     or higher (full = may manage who has access). Owners and admins ignore rows (always full).
 * Levels: view < comment < edit < full; guests are never given `full`.
 *
 * The workspace is the page's (no column of its own): a root that moves follows, a purged root
 * takes its rows along (cascade). Every insert, update and delete bumps the workspace access
 * version in its transaction (docs/adr/1071-*).
 */
export const pageGrants = pgTable(
  'page_grants',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ['view', 'comment', 'edit', 'full'] }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.userId] }), index('page_grants_user_idx').on(t.userId)],
)

/**
 * An invitation to a page for an email address without an account yet (docs/adr/1250-*). The link
 * carries a random token; only its SHA-256 is stored (docs/adr/1110-*). Accepting it signed in with
 * an account of the same email turns it into a page_grants row; it never creates an account and
 * never bypasses the instance's sign-up rules.
 */
export const pageInvites = pgTable(
  'page_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** Lower-cased email the invitation is for. */
    email: text('email').notNull(),
    level: text('level', { enum: ['view', 'comment', 'edit'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('page_invites_page_idx').on(t.pageId), index('page_invites_email_idx').on(t.email)],
)
