import { suggestOrCheck } from '../suggestions'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembershipAcl } from '../helpers'
import { requestLocale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { writePageContentAs } from '../pageContentWrite'

/**
 * Replaces or appends to an existing doc page's body from Markdown (for MCP update_page; the web UI does not use it).
 *
 * Safety: no hand-built Yjs fragments. Blocks come from the same markdownToBlocks (BlockNote parser) as
 * import and are injected into the live document through the snapshot-restore path (DirectConnection +
 * blocksToXmlFragment) → open clients see it in real time and the store hook updates the indexes.
 * append inserts the new blocks after the existing ones (existing blocks untouched → comment anchors survive).
 * replace first saves the previous state as a "Before AI edit" snapshot, so it can be undone from version history,
 * then edits the document minimally (docs/adr/1500-*): blocks sent back unchanged keep their ids and everything
 * Markdown cannot say (colors, toggles, underline); read_page's notation brings back callouts, embeds and files.
 */
const contentBodySchema = z.object({
  markdown: z.string().max(1_000_000),
  mode: z.enum(['replace', 'append']),
})

export async function registerPageContentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/pages/:id/content',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const body = contentBodySchema.parse(req.body)

      const page = await findVisiblePage(id, user.id)
      if (!page) throw notFound()
      // Role and the workspace's lock state come with the membership (docs/adr/1071-*).
      const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id)
      // Under an "agents: suggestions only" lock the body change becomes a suggestion; a replace is
      // refused while another connection claims a section of the page (docs/adr/1532-*, 1536-*).
      const suggestion = await suggestOrCheck(user, page, { role, acl }, {
        ref: null,
        markdown: body.markdown,
        mode: body.mode === 'replace' ? 'page_replace' : 'page_append',
      })
      if (suggestion) return reply.code(202).send({ suggestion })
      if (page.kind !== 'doc') throw badRequest('Only document pages have editable content')

      await writePageContentAs(user, page, { role, acl }, body, () => requestLocale(req, user.id))

      return { ok: true }
    },
  )
}
