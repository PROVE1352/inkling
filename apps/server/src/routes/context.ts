import { and, inArray, isNull } from 'drizzle-orm'
import { suggestOrCheck } from '../suggestions'
import { claimOf, pageClaims } from '../leases'
import type { SectionClaimDTO } from '@inkling/shared'
import type { AuthUser } from '../auth'
import { pageAccess } from '../aclVersion'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { joinPath } from '../context/chunker'
import type { Section } from '../context/chunker'
import { readOutline, readSection } from '../context/sectionSource'
import { movedOrThrow, patchSectionAs, sectionNotFound } from '../context/sectionWrite'
import { resolveSectionWriteRef } from '../context/sectionMoves'
import type { OutlineSection } from '../context/sectionSource'
import { DEFAULT_BUDGET, MAX_BUDGET, memberWorkspaceIds } from '../context/retrieve'
import { cachedFindContext, cachedFindContextMulti, normalizeContextQuery } from '../context/contextCache'
import { MAX_QUERIES } from '../context/multiQuery'
import { semanticExtraLists, semanticOn } from '../context/semanticFind'
import { estimateTokens, truncateToTokens } from '../context/tokens'
import { db } from '../db/index'
import { pageDocs } from '../db/schema'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale } from '../i18n'
import { liveDocState } from '../liveConnections'
import { blocksToMarkdown, stateToBlocks, stripFrontmatter } from '../md/convert'
import { exportPageCanvas, exportPageMd } from '../md/exporter'
import { findVisiblePage, pageColumns, visibleTo } from '../pageDto'
import type { PageRow } from '../pageDto'
import { pages } from '../db/schema'
import { liveWorkspace } from '../workspaceLive'
import { agentProperties, pageVersion } from '../context/pageVersion'
import { registerSectionBatchRoutes } from './sectionBatch'
import { registerSectionLinkRoutes } from './sectionLinks'
import { recordTokenRead } from '../agentTaint'

/**
 * Agent retrieval and section editing routes (docs/adr/0926-0930). Used by the MCP tools
 * find_context, read_page(outline|section), read_pages and patch_section, but plain session-cookie
 * routes like every other /api route. Reads are GET (read-only tokens may call them).
 *
 *   GET  /context?q&workspaceId&budget        ranked sections packed into a token budget; q may repeat
 *                                              (2-5 phrasings, merged by RRF under one budget, ADR 1720;
 *                                              with semantic search on, always merged, ADR 1723)
 *   GET  /pages/:id/outline                    sections: anchor, heading path, level, tokens, version
 *   GET  /pages/:id/section?ref&maxChars       one section as Markdown (+ version)
 *   GET  /pages/read?ids=a,b&budget            several pages as Markdown within a budget
 *   POST /pages/:id/section                    patch one section (replace/append/prepend/insert_after/delete)
 *   POST /pages/:id/sections                   several section patches, all or nothing (routes/sectionBatch.ts)
 */

const queryText = z.string().trim().min(1).max(300)
const contextQuerySchema = z.object({
  // one value: a string (the single-query answer, unchanged); repeated: an array (docs/adr/1720-*)
  q: z.union([queryText, z.array(queryText).min(1).max(2 * MAX_QUERIES)]),
  workspaceId: z.uuid().optional(),
  budget: z.coerce.number().int().min(1).max(MAX_BUDGET).optional(),
})

const sectionQuerySchema = z.object({
  ref: z.string().trim().min(1).max(500),
  maxChars: z.coerce.number().int().min(100).max(400_000).optional(),
})

export const READ_PAGES_MAX = 20
export const READ_PAGES_DEFAULT_BUDGET = 8_000
export const READ_PAGES_MAX_BUDGET = 30_000

