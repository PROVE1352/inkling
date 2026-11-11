import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { withAdminLock } from '../accounts'
import { bumpAcl } from '../aclVersion'
import { db } from '../db/index'
import { files, notifications, pages, signupKeys, users, workspaceMembers } from '../db/schema'
import { env } from '../env'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { lockWorkspaceMembers } from '../helpers'
import { limits } from '../limits'
import { closeConnectionsOfGonePages, closeUserConnections } from '../liveConnections'
import { broadcastToUser } from '../collab'
import { lockTree, purgeDeletedSubtrees, type Tx } from '../pageTree'
import { recordAudit } from '../workspaceAdmin'
import { AUDIT_NAME_ID_PAIRS } from './auditIds'
import { purgeWorkspacesTx } from '../workspaceDeletion'

/**
 * Account deletion (0.22, docs/adr/2517-*): one function for leaving (`self`), the account lifetime
 * (`expiry`) and an admin's forced deletion (`admin`).
 *
 * Always in this order: the plan (what goes, computed from the database, shared by the preview,
 * the dry run and the deletion) → one transaction that deletes → upload blobs unlinked after the
 * commit (a rollback keeps them; a failed unlink leaves an orphan file and one log line).
 *
 *   admin   0.21.1 behaviour, unchanged: refused (409 SOLE_OWNER) while the account is the only owner
 *           of a workspace with other members; its private pages go to the trash; the signup key's
 *           use is given back. Names copied into audit rows stay.
 *   self,   workspaces where the account is the only member → deleted at once, files included;
 *   expiry  workspaces with other members → their content stays, the author is shown as deleted;
 *           the only owner's workspaces pass to the oldest admin-role member, else the oldest member
 *           (who gets an in-app notification, even past LIMIT_WORKSPACES_PER_USER); its private
 *           pages and private templates are deleted at once; its name and sign-in ID are scrubbed
 *           from the rows that copied them as text (audit log, change log, auto-made workspace
 *           names, invitations to its address), found by its id only (scrubCopiedNames). Sessions, tokens, OAuth links, push subscriptions,
 *           2FA and consent records go with the users row (ON DELETE CASCADE).
 */

export type DeleteBy = 'self' | 'expiry' | 'admin'

export interface WsRef {
  id: string
  name: string
}

export interface AccountDeletionPlan {
  /** Deleted with the account: the only member, or soft-deleted with the account as its only owner. */
  purge: (WsRef & { pages: number; files: number })[]
  /** Other members and no other owner. `admin`: the deletion is refused while non-empty. */
  soleOwnedShared: WsRef[]
  /** self/expiry: who takes over each of soleOwnedShared (oldest admin-role member, else oldest member). */
  transfer: { workspace: WsRef; to: { id: string; name: string } }[]
  /** Other workspaces of the account: its shared content stays there. */
  kept: WsRef[]
  /** The account's private pages outside `purge` (deleted at once by self/expiry). */
  privatePages: number
}

type Exec = Pick<Tx, 'execute'>

/**
 * The workspaces a deletion of `userId` affects (docs/adr/0813-*, 2517-*). Read-only: the preview,
 * the dry run and the deletion itself (inside its transaction, after the member locks) call it.
 */
