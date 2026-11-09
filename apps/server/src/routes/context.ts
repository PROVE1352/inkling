import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { assertPageEditable } from '../editLock'
import { pageAccess } from '../aclVersion'
import { pageEditGate } from '../docWriteGate'
import { gatedTransact } from '../md/docWrite'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { hocuspocus } from '../collab'
import { actorOf, withEditActor } from '../context/attribution'
import { joinPath } from '../context/chunker'
import { applySectionPatch, buildEchoIndex } from '../context/sectionPatch'
import type { EchoIndex, PatchOutcome } from '../context/sectionPatch'
import type { Section } from '../context/chunker'
import { pageMentionKeys, readOutline, readSection, readSectionBlocks } from '../context/sectionSource'
import { resolveMovedSection } from '../context/sectionMoves'
import type { OutlineSection } from '../context/sectionSource'
import { DEFAULT_BUDGET, findContext, MAX_BUDGET, memberWorkspaceIds } from '../context/retrieve'
import { estimateTokens, truncateToTokens } from '../context/tokens'
import { db } from '../db/index'
import { pageDocs, pageSnapshots } from '../db/schema'
import { AppError, badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale } from '../i18n'
import { liveDocState } from '../liveConnections'
import { blocksToMarkdown, blocksToStateBuffer, markdownToBlocks, stateToBlocks, stripFrontmatter } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { exportPageCanvas, exportPageMd } from '../md/exporter'
import { buildTitleResolver } from '../md/importer'
import { findVisiblePage, pageColumns, visibleTo } from '../pageDto'
import type { PageRow } from '../pageDto'
import { pages } from '../db/schema'
import { createSnapshot, currentSnapshotSource, hasRecentAgentSnapshot } from '../snapshotStore'
import { liveWorkspace } from '../workspaceLive'

/**
 * Agent retrieval and section editing routes (docs/adr/0926-0930). Used by the MCP tools
 * find_context, read_page(outline|section), read_pages and patch_section, but plain session-cookie
 * routes like every other /api route. Reads are GET (read-only tokens may call them).
 *
 *   GET  /context?q&workspaceId&budget        ranked sections packed into a token budget
 *   GET  /pages/:id/outline                    sections: anchor, heading path, level, tokens, version
 *   GET  /pages/:id/section?ref&maxChars       one section as Markdown (+ version)
 *   GET  /pages/read?ids=a,b&budget            several pages as Markdown within a budget
 *   POST /pages/:id/section                    patch one section (replace/append/prepend/insert_after/delete)
 */

const contextQuerySchema = z.object({
  q: z.string().trim().min(1).max(300),
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
})

