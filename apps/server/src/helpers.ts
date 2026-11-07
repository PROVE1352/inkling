import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from './db/index'
import { workspaceMembers, workspaces } from './db/schema'
import { forbidden, notFound } from './errors'
import { assertAgentAllowed, currentAgent } from './agentAccess'
import { aclColumns, toAcl } from './aclVersion'
import type { AclState } from './aclVersion'
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
  // Agent requests need the access version for the cached block check; browser requests do not
  // (assertAgentAllowed is a no-op for them), so they keep the plain membership statement.
  return (await membership(workspaceId, userId, currentAgent() ? 'version' : 'none')).role
}

/**
 * requireMembership plus the workspace access state (docs/adr/1071-*), read in the same statement:
 * the agent-block check is answered from memory while the version is unchanged, and the edit guards
 * (assertPageEditable / assertPageCommentable) take `acl` instead of looking it up again.
 */
export async function requireMembershipAcl(
  workspaceId: string,
  userId: string,
): Promise<{ role: WorkspaceRole; acl: AclState }> {
  const r = await membership(workspaceId, userId, 'full')
  return { role: r.role, acl: r.acl! }
}

async function membership(
  workspaceId: string,
  userId: string,
  acl: 'none' | 'version' | 'full',
): Promise<{ role: WorkspaceRole; acl: AclState | null }> {
  const c = aclColumns(sql`${workspaceMembers.workspaceId}`)
  const base = { role: workspaceMembers.role, deletedAt: workspaces.deletedAt }
  const where = and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))
  const rows =
    acl === 'none'
      ? (await db
          .select(base)
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
          .where(where)
          .limit(1)).map((r) => ({ ...r, version: null as string | null, hasLocks: null as boolean | null }))
      : await db
          .select({
            ...base,
            version: sql<string | null>`${c.version}`,
            hasLocks: acl === 'full' ? sql<boolean | null>`${c.hasLocks}` : sql<boolean | null>`null::boolean`,
          })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
          .leftJoin(sql`workspace_acl_versions a`, sql`a.workspace_id = ${workspaceMembers.workspaceId}`)
          .where(where)
          .limit(1)

  const row = rows[0]
  if (!row) throw forbidden()
  if (row.deletedAt) throw notFound()
  const state = acl === 'none' ? null : toAcl(workspaceId, row.version, row.hasLocks)
  // Agent (MCP) requests: per-workspace block + access record (docs/adr/0947-*). No-op for cookies.
  await assertAgentAllowed(workspaceId, state?.version)
  return { role: row.role, acl: acl === 'full' ? state : null }
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
