import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { resolveSectionLink } from '../context/sectionLinks'
import { readOutline } from '../context/sectionSource'
import { notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage } from '../pageDto'

/**
 * Section links `[[Page#Heading]]` in the web app (docs/adr/2100-*, 2102-*):
 *
 * - GET /pages/:id/headings — the page's section headings (top-level headings, ADR 0926) for the
 *   `[[Page#` autocomplete: block id, text, level, anchor. Documents only; other kinds have none.
 * - GET /pages/:id/section-link?heading=&block= — which heading a link means now (block id, name,
 *   then the change log). The editor resolves block ids and names itself; it asks this only when
 *   neither is on the page, so the rename trace runs once per click on an old link.
 *
 * Same access as the outline route (/pages/:id/outline): a visible page in a workspace the caller
 * is a member of. Nothing is written and no agent read is recorded (people's UI only).
 */

const resolveQuery = z.object({
  heading: z.string().trim().min(1).max(500),
  block: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
})

async function guard(id: string, userId: string) {
  const page = await findVisiblePage(id, userId)
  if (!page) throw notFound()
  await requireMembership(page.workspaceId, userId)
  return page
}

export async function registerSectionLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/headings', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const page = await guard(idParam(req.params), user.id)
    if (page.kind !== 'doc') return { headings: [] }
    const sections = await readOutline(page.id)
    return {
      headings: sections
        .filter((s) => s.blockId && s.level > 0)
        .map((s) => ({
          blockId: s.blockId!,
          text: s.headingPath[s.headingPath.length - 1] ?? '',
          level: s.level,
          anchor: s.anchor,
        })),
    }
  })

  app.get('/pages/:id/section-link', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const page = await guard(idParam(req.params), user.id)
    const q = resolveQuery.parse(req.query)
    if (page.kind !== 'doc') return { status: 'missing', heading: q.heading, blockId: null, anchor: null }
    const sections = await readOutline(page.id)
    return resolveSectionLink(page.id, sections, { heading: q.heading, ...(q.block ? { blockId: q.block } : {}) })
  })
}