const patchBodySchema = z.object({
  ref: z.string().trim().min(1).max(500),
  markdown: z.string().max(1_000_000).default(''),
  mode: z.enum(['replace', 'append', 'prepend', 'insert_after', 'delete']),
  baseVersion: z.string().trim().max(64).optional(),
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

async function sectionMarkdown(blocks: AnyBlock[], s: Section): Promise<string> {
  const { markdown } = await blocksToMarkdown(blocks.slice(s.start, s.end), { assetMode: 'absolute', notation: 'agent' })
  return markdown.trim()
}

/** The renamed section's new anchor, or the error for a miss (docs/adr/1501-*). */
async function movedOrThrow(pageId: string, ref: string, sections: { anchor: string }[]): Promise<string> {
  const moved = await resolveMovedSection(pageId, ref, sections.map((s) => s.anchor))
  if (moved.status === 'moved') return moved.anchor
  if (moved.status === 'ambiguous') {
    return Promise.reject(
      new AppError(
        409,
        'SECTION_AMBIGUOUS',
        `Section "${ref}" was renamed and now matches several sections: ${moved.anchors.join(', ')}. Use one of these anchors.`,
      ),
    )
  }
  return Promise.reject(sectionNotFound(ref, sections))
}

function sectionNotFound(ref: string, sections: { anchor: string }[]): AppError {
  const list = sections.slice(0, 30).map((s) => s.anchor).join(', ')
  return new AppError(
    404,
    'SECTION_NOT_FOUND',
    `Section "${ref}" not found. Available anchors: ${list || '(none: the page has no headings)'}`,
  )
}

// Section patch (Yjs): context/sectionPatch.ts (docs/adr/0930-*, 0940-*).
export type { PatchMode, PatchOutcome } from '../context/sectionPatch'

/** "Before AI edit" snapshots for destructive section patches: at most one per page per 2 minutes. */
const PATCH_SNAPSHOT_WINDOW_MS = 2 * 60_000

export async function registerContextRoutes(app: FastifyInstance): Promise<void> {
  app.get('/context', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { q, workspaceId, budget } = contextQuerySchema.parse(req.query)
    let workspaceIds: string[]
    if (workspaceId) {
      await requireMembership(workspaceId, user.id)
      workspaceIds = [workspaceId]
    } else {
      workspaceIds = await memberWorkspaceIds(user.id)
    }
    return findContext({ userId: user.id, query: q, workspaceIds, budget: budget ?? DEFAULT_BUDGET })
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
    let markdown = r.markdown
    const totalChars = markdown.length
    const truncated = maxChars !== undefined && markdown.length > maxChars
    if (truncated) markdown = markdown.slice(0, maxChars)
    return {
      page: { id: page.id, title: page.title, workspaceId: page.workspaceId },
      section: { anchor: s.anchor, headingPath: joinPath(s.headingPath), level: s.level, version: s.version },
      ...(movedFrom ? { movedFrom } : {}),
      markdown,
      truncated,
      totalChars,
    }
  })

  app.get('/pages/read', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { ids, budget: b } = readQuerySchema.parse(req.query)
    const budget = b ?? READ_PAGES_DEFAULT_BUDGET
    // One query: visible, live, in a live workspace the user belongs to.
    const rows = await db
      .select(pageColumns)
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
    }[] = []
    const omitted: { id: string; title: string; reason: string }[] = []
    const missing: string[] = []
    for (const id of ids) {
      const page = byId.get(id)
      if (!page) {
        missing.push(id)
        continue
      }
      if (left < 120) {
        omitted.push({ id, title: page.title, reason: 'budget' })
        continue
      }
      let body: string
      if (page.kind === 'doc') {
        const live = liveDocState(id)
        const st = live ?? stateById.get(id)
        body = st ? (await blocksToMarkdown(stateToBlocks(st), { assetMode: 'absolute', notation: 'agent' })).markdown : ''
      } else if (page.kind === 'canvas') {
        body = (await exportPageCanvas(page, user.id)).body
      } else {
        body = stripFrontmatter((await exportPageMd(page, user.id)).body)
      }
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
      })
    }
    return { pages: out, omitted, missing, budget, usedTokens: budget - left }
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
      await assertPageEditable(id, user.id, { role: access.role, acl: access.acl })
      if (page.kind !== 'doc') throw badRequest('Only document pages have editable sections')

      const resolveTitle = await buildTitleResolver(page.workspaceId, new Map(), user.id)
      // Mention chips already in the page may be kept or moved, not created (docs/adr/1500-*).
      const notation = { mentions: await pageMentionKeys(id, body.markdown) }
      const incoming = body.mode === 'delete' ? [] : await markdownToBlocks(stripFrontmatter(body.markdown), resolveTitle, undefined, notation)
      // Full convertibility check on a throwaway doc before touching the live one.
      if (incoming.length) blocksToStateBuffer(incoming)

      if (body.mode === 'replace' || body.mode === 'delete') {
        const recent = await db
          .select({ id: pageSnapshots.id })
          .from(pageSnapshots)
          .where(
            and(
              eq(pageSnapshots.pageId, id),
              inArray(pageSnapshots.label, ['Before AI edit', 'AI 편집 전']),
              gt(pageSnapshots.createdAt, new Date(Date.now() - PATCH_SNAPSHOT_WINDOW_MS)),
            ),
          )
          .orderBy(desc(pageSnapshots.createdAt))
          .limit(1)
        if (recent.length === 0) {
          const before = await currentSnapshotSource(id)
          if (before) {
            const label = (await requestLocale(req, user.id)) === 'ko' ? 'AI 편집 전' : 'Before AI edit'
            await createSnapshot(id, before, label, user.id, user.via ?? null)
          }
        }
      }

      const attempt = async (ref: string): Promise<PatchOutcome> => {
        // What the agent saw of each block (Markdown round trip), so untouched blocks stay untouched.
        // Computed before the synchronous patch; blocks that changed in between are simply diffed.
        let echo: EchoIndex | null = null
        if (body.mode === 'replace') {
          const r = await readSectionBlocks(id, ref)
          if (r.found) echo = await buildEchoIndex(r.blocks, resolveTitle, notation, incoming)
        }
        let outcome: PatchOutcome | null = null
        await withEditActor([id], actorOf(user), async () => {
          const conn = await hocuspocus.openDirectConnection(id)
          try {
            // The patch is applied under the write gate (docs/adr/1150-*); the store runs after it.
            const gate = pageEditGate(id, page.workspaceId, user.id, access)
            await gatedTransact(conn, (doc) => {
              outcome = applySectionPatch(doc, ref, incoming, body.mode, body.baseVersion, echo)
            }, gate)
          } finally {
            await conn.disconnect()
          }
        })
        const out = outcome as PatchOutcome | null
        if (!out) throw new AppError(500, 'INTERNAL', 'Patch did not run')
        return out
      }
      let res = await attempt(body.ref)
      // An anchor from before a heading rename patches the section under its new anchor (docs/adr/1501-*).
      // Nothing was written by the missed attempt; the version check still applies to the section found.
      let movedFrom: string | undefined
      if (res.status === 'not_found') {
        const anchor = await movedOrThrow(id, body.ref, res.sections)
        res = await attempt(anchor)
        if (res.status === 'not_found') throw sectionNotFound(body.ref, res.sections)
        movedFrom = body.ref
      }
      // Non-destructive agent patches leave no "Before" snapshot: mark them in history like an
      // update_page append (throttled "AI edit" snapshot, docs/adr/0936-*).
      if (res.status === 'ok' && user.via && body.mode !== 'replace' && body.mode !== 'delete' && !(await hasRecentAgentSnapshot(id))) {
        const state = await currentSnapshotSource(id)
        if (state) {
          const label = (await requestLocale(req, user.id)) === 'ko' ? 'AI 편집' : 'AI edit'
          await createSnapshot(id, state, label, user.id, user.via)
        }
      }
      if (res.status === 'conflict') {
        const markdown = await sectionMarkdown(res.blocks, res.section)
        return reply.code(409).send({
          error: {
            code: 'SECTION_CONFLICT',
            message: movedFrom
              ? `Section "${movedFrom}" was renamed to "${res.section.anchor}" (its version includes the heading, so it changed since baseVersion ${body.baseVersion}); nothing was written. Check the current content and retry with section "${res.section.anchor}" and baseVersion ${res.section.version}.`
              : `Section "${res.section.anchor}" changed since baseVersion ${body.baseVersion}; nothing was written. Merge your edit into the current content and retry with baseVersion ${res.section.version}.`,
            ...(movedFrom ? { movedFrom } : {}),
            current: {
              anchor: res.section.anchor,
              headingPath: joinPath(res.section.headingPath),
              version: res.section.version,
              markdown,
            },
          },
        })
      }
      return {
        ok: true,
        section: res.section
          ? { anchor: res.section.anchor, headingPath: joinPath(res.section.headingPath), version: res.section.version }
          : null,
        ...(movedFrom ? { movedFrom } : {}),
        sections: res.sections.length,
      }
    },
  )
}
