import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FindContextResult } from '../context/retrieve'
import { DEFAULT_BUDGET, MAX_BUDGET } from '../context/retrieve'
import { reviewFactsFor } from '../review'
import { countReads } from '../pageReads'
import type { ReviewFacts } from '../review'
import { call, text, ToolError, uuid, wrap, wrapWrite } from './core'
import type { ToolCtx } from './core'
import type { AgentContextDTO } from '../routes/editLock'
import { flaggedRules, largeLine, loadAgentContext, pageFacts, pageSuspiciousLine, withApplies } from './agentContext'
import { LARGE_PAGE_HINT } from '../context/largePage'
import { suspiciousNote } from '../context/injectionScan'
import { wrapUntrusted } from './trust'

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
 * Render find_context results (exported for the evaluation, which measures exactly this text).
 * Everything members wrote (titles, headings, section text) sits inside one <untrusted_content>
 * block (docs/adr/0976-*); each fragment line says what this agent may do (`can:`) and who last
 * edited the page. `ac` is optional so the offline evaluation can render without it.
 */
export function renderFindContext(
  query: string,
  r: FindContextResult,
  review?: Map<string, ReviewFacts>,
  ac?: AgentContextDTO,
): string {
  const wrapData = (lines: string[]) => wrapUntrusted(lines.join('\n'), { source: 'find_context' })
  if (r.fragments.length === 0) {
    const lines = [`No sections match "${query}". Try other or fewer words (synonyms, the other language), or list_pages.`]
    if (r.titleOnly.length) {
      lines.push('Pages whose title matches (no text):')
      lines.push(wrapData(r.titleOnly.map((t) => `- ${t.title || 'Untitled'} (page ${t.pageId}, ${t.kind})`)))
    }
    return ac ? withApplies(ac, lines.join('\n')) : lines.join('\n')
  }
  const head = `${r.fragments.length} result(s) for "${query}", ~${r.usedTokens}/${r.budget} tokens`
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
    const who = facts ? `; can: ${facts.can}${facts.lastEdit ? `; edited by ${facts.lastEdit}` : ''}${flag ? `; ${flag}` : ''}${facts.large ? '; large page' : ''}` : ''
    if (i > 0) data.push('')
    data.push(`[${i + 1}] ${f.title || 'Untitled'}${path}`, `(page ${f.pageId}; ${versions}${f.truncated ? '; truncated' : ''}${who}${reviewNote(review?.get(f.pageId))})`, f.text)
  })
  if (r.more.length) {
    // One line per page; a page already shown is referred to by its result number.
    data.push('', 'Also relevant (not shown):')
    const byPage = new Map<string, typeof r.more>()
    for (const m of r.more) byPage.set(m.pageId, [...(byPage.get(m.pageId) ?? []), m])
    for (const [pageId, list] of byPage) {
      const where = fragmentNo.has(pageId) ? `page of [${fragmentNo.get(pageId)}]` : `${list[0].title || 'Untitled'} (page ${pageId})`
      data.push(`- ${where}: ${list.map((m) => `§${shortOf(m)} ~${m.tokens} tok`).join(', ')}`)
    }
  }
  if (r.titleOnly.length) {
    data.push('', 'Title matches without text:')
    for (const t of r.titleOnly) data.push(`- ${t.title || 'Untitled'} (page ${t.pageId}, ${t.kind})`)
  }
  const out = [head, wrapData(data), '', 'Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.']
  // One hint for all large pages shown (docs/adr/1043-*).
  if (ac && r.fragments.some((f) => pageFacts(ac, f.pageId).large)) out.push(`Pages marked "large page": ${LARGE_PAGE_HINT.replace(/^large page: /, '')}.`)
  return ac ? withApplies(ac, out.join('\n')) : out.join('\n')
}

interface ReadPagesResponse {
  pages: { id: string; title: string; kind: string; updatedAt: string; markdown: string; truncated: boolean }[]
  omitted: { id: string; title: string; reason: string }[]
  missing: string[]
  budget: number
  usedTokens: number
}

