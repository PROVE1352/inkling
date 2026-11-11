import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import { bumpAcl } from './aclVersion'
import { db, relaxStatementTimeout } from './db/index'
import { files, notifications, users, workspaceMembers, workspaces } from './db/schema'
import { env } from './env'
import { badRequest, forbidden, notFound } from './errors'
import { lockWorkspaceMembers, memberRoleTx } from './helpers'
import { lockTree, type Tx } from './pageTree'
import { workspaceRestoreMs } from './workspaceLive'
import { recordAudit } from './workspaceAdmin'
import type { AuditActor } from './workspaceAdmin'
import { isTwoFactorBlocked, twoFactorRequired } from './twoFactorPolicy'
import { assertUserRoom } from './quota/room'

/**
 * Workspace deletion and ownership transfer (docs/adr/0910-*, 0911-*).
 *
 * Lock order is the one every membership/tree change uses (ADR 0801, 0813): `ws-members:<ws>`
 * first, then `page-tree:<ws>`, several workspaces in id order. Delete, restore and purge are
 * conditional single statements under the member lock, so concurrent delete/restore/purge of one
 * workspace serialise and each sees the result of the previous one.
 */

/**
 * Permanently deletes `wsIds` inside `tx` and returns the ids of their upload blobs. The caller
 * already holds the `ws-members` lock of every id; the tree locks are taken here in id order.
 * Every workspace_id foreign key cascades (pages → docs, snapshots, links, comments, bookmarks,
 * files rows, members, templates, tasks, notifications, webhooks, sheet syncs). Blobs must be
 * unlinked with `unlinkUploadBlobs` after the transaction commits — a rollback keeps them.
 */
export async function purgeWorkspacesTx(tx: Tx, wsIds: string[]): Promise<string[]> {
  const ids = [...new Set(wsIds)].sort()
  if (ids.length === 0) return []
  for (const id of ids) await lockTree(tx, id)
  // Large workspaces cascade through pages/docs/snapshots: no 15 s statement cap here.
  await relaxStatementTimeout(tx)
  const fileRows = await tx.select({ id: files.id }).from(files).where(inArray(files.workspaceId, ids))
  await tx.delete(workspaces).where(inArray(workspaces.id, ids))
  return fileRows.map((f) => f.id)
}

/** Best-effort removal of upload blobs after the deleting transaction committed. */
export async function unlinkUploadBlobs(fileIds: string[]): Promise<void> {
  for (const fid of fileIds) {
    try {
      await unlink(path.join(env.dataDir, 'uploads', fid))
    } catch {
      // already gone
    }
  }
}

export interface SoftDeleteResult {
  name: string
  /** Every member at deletion time (including the actor) — for socket/inbox fan-out. */
  memberIds: string[]
}

/**
 * Soft-deletes a workspace: owner only, `confirmName` must equal the current name exactly.
 * Other members get a `workspace_deleted` notification in the same transaction (no webhook).
 * 404 when it does not exist, is already deleted, or the actor is not a member.
 */
export async function softDeleteWorkspace(
  actor: AuditActor,
  workspaceId: string,
  confirmName: string,
): Promise<SoftDeleteResult> {
  const actorId = actor.id
  return db.transaction(async (tx) => {
    await lockWorkspaceMembers(tx, workspaceId)
    const [ws] = await tx
      .select({ name: workspaces.name, deletedAt: workspaces.deletedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    const role = ws ? await memberRoleTx(tx, workspaceId, actorId) : null
    if (!ws || !role || ws.deletedAt) throw notFound()
    if (role !== 'owner') throw forbidden('Only owners can delete the workspace')
    // These routes check the role here, not through requireMembership: apply the workspace's
    // 2FA requirement the same way (docs/adr/1112-*).
    if (await isTwoFactorBlocked(workspaceId, actorId)) throw twoFactorRequired(workspaceId)
    if (confirmName.trim() !== ws.name) throw badRequest('The workspace name does not match')

    const updated = await tx
      .update(workspaces)
      .set({ deletedAt: new Date(), deletedBy: actorId })
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .returning({ id: workspaces.id })
    if (updated.length === 0) throw notFound()

    const members = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
    const others = members.map((m) => m.userId).filter((id) => id !== actorId)
    if (others.length > 0) {
      await tx.insert(notifications).values(
        others.map((userId) => ({
          userId,
          type: 'workspace_deleted' as const,
          workspaceId,
          actorId,
        })),
      )
    }
    await recordAudit(tx, { workspaceId, actor, action: 'workspace.deleted', target: { type: 'workspace', id: workspaceId, label: ws.name } })
    return { name: ws.name, memberIds: members.map((m) => m.userId) }
  })
}

/**
 * Restores a soft-deleted workspace within the restore window: owner only. 404 when it is not
 * deleted, the window has passed, or the actor is not a member. The `workspace_deleted`
 * notifications are removed (they would now be wrong).
 */
export async function restoreWorkspace(actor: AuditActor, workspaceId: string): Promise<{ memberIds: string[] }> {
  const actorId = actor.id
  return db.transaction(async (tx) => {
    await lockWorkspaceMembers(tx, workspaceId)
    const role = await memberRoleTx(tx, workspaceId, actorId)
    if (!role) throw notFound()
    if (role !== 'owner') throw forbidden('Only owners can restore the workspace')
    if (await isTwoFactorBlocked(workspaceId, actorId)) throw twoFactorRequired(workspaceId)
    // LIMIT_WORKSPACES_PER_USER (docs/adr/2505-*): the owner must not already be over; the deleted
    // workspace is counted already. In this transaction, after the member lock (members → user).
    await assertUserRoom(tx, actorId, { workspaces: 0 })
    const cutoff = new Date(Date.now() - workspaceRestoreMs())
    const restored = await tx
      .update(workspaces)
      .set({ deletedAt: null, deletedBy: null })
      .where(and(eq(workspaces.id, workspaceId), isNotNull(workspaces.deletedAt), gt(workspaces.deletedAt, cutoff)))
      .returning({ id: workspaces.id, name: workspaces.name })
    if (restored.length === 0) throw notFound()
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'workspace.restored',
      target: { type: 'workspace', id: workspaceId, label: restored[0].name },
    })
    await tx
      .delete(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.type, 'workspace_deleted')))
    const members = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
    return { memberIds: members.map((m) => m.userId) }
  })
}