export async function planAccountDeletion(exec: Exec, userId: string): Promise<AccountDeletionPlan> {
  const rows = (await exec.execute(sql`
    SELECT w.id, w.name, m.role, (w.deleted_at IS NOT NULL) AS deleted,
           (SELECT count(*)::int FROM workspace_members a WHERE a.workspace_id = w.id) AS members,
           EXISTS (SELECT 1 FROM workspace_members o
                    WHERE o.workspace_id = w.id AND o.role = 'owner' AND o.user_id <> ${userId}) AS "otherOwner"
      FROM workspaces w
      JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ${userId}
     ORDER BY w.name, w.id
  `)) as unknown as { id: string; name: string; role: string; deleted: boolean; members: number; otherOwner: boolean }[]
  // as deletionPlan in routes/admin.ts before 0.22: only workspaces without another owner count
  const purgeRow = (r: (typeof rows)[number]) => !r.otherOwner && (Number(r.members) <= 1 || (r.deleted && r.role === 'owner'))
  const purgeIds = rows.filter(purgeRow).map((r) => r.id)
  const sizes = purgeIds.length
    ? ((await exec.execute(sql`
        SELECT w.id,
               (SELECT count(*)::int FROM pages p WHERE p.workspace_id = w.id) AS pages,
               (SELECT count(*)::int FROM files f WHERE f.workspace_id = w.id) AS files
          FROM workspaces w WHERE w.id = ANY(${pgUuids(purgeIds)}::uuid[])
      `)) as unknown as { id: string; pages: number; files: number }[])
    : []
  const sizeOf = new Map(sizes.map((s) => [s.id, s]))
  const purge = rows
    .filter(purgeRow)
    .map((r) => ({ id: r.id, name: r.name, pages: Number(sizeOf.get(r.id)?.pages ?? 0), files: Number(sizeOf.get(r.id)?.files ?? 0) }))
  const soleOwnedShared = rows.filter((r) => !purgeRow(r) && !r.otherOwner && r.role === 'owner').map((r) => ({ id: r.id, name: r.name }))
  const kept = rows.filter((r) => !purgeRow(r) && !(r.role === 'owner' && !r.otherOwner)).map((r) => ({ id: r.id, name: r.name }))
  const transfer: AccountDeletionPlan['transfer'] = []
  for (const w of soleOwnedShared) {
    const [to] = (await exec.execute(sql`
      SELECT m.user_id AS id, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ${w.id} AND m.user_id <> ${userId}
       ORDER BY (m.role = 'admin') DESC, m.created_at, m.user_id
       LIMIT 1
    `)) as unknown as { id: string; name: string }[]
    if (to) transfer.push({ workspace: w, to: { id: to.id, name: to.name } })
  }
  const [priv] = (await exec.execute(sql`
    SELECT count(*)::int AS n FROM pages
     WHERE created_by = ${userId} AND scope = 'private'
       ${purgeIds.length ? sql`AND workspace_id <> ALL(${pgUuids(purgeIds)}::uuid[])` : sql``}
  `)) as unknown as { n: number }[]
  return { purge, soleOwnedShared, transfer, kept, privatePages: Number(priv?.n ?? 0) }
}

export interface DeleteAccountResult {
  /** false: nothing to do (the account was already gone, or no longer matched the expiry rule). */
  deleted: boolean
  deletedWorkspaces: number
  transferredWorkspaces: number
}

export interface DeleteAccountOptions {
  by: DeleteBy
  /** The admin doing a forced deletion (`admin`). */
  actorId?: string
  /** Log line sink for blob unlink failures (never the account's name or ID). */
  log?: (msg: string) => void
}

/**
 * Delete the account `userId` (see the file comment). One transaction under the admin lock (the
 * same lock that guards the set of admins), so a leave and an expiry of the same account at the
 * same moment delete it once: the second one finds no row and returns `deleted: false`.
 *
 * Errors: admin → 400 (last admin), 403 (actor not admin), 404, 409 SOLE_OWNER; self → 404,
 * 409 LAST_ADMIN. `expiry` re-checks the double lock inside the transaction (setting on, expires_at
 * in the past, not an admin) and returns `deleted: false` when it no longer holds.
 */
