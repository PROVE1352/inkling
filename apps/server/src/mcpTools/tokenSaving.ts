import { countReads } from '../pageReads'
import { flaggedRules, largeLine, loadAgentContext, pageFacts, withApplies } from './agentContext'
import { suspiciousNote } from '../context/injectionScan'
import { call, text } from './core'
import type { CallToolResult, ToolCtx } from './core'
import type { AgentContextDTO } from '../routes/editLock'
import { resolvePageRef, resolvePageRefs, shortId } from './shortIds'
import { shortAnchors, splitSections } from '../context/chunker'
import { matchRenamedKnown, renameHints } from '../context/renamedKnown'
import type { KnownRename } from '../context/renamedKnown'
import { currentBlocks } from '../context/sectionSource'
import { cleanText, wrapUntrusted } from './trust'
import { versionArg } from '../versionArg'

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

/**
 * `unchanged (page <id8>[ outline][ §anchor] v=<v>; can: …)` with the applies line in front when
 * instructions apply. The page id is the 8-character form (docs/adr/1942-*).
 */
export function unchangedText(
  ac: AgentContextDTO,
  pageId: string,
  version: string,
  anchor?: string,
  claims?: string | null,
  what?: 'outline',
): CallToolResult {
  // A live claim is not part of the version: it is said after the stable line (docs/adr/1654-*).
  const tail = claims ? `\n${claims}` : ''
  return text(
    withApplies(ac, `unchanged (page ${shortId(pageId)}${what ? ` ${what}` : ''}${anchor ? ` §${anchor}` : ''} v=${version}; can: ${pageFacts(ac, pageId).can})${tail}`),
  )
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
  for (const [k, raw] of Object.entries(known)) {
    const v = versionArg(raw) // `v=…` as printed (0.24.1)
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
 * Known anchors that are gone whose section lives on under a new anchor with the same body
 * (docs/adr/2597-*). Runs after the permission-checked outline read; only sections the outline
 * lists as changed, at the version the outline printed, are candidates (an edit landing in between
 * is read in full).
 */
async function provenRenames(
  pageId: string,
  gone: [string, string][],
  changed: { anchor: string; version: string }[],
  current: string[],
): Promise<KnownRename[]> {
  const listed = new Map(changed.map((s) => [s.anchor, s.version]))
  const sections = splitSections(await currentBlocks(pageId)).filter((s) => listed.get(s.anchor) === s.version)
  if (!sections.length) return []
  return matchRenamedKnown(gone, sections, await renameHints(pageId, gone.map(([a]) => a), current))
}

/**
 * read_page(pageId, knownSections={anchor: v}): only the sections whose version differs from the
 * caller's (changed or new) in full, a count of the unchanged ones, `§old → §new v=…` lines for
 * sections renamed with the body unchanged (docs/adr/2597-*) and the anchors that are gone.
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
  // Keys may be find_context's short anchors (docs/adr/1212-*): mapped to the full anchor they stand
  // for now (read only: at worst a section comes back that the caller already had); a key that is
  // neither stays as given and is reported removed.
  const shorts = shortAnchors(outline.sections.map((s) => s.anchor))
  const fullOf = new Map<string, string>()
  for (const [full, short] of shorts) {
    fullOf.set(full, full)
    if (!fullOf.has(short)) fullOf.set(short, full)
  }
  const known = new Map<string, string>()
  const given = new Map<string, string>() // full anchor → the key the caller used
  for (const [k, v] of Object.entries(knownSections)) {
    const key = k.replace(/^§/, '')
    const full = fullOf.get(key) ?? key
    known.set(full, v)
    given.set(full, key)
  }
  const current = new Set(outline.sections.map((s) => s.anchor))
  let changed = outline.sections.filter((s) => known.get(s.anchor) !== s.version)
  const unchangedCount = outline.sections.length - changed.length
  const gone = [...known.entries()].filter(([a]) => !current.has(a))
  // Renamed with the body unchanged (docs/adr/2597-*): proven by the version, re-keyed, not re-sent.
  const renames = gone.length && changed.length ? await provenRenames(pageId, gone, changed, outline.sections.map((s) => s.anchor)) : []
  const renamedTo = new Set(renames.map((r) => r.to))
  const renamedFrom = new Set(renames.map((r) => r.from))
  changed = changed.filter((s) => !renamedTo.has(s.anchor))
  const removed = gone
    .map(([a]) => a)
    .filter((a) => !renamedFrom.has(a))
    .map((a) => given.get(a) ?? a)
    .sort()
  const order = new Map(outline.sections.map((s, i) => [s.anchor, i]))
  const renameLines = [...renames]
    .sort((x, y) => order.get(x.to)! - order.get(y.to)!)
    .map((r) => `§${cleanText(given.get(r.from) ?? r.from)} → §${cleanText(r.to)} v=${r.version} (renamed, body unchanged)`)
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
    `(page ${shortId(pageId)}; ${changed.length} changed or new, ${unchangedCount} unchanged, ` +
      `${renames.length ? `${renames.length} renamed (body unchanged), ` : ''}${removed.length} removed of your ${known.size} known sections)`,
    `can: ${f.can}`,
    ...(large ? [large] : []),
    ...renameLines,
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
    withApplies(ac, `${head.join('\n')}\n\n${wrapUntrusted(data.join('\n'), { source: 'page', id: shortId(pageId), createdBy: f.createdBy, lastEdit: f.lastEdit })}`),
  )
}