/** Soft-deleted workspaces `userId` owns that can still be restored, newest deletion first. */
export async function listRestorableWorkspaces(userId: string) {
  const cutoff = new Date(Date.now() - workspaceRestoreMs())
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      icon: workspaces.icon,
      deletedAt: workspaces.deletedAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.role, 'owner'),
        isNotNull(workspaces.deletedAt),
        gt(workspaces.deletedAt, cutoff),
      ),
    )
    .orderBy(sql`${workspaces.deletedAt} desc`)
  return rows.map((r) => {
    const deletedAt = r.deletedAt as Date
    return {
      id: r.id,
      name: r.name,
      icon: r.icon,
      deletedAt: deletedAt.toISOString(),
      purgeAt: new Date(deletedAt.getTime() + workspaceRestoreMs()).toISOString(),
    }
  })
}

/**
 * Housekeeping: permanently deletes workspaces soft-deleted longer than the restore window. Each
 * one in its own transaction: member lock → re-check under the lock (a restore that won the race
 * leaves nothing to do) → tree lock → cascade delete. Blobs are unlinked after commit.
 */
export async function purgeExpiredWorkspaces(now: Date, log: (msg: string) => void): Promise<number> {
  const cutoff = new Date(now.getTime() - workspaceRestoreMs())
  const candidates = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(isNotNull(workspaces.deletedAt), lt(workspaces.deletedAt, cutoff)))
    .orderBy(asc(workspaces.id))
    .limit(50)
  let purged = 0
  for (const c of candidates) {
    try {
      const fileIds = await db.transaction(async (tx) => {
        await lockWorkspaceMembers(tx, c.id)
        const [still] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.id, c.id), isNotNull(workspaces.deletedAt), lt(workspaces.deletedAt, cutoff)))
          .limit(1)
        if (!still) return null
        return purgeWorkspacesTx(tx, [c.id])
      })
      if (fileIds) {
        purged++
        await unlinkUploadBlobs(fileIds)
      }
    } catch (err) {
      log(`[inkling] workspace purge failed ${c.id}: ${String(err)}`)
    }
  }
  return purged
}

/**
 * Transfers ownership (docs/adr/0911-*): the actor (an owner) makes `targetId` an owner and
 * becomes a member, atomically under the member lock. The target must already be a member
 * (400 otherwise; delegated accounts are members like any other). Two concurrent transfers by the
 * same owner: the second sees the actor demoted and gets 403, so the workspace always keeps at
 * least one owner.
 */
export async function transferOwnership(actor: AuditActor, workspaceId: string, targetId: string): Promise<void> {
  const actorId = actor.id
  await db.transaction(async (tx) => {
    await lockWorkspaceMembers(tx, workspaceId)
    // Two roles change, and owners pass every lock: an access change (docs/adr/1071-*, 1923-*).
    await bumpAcl(tx, workspaceId)
    const myRole = await memberRoleTx(tx, workspaceId, actorId)
    if (!myRole) throw notFound()
    if (myRole !== 'owner') throw forbidden('Only owners can transfer ownership')
    if (actorId === targetId) throw badRequest('You already own this workspace')
    const target = await memberRoleTx(tx, workspaceId, targetId)
    if (!target) throw badRequest('The new owner must be a member of this workspace')
    // The new owner's LIMIT_WORKSPACES_PER_USER (docs/adr/2505-*), in this transaction under the member
    // lock (members → user), so two transfers to the same person cannot both take the last place.
    // Account deletion hands workspaces over on its own path and does not look at the limit (contract §13).
    if (target !== 'owner') await assertUserRoom(tx, targetId, { workspaces: 1 })
    await tx
      .update(workspaceMembers)
      .set({ role: 'owner' })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)))
    await tx
      .update(workspaceMembers)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, actorId),
          ne(workspaceMembers.userId, targetId),
        ),
      )
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, targetId)).limit(1)
    await recordAudit(tx, {
      workspaceId,
      actor,
      action: 'workspace.transferred',
      target: { type: 'user', id: targetId, label: u?.name ?? null },
      before: { owner: actor.name, targetRole: target },
      after: { owner: u?.name ?? null, actorRole: 'member' },
    })
  })
}

/** Counts for the delete confirmation dialog. */
export async function workspaceDeletePreview(workspaceId: string) {
  const [r] = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM pages WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL) AS pages,
      (SELECT count(*)::int FROM files WHERE workspace_id = ${workspaceId}) AS files,
      (SELECT count(*)::int FROM pages WHERE workspace_id = ${workspaceId} AND share_token IS NOT NULL AND deleted_at IS NULL) AS "publicLinks",
      (SELECT count(*)::int FROM workspace_members WHERE workspace_id = ${workspaceId}) AS members
  `)) as unknown as { pages: number; files: number; publicLinks: number; members: number }[]
  return {
    pages: Number(r?.pages ?? 0),
    files: Number(r?.files ?? 0),
    publicLinks: Number(r?.publicLinks ?? 0),
    members: Number(r?.members ?? 0),
    restoreDays: workspaceRestoreMs() / 86_400_000,
  }
}
