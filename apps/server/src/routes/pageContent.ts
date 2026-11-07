import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { pageDocs } from '../db/schema'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { markdownToBlocks, stripFrontmatter } from '../md/convert'
import { writeBlocksToDoc } from '../md/docWrite'
import { buildTitleResolver } from '../md/importer'
import { requestLocale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { createSnapshot } from '../snapshotStore'
import { liveDocState } from '../liveConnections'

/**
 * Replaces or appends to an existing doc page's body from Markdown (for MCP update_page; the web UI does not use it).
 *
 * Safety: no hand-built Yjs fragments. Blocks come from the same markdownToBlocks (BlockNote parser) as
 * import and are injected into the live document through the snapshot-restore path (DirectConnection +
 * blocksToXmlFragment) → open clients see it in real time and the store hook updates the indexes.
 * append replaces the content with the existing blocks (ids kept → comment anchors survive) followed by the new ones.
 * replace first saves the previous state as a "Before AI edit" snapshot, so it can be undone from version history.
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
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const body = contentBodySchema.parse(req.body)

      const page = await findVisiblePage(id, user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)
      if (page.kind !== 'doc') throw badRequest('Only document pages have editable content')

      const resolveTitle = await buildTitleResolver(page.workspaceId, new Map(), user.id)
      const incoming = await markdownToBlocks(stripFrontmatter(body.markdown), resolveTitle)

      if (body.mode === 'replace') {
        const cur = (
          await db
            .select({ state: pageDocs.state })
            .from(pageDocs)
            .where(eq(pageDocs.pageId, id))
            .limit(1)
        )[0]
        // Prefer the in-memory document: page_docs trails it by the store debounce (ADR 0757).
        const before = liveDocState(id) ?? cur?.state
        // the label is stored in the DB, so it is written in the editor's locale
        if (before) {
          const label = (await requestLocale(req, user.id)) === 'ko' ? 'AI 편집 전' : 'Before AI edit'
          await createSnapshot(id, before, label, user.id)
        }
      }

      await writeBlocksToDoc(id, incoming, body.mode)

      return { ok: true }
    },
  )
}