const readQuerySchema = z.object({
  ids: z
    .string()
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.uuid()).min(1).max(READ_PAGES_MAX)),
  budget: z.coerce.number().int().min(200).max(READ_PAGES_MAX_BUDGET).optional(),
  // "id:version,…" the caller already has (docs/adr/1540-*): such pages come back as `unchanged`
  known: z
    .string()
    .max(READ_PAGES_MAX * 60)
    .optional()
    .transform((s) => new Map((s ?? '').split(',').map((x) => x.trim().split(':')).filter((kv) => kv.length === 2 && kv[0] && kv[1]) as [string, string][])),
})

const patchBodySchema = z.object({
  ref: z.string().trim().min(1).max(500),
  markdown: z.string().max(1_000_000).default(''),
  mode: z.enum(['replace', 'append', 'prepend', 'insert_after', 'delete']),
  baseVersion: z.string().trim().max(64).optional(),
  /** Leave the change as a suggestion for a person to accept (docs/adr/1531-*). */
  suggest: z.boolean().optional(),
})

/** The visible + member page, or 404 (same guard as export). */
async function guardPage(id: string, userId: string): Promise<PageRow> {
  const page = await findVisiblePage(id, userId)
  if (!page) throw notFound()
  await requireMembership(page.workspaceId, userId)
  return page
}

function outlineOf(sections: OutlineSection[]) {
  return sections.map((s) => ({
    anchor: s.anchor,
    headingPath: joinPath(s.headingPath),
    level: s.level,
    tokens: s.tokens,
    version: s.version,
  }))
}

/** `{ claims }` for an outline answer when the page has live claims, else nothing. */
async function claimsField(pageId: string, user: AuthUser): Promise<{ claims?: SectionClaimDTO[] }> {
  const claims = await pageClaims(pageId, user)
  return claims.length ? { claims } : {}
}

/** `{ claim }` for a section answer when that section is claimed, else nothing. */
async function claimField(pageId: string, user: AuthUser, s: { anchor: string; blockId: string | null }): Promise<{ claim?: SectionClaimDTO }> {
  const claims = await pageClaims(pageId, user)
  const c = claims.length ? claimOf(claims, s) : null
  return c ? { claim: c } : {}
}

/** Queries in order without repeats (two spellings that retrieval sees alike count once). */
export function distinctQueries(qs: string[]): string[] {
  const seen = new Set<string>()
  return qs.filter((q) => {
    const n = normalizeContextQuery(q)
    if (seen.has(n)) return false
    seen.add(n)
    return true
  })
}

// Section patch (Yjs): context/sectionPatch.ts (docs/adr/0930-*, 0940-*).
export type { PatchMode, PatchOutcome } from '../context/sectionPatch'

