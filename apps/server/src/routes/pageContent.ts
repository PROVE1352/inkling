import { assertPageEditable } from '../editLock'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { badRequest, notFound } from '../errors'
import { idParam, requireMembershipAcl } from '../helpers'
import { markdownToBlocks, stripFrontmatter } from '../md/convert'
import { writeBlocksToDoc } from '../md/docWrite'
import { buildTitleResolver } from '../md/importer'
import { requestLocale } from '../i18n'
import { findVisiblePage } from '../pageDto'
import { createSnapshot, currentSnapshotSource, hasRecentAgentSnapshot } from '../snapshotStore'
import { actorOf, withEditActor } from '../context/attribution'

/**
 * Replaces or appends to an existing doc page's body from Markdown (for MCP update_page; the web UI does not use it).
 *
 * Safety: no hand-built Yjs fragments. Blocks come from the same markdownToBlocks (BlockNote parser) as
 * import and are injected into the live document through the snapshot-restore path (DirectConnection +
 * blocksToXmlFragment) → open clients see it in real time and the store hook updates the indexes.
 * append inserts the new blocks after the existing ones (existing blocks untouched → comment anchors survive).
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
      // Role and the workspace's lock state come with the membership (docs/adr/1071-*).
      const { role, acl } = await requireMembershipAcl(page.workspaceId, user.id)
      await assertPageEditable(id, user.id, { role, acl })
      if (page.kind !== 'doc') throw badRequest('Only document pages have editable content')

      const resolveTitle = await buildTitleResolver(page.workspaceId, new Map(), user.id)
      const incoming = await markdownToBlocks(stripFrontmatter(body.markdown), resolveTitle)

      if (body.mode === 'replace') {
        // Prefer the in-memory document: page_docs trails it by the store debounce (ADR 0757).
        const before = await currentSnapshotSource(id)
        // the label is stored in the DB, so it is written in the editor's locale
        if (before) {
          const label = (await requestLocale(req, user.id)) === 'ko' ? 'AI 편집 전' : 'Before AI edit'
          await createSnapshot(id, before, label, user.id, user.via ?? null)
        }
      }

      // The change feed reads the actor (user + OAuth client) while the store hook indexes this edit.
      await withEditActor([id], actorOf(user), () => writeBlocksToDoc(id, incoming, body.mode))

      // An agent append leaves no "Before" snapshot, so mark it in history with an "AI edit"
      // snapshot of the result (docs/adr/0936-*), throttled per page like auto snapshots. The
      // result is what the store hook just saved (the doc is usually unloaded by now).
      if (body.mode === 'append' && user.via && !(await hasRecentAgentSnapshot(id))) {
        const state = await currentSnapshotSource(id)
        if (state) {
          const label = (await requestLocale(req, user.id)) === 'ko' ? 'AI 편집' : 'AI edit'
          await createSnapshot(id, state, label, user.id, user.via)
        }
      }

      return { ok: true }
    },
  )
}
