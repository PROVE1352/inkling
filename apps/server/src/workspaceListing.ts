import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from './db/index'
import { agentAllowedSql } from './agentAccess'
import { twoFactorBlockedSql } from './twoFactorPolicy'
import { currentRange } from './tokenRange'
import type { WorkspaceListingDTO } from '@inkling/shared'
import type { ArchivedWorkspace } from './workspaceArchivedNote'

export type { ArchivedWorkspace }

/**
 * A person's own workspace list (docs/adr/2300-*, 2301-*): groups and archived workspaces. Nothing in
 * here decides access (docs/adr/2302-*); it narrows what "all my workspaces" means for the
 * cross-workspace defaults: find_context and search without workspaceId, catch_up's page and comment
 * feed. A workspaceId given by name or id ignores it.
 */

export interface DefaultScope {
  /** The workspaces a default (no workspaceId) search covers. */
  ids: string[]
  /** Workspaces the caller could search but archived; [] when none. */
  archived: ArchivedWorkspace[]
}

/**
 * Archiving applies to this request: not to a connection limited to some workspaces or one subtree,
 * whose range already says where it looks (docs/adr/2303-*).
 */
export function archiveApplies(userId: string): boolean {
  return !currentRange(userId)
}

/** SQL: `ws` is archived by `userId` (a NOT EXISTS probe on the primary key, no extra round trip). */
export function archivedSql(ws: SQL, userId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM workspace_listings l WHERE l.user_id = ${userId} AND l.workspace_id = ${ws} AND l.archived_at IS NOT NULL)`
}

/**
 * memberWorkspaceIds (retrieve.ts) for the default scope of cross-workspace reads: the same rules
 * (member, live, not 2FA-blocked, not blocking this agent), archived ones split off. One statement.
 */
export async function defaultSearchScope(userId: string): Promise<DefaultScope> {
  const rows = (await db.execute(sql`
    SELECT wm.workspace_id AS id, w.name, ${archivedSql(sql`wm.workspace_id`, userId)} AS archived
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ${userId} AND w.deleted_at IS NULL AND ${agentAllowedSql(sql`wm.workspace_id`)}
       AND NOT ${twoFactorBlockedSql(sql`wm.workspace_id`, userId)}
     ORDER BY w.created_at, w.id
  `)) as unknown as { id: string; name: string; archived: boolean }[]
  return splitArchived(userId, rows)
}

/** Splits scope rows (each with `archived`) by the caller's archive, unless a range applies. */
export function splitArchived<T extends { id: string; name: string; archived: boolean }>(userId: string, rows: T[]): DefaultScope & { kept: T[] } {
  if (!archiveApplies(userId) || !rows.some((r) => r.archived)) return { ids: rows.map((r) => r.id), archived: [], kept: rows }
  const kept = rows.filter((r) => !r.archived)
  return {
    ids: kept.map((r) => r.id),
    archived: rows.filter((r) => r.archived).map((r) => ({ id: r.id, name: r.name })),
    kept,
  }
}

export { archivedNote, ARCHIVED_NOTE_NAMES } from './workspaceArchivedNote'

/** The caller's arrangement of each workspace in `ids` (GET /workspaces' `listing`). */
export async function listingsFor(userId: string): Promise<Map<string, WorkspaceListingDTO>> {
  const rows = (await db.execute(sql`
    SELECT l.workspace_id AS "workspaceId", l.group_id AS "groupId", g.name AS "group", l.position,
           (l.archived_at IS NOT NULL) AS archived
      FROM workspace_listings l
      LEFT JOIN workspace_list_groups g ON g.id = l.group_id AND g.user_id = l.user_id
     WHERE l.user_id = ${userId}
  `)) as unknown as { workspaceId: string; groupId: string | null; group: string | null; position: number | null; archived: boolean }[]
  const out = new Map<string, WorkspaceListingDTO>()
  for (const r of rows) {
    const dto: WorkspaceListingDTO = {}
    if (r.archived) dto.archived = true
    if (r.groupId && r.group !== null) {
      dto.groupId = r.groupId
      dto.group = r.group
    }
    if (r.position !== null && r.position !== undefined) dto.position = Number(r.position)
    if (Object.keys(dto).length) out.set(r.workspaceId, dto)
  }
  return out
}
