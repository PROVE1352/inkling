import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FindContextResult } from '../context/retrieve'
import { DEFAULT_BUDGET, MAX_BUDGET } from '../context/retrieve'
import { isMultiResult, MAX_QUERIES } from '../context/multiQuery'
import { normalizeContextQuery } from '../context/contextCache'
import { reviewFactsFor } from '../review'
import { countReads } from '../pageReads'
import type { ReviewFacts } from '../review'
import { call, idArg, text, ToolError, uuid, wrap, wrapWrite } from './core'
import type { ToolCtx } from './core'
import type { AgentContextDTO } from '../routes/editLock'
import { flaggedRules, largeLine, loadAgentContext, pageFacts, pageSuspiciousLine, withApplies } from './agentContext'
import { LARGE_PAGE_HINT } from '../context/largePage'
import { groupSpans, queryGroups, searchText } from '../context/rank'
import { suspiciousNote } from '../context/injectionScan'
import { cleanText, wrapUntrusted } from './trust'
import { inkMarker, inkStrokeCounts } from '../agentInk'
import type { SuggestionDTO } from '@inkling/shared'
import { suggestionMadeText } from './collabTools'
import { pageRef } from './shortIds'
import { readPagesArgs } from './tokenSaving'
import { verificationFactsFor, verificationNote } from '../verification'
import type { VerificationFacts } from '../verification'
import { mentionStatusLineForPage } from '../memberStatus'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { pages, workspaces } from '../db/schema'
import { archivedNote } from '../workspaceListing'

/**
 * Agent retrieval tools (docs/adr/0927-0930): find_context, read_pages, patch_section.
 * Output is compact text: one header line per fragment with the ids an agent needs for a follow-up
 * (pageId, §anchor, version), then the text. No JSON envelopes, no repeated field names.
 */

/**
 * Short review note for a fragment header (docs/adr/0951-*, 0953-*):
 * "owner Alice, reviewed 2026-10-01, stale p=0.62". Stale and p come from the daily priority batch
 * (rounded), dates are the document's own values, never relative ("N days ago").
 */
export function reviewNote(f: ReviewFacts | undefined): string {
  if (!f) return ''
  const parts: string[] = []
  if (f.owner) parts.push(`owner ${f.owner}`)
  if (f.reviewedOn) parts.push(`reviewed ${f.reviewedOn}`)
  if (f.living) parts.push('living document')
  else if (f.stale && f.p !== null) parts.push(`stale p=${f.p.toFixed(2)}`)
  return parts.length ? `; ${parts.join(', ')}` : ''
}

/**
 * Printed page ids (docs/adr/1906-*): the 8-character prefix every page-id argument accepts; ids that
 * share it within one answer get longer prefixes (cut at the UUID's dashes) until they differ.
 */
export function printedIds(ids: Iterable<string>): Map<string, string> {
  const all = [...new Set(ids)]
  const out = new Map<string, string>()
  for (const id of all) {
    let n = 8
    for (const len of [8, 13, 18, 23, 36]) {
      n = len
      const p = id.slice(0, len)
      if (!all.some((o) => o !== id && o.startsWith(p))) break
    }
    out.set(id, id.slice(0, n))
  }
  return out
}

/**
 * Query words that none of the shown sections contains (title, heading path or text, URLs not
 * counted), in query order. Used for the "other language?" hint (docs/adr/1904-*).
 */
export function wordsInNoResult(query: string, r: Pick<FindContextResult, 'fragments'>): string[] {
  const groups = queryGroups(query)
  const hay = r.fragments
    .map((f) => `${f.title}\n${f.sections.map((s) => s.headingPath).join('\n')}\n${searchText(f.text)}`)
    .join('\n')
    .toLowerCase()
  return groups.filter((g) => groupSpans(hay, g).length === 0).map((g) => g.word)
}

