import { sql } from 'drizzle-orm'
import type { WorkspaceRole } from '@inkling/shared'
import { db } from './db/index'
import { badRequest, forbidden } from './errors'
import { isManagerRole } from './workspaceAdmin'
import { actorFor, assertCan } from './editLock'

/**
 * Page tree integrity (docs/adr/0800-*).
 *
 * Every change to the shape of a workspace's page tree (create under a parent, move, scope change,
 * soft delete, restore, purge, sync/import creation) runs in a transaction that first takes
 * `pg_advisory_xact_lock(hashtext('page-tree:' || workspaceId))`. Inside that lock the ancestor
 * check is one recursive CTE, so two concurrent "move A under B" / "move B under A" requests can no
 * longer both pass their checks and commit a parent cycle.
 *
 * Every recursive walk over parent_id is capped at TREE_MAX_DEPTH levels, so even a cycle that is
 * already in the database (written before this lock existed) terminates instead of spinning a
 * backend until the pool is exhausted. New placements that would make any chain deeper than
 * TREE_MAX_DEPTH are rejected with 400, which keeps the capped descendant walks complete.
 */
export const TREE_MAX_DEPTH = 64

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Exec = Pick<typeof db, 'execute'>

/** Takes the workspace tree lock for the rest of the current transaction. */
export async function lockTree(tx: Exec, workspaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'page-tree:' + workspaceId}))`)
}

/** Runs `fn` in a transaction holding the workspace tree lock. */
export function withTreeLock<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await lockTree(tx, workspaceId)
    return fn(tx)
  })
}

export interface ChainRow {
  id: string
  parentId: string | null
  workspaceId: string
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  scope: 'shared' | 'private'
  shareToken: string | null
  deletedAt: Date | null
  depth: number
}

/**
 * `pageId` and its ancestors (depth 0 = the page itself), nearest first, at most
 * TREE_MAX_DEPTH + 1 rows. The walk follows parent_id regardless of deleted_at.
 */
export async function ancestorChain(tx: Exec, pageId: string): Promise<ChainRow[]> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, workspace_id, kind, scope, share_token, deleted_at, 0 AS depth
        FROM pages WHERE id = ${pageId}
      UNION ALL
      SELECT p.id, p.parent_id, p.workspace_id, p.kind, p.scope, p.share_token, p.deleted_at,
             c.depth + 1
        FROM pages p JOIN chain c ON p.id = c.parent_id
       WHERE c.depth < ${TREE_MAX_DEPTH}
    )
    SELECT id, parent_id AS "parentId", workspace_id AS "workspaceId", kind, scope,
           share_token AS "shareToken", deleted_at AS "deletedAt", depth
      FROM chain ORDER BY depth
  `)) as unknown as ChainRow[]
  return rows
}

