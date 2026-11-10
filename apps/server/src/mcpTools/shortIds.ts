import { and, asc, between, inArray, isNull } from 'drizzle-orm'
import { idArg } from './idSchema'
import { db } from '../db/index'
import { pages } from '../db/schema'
import { memberWorkspaceIds } from '../context/retrieve'
import { visibleTo } from '../pageDto'
import { liveWorkspace } from '../workspaceLive'
import { runAsConnection } from './agentContext'
import { ToolError } from './core'
import type { ToolCtx } from './core'
import { cleanText } from './trust'

/**
 * Short page ids in tool arguments (docs/adr/1541-*). list_pages/search with format 'compact' print
 * the first 8 hex characters of a page id; the tools that take this schema accept such a prefix (or
 * any longer one, or the full id) and resolve it here among the pages this connection can see:
 * member workspaces (agent blocks and the connection range applied), live, visible. One match → its
 * full id; none → not-found error; several → an error listing the candidates.
 *
 * The lookup is a primary-key range scan (id BETWEEN prefix000… AND prefixfff…), not a text LIKE.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AMBIGUOUS_SHOWN = 5

/** Page id argument: a full id or a prefix of at least 8 hex characters (docs/adr/1940-*: no pattern in the tool list). */
export const pageRef = () => idArg('page')

/** The 8-character form tools print (docs/adr/1541-*, 1942-*). */
export const shortId = (id: string) => id.slice(0, 8)

const asUuid = (hex32: string) =>
  `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`

/** Lookup statistics for the bench and tests. */
export const shortIdStats = { lookups: 0 }

export async function resolvePageRef(ctx: ToolCtx, ref: string): Promise<string> {
  const lower = ref.trim().toLowerCase()
  if (UUID_RE.test(lower)) return lower
  const hex = lower.replace(/-/g, '')
  if (!/^[0-9a-f]{8,32}$/.test(hex)) {
    throw new ToolError(`"${cleanText(ref)}" is not a page id; pass the full id or the 8-character prefix list_pages/search print`)
  }
  shortIdStats.lookups++
  const lo = asUuid(hex.padEnd(32, '0'))
  const hi = asUuid(hex.padEnd(32, 'f'))
  const rows = await runAsConnection(ctx, async () => {
    const ws = await memberWorkspaceIds(ctx.user.id)
    if (!ws.length) return []
    return db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(
        and(
          between(pages.id, lo, hi),
          isNull(pages.deletedAt),
          visibleTo(ctx.user.id),
          inArray(pages.workspaceId, ws),
          liveWorkspace(pages.workspaceId),
        ),
      )
      .orderBy(asc(pages.id))
      .limit(AMBIGUOUS_SHOWN + 1)
  })
  if (rows.length === 1) return rows[0].id
  if (rows.length === 0) {
    throw new ToolError(`no page you can see has an id starting with "${hex}"; use list_pages or find_context to get a valid id`)
  }
  const shown = rows.slice(0, AMBIGUOUS_SHOWN).map((r) => `${r.id} "${cleanText(r.title || 'Untitled').replace(/\s+/g, ' ')}"`)
  throw new ToolError(
    `"${hex}" matches ${rows.length > AMBIGUOUS_SHOWN ? `more than ${AMBIGUOUS_SHOWN}` : rows.length} pages: ${shown.join(', ')}. ` +
      'Pass a longer prefix or the full id.',
  )
}

export async function resolvePageRefs(ctx: ToolCtx, refs: string[]): Promise<string[]> {
  const out: string[] = []
  for (const r of refs) out.push(await resolvePageRef(ctx, r))
  return out
}