export async function registerContextRoutes(app: FastifyInstance): Promise<void> {
  app.get('/context', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { q, workspaceId, budget } = contextQuerySchema.parse(req.query)
    if (workspaceId) await requireMembership(workspaceId, user.id)
    const queries = distinctQueries(typeof q === 'string' ? [q] : q)
    if (queries.length > MAX_QUERIES) throw badRequest(`At most ${MAX_QUERIES} different queries per call`)
    // Semantic search off (the default): one query takes the single path exactly as before; same
    // workspaces and permission filter, through the result cache (docs/adr/1550-*).
    const semantic = semanticOn()
    const run = (only: string | null) =>
      queries.length === 1 && !semantic
        ? cachedFindContext(user.id, queries[0], only, budget ?? DEFAULT_BUDGET)
        : // Several phrasings: per-query entries of the same cache, merged under one budget (docs/adr/1720-*).
          // Semantic search on: every call merges, each query's semantic candidates joining as an extra
          // ranked list labelled with its number (docs/adr/1723-*). Called inside this request's scope.
          cachedFindContextMulti(user.id, queries, only, budget ?? DEFAULT_BUDGET, semantic ? { extraLists: semanticExtraLists } : {})
    // ranks every workspace together without workspaceId; "best workspace first" was measured and not
    // adopted (docs/adr/2188-*)
    const res = await run(workspaceId ?? null)
    // An API token handed flagged sections becomes suggest-only for a while (docs/adr/2040-*).
    const shown = res.fragments.flatMap((f) => f.sections.map((s) => ({ pageId: f.pageId, anchor: s.anchor })))
    await recordTokenRead(user.tokenId, [...new Set(shown.map((x) => x.pageId))], shown)
    return res
  })

  app.get('/pages/:id/outline', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const page = await guardPage(idParam(req.params), user.id)
    if (page.kind !== 'doc') {
      return { page: { id: page.id, title: page.title, kind: page.kind, workspaceId: page.workspaceId }, sections: [], tokens: 0 }
    }
    // From the section index when it reflects the current document, else a decode (docs/adr/1041-*).
    const sections = await readOutline(page.id)
    return {
      page: { id: page.id, title: page.title, kind: page.kind, workspaceId: page.workspaceId, updatedAt: page.updatedAt.toISOString() },
      sections: outlineOf(sections),
      tokens: sections.reduce((n, s) => n + s.tokens, 0),
      // Live section claims (docs/adr/1535-*), only when there are any
      ...(await claimsField(page.id, user)),
    }
  })

  app.get('/pages/:id/section', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const page = await guardPage(idParam(req.params), user.id)
    const { ref, maxChars } = sectionQuerySchema.parse(req.query)
    if (page.kind !== 'doc') throw badRequest('Only document pages have sections; use read_page')
    let r = await readSection(page.id, ref)
    // An anchor from before a heading rename reads the section under its new anchor (docs/adr/1501-*).
    let movedFrom: string | undefined
    if (!r.found) {
      const anchor = await movedOrThrow(page.id, ref, r.sections)
      r = await readSection(page.id, anchor)
      if (!r.found) throw sectionNotFound(ref, r.sections)
      movedFrom = ref
    }
    const s = r.section
    await recordTokenRead(user.tokenId, [page.id], [{ pageId: page.id, anchor: s.anchor }])
    let markdown = r.markdown
    const totalChars = markdown.length
    const truncated = maxChars !== undefined && markdown.length > maxChars
    if (truncated) markdown = markdown.slice(0, maxChars)
    return {
      page: { id: page.id, title: page.title, workspaceId: page.workspaceId },
      section: { anchor: s.anchor, headingPath: joinPath(s.headingPath), level: s.level, version: s.version },
      ...(movedFrom ? { movedFrom } : {}),
      // A live claim on this section (docs/adr/1535-*)
      ...(await claimField(page.id, user, s)),
      markdown,
      truncated,
      totalChars,
    }
  })

  app.get('/pages/read', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { ids, budget: b, known } = readQuerySchema.parse(req.query)
    const budget = b ?? READ_PAGES_DEFAULT_BUDGET
    // One query: visible, live, in a live workspace the user belongs to.
    const rows = await db
      .select({ ...pageColumns, properties: pages.properties })
      .from(pages)
      .where(
        and(
          inArray(pages.id, ids),
          isNull(pages.deletedAt),
          visibleTo(user.id),
          liveWorkspace(pages.workspaceId),
        ),
      )
    const member = new Set(await memberWorkspaceIds(user.id))
    const byId = new Map(rows.filter((r) => member.has(r.workspaceId)).map((r) => [r.id, r]))
    const docIds = [...byId.values()].filter((p) => p.kind === 'doc').map((p) => p.id)
    const states = docIds.length
      ? await db.select({ pageId: pageDocs.pageId, state: pageDocs.state }).from(pageDocs).where(inArray(pageDocs.pageId, docIds))
      : []
    const stateById = new Map(states.map((s) => [s.pageId, s.state]))

    let left = budget
    const out: {
      id: string
      title: string
      workspaceId: string
      kind: string
      updatedAt: string
      markdown: string
      tokens: number
      truncated: boolean
      version: string
    }[] = []
    const omitted: { id: string; title: string; reason: string }[] = []
    const missing: string[] = []
    // Pages whose version equals the caller's `known` one: no body, no budget (docs/adr/1540-*).
    const unchanged: { id: string; title: string; kind: string; updatedAt: string; version: string }[] = []
    const readBody = async (page: (typeof rows)[number]): Promise<string> => {
      if (page.kind === 'doc') {
        const live = liveDocState(page.id)
        const st = live ?? stateById.get(page.id)
        return st ? (await blocksToMarkdown(stateToBlocks(st), { assetMode: 'absolute', notation: 'agent' })).markdown : ''
      }
      if (page.kind === 'canvas') return (await exportPageCanvas(page, user.id)).body
      // agent notation as read_page's export (docs/adr/1500-*), so both print the same page version (1540)
      return stripFrontmatter((await exportPageMd(page, user.id, 'agent')).body)
    }
    for (const id of ids) {
      const page = byId.get(id)
      if (!page) {
        missing.push(id)
        continue
      }
      // A known page is read first: when it is unchanged it costs nothing, wherever it is in the list.
      let body: string | null = null
      let version: string | null = null
      if (known.has(id)) {
        body = await readBody(page)
        version = pageVersion({ kind: page.kind, title: page.title, properties: agentProperties(page.properties), body })
        if (version === known.get(id)) {
          unchanged.push({ id, title: page.title, kind: page.kind, updatedAt: page.updatedAt.toISOString(), version })
          continue
        }
      }
      if (left < 120) {
        omitted.push({ id, title: page.title, reason: 'budget' })
        continue
      }
      body ??= await readBody(page)
      version ??= pageVersion({ kind: page.kind, title: page.title, properties: agentProperties(page.properties), body })
      const header = 30
      const { text, truncated } = truncateToTokens(body.trim(), left - header)
      const tokens = estimateTokens(text) + header
      left -= tokens
      out.push({
        id,
        title: page.title,
        workspaceId: page.workspaceId,
        kind: page.kind,
        updatedAt: page.updatedAt.toISOString(),
        markdown: text,
        tokens,
        truncated,
        version,
      })
    }
    await recordTokenRead(user.tokenId, out.map((o) => o.id))
    return { pages: out, ...(known.size ? { unchanged } : {}), omitted, missing, budget, usedTokens: budget - left }
  })

  app.post(
    '/pages/:id/section',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const body = patchBodySchema.parse(req.body)
      const page = await guardPage(id, user.id)
      // Role + access version, kept for the write gate below (docs/adr/1071-*, 1150-*).
      const access = await pageAccess(db, id, user.id)
      if (!access) throw notFound()
      // The section the name means now, or SECTION_AMBIGUOUS when another section answered to it
      // since it was printed (docs/adr/1960-*); claims, suggestions and the patch then use that anchor.
      if (page.kind === 'doc') {
        body.ref = await resolveSectionWriteRef(page.id, body.ref, await readOutline(page.id), { baseVersion: body.baseVersion, exactHistory: true })
      }
      // The edit check, or a suggestion instead (suggest=true, or a "suggestions only" lock for
      // agents), and other connections' section claims (docs/adr/1531-*, 1532-*, 1536-*).
      const suggestion = await suggestOrCheck(user, page, access, { ref: body.ref, markdown: body.markdown, mode: body.mode, baseVersion: body.baseVersion, suggest: body.suggest })
      if (suggestion) return reply.code(202).send({ suggestion })
      if (page.kind !== 'doc') throw badRequest('Only document pages have editable sections')

      // The patch itself (snapshot, echo, gate, rename follow-up, conflict) is shared with
      // accepting a suggestion (context/sectionWrite.ts, docs/adr/1533-*).
      const r = await patchSectionAs(user, page, access, body, () => requestLocale(req, user.id))
      if (r.status === 409) return reply.code(409).send(r.body)
      return r.body
    },
  )

  // POST /pages/:id/sections — several section patches, all or nothing (docs/adr/1542-*)
  await registerSectionBatchRoutes(app)
  // [[Page#Heading]] headings and resolution for the web app (docs/adr/2100-*, 2102-*)
  await registerSectionLinkRoutes(app)
}
