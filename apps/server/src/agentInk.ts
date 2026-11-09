import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from './db/index'
import { pageInk, pages, workspaces } from './db/schema'
import { AppError } from './errors'

/**
 * "Agents can read handwriting" (docs/adr/1510-*): a workspace setting, off by default. While it is
 * off, MCP connections get nothing of the ink layer: GET /pages/:id/ink refuses agent requests
 * (read_ink is its only agent caller) and page headers do not mention ink. People in the app and
 * personal API tokens (not agent connections, docs/adr/1201-*) are not affected.
 */

export const AGENT_INK_OFF_CODE = 'AGENT_INK_OFF'
export const AGENT_INK_OFF_MESSAGE =
  'Agents cannot read handwriting in this workspace. An owner or admin can turn on ' +
  '"Agents can read handwriting" in Workspace settings › Connected agents'

export function agentInkOff(): AppError {
  return new AppError(403, AGENT_INK_OFF_CODE, AGENT_INK_OFF_MESSAGE)
}

export async function agentInkAllowed(workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: workspaces.agentInkRead })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return row?.on === true
}

/**
 * Stroke counts of pages that have ink, for the one-line ink marker in page headers. Only pages
 * of workspaces where agents may read ink are returned. Callers pass ids that already passed the
 * page's permission check (this does not check visibility).
 */
export async function inkStrokeCounts(pageIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (pageIds.length === 0) return out
  const rows = await db
    .select({ pageId: pageInk.pageId, n: sql<number>`jsonb_array_length(${pageInk.strokes})::int` })
    .from(pageInk)
    .innerJoin(pages, eq(pages.id, pageInk.pageId))
    .innerJoin(workspaces, eq(workspaces.id, pages.workspaceId))
    .where(and(inArray(pageInk.pageId, [...new Set(pageIds)]), eq(workspaces.agentInkRead, true)))
  for (const r of rows) if (r.n > 0) out.set(r.pageId, r.n)
  return out
}

/** The header marker: handwriting exists, here is how to see it. */
export function inkMarker(strokes: number): string {
  return `ink: ${strokes} stroke${strokes === 1 ? '' : 's'} (read_ink to view)`
}