export async function deleteAccount(userId: string, opts: DeleteAccountOptions): Promise<DeleteAccountResult> {
  const log = opts.log ?? ((m: string) => console.warn(m))
  const blobIds: string[] = []
  let purgedIds: string[] = []
  let notified: string[] = []
  const result = await withAdminLock(async (tx): Promise<DeleteAccountResult> => {
    const none = { deleted: false, deletedWorkspaces: 0, transferredWorkspaces: 0 }
    if (opts.by === 'admin') {
      if (!opts.actorId) throw forbidden('Admins only')
      const [self] = await tx.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, opts.actorId))
      if (!self?.isAdmin) throw forbidden('Admins only')
    }
    const [target] = await tx
      .select({ name: users.name, email: users.email, isAdmin: users.isAdmin, signupKey: users.signupKey, expiresAt: users.expiresAt })
      .from(users)
      .where(eq(users.id, userId))
    if (!target) {
      if (opts.by === 'expiry') return none
      throw notFound('USER_NOT_FOUND', 'User not found')
    }
    if (opts.by === 'expiry') {
      // the double lock (docs/adr/2517-*), re-read under the lock
      if (limits.accountLifetimeDays === null || target.isAdmin || !target.expiresAt || target.expiresAt.getTime() >= Date.now()) return none
    }
    if (target.isAdmin && opts.by !== 'expiry') {
      const [c] = await tx
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.isAdmin, true), ne(users.id, userId)))
      if ((c?.n ?? 0) === 0) {
        if (opts.by === 'admin') throw badRequest('You cannot delete the last admin')
        throw new AppError(409, 'LAST_ADMIN', 'You are the only admin of this server. Make another account an admin first.')
      }
    }

    // Membership changes take the per-workspace member lock (ws-members, ids in order), as removeMember does.
    const memberOf = (await tx.execute(sql`
      SELECT workspace_id AS id FROM workspace_members WHERE user_id = ${userId} ORDER BY workspace_id
    `)) as unknown as { id: string }[]
    for (const w of memberOf) await lockWorkspaceMembers(tx, w.id)
    const plan = await planAccountDeletion(tx, userId)

    if (opts.by === 'admin') {
      // A workspace whose only owner disappears can no longer be managed (C-H1, docs/adr/0813-*).
      if (plan.soleOwnedShared.length > 0) {
        throw new AppError(
          409,
          'SOLE_OWNER',
          'This user is the only owner of some shared workspaces. An owner of each must use "Transfer ownership" in the workspace menu, or delete the workspace, first.',
          undefined,
          { workspaces: plan.soleOwnedShared },
        )
      }
      if (plan.purge.length > 0) {
        blobIds.push(...(await purgeWorkspacesTx(tx, plan.purge.map((w) => w.id))))
        purgedIds = plan.purge.map((w) => w.id)
      }
      // pages.created_by is ON DELETE SET NULL. The user's private pages go to the trash and
      // become ownerless: visible to nobody, admins included (pageDto.visibleTo), and removed by
      // the 30-day trash purge (docs/adr/0803-*).
      await tx
        .update(pages)
        .set({ deletedAt: sql`coalesce(${pages.deletedAt}, now())` })
        .where(and(eq(pages.createdBy, userId), eq(pages.scope, 'private')))
      await tx.delete(users).where(eq(users.id, userId))
      if (target.signupKey) {
        await tx
          .update(signupKeys)
          .set({ usedCount: sql`greatest(${signupKeys.usedCount} - 1, 0)` })
          .where(eq(signupKeys.key, target.signupKey))
      }
      return { deleted: true, deletedWorkspaces: plan.purge.length, transferredWorkspaces: 0 }
    }

    // --- self / expiry ---
    const purgeIds = plan.purge.map((w) => w.id)
    const staying = [...plan.kept.map((w) => w.id), ...plan.transfer.map((t) => t.workspace.id)].sort()
    // pages.owner_id (ON DELETE SET NULL) and member roles change in these: new access version first
    // (docs/adr/1071-*), before any page row of this transaction is written.
    for (const id of staying) await bumpAcl(tx, id)

    // The only owner leaves: the oldest admin-role member, else the oldest member, takes over.
    for (const t of plan.transfer) {
      await tx
        .update(workspaceMembers)
        .set({ role: 'owner' })
        .where(and(eq(workspaceMembers.workspaceId, t.workspace.id), eq(workspaceMembers.userId, t.to.id)))
      await tx.insert(notifications).values({ userId: t.to.id, type: 'workspace_owner', workspaceId: t.workspace.id, actorId: null })
      // no actor and no name of the deleted account (it is scrubbed below anyway)
      await recordAudit(tx, {
        workspaceId: t.workspace.id,
        actor: null,
        action: 'workspace.transferred',
        target: { type: 'user', id: t.to.id, label: t.to.name },
        after: { reason: 'account_deleted' },
      })
    }
    notified = plan.transfer.map((t) => t.to.id)

    // Tree locks of every workspace whose page rows change, in id order (after the member locks).
    const privWs = (await tx.execute(sql`
      SELECT DISTINCT workspace_id AS id FROM pages WHERE created_by = ${userId} AND scope = 'private'
    `)) as unknown as { id: string }[]
    for (const id of [...new Set([...purgeIds, ...privWs.map((w) => w.id)])].sort()) await lockTree(tx, id)

    if (purgeIds.length > 0) {
      blobIds.push(...(await purgeWorkspacesTx(tx, purgeIds)))
      purgedIds = purgeIds
    }

    // Private pages (and the trash's copies of them) elsewhere: deleted now, with their attachments.
    const priv = (await tx.execute(sql`
      UPDATE pages SET deleted_at = coalesce(deleted_at, now())
       WHERE created_by = ${userId} AND scope = 'private'
      RETURNING id
    `)) as unknown as { id: string }[]
    if (priv.length > 0) {
      const ids = priv.map((p) => p.id)
      const res = await purgeDeletedSubtrees(tx, ids)
      if (res.fileIds.length > 0) {
        await tx.delete(files).where(inArray(files.id, res.fileIds))
        blobIds.push(...res.fileIds)
      }
      await tx.execute(sql`DELETE FROM page_changes WHERE page_id = ANY(${pgUuids(ids)}::uuid[])`)
    }
    // The change log keeps no foreign key to users or pages: private-page entries go, others lose the author.
    await tx.execute(sql`DELETE FROM page_changes WHERE owner_id = ${userId}`)
    await tx.execute(sql`UPDATE page_changes SET actor_id = NULL WHERE actor_id = ${userId}`)
    // Private templates (only their author sees them).
    await tx.execute(sql`DELETE FROM templates WHERE created_by = ${userId} AND scope = 'private'`)
    // Invitations addressed to the account's email.
    await tx.execute(sql`DELETE FROM page_invites WHERE email = ${target.email.toLowerCase()}`)

    await scrubCopiedNames(tx, userId, target)

    await tx.delete(users).where(eq(users.id, userId))
    return { deleted: true, deletedWorkspaces: purgeIds.length, transferredWorkspaces: plan.transfer.length }
  })

  if (result.deleted) {
    // Sessions and tokens are gone with the row; open collab sockets and the inbox channel close now
    // (docs/adr/0754-*). MCP and API tokens are checked per request, so they stop with the rows.
    closeUserConnections(userId, { includeInbox: true })
    // the purged workspaces' pages are gone: find their sockets (page guests' too) from the open documents
    if (purgedIds.length > 0) await closeConnectionsOfGonePages()
    for (const uid of notified) broadcastToUser(uid, { t: 'notifications' })
    await unlinkBlobs(blobIds, log)
  }
  return result
}

