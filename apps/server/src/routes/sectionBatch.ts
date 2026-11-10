import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pageAccess } from '../aclVersion'
import { getUser, requireUser } from '../auth'
import { hocuspocus } from '../collab'
import { actorOf, withEditActor } from '../context/attribution'
import { findSection, joinPath } from '../context/chunker'
import { applySectionBatch } from '../context/sectionBatch'
import type { BatchEdit, BatchOutcome } from '../context/sectionBatch'
import { buildEchoIndex } from '../context/sectionPatch'
import { resolveMovedSection, resolveSectionWriteRef } from '../context/sectionMoves'
import { pageMentionKeys, readOutline, readSection, readSectionBlocks } from '../context/sectionSource'
import { db } from '../db/index'
import { pageEditGate } from '../docWriteGate'
import { createSuggestions, suggestionMode } from '../suggestions'
import { AppError, badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { requestLocale } from '../i18n'
import { blocksToMarkdown, blocksToStateBuffer, markdownToBlocks, stripFrontmatter } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { gatedTransact } from '../md/docWrite'
import { buildTitleResolver } from '../md/importer'
import { findVisiblePage } from '../pageDto'
import { asAgentStep, beforeAgentEditSnapshot, sectionEditDelta, stepSections } from '../context/sectionWrite'
import { isAgentVia } from '../agentVia'
import { claimLine, claimOf, connectionKey, pageClaims } from '../leases'

/**
 * POST /pages/:id/sections — several section patches in one request, all or nothing
 * (docs/adr/1542-*; the MCP tool patch_sections). Each edit is what POST /pages/:id/section takes
 * ({ref, markdown, mode, baseVersion}); the same permission checks run once (membership,
 * visibility, edit lock), the edits run under one write gate in one document transaction
 * (context/sectionBatch.ts), and any failure — unknown section, renamed-and-ambiguous anchor, stale
 * baseVersion, the same section twice, a patch that cannot apply — writes nothing and is answered
 * with 409 SECTIONS_CONFLICT listing every failure.
 */

export const PATCH_SECTIONS_MAX = 20

const editSchema = z.object({
  ref: z.string().trim().min(1).max(500),
  markdown: z.string().max(1_000_000).default(''),
  mode: z.enum(['replace', 'append', 'prepend', 'insert_after', 'delete']),
  baseVersion: z.string().trim().max(64).optional(),
})
const bodySchema = z.object({
  /** Leave every edit as a suggestion for a person (docs/adr/1538-*). */
  suggest: z.boolean().optional(),
  edits: z
    .array(editSchema)
    .min(1)
    .max(PATCH_SECTIONS_MAX)
    .refine((es) => es.reduce((n, e) => n + e.markdown.length, 0) <= 2_000_000, 'edits: at most 2,000,000 characters of Markdown in total'),
})

export interface SectionConflict {
  /** 0-based position in `edits`. */
  index: number
  ref: string
  reason: 'version' | 'not_found' | 'ambiguous' | 'duplicate' | 'empty' | 'invalid' | 'claimed'
  message: string
  anchor?: string
  baseVersion?: string
  /** Current version and Markdown of the section (version conflicts only). */
  version?: string
  markdown?: string
}

export async function registerSectionBatchRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/pages/:id/sections',
    { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const body = bodySchema.parse(req.body)
      const page = await findVisiblePage(id, user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)
      const access = await pageAccess(db, id, user.id)
      if (!access) throw notFound()
      // Which section each name means now (docs/adr/1960-*): a name another section answered to since it
      // was printed needs the version read, else that edit is listed as ambiguous and nothing is written.
      const refOutline = page.kind === 'doc' ? await readOutline(id) : []
      const refs: string[] = []
      const refConflicts: SectionConflict[] = []
      for (const [index, e] of body.edits.entries()) {
        try {
          refs.push(page.kind === 'doc' ? await resolveSectionWriteRef(id, e.ref, refOutline, { baseVersion: e.baseVersion, exactHistory: true }) : e.ref)
        } catch (err) {
          if (!(err instanceof AppError) || err.code !== 'SECTION_AMBIGUOUS') throw err
          refs.push(e.ref)
          refConflicts.push({ index, ref: e.ref, reason: 'ambiguous', message: err.message })
        }
      }
      if (refConflicts.length) return sendConflicts(reply, refConflicts, body.edits.length, refOutline.map((s) => s.anchor))
      // The edit check, or suggestions instead: asked (suggest=true) or the "agents: suggestions only"
      // lock. Suggestions are made all together in one transaction or not at all (docs/adr/1538-*);
      // claims and stale base versions do not stop them (the person sees "changed since").
      const how = await suggestionMode(user, page, access, body.suggest)
      if (how) {
        if (page.kind !== 'doc') throw badRequest('Only document pages have editable sections')
        const suggestions = await createSuggestions(
          user,
          page,
          body.edits.map((e, i) => ({ ref: refs[i], markdown: e.markdown, mode: e.mode, ...(e.baseVersion ? { baseVersion: e.baseVersion } : {}) })),
          how.origin,
          how.policy,
        )
        return reply.code(202).send({ suggestions })
      }
      if (page.kind !== 'doc') throw badRequest('Only document pages have editable sections')
      // Sections other connections have claimed (docs/adr/1535-*): refused like patch_section, listed per edit.
      const claims = connectionKey(user) ? (await pageClaims(id, user)).filter((c) => !c.mine) : []

      const conflicts: SectionConflict[] = []
      const resolveTitle = await buildTitleResolver(page.workspaceId, new Map(), user.id)
      // Mention chips already in the page may be kept or moved, not created (docs/adr/1500-*).
      const notation = { mentions: await pageMentionKeys(id, body.edits.map((e) => e.markdown).join('\n')) }
      const incoming: AnyBlock[][] = []
      for (const [index, e] of body.edits.entries()) {
        const blocks = e.mode === 'delete' ? [] : await markdownToBlocks(stripFrontmatter(e.markdown), resolveTitle, undefined, notation)
        // Full convertibility check on a throwaway doc before touching the live one.
        if (blocks.length) blocksToStateBuffer(blocks)
        else if (e.mode !== 'delete') conflicts.push({ index, ref: e.ref, reason: 'empty', message: 'markdown is empty; use mode=delete to remove a section' })
        incoming.push(blocks)
      }

      // Targets: by anchor, heading text or path; an anchor from before a heading rename follows it (docs/adr/1501-*).
      const outline = await readOutline(id)
      const anchors = outline.map((s) => s.anchor)
      const targets: ({ anchor: string; blockId: string | null; movedFrom?: string } | null)[] = []
      for (const [index, e] of body.edits.entries()) {
        const s = findSection(outline, refs[index])
        if (s) {
          targets.push({ anchor: s.anchor, blockId: s.blockId })
          const held = claimOf(claims, s)
          if (held) conflicts.push({ index, ref: e.ref, anchor: s.anchor, reason: 'claimed', message: `${claimLine(held)}; work on another section or wait for the claim to end` })
          // Checked again inside the transaction; here so one answer lists every problem.
          if (e.baseVersion && e.baseVersion !== s.version) conflicts.push(await versionConflict(id, index, e, s.anchor, s.version))
          continue
        }
        const moved = await resolveMovedSection(id, e.ref, anchors)
        if (moved.status === 'moved') {
          const t = outline.find((x) => x.anchor === moved.anchor)!
          targets.push({ anchor: t.anchor, blockId: t.blockId, movedFrom: e.ref })
          const held = claimOf(claims, t)
          if (held) conflicts.push({ index, ref: e.ref, anchor: t.anchor, reason: 'claimed', message: `${claimLine(held)}; work on another section or wait for the claim to end` })
          // The version covers the heading, so a renamed section never matches an older baseVersion (docs/adr/1501-*).
          if (e.baseVersion && e.baseVersion !== t.version) conflicts.push(await versionConflict(id, index, e, t.anchor, t.version))
        } else {
          targets.push(null)
          conflicts.push(
            moved.status === 'ambiguous'
              ? { index, ref: e.ref, reason: 'ambiguous', message: `was renamed and now matches several sections: ${moved.anchors.join(', ')}; use one of these anchors` }
              : { index, ref: e.ref, reason: 'not_found', message: 'not found' },
          )
        }
      }
      const firstUse = new Map<string, number>()
      targets.forEach((t, index) => {
        if (!t) return
        const prev = firstUse.get(t.anchor)
        if (prev === undefined) firstUse.set(t.anchor, index)
        else {
          conflicts.push({
            index,
            ref: body.edits[index].ref,
            anchor: t.anchor,
            reason: 'duplicate',
            message: `§${t.anchor} is edited twice (edits ${prev + 1} and ${index + 1}); combine them into one edit`,
          })
        }
      })
      if (conflicts.length) return sendConflicts(reply, conflicts, body.edits.length, anchors)

      // What the agent saw of each replaced section, so untouched blocks stay untouched (as POST …/section).
      const agent = isAgentVia(user.via)
      const edits: BatchEdit[] = []
      // What each replaced/deleted section held, for the AI step's line counts (docs/adr/2180-*).
      const olds: (AnyBlock[] | null)[] = []
      for (const [index, e] of body.edits.entries()) {
        const t = targets[index]!
        let echo = null
        let old: AnyBlock[] | null = null
        if (e.mode === 'replace' || (agent && e.mode === 'delete')) {
          const r = await readSectionBlocks(id, t.anchor)
          if (r.found) {
            old = r.blocks
            if (e.mode === 'replace') echo = await buildEchoIndex(r.blocks, resolveTitle, notation, incoming[index])
          }
        }
        olds.push(old)
        edits.push({ blockId: t.blockId, anchor: t.anchor, incoming: incoming[index], mode: e.mode, baseVersion: e.baseVersion, echo })
      }

      const destructive = body.edits.some((e) => e.mode === 'replace' || e.mode === 'delete')
      const locale = () => requestLocale(req, user.id)
      // A person's destructive batch keeps the "Before AI edit" undo point; an agent's batch is one AI step.
      if (destructive && !agent) await beforeAgentEditSnapshot(id, user, locale)

      const { result: out } = await asAgentStep(id, user, locale, async () => {
        let outcome: BatchOutcome | null = null
        await withEditActor([id], actorOf(user), async () => {
          const conn = await hocuspocus.openDirectConnection(id)
          try {
            // One write gate for the whole batch (docs/adr/1150-*); the store runs after it.
            const gate = pageEditGate(id, page.workspaceId, user.id, access)
            await gatedTransact(conn, (doc) => {
              outcome = applySectionBatch(doc, edits)
            }, gate)
          } finally {
            await conn.disconnect()
          }
        })
        const res = outcome as BatchOutcome | null
        if (!res || res.status !== 'ok' || !agent) return { result: res, step: null }
        // all the batch's edits are one step: anchors written, lines summed
        let added = 0
        let removed = 0
        for (const [index, e] of body.edits.entries()) {
          const d = await sectionEditDelta(e.mode, olds[index], incoming[index])
          added += d.added
          removed += d.removed
        }
        const anchors = res.results.map((sec, index) => sec?.anchor ?? targets[index]!.anchor)
        return { result: res, step: { tool: 'patch_sections', ...stepSections(anchors), added, removed } }
      })
      if (!out) throw new AppError(500, 'INTERNAL', 'Patch did not run')
      if (out.status === 'failed') {
        const list: SectionConflict[] = []
        for (const f of out.failures) {
          const e = body.edits[f.index]
          const anchor = targets[f.index]!.anchor
          if (f.reason === 'version') {
            const { markdown } = await blocksToMarkdown(f.blocks.slice(f.section.start, f.section.end), { assetMode: 'absolute', notation: 'agent' })
            list.push({
              index: f.index,
              ref: e.ref,
              anchor: f.section.anchor,
              reason: 'version',
              baseVersion: e.baseVersion,
              version: f.section.version,
              markdown: markdown.trim(),
              message: `changed since baseVersion ${e.baseVersion} (now v=${f.section.version})`,
            })
          } else if (f.reason === 'not_found') {
            list.push({ index: f.index, ref: e.ref, anchor, reason: 'not_found', message: 'not found (the section was removed meanwhile, or an earlier edit removed it)' })
          } else {
            list.push({ index: f.index, ref: e.ref, anchor, reason: 'invalid', message: f.message })
          }
        }
        return sendConflicts(reply, list, body.edits.length, out.sections.map((s) => s.anchor))
      }
      return {
        ok: true,
        results: out.results.map((s, index) => ({
          index,
          section: s ? { anchor: s.anchor, headingPath: joinPath(s.headingPath), version: s.version } : null,
          ...(targets[index]!.movedFrom ? { movedFrom: targets[index]!.movedFrom } : {}),
        })),
        sections: out.sections,
      }
    },
  )
}

async function versionConflict(
  pageId: string,
  index: number,
  e: { ref: string; baseVersion?: string },
  anchor: string,
  version: string,
): Promise<SectionConflict> {
  const r = await readSection(pageId, anchor)
  return {
    index,
    ref: e.ref,
    anchor,
    reason: 'version',
    baseVersion: e.baseVersion,
    version,
    ...(r.found ? { markdown: r.markdown } : {}),
    message: `changed since baseVersion ${e.baseVersion} (now v=${version})`,
  }
}

function sendConflicts(
  reply: import('fastify').FastifyReply,
  conflicts: SectionConflict[],
  total: number,
  anchors: string[],
) {
  conflicts.sort((a, b) => a.index - b.index)
  return reply.code(409).send({
    error: {
      code: 'SECTIONS_CONFLICT',
      message: `${conflicts.length} of ${total} edits cannot be applied; nothing was written. Fix them and send all edits again.`,
      conflicts,
      anchors: anchors.slice(0, 50),
    },
  })
}