/**
 * One line at the end when a single query's answer is weak: more than half of its words, and at least
 * two, are in no result (half was too eager: a two-word query with one alias or one common word missing
 * fired; a one-word query that matched only an alias, "PayFix", would always fire).
 */
export function otherLanguageHint(query: string, r: Pick<FindContextResult, 'fragments'>): string | null {
  const groups = queryGroups(query)
  const missing = wordsInNoResult(query, r)
  if (missing.length < 2 || missing.length * 2 <= groups.length) return null
  return `Not in any result: ${missing.join(', ')}. If the notes may be in another language, ask again with queries=[${JSON.stringify(query)}, "<translation>"].`
}

/** The workspace of a printed page: its id and (member-written) name. */
export interface PageWorkspace {
  id: string
  name: string
}

/** Longest workspace name printed in a result line (cut with "…"). */
const WS_NAME_MAX = 40

/**
 * Workspace labels for one answer (docs/adr/2185-*): only when the printed pages (fragments,
 * pointers, title matches) come from two or more workspaces, else null and the output is exactly
 * the one-workspace output. `{Name}` goes on the member-text lines (inside the data block); the
 * closing line names the workspaces by id only, in order of first appearance.
 */
export function workspaceLabels(
  r: Pick<FindContextResult, 'fragments' | 'more' | 'titleOnly'>,
  wsOf?: Map<string, PageWorkspace>,
): { label: (pageId: string) => string; line: string } | null {
  const of = (pageId: string, fallback?: string): PageWorkspace | null => {
    const w = wsOf?.get(pageId)
    return w ?? (fallback ? { id: fallback, name: '' } : null)
  }
  const fragNo = new Map<string, number[]>()
  const order: PageWorkspace[] = []
  const note = (w: PageWorkspace | null): string | null => {
    if (!w) return null
    if (!order.some((o) => o.id === w.id)) order.push(w)
    return w.id
  }
  r.fragments.forEach((f, i) => {
    const id = note(of(f.pageId, f.workspaceId))
    if (id) fragNo.set(id, [...(fragNo.get(id) ?? []), i + 1])
  })
  for (const p of [...r.more, ...r.titleOnly]) note(of(p.pageId))
  if (order.length < 2) return null
  const ids = printedIds(order.map((w) => w.id))
  const byId = new Map(order.map((w) => [w.id, w]))
  const label = (pageId: string): string => {
    const f = r.fragments.find((x) => x.pageId === pageId)
    const w = of(pageId, f?.workspaceId)
    if (!w) return ''
    const w0 = byId.get(w.id) ?? w
    const name = cleanText(w0.name).replace(/\s+/g, ' ').replace(/[{}]/g, '').trim()
    const short = [...name].length > WS_NAME_MAX ? `${[...name].slice(0, WS_NAME_MAX - 1).join('')}…` : name
    return `{${short || ids.get(w.id)}} `
  }
  const parts = order.map((w) => {
    const nos = fragNo.get(w.id)
    return `${ids.get(w.id)} ${nos ? nos.map((n) => `[${n}]`).join('') : '(Also relevant only)'}`
  })
  const line =
    `Results come from ${order.length} workspaces ({name} on each line): ${parts.join(', ')}. ` +
    'To search one, pass workspaceId=<its id> (its name works too).'
  return { label, line }
}

/**
 * Render find_context results (exported for the evaluation, which measures exactly this text).
 * Everything members wrote (titles, headings, section text) sits inside one <untrusted_content>
 * block (docs/adr/0976-*); each fragment line says what this agent may do (`can:`) and who last
 * edited the page. `ac` is optional so the offline evaluation can render without it. `wsOf` (page id
 * → workspace) names the workspaces when an answer spans several (docs/adr/2185-*); without it the
 * fragments' own workspace ids are used and the labels print short ids.
 */
