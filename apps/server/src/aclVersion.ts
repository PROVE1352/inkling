import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { WorkspaceRole } from '@inkling/shared'
import { db } from './db/index'

/**
 * Workspace access version and write gate (docs/adr/1071-*).
 *
 * `workspace_acl_versions(workspace_id, version, locked_pages)` changes in the same transaction as
 * everything that can change a write decision in the workspace: edit locks and their rules
 * (applyLockChange), agent instruction designations, agent blocks, page owners and parent_id moves.
 * In-process caches over that state (lock chains, agent blocks, "has instructions") are keyed by
 * `version`; a reader always gets the version from the database first and only then the data, so a
 * cached entry is never newer-labelled than its content.
 *
 * Gate (the RW structure that closes the check-then-write race with lock changes):
 *   - transactional writers read the row `FOR SHARE` before any page row lock (`gateWrite`); in READ
 *     COMMITTED a locked row comes back at its latest committed version, so `version` and
 *     `locked_pages` are fresh even when the statement had to wait for a bumper;
 *   - bumpers upsert the row (`bumpAcl`, a row lock that conflicts with FOR SHARE) right after the
 *     page-tree / member advisory locks and before touching any page row, then commit.
 * Lock order: page-tree advisory → ws-members advisory → acl row → page rows. Nothing else reads or
 * writes this table, so it never meets FK checks, the collab store or review scoring.
 *
 * A missing row reads as version 0; writers create it on first use. Readers take "has a locked page"
 * live (EXISTS on a partial index); the gate also trusts `locked_pages`, which a bumper it waited for
 * may have changed after the statement's snapshot was taken.
 */

type Exec = Pick<typeof db, 'execute'>

// Transactions that bumped a version: what they read is their own uncommitted state, labelled with
// a version other sessions only see after the commit — never cache it.
const bumpedTxs = new WeakSet<object>()

/** May data read through `exec` be cached under the version it read? */
export function cacheable(exec: object): boolean {
  return !bumpedTxs.has(exec)
}

export interface AclState {
  workspaceId: string
  version: number
  /** Some page of the workspace has edit_locked (false = the lock walk can be skipped). */
  hasLocks: boolean
}

