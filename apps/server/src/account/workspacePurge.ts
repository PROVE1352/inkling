import { and, count, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { workspaceMembers, workspaces } from '../db/schema'
import { badRequest, forbidden, notFound } from '../errors'
import { lockWorkspaceMembers, memberRoleTx } from '../helpers'
import type { Tx } from '../pageTree'
import { isTwoFactorBlocked, twoFactorRequired } from '../twoFactorPolicy'
import { purgeWorkspacesTx } from '../workspaceDeletion'
import { closeConnectionsOfGonePages } from '../liveConnections'
import { invalidateWebhookCache } from '../webhooks'
import { unlinkBlobs } from './deletion'

/**
 * Workspaces without members, and "delete now" (0.22, docs/adr/2513-*). Both delete at once, with
 * their files, and cannot be undone; both confirm with the workspace's name, as the soft delete does.
 */

/**
 * Leave as the only member (removeMember, routes/workspaces.ts): the caller holds the member lock and
 * knows the leaver is the last owner. Without `confirmName` the 0.21.1 answer stands (400, the last
 * owner cannot leave); with another member present it stands too. Alone and with the right name, the
 * workspace is deleted in `tx` and the ids of its upload blobs are returned (unlink after commit).
 */
export async function leaveAsLastMemberTx(tx: Tx, workspaceId: string, confirmName: string | undefined): Promise<string[] | null> {
  if (confirmName === undefined) return null
  const [m] = await tx.select({ n: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
  if ((m?.n ?? 0) !== 1) return null
  const [ws] = await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!ws) throw notFound()
  if (confirmName.trim() !== ws.name) throw badRequest('The workspace name does not match')
  return purgeWorkspacesTx(tx, [workspaceId])
}

/**
 * DELETE /workspaces/:id/permanent: an owner deletes a workspace that is already deleted (still in
 * its restore window) for good, e.g. to make room under LIMIT_WORKSPACES_PER_USER. Owner only, the
 * workspace's 2FA rule applies as for restore, `confirmName` must equal its name. 404 when it is not
 * a deleted workspace of the caller (a restore that won the race included). Returns blob ids.
 */
export async function purgeDeletedWorkspace(actorId: string, workspaceId: string, confirmName: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockWorkspaceMembers(tx, workspaceId)
    const role = await memberRoleTx(tx, workspaceId, actorId)
    if (!role) throw notFound()
    const [ws] = await tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNotNull(workspaces.deletedAt)))
      .limit(1)
    if (!ws) throw notFound()
    if (role !== 'owner') throw forbidden('Only owners can delete the workspace')
    if (await isTwoFactorBlocked(workspaceId, actorId)) throw twoFactorRequired(workspaceId)
    if (confirmName.trim() !== ws.name) throw badRequest('The workspace name does not match')
    // re-checked by the delete itself: still soft-deleted under the lock
    const still = (await tx.execute(sql`SELECT 1 FROM workspaces WHERE id = ${workspaceId} AND deleted_at IS NOT NULL FOR UPDATE`)) as unknown as unknown[]
    if (still.length === 0) throw notFound()
    return purgeWorkspacesTx(tx, [workspaceId])
  })
}

/**
 * After the commit of a deletion of `workspaceId`: close its sockets, tell nobody (no members), unlink
 * its blobs. Its pages are gone, so the sockets are found from the open documents whose page no longer
 * exists (page guests' included), not by workspace.
 */
export async function afterLastMemberLeft(workspaceId: string, blobIds: string[], log: (msg: string) => void): Promise<void> {
  invalidateWebhookCache(workspaceId)
  await closeConnectionsOfGonePages()
  await unlinkBlobs(blobIds, log)
}