/**
 * Rows that copied the account's name or sign-in ID as text (docs/adr/2517-*, 2535-*), found **by the
 * account's id only** (contract §14): a row or value about anyone else, even someone with the same
 * display name, never changes.
 *
 *   workspace_audit_events  actor_name of its rows (actor_id), target_label of rows about it
 *                           (target_id), and the JSON values the write sites keep beside an id
 *                           (AUDIT_NAME_ID_PAIRS; the ownership transfer's owners by actor/target)
 *   workspaces              the workspace it made at sign-up ("<name>'s workspace", created_by)
 *
 * A name copied without an id (audit rows written before 0.22's fix: a lock's editor list, an agent
 * block's member) cannot be told apart from a namesake's and stays.
 */
async function scrubCopiedNames(tx: Tx, userId: string, who: { name: string }): Promise<void> {
  await tx.execute(sql`UPDATE workspace_audit_events SET actor_name = '' WHERE actor_id = ${userId}`)
  await tx.execute(sql`
    UPDATE workspace_audit_events SET target_label = NULL
     WHERE target_id IS NOT NULL AND position(${userId} in target_id) > 0
  `)
  const idLike = `%${userId}%`
  const rows = (await tx.execute(sql`
    SELECT id, action, actor_id AS "actorId", target_id AS "targetId", before, after FROM workspace_audit_events
     WHERE (action = 'workspace.transferred' AND (actor_id = ${userId} OR target_id = ${userId}))
        OR before::text LIKE ${idLike} OR after::text LIKE ${idLike}
  `)) as unknown as AuditJsonRow[]
  for (const r of rows) {
    const before = scrubAuditValue(r, 'before', userId)
    const after = scrubAuditValue(r, 'after', userId)
    if (JSON.stringify(before) === JSON.stringify(r.before) && JSON.stringify(after) === JSON.stringify(r.after)) continue
    await tx.execute(sql`
      UPDATE workspace_audit_events SET before = ${jsonOrNull(before)}::jsonb, after = ${jsonOrNull(after)}::jsonb WHERE id = ${r.id}
    `)
  }
  // The workspace made at sign-up carries the name; with other members it stays, renamed. Only the
  // ones this account made (created_by is its id): a namesake's "<name>'s workspace" keeps its name.
  if (who.name.length > 0) {
    await tx.execute(sql`
      UPDATE workspaces
         SET name = CASE WHEN name = ${`${who.name}의 워크스페이스`} THEN '워크스페이스' ELSE 'Workspace' END
       WHERE created_by = ${userId}
         AND name IN (${`${who.name}의 워크스페이스`}, ${`${who.name}'s workspace`})
    `)
  }
}

export interface AuditJsonRow {
  id: string
  action: string
  actorId: string | null
  targetId: string | null
  before: unknown
  after: unknown
}

/**
 * One audit JSON value with the deleted account's entries set to null, by id only (pure, for tests):
 * a name beside the account's id, and the transfer row's `owner` on the side the account was on
 * (before = the actor, after = the target; that row's shape since 0.13, so older rows are covered).
 */
export function scrubAuditValue(r: AuditJsonRow, side: 'before' | 'after', userId: string): unknown {
  const v = r[side]
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  const out: Record<string, unknown> = { ...(v as Record<string, unknown>) }
  if (r.action === 'workspace.transferred' && 'owner' in out) {
    if ((side === 'before' && r.actorId === userId) || (side === 'after' && r.targetId === userId)) out.owner = null
  }
  for (const { name, ids } of AUDIT_NAME_ID_PAIRS) {
    const n = out[name]
    const i = out[ids]
    if (Array.isArray(n) && Array.isArray(i) && n.length === i.length) {
      out[name] = n.map((x, k) => (i[k] === userId ? null : x))
      out[ids] = i.map((x) => (x === userId ? null : x))
    } else if (i === userId) {
      if (name in out) out[name] = null
      out[ids] = null
    }
  }
  return out
}

const jsonOrNull = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v))
const pgUuids = (ids: string[]) => `{${ids.join(',')}}`

/**
 * Unlink upload blobs after the commit. A blob that cannot be removed stays as an orphan file (no
 * row points at it) and is logged by id only.
 */
export async function unlinkBlobs(fileIds: string[], log: (msg: string) => void): Promise<number> {
  let failed = 0
  for (const fid of fileIds) {
    try {
      await unlink(path.join(env.dataDir, 'uploads', fid))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      failed++
      log(`[inkling] account deletion: could not remove upload ${fid} (${(err as NodeJS.ErrnoException).code ?? 'error'}); it stays as an orphan file`)
    }
  }
  return failed
}

/** The admin screen's preview (GET /admin/users/:id/delete-preview), unchanged since 0.21.1. */
export async function adminDeletePreview(userId: string) {
  const plan = await planAccountDeletion(db, userId)
  const personal = plan.purge.map((w) => ({ id: w.id, name: w.name }))
  return { personalWorkspaces: personal.length, personal, soleOwnedShared: plan.soleOwnedShared }
}