export function renderReadPages(r: ReadPagesResponse, ac?: AgentContextDTO): string {
  const out: string[] = []
  for (const p of r.pages) {
    const facts = ac ? pageFacts(ac, p.id) : null
    out.push(
      `(page ${p.id}, ${p.kind}, updated ${p.updatedAt.slice(0, 10)}${p.truncated ? ', truncated' : ''}${facts ? `; can: ${facts.can}` : ''})`,
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

export function registerContextTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    'find_context',
    {
      title: 'Find context',
      description:
        'Start here. Searches all your notes (or one workspace) and returns the most relevant sections, ranked and packed ' +
        `into a token budget (default ${DEFAULT_BUDGET}, max ${MAX_BUDGET}; tokens are estimated). Each result has pageId, §anchor and ` +
        'version for read_page(section=…) or patch_section. Use specific words; Korean and English both work.',
      inputSchema: {
        query: z.string().trim().min(1).max(300).describe('What you are looking for (keywords or a question)'),
        workspaceId: uuid().optional().describe('Limit to one workspace (default: all of yours)'),
        budget: z.number().int().min(300).max(MAX_BUDGET).optional().describe(`Max tokens to return (default ${DEFAULT_BUDGET})`),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ query, workspaceId, budget }) => {
      const res = await call(ctx, 'GET', '/api/context', {
        query: { q: query, ...(workspaceId ? { workspaceId } : {}), ...(budget ? { budget: String(budget) } : {}) },
      })
      const result = res.json() as FindContextResult
      // pageIds come from the permission-checked REST answer; this only adds owner/review facts.
      const shown = result.fragments.map((f) => f.pageId)
      const review = await reviewFactsFor(shown)
      countReads(shown) // read counters, page totals only (docs/adr/0953-*)
      const ac = await loadAgentContext(ctx, shown, { read: true })
      return text(renderFindContext(query, result, review, ac))
    }),
  )

  server.registerTool(
    'read_pages',
    {
      title: 'Read pages',
      description:
        'Read several pages as Markdown in one call (up to 20 ids, in order) within a token budget (default 8000, max 30000). ' +
        'Pages that do not fit are listed so you can read them by section.',
      inputSchema: {
        pageIds: z.array(uuid()).min(1).max(20).describe('Page ids'),
        budget: z.number().int().min(200).max(30_000).optional().describe('Max tokens (default 8000)'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ pageIds, budget }) => {
      const res = await call(ctx, 'GET', '/api/pages/read', {
        query: { ids: pageIds.join(','), ...(budget ? { budget: String(budget) } : {}) },
      })
      const read = res.json() as ReadPagesResponse
      countReads(read.pages.map((p) => p.id)) // read counters (docs/adr/0953-*)
      return text(renderReadPages(read, await loadAgentContext(ctx, read.pages.map((p) => p.id), { read: true })))
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
        'text and version — merge and retry. Preferred over update_page.',
      inputSchema: {
        pageId: uuid().describe('Page id (kind=doc)'),
        section: z.string().trim().min(1).max(500).describe('Section anchor (e.g. "setup/backups"), heading text or heading block id'),
        markdown: z.string().max(1_000_000).optional().describe('Markdown to write (not needed for delete)'),
        mode: z.enum(['replace', 'append', 'prepend', 'insert_after', 'delete']).describe('How to apply the markdown'),
        baseVersion: z.string().trim().max(64).optional().describe('Section version you based the edit on (v=…)'),
      },
      annotations: { destructiveHint: true },
    },
    wrapWrite(ctx, async ({ pageId, section, markdown, mode, baseVersion }) => {
      if ((mode === 'replace' || mode === 'delete') && !baseVersion) {
        throw new ToolError(
          `baseVersion is required for mode=${mode}; get it from read_page(pageId, outline=true) or find_context (v=…)`,
        )
      }
      if (mode !== 'delete' && !markdown?.trim()) throw new ToolError('markdown is empty; use mode=delete to remove a section')
      const res = await call(ctx, 'POST', `/api/pages/${pageId}/section`, {
        json: { ref: section, markdown: markdown ?? '', mode, ...(baseVersion ? { baseVersion } : {}) },
        passStatuses: [409],
      })
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
      const r = res.json() as { section: { anchor: string; headingPath: string; version: string } | null }
      const ac = await loadAgentContext(ctx, [pageId])
      const large = largeLine(ac, pageId)
      const tail = large ? `\n${large}` : ''
      if (!r.section) return text(withApplies(ac, `Done (${mode}). The section was removed.${tail}`))
      return text(withApplies(ac, `Done (${mode}): §${r.section.anchor} is now v=${r.section.version}.${tail}`))
    }),
  )
}
