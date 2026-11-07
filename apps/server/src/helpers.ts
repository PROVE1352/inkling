import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from './db/index'
import { workspaceMembers, workspaces } from './db/schema'
import { forbidden, notFound } from './errors'
import { assertAgentAllowed } from './agentAccess'
import { newInviteCode } from './util'
import type { WorkspaceRole } from '@inkling/shared'

// Both db and a transaction (tx) structurally satisfy the select method.
type SelectCapable = Pick<typeof db, 'select'>

/** Generate an unused invite code, retrying up to 3 times to avoid unique collisions. */
export async function generateInviteCode(exec: SelectCapable): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newInviteCode()
    const existing = await exec
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.inviteCode, code))
      .limit(1)
    if (existing.length === 0) return code
  }
  return newInviteCode()
}

/**
 * Check workspace membership: 403 if not a member, 404 if the workspace is soft-deleted
 * (docs/adr/0910-*), 403 AGENT_BLOCKED for an agent connection blocked in this workspace
 * (docs/adr/0947-*), otherwise return the role. Every `/workspaces/:id/*` and page/file route goes
 * through here, so this one check hides a deleted workspace from all of them.
 */
export async function requireMembership(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole> {
  const rows = await db
    .select({ role: workspaceMembers.role, deletedAt: workspaces.deletedAt })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) throw forbidden()
  if (row.deletedAt) throw notFound()
  // Agent (MCP) requests: per-workspace block + access record (docs/adr/0947-*). No-op for cookies.
  await assertAgentAllowed(workspaceId)
  return row.role
}

const idParamSchema = z.object({ id: z.uuid() })

/** Validate the `:id` path parameter as a UUID and return it (bad format -> 400 VALIDATION) */
export function idParam(params: unknown): string {
  return idParamSchema.parse(params).id
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Serialises changes to one workspace's member set (role changes, removal, leaving, account
 * deletion) so the "at least one owner" invariant is checked and written atomically (A-H2).
 */
export async function lockWorkspaceMembers(tx: Pick<Tx, 'execute'>, workspaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'ws-members:' + workspaceId}))`)
}

/** Role of `userId` in `workspaceId` read inside `tx` (null = not a member). */
export async function memberRoleTx(
  tx: Pick<Tx, 'select'>,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1)
  return row?.role ?? null
}

/** Number of owners of `workspaceId`, read inside `tx`. */
export async function ownerCountTx(tx: Pick<Tx, 'execute'>, workspaceId: string): Promise<number> {
  const [r] = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = ${workspaceId} AND role = 'owner'
  `)) as unknown as { n: number }[]
  return r?.n ?? 0
}
