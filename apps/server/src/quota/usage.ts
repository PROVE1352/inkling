import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { WorkspaceUsageDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { idParam, requireMembership } from '../helpers'
import { limits } from '../limits'
import { fileStorageSql, storageLimitBytes } from './room'
import { recountWorkspaceStorage } from './storage'

/** The usage route recounts storage when the cached count is older than this (limit set). */
export const USAGE_RECOUNT_MS = 60_000

/**
 * GET /api/workspaces/:id/usage (members, docs/adr/2506-*): members, pages (trash included), storage
 * and file bytes, and the limits that apply. The cached count is used, recounted first when older than
 * a minute (with or without a storage limit), so deleting files and opening the settings is enough to
 * edit again, and a server without limits counts a workspace at most once a minute.
 */
export async function workspaceUsage(workspaceId: string): Promise<WorkspaceUsageDTO> {
  const [r] = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM workspace_members WHERE workspace_id = ${workspaceId}) AS members,
           (SELECT count(*)::int FROM pages WHERE workspace_id = ${workspaceId}) AS pages,
           (storage_checked_at IS NULL OR storage_checked_at < now() - make_interval(secs => ${USAGE_RECOUNT_MS / 1000})) AS stale
      FROM workspaces WHERE id = ${workspaceId}
  `)) as unknown as { members: number; pages: number; stale: boolean }[]
  const storageLimit = storageLimitBytes()
  let storageBytes: number
  let fileBytes: number
  // The full count reads every member-grown column of the workspace: at most once a minute per
  // workspace, with or without a limit (the settings screen asks on every visit).
  if (r?.stale) {
    ;({ total: storageBytes, fileBytes } = await recountWorkspaceStorage(workspaceId))
  } else {
    const [c] = (await db.execute(sql`
      SELECT storage_bytes AS used, (SELECT coalesce(sum(${fileStorageSql(sql`size`)}), 0) FROM files WHERE workspace_id = ${workspaceId})::bigint AS files
        FROM workspaces WHERE id = ${workspaceId}
    `)) as unknown as { used: string | number; files: string | number }[]
    storageBytes = Number(c?.used ?? 0)
    fileBytes = Number(c?.files ?? 0)
  }
  return {
    members: r?.members ?? 0,
    pages: r?.pages ?? 0,
    storageBytes,
    fileBytes,
    limits: {
      ...(limits.membersPerWorkspace != null ? { members: limits.membersPerWorkspace } : {}),
      ...(limits.pagesPerWorkspace != null ? { pages: limits.pagesPerWorkspace } : {}),
      ...(storageLimit != null ? { storageBytes: storageLimit } : {}),
    },
  }
}

export function registerUsageRoute(api: FastifyInstance): void {
  api.get('/workspaces/:id/usage', { preHandler: requireUser }, async (req): Promise<WorkspaceUsageDTO> => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)
    return workspaceUsage(id)
  })
}
