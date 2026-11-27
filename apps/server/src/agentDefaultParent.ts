import { and, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { PageScope } from '@inkling/shared'
import { db } from './db/index'
import { pages, workspaces } from './db/schema'
import { AppError } from './errors'
import { assertPageEditable } from './editLock'
import { findVisiblePage } from './pageDto'

/**
 * Where agents' new pages go when they name no parent (docs/adr/2592-*).
 *
 * A workspace may name one shared page as the place for pages that a token (an MCP connection or a
 * personal API token) creates at the top level of the shared section without naming a parent. It is a
 * default only: a parent the caller names, an explicit top level (`parentId: null` in JSON, `parentId=root`
 * in a query), a private page and every browser request are left alone.
 *
 * The page is used only when this caller could have named it themselves: it is live and visible to them
 * (membership, connection range, agent blocks), neither it nor a page above it is an agent instruction
 * page, and they may edit it (edit lock, page levels, agent lock rules, suggest-only). Otherwise the page is
 * created at the top level as before, and nothing in the answer mentions the setting, so a connection that
 * cannot see the page learns neither its title nor that it exists.
 */

export interface DefaultParent {
  id: string
  title: string
}

/** The request is a token's (MCP connection or personal API token), not a person in the browser or a database automation. */
export function isTokenRequest(req: FastifyRequest): boolean {
  return req.authVia === 'bearer' && !!req.user && !req.user.automation
}

/** The page, its parent or anything above it is an agent instruction page. */
export async function underInstructionPage(exec: Pick<typeof db, 'execute'>, pageId: string): Promise<boolean> {
  const rows = (await exec.execute(sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS depth FROM pages WHERE id = ${pageId}
      UNION ALL
      SELECT p.id, p.parent_id, up.depth + 1 FROM pages p JOIN up ON p.id = up.parent_id WHERE up.depth < 64
    )
    SELECT EXISTS (SELECT 1 FROM agent_instructions ai JOIN up ON ai.page_id = up.id) AS "hit"
  `)) as unknown as { hit: boolean }[]
  return !!rows[0]?.hit
}

/** The stored setting, null when unset or when the page is in the trash. */
export async function storedDefaultParent(exec: Pick<typeof db, 'select'>, workspaceId: string): Promise<DefaultParent | null> {
  const [row] = await exec
    .select({ id: pages.id, title: pages.title })
    .from(workspaces)
    .innerJoin(pages, and(eq(pages.id, workspaces.agentDefaultParentId), isNull(pages.deletedAt)))
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return row ?? null
}

/**
 * The page a token's new top-level page goes under, or null for the top level (see above). `explicitTop`:
 * the caller asked for the top level on purpose. `scope`: the section the page would be created in.
 */
export async function agentDefaultParent(
  req: FastifyRequest,
  workspaceId: string,
  opts: { explicitTop: boolean; scope: PageScope },
): Promise<DefaultParent | null> {
  if (!isTokenRequest(req) || opts.explicitTop || opts.scope !== 'shared') return null
  const userId = req.user!.id
  const stored = await storedDefaultParent(db, workspaceId)
  if (!stored) return null
  // visible to this caller: membership, connection range, agent block, live page and workspace
  const page = await findVisiblePage(stored.id, userId)
  if (!page || page.workspaceId !== workspaceId || page.scope !== 'shared' || page.kind === 'collection') return null
  if (await underInstructionPage(db, page.id)) return null
  try {
    await assertPageEditable(page.id, userId)
  } catch (err) {
    if (err instanceof AppError) return null
    throw err
  }
  return { id: page.id, title: page.title }
}