export function renderFindContext(
  query: string,
  r: FindContextResult,
  review?: Map<string, ReviewFacts>,
  ac?: AgentContextDTO,
  ink?: Map<string, number>,
  verifications?: Map<string, VerificationFacts>,
  wsOf?: Map<string, PageWorkspace>,
): string {
  const wrapData = (lines: string[]) => wrapUntrusted(lines.join('\n'), { source: 'find_context' })
  // Two or more workspaces: `{Name} ` before each title and one closing line (docs/adr/2185-*); else ''.
  const spans = workspaceLabels(r, wsOf)
  const ws = (pageId: string) => (spans ? spans.label(pageId) : '')
  // Several queries (docs/adr/1720-*): one header naming them by number, `matched:` per fragment.
  // A merged result of ONE query (semantic search on, docs/adr/1723-*) keeps the single-query header
  // and no `matched:`; only its pointer lines use the merged form (`fused`).
  const fused = isMultiResult(r) ? r : null
  const multi = fused && fused.queries.length > 1 ? fused : null
  const queryList = multi ? multi.queries.map((q, i) => `${i + 1} "${q}"`).join(', ') : ''
  // 8-character page ids, longer only where two printed ids share a prefix (docs/adr/1906-*)
  const ids = printedIds([...r.fragments.map((f) => f.pageId), ...r.more.map((m) => m.pageId), ...r.titleOnly.map((t) => t.pageId)])
  const idOf = (id: string) => ids.get(id) ?? id
  if (r.fragments.length === 0) {
    const lines = [
      multi
        ? `No sections match any of ${multi.queries.length} queries (${queryList}). Try other or fewer words, or list_pages.`
        : `No sections match "${query}". Try other or fewer words (synonyms), queries=[${JSON.stringify(query)}, "<translation>"] if the notes may be in another language, or list_pages.`,
    ]
    if (r.titleOnly.length) {
      lines.push('Pages whose title matches (no text):')
      lines.push(wrapData(r.titleOnly.map((t) => `- ${ws(t.pageId)}${t.title || 'Untitled'} (page ${idOf(t.pageId)}, ${t.kind})`)))
    }
    if (spans) lines.push(spans.line)
    // archived workspaces left out of a search without workspaceId (docs/adr/2304-*)
    const left = archivedNote(r.archived)
    if (left) lines.push(left)
    return ac ? withApplies(ac, lines.join('\n')) : lines.join('\n')
  }
  // `can:` once in the header when two or more results all have the same (docs/adr/1906-*); with one
  // result the fragment line is as short
  const cans = ac ? [...new Set(r.fragments.map((f) => pageFacts(ac, f.pageId).can))] : []
  const sharedCan = cans.length === 1 && r.fragments.length > 1 ? cans[0] : null
  const head =
    (multi
      ? `${r.fragments.length} result(s) for ${multi.queries.length} queries (${queryList}), ~${r.usedTokens}/${r.budget} tokens`
      : `${r.fragments.length} result(s) for "${query}", ~${r.usedTokens}/${r.budget} tokens`) + (sharedCan ? `; can: ${sharedCan} (all results)` : '')
  const data: string[] = []
  // Location = last heading + short anchor (docs/adr/1212-*); the full path only where a short one
  // would be ambiguous on the page. Older result objects without short/heading print the full form.
  const shortOf = (s: { anchor: string; short?: string }) => s.short ?? s.anchor
  const fragmentNo = new Map<string, number>()
  r.fragments.forEach((f, i) => {
    if (!fragmentNo.has(f.pageId)) fragmentNo.set(f.pageId, i + 1)
    const heading = f.sections[0]?.heading ?? f.headingPath
    const path = heading ? ` › ${heading}` : ''
    const versions = f.sections.map((s) => `§${shortOf(s)} v=${s.version}`).join(', ')
    const facts = ac ? pageFacts(ac, f.pageId) : null
    const flag = ac ? suspiciousNote(flaggedRules(ac, f.pageId, f.sections.map((s) => s.anchor))) : ''
    const can = facts && !sharedCan ? `; can: ${facts.can}` : ''
    const who = facts ? `${can}${facts.lastEdit ? `; edited by ${facts.lastEdit}` : ''}${flag ? `; ${flag}` : ''}${facts.large ? '; large page' : ''}` : ''
    if (i > 0) data.push('')
    // handwriting marker (docs/adr/1512-*): only where agents may read ink
    const inkNote = ink?.get(f.pageId) ? `; ${inkMarker(ink.get(f.pageId)!)}` : ''
    const matched = multi ? `; matched: ${multi.fragments[i].matched.join(',')}` : ''
    // a cut section says how long the whole is (read_page(section=…) returns it), docs/adr/1902-*
    const cut = f.truncated ? `; truncated${f.fullTokens ? `, section ~${f.fullTokens} tok` : ''}` : ''
    data.push(`[${i + 1}] ${ws(f.pageId)}${f.title || 'Untitled'}${path}`, `(page ${idOf(f.pageId)}; ${versions}${cut}${matched}${who}${reviewNote(review?.get(f.pageId))}${inkNote})`, f.text)
  })
  if (r.more.length) {
    // One line per page; a page already shown is referred to by its result number.
    data.push('', 'Also relevant (not shown):')
    const byPage = new Map<string, typeof r.more>()
    for (const m of r.more) byPage.set(m.pageId, [...(byPage.get(m.pageId) ?? []), m])
    for (const [pageId, list] of byPage) {
      const where = fragmentNo.has(pageId) ? `page of [${fragmentNo.get(pageId)}]` : `${ws(pageId)}${list[0].title || 'Untitled'} (page ${idOf(pageId)})`
      // a pointer from an extra ranked list may name a whole page (no anchor) or have no size
      const one = (m: (typeof list)[number]) =>
        fused && !m.anchor ? 'whole page' : fused && !m.tokens ? `§${shortOf(m)}` : `§${shortOf(m)} ~${m.tokens} tok`
      data.push(`- ${where}: ${list.map(one).join(', ')}`)
    }
  }
  if (r.titleOnly.length) {
    data.push('', 'Title matches without text:')
    for (const t of r.titleOnly) data.push(`- ${ws(t.pageId)}${t.title || 'Untitled'} (page ${idOf(t.pageId)}, ${t.kind})`)
  }
  // the "best workspace first" rule changed this answer (docs/adr/2188-*; off unless the evaluation turns it on)
  const out = [head, wrapData(data), '', 'Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.']
  // One hint for all large pages shown (docs/adr/1043-*).
  if (ac && r.fragments.some((f) => pageFacts(ac, f.pageId).large)) out.push(`Pages marked "large page": ${LARGE_PAGE_HINT.replace(/^large page: /, '')}.`)
  // A weak answer to one lexical query: words no result contains, and the bundle to try (docs/adr/1904-*).
  // Not for a merged answer (several queries, or semantic search on: a section found by meaning shares
  // no word with the query by design).
  const hint = fused ? null : otherLanguageHint(query, r)
  if (hint) out.push(hint)
  // Several workspaces: which results are where, by id, and how to narrow (docs/adr/2185-*).
  if (spans) out.push(spans.line)
  // Archived workspaces left out of a search without workspaceId (docs/adr/2304-*): before the dated line.
  const left = archivedNote(r.archived)
  if (left) out.push(left)
  // Verified / stale marks (docs/adr/1842-*) are dated and flip with the clock: one line, last
  // (docs/adr/1907-*), so the fragments above stay byte-stable when a verification lapses.
  const marks = r.fragments.flatMap((f, i) => {
    const note = fragmentNo.get(f.pageId) === i + 1 ? verificationNote(verifications?.get(f.pageId)).replace(/^; /, '') : ''
    return note ? [`[${i + 1}] ${note}`] : []
  })
  if (marks.length) out.push(`Verification: ${marks.join('; ')}`)
  return ac ? withApplies(ac, out.join('\n')) : out.join('\n')
}

