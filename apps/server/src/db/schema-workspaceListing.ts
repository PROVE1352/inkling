import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users, workspaces } from './schema'

/**
 * A person's own arrangement of their workspace list (docs/adr/2300-*): named groups and archived
 * workspaces. Nothing here is a permission (docs/adr/2302-*): access is still membership, visibleTo
 * and the guest scope; these rows only decide where a workspace sits in that person's switcher and
 * whether "all my workspaces" searches include it.
 *
 * workspace_list_groups: one row per group the person made ("Contests", "Classes"), in `position`
 * order; `collapsed` = folded in the switcher.
 */
export const workspaceListGroups = pgTable(
  'workspace_list_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    collapsed: boolean('collapsed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_list_groups_user_idx').on(t.userId, t.position)],
)

/**
 * workspace_listings: one row per (person, workspace) the person has arranged; no row = ungrouped,
 * not archived, in the server's order. Members and guests alike (a guest has no workspace_members
 * row). Deleted with the account or the workspace (cascade, the 30-day purge), and by removeMember
 * when the person leaves or is removed. A group's deletion leaves its workspaces ungrouped.
 */
export const workspaceListings = pgTable(
  'workspace_listings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => workspaceListGroups.id, { onDelete: 'set null' }),
    /** Order inside the group (or among the ungrouped); null = after the ordered ones, server order. */
    position: integer('position'),
    /** Archived for this person: under "Archived" in the switcher, out of default cross-workspace searches. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] }), index('workspace_listings_group_idx').on(t.groupId)],
)
