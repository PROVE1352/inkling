import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { NotesCheckDTO } from '../notesCheck'
import { NOTES_CHECK_DEFAULT_LIMIT, NOTES_CHECK_MAX_LIMIT } from '../notesCheck'
import { call, estimateTokens, idArg, text, wrap } from './core'
import type { ToolCtx } from './core'
import { inferWorkspace } from './idArgs'
import { shortId } from './shortIds'
import { cleanText, wrapUntrusted } from './trust'

/**
 * check_notes (docs/adr/2003-*): the memory check of a workspace or subtree as compact text. Calls
 * GET /api/workspaces/:id/notes-check as the token user, so membership, visibility, agent blocks,
 * the two-step requirement and the connection range are the route's. Titles and link texts are
 * member text: inside one <untrusted_content source="check"> block. The answer fits `budget`
 * tokens by showing the same number of items of every kind (fewer when it does not fit); the
 * totals are always given.
 */

export const CHECK_DEFAULT_BUDGET = 2_000
export const CHECK_MIN_BUDGET = 500
export const CHECK_MAX_BUDGET = 8_000

const one = (s: string) => cleanText(s || 'Untitled').replace(/\s+/g, ' ')
const q = (s: string) => `"${one(s)}"`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The kinds block (member text inside) with at most `n` items per kind. */
export function renderCheckKinds(r: NotesCheckDTO, n: number): string {
  const out: string[] = []
  const more = (shown: number, total: number) => (total > shown ? [`- … ${total - shown} more`] : [])

  out.push(r.broken.total ? `broken links: ${r.broken.total} in ${plural(r.broken.pages, 'page')}` : 'broken links: none')
  const b = r.broken.items.slice(0, n)
  for (const p of b) {
    const links = p.links.map((l) =>
      l.state === 'missing'
        ? `[[${one(l.text)}]] missing`
        : l.state === 'exists'
          ? `[[${one(l.text)}]] not linked, page ${shortId(l.targetId!)} has that name now`
          : l.state === 'noHeading'
            ? `[[${one(l.text)}]] heading not found in page ${shortId(l.targetId!)}`
            : `link to ${q(l.text)} ${shortId(l.targetId!)} trashed ${l.trashedOn}`,
    )
    out.push(`- ${shortId(p.pageId)} ${q(p.title)} (${p.count}): ${links.join('; ')}${p.count > p.links.length ? '; …' : ''}`)
  }
  out.push(...more(b.length, r.broken.pages))

  out.push(r.duplicates.total ? `duplicate titles: ${plural(r.duplicates.total, 'group')}` : 'duplicate titles: none')
  const d = r.duplicates.items.slice(0, n)
  for (const g of d) out.push(`- ${q(g.title)} ×${g.pageIds.length}: ${g.pageIds.map(shortId).join(', ')}`)
  out.push(...more(d.length, r.duplicates.total))

  out.push(r.unlinked.total ? `unlinked (no link in or out), oldest first: ${r.unlinked.total}` : 'unlinked: none')
  const u = r.unlinked.items.slice(0, n)
  for (const p of u) out.push(`- ${shortId(p.pageId)} ${q(p.title)} updated ${p.updatedOn}`)
  out.push(...more(u.length, r.unlinked.total))

  out.push(r.verification.total ? `verification: ${r.verification.total}` : 'verification: nothing lapsed or changed much')
  const v = r.verification.items.slice(0, n)
  for (const x of v) {
    out.push(
      x.state === 'lapsed'
        ? `- ${shortId(x.pageId)} ${q(x.title)} lapsed ${x.until}${x.changedSections ? `, ${plural(x.changedSections, 'section')} changed since` : ''}`
        : `- ${shortId(x.pageId)} ${q(x.title)} verified until ${x.until}, ${plural(x.changedSections, 'section')} changed since`,
    )
  }
  out.push(...more(v.length, r.verification.total))

  const ql = r.quietLarge
  out.push(
    ql.total
      ? `large and quiet (≥ ${ql.minTokens.toLocaleString('en-US')} tok, unchanged since before ${ql.before}): ${ql.total}`
      : `large and quiet (≥ ${ql.minTokens.toLocaleString('en-US')} tok, unchanged since before ${ql.before}): none`,
  )
  const l = ql.items.slice(0, n)
  for (const p of l) out.push(`- ${shortId(p.pageId)} ${q(p.title)} ~${p.tokens.toLocaleString('en-US')} tok, updated ${p.updatedOn}`)
  out.push(...more(l.length, ql.total))
  return out.join('\n')
}

export function renderCheck(r: NotesCheckDTO, limit: number, budget: number): string {
  const head =
    `Notes check: workspace ${shortId(r.workspaceId)}${r.rootId ? `, page ${shortId(r.rootId)} and the pages under it` : ''}, ` +
    `${plural(r.checked, 'page')} you can see (collection rows not counted). Read-only; nothing was changed.`
  const foot =
    'Fix with patch_section / update_page (or suggest=true), rename_page, move_page; trash_page only with the person\'s OK. ' +
    'Verifying is for people (web app): ask the page owner.'
  let n = limit
  for (;;) {
    const body = `${head}\n${wrapUntrusted(renderCheckKinds(r, n), { source: 'check' })}\n${n < limit ? `Shown: ${n} per kind to fit the budget; raise budget for more.\n` : ''}${foot}`
    if (n === 0 || estimateTokens(body) <= budget) return body
    n--
  }
}

export function registerNotesCheckTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'check_notes',
    {
      title: 'Check notes',
      description:
        'Memory check of a workspace or a subtree, read-only: broken [[links]], duplicate titles, pages with no links in or ' +
        'out, lapsed or much-changed verifications, large pages unchanged for 180 days. Totals per kind, top items first, ' +
        '8-character ids. Material for tidying; it changes nothing.',
      inputSchema: {
        workspaceId: idArg('workspace').optional().describe("Default: parentId's workspace, or your only one"),
        parentId: idArg('page').optional().describe('Only this page and the pages under it'),
        limit: z.number().int().min(1).max(NOTES_CHECK_MAX_LIMIT).optional().describe(`Items per kind (default ${NOTES_CHECK_DEFAULT_LIMIT})`),
        budget: z.number().int().min(CHECK_MIN_BUDGET).max(CHECK_MAX_BUDGET).optional().describe(`Max tokens (default ${CHECK_DEFAULT_BUDGET})`),
      },
    },
    wrap(async ({ workspaceId: wsRef, parentId, limit, budget }) => {
      const workspaceId = await inferWorkspace(ctx, wsRef, parentId) // docs/adr/1943-*
      const query: Record<string, string> = {}
      if (parentId) query.parentId = parentId
      const lim = limit ?? NOTES_CHECK_DEFAULT_LIMIT
      query.limit = String(lim)
      const res = await call(ctx, 'GET', `/api/workspaces/${workspaceId}/notes-check`, { query })
      return text(renderCheck(res.json() as NotesCheckDTO, lim, budget ?? CHECK_DEFAULT_BUDGET))
    }),
  )
}