interface ReadPagesResponse {
  pages: { id: string; title: string; kind: string; updatedAt: string; markdown: string; truncated: boolean; version?: string }[]
  /** Pages the caller passed in `known` with the same version (docs/adr/1540-*). */
  unchanged?: { id: string; version: string }[]
  omitted: { id: string; title: string; reason: string }[]
  missing: string[]
  budget: number
  usedTokens: number
}

export function renderReadPages(r: ReadPagesResponse, ac?: AgentContextDTO): string {
  const out: string[] = []
  // Unchanged pages first: one line each, no body (docs/adr/1540-*). The can: line always shows, so a
  // permission change is never hidden behind "unchanged".
  for (const u of r.unchanged ?? []) out.push(`(page ${u.id} unchanged v=${u.version}${ac ? `; can: ${pageFacts(ac, u.id).can}` : ''})`)
  if (r.unchanged?.length) out.push('')
  for (const p of r.pages) {
    const facts = ac ? pageFacts(ac, p.id) : null
    out.push(
      `(page ${p.id}, ${p.kind}, updated ${p.updatedAt.slice(0, 10)}${p.version ? `, v=${p.version}` : ''}${p.truncated ? ', truncated' : ''}${facts ? `; can: ${facts.can}` : ''})`,
      ...(ac && pageSuspiciousLine(ac, p.id) ? [pageSuspiciousLine(ac, p.id)!] : []),
      wrapUntrusted(`# ${p.title || 'Untitled'}\n\n${p.markdown}`, {
        source: 'page',
        id: p.id,
        createdBy: facts?.createdBy ?? null,
        lastEdit: facts?.lastEdit ?? null,
      }),
      '',
    )
  }
  if (r.omitted.length) {
    out.push(`Not shown (budget ${r.budget} tokens used up): ${r.omitted.map((o) => `${o.title || 'Untitled'} (${o.id})`).join(', ')}. Read them in another call or by section.`)
  }
  if (r.missing.length) out.push(`Not found or not visible: ${r.missing.join(', ')} — use find_context to get valid ids.`)
  const textOut = out.join('\n').trim()
  return ac ? withApplies(ac, textOut) : textOut
}