/** Height of the subtree below `pageId` (0 = no children), capped at TREE_MAX_DEPTH. */
export async function subtreeHeight(tx: Exec, pageId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE sub AS (
      SELECT id, 0 AS depth FROM pages WHERE id = ${pageId}
      UNION ALL
      SELECT p.id, s.depth + 1 FROM pages p JOIN sub s ON p.parent_id = s.id
       WHERE s.depth < ${TREE_MAX_DEPTH}
    )
    SELECT coalesce(max(depth), 0)::int AS h FROM sub
  `)) as unknown as { h: number }[]
  return rows[0]?.h ?? 0
}

/**
 * SQL fragment: `WITH RECURSIVE descendants(id, depth) AS (...)` of `rootId` (inclusive), capped.
 * `onlyDeleted` restricts the walk to soft-deleted rows (purge must never reach a live page).
 */
export function descendantsCte(rootId: string, opts: { onlyDeleted?: boolean } = {}) {
  const filter = opts.onlyDeleted ? sql`AND p.deleted_at IS NOT NULL` : sql``
  return sql`WITH RECURSIVE descendants AS (
      SELECT id, 0 AS depth FROM pages WHERE id = ${rootId}
      UNION ALL
      SELECT p.id, d.depth + 1 FROM pages p JOIN descendants d ON p.parent_id = d.id
       WHERE d.depth < ${TREE_MAX_DEPTH} ${filter}
    )`
}

/** Shared ancestors with a public link that expose the subtree under `chain[0]`. */
function publicAncestors(chain: ChainRow[]): Set<string> {
  return new Set(chain.filter((r) => r.shareToken && r.scope === 'shared').map((r) => r.id))
}

/**
 * Validates placing a page (new, or `movingId` with its subtree) directly under `parentId`.
 * Must run inside the workspace tree lock. Throws:
 *  - 400 when the parent is missing, in another workspace or in the trash,
 *  - 400 when the parent chain contains `movingId` (cycle) or the result would exceed
 *    TREE_MAX_DEPTH (also the answer for a pre-existing cycle above the parent),
 *  - 403 PAGE_LOCKED when the actor may not edit the parent (or, for a move, the moved subtree),
 *  - 403 when the parent is inside a publicly shared folder, the actor is not a workspace owner
 *    and the placement would newly expose content there (docs/adr/0802-*).
 * Returns the parent chain (depth 0 = parent).
 */
export async function assertPlacement(
  tx: Exec,
  opts: {
    workspaceId: string
    parentId: string
    movingId?: string
    role: WorkspaceRole
    /**
     * The acting member: the parent must be editable for them (edit lock, docs/adr/0970-*), and a
     * moved subtree must be editable as a whole. Inside an MCP request the agent rules apply.
     */
    userId: string
    /** Height of new content placed under the parent (copies); moves measure `movingId`. */
    height?: number
    /** false for copies placed next to their original (they expose nothing new). */
    publicRule?: boolean
  },
): Promise<ChainRow[]> {
  const chain = await ancestorChain(tx, opts.parentId)
  const parent = chain[0]
  if (!parent || parent.workspaceId !== opts.workspaceId) {
    throw badRequest('Invalid parent page')
  }
  if (opts.movingId && chain.some((r) => r.id === opts.movingId)) {
    throw badRequest("Can't move a page under its own subpage")
  }
  if (chain.some((r) => r.deletedAt)) {
    throw badRequest('The parent page is in the trash')
  }
  const last = chain[chain.length - 1]
  const capped = last.depth >= TREE_MAX_DEPTH && last.parentId !== null
  // Levels from the root down to the parent, plus the new page, plus its own subtree.
  const height = opts.movingId ? await subtreeHeight(tx, opts.movingId) : (opts.height ?? 0)
  if (capped || chain.length + 1 + height > TREE_MAX_DEPTH) {
    throw badRequest(`Pages can be nested at most ${TREE_MAX_DEPTH} levels deep`)
  }

  // Edit lock: nothing may be created under, or moved into, a page the actor cannot edit; a move
  // also needs the whole moved subtree (docs/adr/0970-*).
  const actor = actorFor(opts.userId, opts.role)
  await assertCan(tx, opts.parentId, actor)
  if (opts.movingId) await assertCan(tx, opts.movingId, actor, { subtree: true })

  // A new row in a collection is an edit of that collection's content (like typing into a public
  // page), not a new page published under a folder — members keep adding rows to public databases.
  const newRow = !opts.movingId && parent.kind === 'collection'
  if (!isManagerRole(opts.role) && opts.publicRule !== false && !newRow) {
    const target = publicAncestors(chain)
    if (target.size > 0) {
      // A move inside the same public folder exposes nothing new; anything else does.
      let already = new Set<string>()
      if (opts.movingId) {
        const own = await ancestorChain(tx, opts.movingId)
        already = publicAncestors(own.slice(1))
      }
      if ([...target].some((id) => !already.has(id))) {
        throw forbidden(
          'Only workspace owners and admins can create or move pages under a folder that is published to the web',
        )
      }
    }
  }
  return chain
}

/** Postgres uuid[] literal for ids we generated or validated (uuid charset only). */
function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`
}

/**
 * Hard-deletes the soft-deleted subtrees rooted at `rootIds` and returns the ids of files that were
 * attached to them plus the number of pages removed (rows and blobs are the caller's to remove after commit). Must run inside the
 * tree lock of the workspace(s) involved.
 *
 * The walk only follows rows that are themselves in the trash (A-M10): a live page that ended up
 * under a trashed parent (e.g. created by a request that raced the delete before the tree lock
 * existed) is moved to the root first, because pages.parent_id is ON DELETE CASCADE and would
 * otherwise take it down with the parent.
 */
export async function purgeDeletedSubtrees(
  tx: Exec,
  rootIds: string[],
): Promise<{ fileIds: string[]; purged: number }> {
  if (rootIds.length === 0) return { fileIds: [], purged: 0 }
  const cte = sql`WITH RECURSIVE descendants AS (
      SELECT id, 0 AS depth FROM pages
       WHERE id = ANY(${uuidArray(rootIds)}::uuid[]) AND deleted_at IS NOT NULL
      UNION ALL
      SELECT p.id, d.depth + 1 FROM pages p JOIN descendants d ON p.parent_id = d.id
       WHERE d.depth < ${TREE_MAX_DEPTH} AND p.deleted_at IS NOT NULL
    )`
  await tx.execute(sql`
    ${cte}
    UPDATE pages SET parent_id = NULL, updated_at = now()
     WHERE parent_id IN (SELECT id FROM descendants) AND deleted_at IS NULL
  `)
  const attached = (await tx.execute(sql`
    ${cte}
    SELECT f.id FROM files f WHERE f.page_id IN (SELECT id FROM descendants)
  `)) as unknown as { id: string }[]
  const deleted = (await tx.execute(sql`
    ${cte}
    DELETE FROM pages WHERE id IN (SELECT id FROM descendants) RETURNING id
  `)) as unknown as { id: string }[]
  return { fileIds: attached.map((r) => r.id), purged: deleted.length }
}
