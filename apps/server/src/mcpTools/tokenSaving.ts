import { countReads } from '../pageReads'
import { flaggedRules, largeLine, loadAgentContext, pageFacts, withApplies } from './agentContext'
import { suspiciousNote } from '../context/injectionScan'
import { call, text } from './core'
import type { CallToolResult, ToolCtx } from './core'
import type { AgentContextDTO } from '../routes/editLock'
import { resolvePageRef, resolvePageRefs } from './shortIds'
import { cleanText, wrapUntrusted } from './trust'

/**
 * Token saving for repeated reads (docs/adr/1540-*): the `known` argument of read_page/read_pages
 * and read_page(knownSections). Kept out of mcp.ts/contextTools.ts so those tools only gain a
 * parameter and a one-line branch.
 *
 * Rules:
 * - "unchanged" is answered only after the normal permission-checked read (the REST route), so a
 *   page that was trashed, made private or moved out of the connection range is the usual error,
 *   never "unchanged".
 * - The unchanged line always carries the `can:` facts, so a permission change shows even when the
 *   content did not change. The applies: line (instructions) stays in front as everywhere.
 */

/** `unchanged (page <id>[ §anchor] v=<v>; can: …)` with the applies line in front when instructions apply. */
export function unchangedText(ac: AgentContextDTO, pageId: string, version: string, anchor?: string): CallToolResult {
  return text(withApplies(ac, `unchanged (page ${pageId}${anchor ? ` §${anchor}` : ''} v=${version}; can: ${pageFacts(ac, pageId).can})`))
}

/** read_pages arguments: short ids resolved; `known` (keys may be short ids too) as the route's "id:v,…". */
export async function readPagesArgs(
  ctx: ToolCtx,
  pageIds: string[],
  known: Record<string, string> | undefined,
): Promise<{ ids: string[]; knownQuery: string | null }> {
  const ids = await resolvePageRefs(ctx, pageIds)
  if (!known || !Object.keys(known).length) return { ids, knownQuery: null }
  const wanted = new Set(ids)
  const pairs: string[] = []
  for (const [k, v] of Object.entries(known)) {
    if (!/^[0-9a-f]{1,64}$/i.test(v)) continue
    let id: string
    try {
      id = await resolvePageRef(ctx, k)
    } catch {
      continue // a stale key only means "read it in full"
    }
    if (wanted.has(id)) pairs.push(`${id}:${v.toLowerCase()}`)
  }
  return { ids, knownQuery: pairs.length ? pairs.sort().join(',') : null }
}

interface OutlineResponse {
  page: { id: string; title: string; kind: string; updatedAt?: string }
  sections: { anchor: string; headingPath: string; tokens: number; version: string }[]
  tokens: number
}

interface SectionResponse {
  page: { id: string; title: string }
  section: { anchor: string; headingPath: string; version: string }
  markdown: string
  truncated: boolean
  totalChars: number
}

/**
 * read_page(pageId, knownSections={anchor: v}): only the sections whose version differs from the
 * caller's (changed or new) in full, a count of the unchanged ones and the anchors that are gone.
 * Returns null for pages without sections (the caller reads the page in full instead).
 */
export async function readChangedSections(
  ctx: ToolCtx,
  pageId: string,
  knownSections: Record<string, string>,
  maxChars: number | undefined,
): Promise<CallToolResult | null> {
  const outline = (await call(ctx, 'GET', `/api/pages/${pageId}/outline`)).json() as OutlineResponse
  if (outline.page.kind !== 'doc') return null
  const known = new Map(Object.entries(knownSections).map(([k, v]) => [k.replace(/^§/, ''), v]))
  const current = new Set(outline.sections.map((s) => s.anchor))
  const changed = outline.sections.filter((s) => known.get(s.anchor) !== s.version)
  const unchangedCount = outline.sections.length - changed.length
  const removed = [...known.keys()].filter((a) => !current.has(a)).sort()
  const bodies: SectionResponse[] = []
  for (const s of changed) {
    bodies.push(
      (
        await call(ctx, 'GET', `/api/pages/${pageId}/section`, {
          query: { ref: s.anchor, ...(maxChars ? { maxChars: String(maxChars) } : {}) },
        })
      ).json() as SectionResponse,
    )
  }
  if (bodies.length) countReads([pageId])
  const ac = await loadAgentContext(ctx, [pageId], { read: true })
  const f = pageFacts(ac, pageId)
  const large = largeLine(ac, pageId)
  const head = [
    `# ${cleanText(outline.page.title || 'Untitled')}`,
    `(page ${pageId}; ${changed.length} changed or new, ${unchangedCount} unchanged, ${removed.length} removed of your ${known.size} known sections)`,
    `can: ${f.can}`,
    ...(large ? [large] : []),
    ...(removed.length ? [`removed: ${removed.map((a) => `§${cleanText(a)}`).join(', ')}`] : []),
  ]
  if (!bodies.length) return text(withApplies(ac, head.join('\n')))
  const data: string[] = []
  for (const b of bodies) {
    const flag = suspiciousNote(flaggedRules(ac, pageId, [b.section.anchor]))
    if (data.length) data.push('')
    data.push(
      `§${b.section.anchor} v=${b.section.version}${b.section.headingPath ? ` › ${b.section.headingPath}` : ''}${flag ? `  ${flag}` : ''}`,
      b.markdown + (b.truncated ? `\n[truncated: ${maxChars} of ${b.totalChars} chars]` : ''),
    )
  }
  return text(
    withApplies(ac, `${head.join('\n')}\n\n${wrapUntrusted(data.join('\n'), { source: 'page', id: pageId, createdBy: f.createdBy, lastEdit: f.lastEdit })}`),
  )
}