/**
 * Workspace (id, name) of every page an answer prints, or undefined when it cannot span two
 * workspaces (all fragments in one, no pointer to another page). The page ids come from the
 * permission-checked REST answer, so their workspaces are the caller's.
 */
async function printedWorkspaces(r: FindContextResult): Promise<Map<string, PageWorkspace> | undefined> {
  const fragmentPages = new Set(r.fragments.map((f) => f.pageId))
  const others = [...r.more, ...r.titleOnly].map((p) => p.pageId).filter((id) => !fragmentPages.has(id))
  if (new Set(r.fragments.map((f) => f.workspaceId)).size < 2 && others.length === 0) return undefined
  const ids = [...new Set([...fragmentPages, ...others])]
  const rows = await db
    .select({ pageId: pages.id, id: workspaces.id, name: workspaces.name })
    .from(pages)
    .innerJoin(workspaces, eq(workspaces.id, pages.workspaceId))
    .where(inArray(pages.id, ids))
  return new Map(rows.map((x) => [x.pageId, { id: x.id, name: x.name }]))
}

export function registerContextTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'find_context',
    {
      title: 'Find context',
      description:
        'Start here. Searches all your notes (or one workspace) and returns the most relevant sections, ranked and packed ' +
        `into a token budget (default ${DEFAULT_BUDGET}, max ${MAX_BUDGET}; tokens are estimated). Each result has pageId, §anchor and ` +
        'version for read_page(section=…) or patch_section. Use specific words. ' +
        `Unsure of the wording, or notes may be in another language? Pass queries=[original, translation, …] (up to ${MAX_QUERIES}): one merged answer, one budget.`,
      inputSchema: {
        query: z.string().trim().min(1).max(300).optional().describe('What you are looking for (keywords or a question)'),
        queries: z
          .array(z.string().trim().min(1).max(300))
          .min(1)
          .max(MAX_QUERIES)
          .optional()
          .describe('Other phrasings searched together (merged, each section once; "matched: 1,3" = query numbers)'),
        workspaceId: idArg('workspace').optional().describe('Limit to one workspace, id or name (default: all of yours)'),
        budget: z.number().int().min(300).max(MAX_BUDGET).optional().describe(`Max tokens to return (default ${DEFAULT_BUDGET})`),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ query, queries, workspaceId, budget }) => {
      // query first, then queries; repeats (as retrieval sees them) once. One left: the single-query call.
      const seen = new Set<string>()
      const list = [...(query ? [query] : []), ...(queries ?? [])].filter((q) => {
        const n = normalizeContextQuery(q)
        return seen.has(n) ? false : (seen.add(n), true)
      })
      if (list.length === 0) throw new ToolError('query or queries is required')
      if (list.length > MAX_QUERIES) throw new ToolError(`at most ${MAX_QUERIES} different queries in all (query + queries)`)
      const res = await call(ctx, 'GET', '/api/context', {
        query: { q: list.length === 1 ? list[0] : list, ...(workspaceId ? { workspaceId } : {}), ...(budget ? { budget: String(budget) } : {}) },
      })
      const result = res.json() as FindContextResult
      // pageIds come from the permission-checked REST answer; this only adds owner/review facts.
      const shown = result.fragments.map((f) => f.pageId)
      const review = await reviewFactsFor(shown)
      countReads(shown) // read counters, page totals only (docs/adr/0953-*)
      const ac = await loadAgentContext(ctx, shown, { read: true })
      // Workspace names only when this answer may span several (no workspaceId), docs/adr/2185-*
      const wsOf = workspaceId ? undefined : await printedWorkspaces(result)
      return text(renderFindContext(list[0], result, review, ac, await inkStrokeCounts(shown), await verificationFactsFor(shown), wsOf))
    }),
  )

  server.registerTool(
    'read_pages',
    {
      title: 'Read pages',
      description:
        'Read several pages as Markdown in one call (up to 20 ids, in order) within a token budget (default 8000, max 30000). ' +
        'Pages that do not fit are listed so you can read them by section. Each page header has its version v=…; pass ' +
        'known={pageId: v} on a later call and pages that did not change come back as one "unchanged" line (no budget used).',
      inputSchema: {
        pageIds: z.array(pageRef()).min(1).max(20).describe('Page ids (full, or 8-character prefixes)'),
        budget: z.number().int().min(200).max(30_000).optional().describe('Max tokens (default 8000)'),
        known: z
          .record(z.string().max(36), z.string().trim().max(64))
          .optional()
          .describe('Versions you already have: pageId → v from an earlier read_page/read_pages'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ pageIds, budget, known }) => {
      // Short ids and known versions (docs/adr/1540-*, 1541-*): handled in tokenSaving.ts
      const { ids, knownQuery } = await readPagesArgs(ctx, pageIds, known)
      const res = await call(ctx, 'GET', '/api/pages/read', {
        query: { ids: ids.join(','), ...(budget ? { budget: String(budget) } : {}), ...(knownQuery ? { known: knownQuery } : {}) },
      })
      const read = res.json() as ReadPagesResponse
      countReads(read.pages.map((p) => p.id)) // read counters (docs/adr/0953-*)
      const shown = [...(read.unchanged ?? []).map((u) => u.id), ...read.pages.map((p) => p.id)]
      return text(renderReadPages(read, await loadAgentContext(ctx, shown, { read: true })))
    }),
  )

  server.registerTool(
    'patch_section',
    {
      title: 'Patch section',
      description:
        "Edit one section of a document page, leaving the rest untouched (live editors keep their work). section = §anchor from " +
        "find_context/read_page(outline). mode: replace (body; a leading heading in markdown also renames it), append (end of the " +
        "section), prepend (after its heading), insert_after (new content after the section, e.g. a new '## Heading'), delete. " +
        'baseVersion (the v=… you read) is required for replace/delete; if the section changed you get a conflict with its current ' +
        'text and version — merge and retry. Preferred over update_page. suggest=true leaves the change as a suggestion that a ' +
        'person accepts or rejects (also what happens on pages locked to "agents: suggestions only").',
      inputSchema: {
        pageId: uuid().describe('Page id (kind=doc)'),
        section: z.string().trim().min(1).max(500).describe('Section anchor (e.g. "setup/backups"), heading text or heading block id'),
        markdown: z.string().max(1_000_000).optional().describe('Markdown to write (not needed for delete)'),
        mode: z.enum(['replace', 'append', 'prepend', 'insert_after', 'delete']).describe('How to apply the markdown'),
        baseVersion: z.string().trim().max(64).optional().describe('Section version you based the edit on (v=…)'),
        suggest: z.boolean().optional().describe('true: do not write; leave it as a suggestion for a person (docs/adr/1531-*)'),
      },
      annotations: { destructiveHint: true },
    },
    wrapWrite(ctx, async ({ pageId, section, markdown, mode, baseVersion, suggest }) => {
      if ((mode === 'replace' || mode === 'delete') && !baseVersion) {
        throw new ToolError(
          `baseVersion is required for mode=${mode}; get it from read_page(pageId, outline=true) or find_context (v=…)`,
        )
      }
      if (mode !== 'delete' && !markdown?.trim()) throw new ToolError('markdown is empty; use mode=delete to remove a section')
      const res = await call(ctx, 'POST', `/api/pages/${pageId}/section`, {
        json: { ref: section, markdown: markdown ?? '', mode, ...(baseVersion ? { baseVersion } : {}), ...(suggest ? { suggest } : {}) },
        passStatuses: [409],
      })
      // Kept as a suggestion instead of written (docs/adr/1530-*, 1532-*)
      if (res.statusCode === 202) return text(suggestionMadeText((res.json() as { suggestion: SuggestionDTO }).suggestion))
      if (res.statusCode === 409) {
        const body = res.json() as {
          error: { message: string; current?: { anchor: string; version: string; markdown: string } }
        }
        const cur = body.error.current
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `Conflict: ${body.error.message}` +
                (cur ? `\n\nCurrent §${cur.anchor} (v=${cur.version}):\n${cur.markdown}` : ''),
            },
          ],
        }
      }
      const r = res.json() as { section: { anchor: string; headingPath: string; version: string } | null; movedFrom?: string }
      const ac = await loadAgentContext(ctx, [pageId])
      const large = largeLine(ac, pageId)
      // statuses of the people the Markdown mentions (docs/adr/1846-*)
      const mentioned = mode === 'delete' ? null : await mentionStatusLineForPage(pageId, markdown)
      const tail = (large ? `\n${large}` : '') + (mentioned ? `\n${mentioned}` : '')
      // An old anchor after a heading rename was followed to the section's new anchor (docs/adr/1501-*).
      const moved = r.movedFrom && r.section ? `\nmoved_to: §${r.section.anchor} (the heading was renamed; "${r.movedFrom}" no longer exists)` : ''
      if (!r.section) {
        const was = r.movedFrom ? ` (it had been renamed from "${r.movedFrom}")` : ''
        return text(withApplies(ac, `Done (${mode}). The section was removed${was}.${tail}`))
      }
      return text(withApplies(ac, `Done (${mode}): §${r.section.anchor} is now v=${r.section.version}.${moved}${tail}`))
    }),
  )
}
