# 2301. Two tables for the list: workspace_list_groups and workspace_listings (migration 0059)

- Status: Accepted
- Date: 2026-11-10

## Context
Where to keep "group, position, archived" per person and workspace. Candidates already in the schema:
`users.sidebar_prefs` (the per-user jsonb of 0.3.1, ADR 1020) and `workspace_members`. Guests (ADR
1250–1253) open workspaces through `page_grants` without a `workspace_members` row, and must be able
to tidy their list too. The default search scope (ADR 2303) needs the archived set inside the
statement that already lists the person's workspaces.

## Decision
- `workspace_list_groups (id, user_id → users cascade, name, position, collapsed, created_at)`, index
  `(user_id, position)`.
- `workspace_listings (user_id → users cascade, workspace_id → workspaces cascade, group_id →
  workspace_list_groups set null, position, archived_at, updated_at)`, primary key `(user_id,
  workspace_id)`, index on `group_id`. No row = ungrouped, not archived, server order.
- Cleanup: account deletion and the 30-day workspace purge cascade; `removeMember` (leaving and being
  removed) deletes the row in its transaction; deleting a group sets its workspaces' group to null
  and appends them to the ungrouped ones. A **soft-deleted** workspace keeps the rows, so a restore
  within 30 days brings the person's arrangement back. A guest whose last page row is removed keeps
  a harmless row (every read joins the current list: GET /workspaces only decorates workspaces it
  already lists, and the scope statements start from `workspace_members`); it goes with the purge or
  the account.
- A group belongs to its person: every route looks groups up by `(id, user_id)`.

## Alternatives considered
- **jsonb on users** (like sidebar prefs): no foreign keys, so workspace purge, leave and removal
  would each need jsonb surgery, and the scope statement would unpack an array per call.
- **Columns on workspace_members**: guests have no row there; a workspace_members change would also
  look like a membership change to the code that watches that table.
- **One table with group names inline**: renaming a group would rewrite every row of it, and an empty
  group could not exist.

## Consequences
- Migration 0059_workspace_listings (two tables, four foreign keys, two indexes), no data migration.
- The scope probe is a primary-key lookup per listed workspace (ADR 2303).

## References
- apps/server/src/db/schema-workspaceListing.ts, drizzle/0059_workspace_listings.sql, routes/workspaces.ts (`removeMember`)