/** "Some page of the workspace in `wsCol` is locked" (partial index pages_ws_locked_idx). */
export function hasLocksSql(wsCol: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM pages lq WHERE lq.workspace_id = ${wsCol} AND lq.edit_locked)`
}

/**
 * SQL fragments for a query that LEFT JOINs `workspace_acl_versions a` for workspace `wsCol`.
 * Readers without the gate take `hasLocks` live from the pages (same snapshot as the version).
 */
export function aclColumns(wsCol: SQL): { version: SQL; hasLocks: SQL } {
  return { version: sql`coalesce(a.version, 0)::bigint`, hasLocks: hasLocksSql(wsCol) }
}

export function toAcl(workspaceId: string, version: number | string | null, hasLocks: boolean | null): AclState {
  return { workspaceId, version: Number(version ?? 0), hasLocks: !!hasLocks }
}

/** Access state of the workspace of each page (one statement, no lock). */
export async function aclForPages(exec: Exec, pageIds: string[]): Promise<Map<string, AclState>> {
  const out = new Map<string, AclState>()
  if (!pageIds.length) return out
  const c = aclColumns(sql`p.workspace_id`)
  const rows = (await exec.execute(sql`
    SELECT p.id, p.workspace_id AS "workspaceId", ${c.version} AS version, ${c.hasLocks} AS "hasLocks"
      FROM pages p LEFT JOIN workspace_acl_versions a ON a.workspace_id = p.workspace_id
     WHERE p.id = ANY(${`{${pageIds.join(',')}}`}::uuid[])
  `)) as unknown as { id: string; workspaceId: string; version: string; hasLocks: boolean }[]
  for (const r of rows) out.set(r.id, toAcl(r.workspaceId, r.version, r.hasLocks))
  return out
}

/** Role of `userId` in the workspace of `pageId` and that workspace's access state (one statement). */
export async function pageAccess(
  exec: Exec,
  pageId: string,
  userId: string,
): Promise<{ role: WorkspaceRole | null; acl: AclState } | null> {
  const c = aclColumns(sql`p.workspace_id`)
  const [r] = (await exec.execute(sql`
    SELECT p.workspace_id AS "workspaceId", m.role, ${c.version} AS version, ${c.hasLocks} AS "hasLocks"
      FROM pages p
      LEFT JOIN workspace_acl_versions a ON a.workspace_id = p.workspace_id
      LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = ${userId}
     WHERE p.id = ${pageId}
  `)) as unknown as { workspaceId: string; role: WorkspaceRole | null; version: string; hasLocks: boolean }[]
  if (!r) return null
  return { role: r.role ?? null, acl: toAcl(r.workspaceId, r.version, r.hasLocks) }
}

/** Creates the row of `workspaceId` when it is missing (count of locked pages taken live). */
async function ensureAclRow(exec: Exec, workspaceId: string): Promise<void> {
  await exec.execute(sql`
    INSERT INTO workspace_acl_versions (workspace_id, version, locked_pages)
    SELECT ${workspaceId}::uuid, 0, count(*)::int FROM pages WHERE workspace_id = ${workspaceId} AND edit_locked
    ON CONFLICT (workspace_id) DO NOTHING
  `)
}

/**
 * Write gate for a transaction that is about to check and write in `workspaceId`: holds the acl row
 * FOR SHARE until commit (a lock change, block or move waits for this write; this write waits for one
 * in progress) and returns the fresh state plus the caller's role there. Call it before any page
 * row lock of the transaction (after lockTree when the transaction takes it).
 */
export async function gateWrite(
  tx: Exec,
  workspaceId: string,
  userId: string,
): Promise<{ role: WorkspaceRole | null; acl: AclState }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // locked_pages: fresh even after waiting for a bumper (the locked row is re-read at its latest
    // version); EXISTS: same snapshot as the statement, catches edit_locked written without a bump.
    const [r] = (await tx.execute(sql`
      SELECT a.version, (a.locked_pages > 0 OR ${hasLocksSql(sql`a.workspace_id`)}) AS "hasLocks", m.role
        FROM workspace_acl_versions a
        LEFT JOIN workspace_members m ON m.workspace_id = a.workspace_id AND m.user_id = ${userId}
       WHERE a.workspace_id = ${workspaceId}
         FOR SHARE OF a
    `)) as unknown as { version: string; hasLocks: boolean; role: WorkspaceRole | null }[]
    if (r) return { role: r.role ?? null, acl: toAcl(workspaceId, r.version, r.hasLocks) }
    await ensureAclRow(tx, workspaceId)
  }
  throw new Error(`workspace_acl_versions row for ${workspaceId} could not be created`)
}

/**
 * Bumps the access version of `workspaceId` and takes its gate exclusively until commit. Call it in
 * the transaction of the change, right after lockTree / lockWorkspaceMembers and before any page row
 * is touched (see the lock order above).
 */
export async function bumpAcl(tx: Exec, workspaceId: string): Promise<void> {
  bumpedTxs.add(tx)
  await tx.execute(sql`
    INSERT INTO workspace_acl_versions (workspace_id, version, locked_pages)
    SELECT ${workspaceId}::uuid, 1, count(*)::int FROM pages WHERE workspace_id = ${workspaceId} AND edit_locked
    ON CONFLICT (workspace_id) DO UPDATE SET version = workspace_acl_versions.version + 1
  `)
}

/** Recounts locked pages (after edit_locked changed in this transaction; bumpAcl must have run). */
export async function recountLockedPages(tx: Exec, workspaceId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE workspace_acl_versions
       SET locked_pages = (SELECT count(*)::int FROM pages WHERE workspace_id = ${workspaceId} AND edit_locked)
     WHERE workspace_id = ${workspaceId}
  `)
}

/**
 * Boot pass: creates missing rows and corrects locked_pages wherever it disagrees with the pages
 * (bumping the version of those workspaces). Idempotent; a corrected count means something changed
 * edit_locked outside applyLockChange.
 */
export async function reconcileAclVersions(): Promise<number> {
  await db.execute(sql`
    INSERT INTO workspace_acl_versions (workspace_id, version, locked_pages)
    SELECT w.id, 0, 0 FROM workspaces w
    ON CONFLICT (workspace_id) DO NOTHING
  `)
  const rows = (await db.execute(sql`
    UPDATE workspace_acl_versions a
       SET locked_pages = c.n, version = a.version + 1
      FROM (SELECT w.id, (SELECT count(*)::int FROM pages p WHERE p.workspace_id = w.id AND p.edit_locked) AS n
              FROM workspaces w) c
     WHERE c.id = a.workspace_id AND a.locked_pages <> c.n
    RETURNING a.workspace_id
  `)) as unknown as { workspace_id: string }[]
  return rows.length
}
