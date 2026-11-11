import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { workspaceRestoreDays } from './limits'

/**
 * "The workspace in `workspaceIdCol` is not soft-deleted" (docs/adr/0910-*), as a correlated
 * EXISTS on the workspaces primary key. Every read path that reaches workspace content without
 * going through `requireMembership` (which checks it itself) adds this to its WHERE clause:
 * single-page guards (pageDto), public share tokens, collab authentication, notifications,
 * reminders, webhook delivery and the sheet-sync scheduler. One fragment keeps the list greppable:
 * `grep -rn liveWorkspace apps/server/src`.
 */
export function liveWorkspace(workspaceIdCol: AnyPgColumn | SQL): SQL {
  return sql`exists (select 1 from workspaces lw where lw.id = ${workspaceIdCol} and lw.deleted_at is null)`
}

/**
 * Days an owner can restore a deleted workspace before housekeeping removes it for good:
 * WORKSPACE_RESTORE_DAYS (limits.ts, default 30). Read at call time so tests can change it.
 */
export function workspaceRestoreMs(): number {
  return workspaceRestoreDays() * 24 * 60 * 60 * 1_000
}
