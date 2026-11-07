import { assertPlacement, withTreeLock } from '../pageTree'
import { readBlocks } from '../context/sectionPatch'
import { and, eq, gt, inArray, isNull, isNotNull, max, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { PageScope } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { hocuspocus } from '../collab'
import { db } from '../db/index'
import { pageDocs, pageLinks, pages, pageSyncHashes } from '../db/schema'
import { AppError, badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { blocksToStateBuffer, blocksToXmlFragment, markdownToBlocks, stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { getServerEditor } from '../md/editor'
import { buildTitleResolver } from '../md/importer'
import { forgetDocIndex } from '../docIndexer'
import { reindexPageLinks } from '../md/linkIndex'
import {
  contentHashOf,
  fixAliasedLinkText,
  frontmatterToMeta,
  linkTargets,
  metaHash,
  parseFrontmatter,
  renderSyncMarkdown,
  revisionFromDoc,
  revisionFromState,
  splitRevision,
  wikiTitleResolver,
} from '../md/syncMd'
import { reindexPageTags } from '../md/tagIndex'
import { reindexPageTasks } from '../md/taskIndex'
import { reindexPageChunks } from '../context/chunkIndex'
import { reindexPageText } from '../md/textIndex'
import { findVisiblePage, visibleTo } from '../pageDto'

/**
 * Obsidian vault two-way sync — server side (experimental `vault-sync`, registered only when the
 * flag is on). Protocol: docs/adr/0200-vault-sync-protocol.md. Endpoints (all under /api):
 *
 *   GET    /workspaces/:id/sync/changes?since=<cursor>  page tree + revisions of changed docs
 *   POST   /workspaces/:id/sync/read  { ids }           canonical markdown for ≤100 pages
 *   POST   /workspaces/:id/sync/pages { … }             create doc/folder page (optionally with md)
 *   PUT    /pages/:id/sync/md { markdown, expectedRevision }  write; 412 on revision mismatch
 *   DELETE /pages/:id/sync?expectedRevision=…           trash a leaf page; 412 on mismatch
 *
 * Writes reuse the snapshot-restore path (Hocuspocus DirectConnection → BlockNote fragment), so
 * browsers editing the page receive the change live and the store hook re-indexes it.
 */

const MAX_LIST = 20_000
const MAX_READ_BATCH = 100
const MAX_MD_CHARS = 1_500_000
const EMPTY_BLOCKS: AnyBlock[] = [{ type: 'paragraph', content: [] }]

const changesQuerySchema = z.object({ since: z.iso.datetime({ offset: true }).optional() })
const readBodySchema = z.object({ ids: z.array(z.uuid()).min(1).max(MAX_READ_BATCH) })
const writeBodySchema = z.object({
  markdown: z.string().max(MAX_MD_CHARS),
  expectedRevision: z.string().min(1).max(80),
})
const createBodySchema = z.object({
  parentId: z.uuid().nullable().optional(),
  title: z.string().max(300),
  kind: z.enum(['doc', 'folder']),
  markdown: z.string().max(MAX_MD_CHARS).optional(),
})
const deleteQuerySchema = z.object({ expectedRevision: z.string().min(1).max(80).optional() })

interface MetaRow {
  id: string
  workspaceId: string
  kind: string
  properties: unknown
  aliases: unknown
}

/** Live (in-memory) Hocuspocus document for a page, if a browser or direct connection holds it. */
function liveDoc(pageId: string) {
  return hocuspocus.documents.get(pageId) ?? null
}

async function loadState(pageId: string): Promise<Uint8Array | null> {
  const row = (
    await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, pageId)).limit(1)
  )[0]
  return row?.state ?? null
}

/** Current blocks + revision, read at the same instant (live doc preferred over page_docs). */
/**
 * `targetId:title|…` of each page's live link targets (from the page_links index kept by the
 * store hook). One grouped query for any number of pages.
 */
async function linkSigs(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000)
    const rows = (await db.execute(sql`
      SELECT l.source_page_id AS id,
             string_agg(l.target_page_id::text || ':' || t.title, '|' ORDER BY l.target_page_id) AS sig
        FROM page_links l JOIN pages t ON t.id = l.target_page_id AND t.deleted_at IS NULL
       WHERE l.source_page_id IN ${sql`(${sql.join(chunk.map((c) => sql`${c}::uuid`), sql`, `)})`}
       GROUP BY l.source_page_id`)) as unknown as { id: string; sig: string }[]
    for (const r of rows) out.set(r.id, r.sig)
  }
  return out
}

async function pageMetaHash(page: MetaRow): Promise<string> {
  const sig = (await linkSigs([page.id])).get(page.id) ?? ''
  return metaHash(page.properties, page.aliases, sig)
}

async function snapshotPage(page: MetaRow): Promise<{ blocks: AnyBlock[]; revision: string }> {
  const meta = await pageMetaHash(page)
  const live = liveDoc(page.id)
  if (live) {
    // Copy read: yDocToBlocks on the live doc deletes nodes the server schema does not know.
    const blocks = readBlocks(live)
    return { blocks, revision: revisionFromDoc(live, meta) }
  }
  const state = await loadState(page.id)
  return {
    blocks: state && state.length ? stateToBlocks(state) : EMPTY_BLOCKS,
    revision: revisionFromState(state, meta),
  }
}

async function cacheHash(pageId: string, revision: string, contentHash: string): Promise<void> {
  await db
    .insert(pageSyncHashes)
    .values({ pageId, revision, contentHash })
    .onConflictDoUpdate({
      target: pageSyncHashes.pageId,
      set: { revision, contentHash, updatedAt: new Date() },
    })
}

/** Current titles of link targets the reader may see (others export as their shown text). */
async function linkTitles(blocks: AnyBlock[], workspaceId: string, userId: string): Promise<Map<string, string>> {
  const ids = linkTargets(blocks)
  const map = new Map<string, string>()
  if (!ids.length) return map
  const rows = await db
    .select({ id: pages.id, title: pages.title })
    .from(pages)
    .where(and(inArray(pages.id, ids), eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)))
  for (const r of rows) map.set(r.id.toLowerCase(), r.title)
  return map
}

async function importBlocks(
  markdownBody: string,
  workspaceId: string,
  userId: string,
): Promise<AnyBlock[]> {
  const resolve = wikiTitleResolver(await buildTitleResolver(workspaceId, new Map(), userId))
  const blocks = await markdownToBlocks(markdownBody, resolve)
  fixAliasedLinkText(blocks)
  return blocks.length ? blocks : EMPTY_BLOCKS
}

async function renderPage(page: MetaRow, userId: string) {
  const { blocks, revision } = await snapshotPage(page)
  const markdown = await renderSyncMarkdown(page, blocks, await linkTitles(blocks, page.workspaceId, userId))
  const contentHash = contentHashOf(markdown)
  await cacheHash(page.id, revision, contentHash)
  return { revision, contentHash, markdown }
}

async function loadMetaRow(pageId: string, userId: string): Promise<MetaRow | null> {
  const row = (
    await db
      .select({
        id: pages.id,
        workspaceId: pages.workspaceId,
        kind: pages.kind,
        properties: pages.properties,
        aliases: pages.aliases,
      })
      .from(pages)
      .where(and(eq(pages.id, pageId), isNull(pages.deletedAt), visibleTo(userId)))
      .limit(1)
  )[0]
  return row ?? null
}

function preconditionFailed(reply: FastifyReply, current: Record<string, unknown>) {
  return reply.code(412).send({
    error: {
      code: 'REVISION_MISMATCH',
      message: 'The page changed on the server since your last sync',
    },
    current,
  })
}

async function reindexAll(pageId: string, blocks: AnyBlock[]): Promise<void> {
  forgetDocIndex(pageId) // out-of-band rewrite: the live indexer must not trust its signatures
  await reindexPageLinks(pageId, blocks)
  await reindexPageText(pageId, blocks)
  await reindexPageChunks(pageId, blocks)
  await reindexPageTags(pageId, blocks)
  await reindexPageTasks(pageId, blocks)
}

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // change feed
  // ---------------------------------------------------------------------------
  app.get(
    '/workspaces/:id/sync/changes',
    { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const workspaceId = idParam(req.params)
      await requireMembership(workspaceId, user.id)
      const { since } = changesQuerySchema.parse(req.query)
      const sinceDate = since ? new Date(since) : null
      // cursor overlaps by a few seconds so commits racing this read are seen next time
      const cursor = new Date(Date.now() - 5000).toISOString()

      const rows = await db
        .select({
          id: pages.id,
          parentId: pages.parentId,
          kind: pages.kind,
          title: pages.title,
          updatedAt: pages.updatedAt,
          properties: pages.properties,
          aliases: pages.aliases,
        })
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(user.id)))
        .orderBy(pages.sortOrder, pages.createdAt)
        .limit(MAX_LIST + 1)
      if (rows.length > MAX_LIST) {
        throw new AppError(413, 'TOO_MANY_PAGES', `Workspace has more than ${MAX_LIST} pages`)
      }

      // revisions only for docs changed since the cursor (or all docs on a first sync)
      // + docs linking to anything renamed/changed/trashed since the cursor (their exported
      //   [[Title]] text changes even though their own document did not)
      const referrers = new Set<string>()
      if (sinceDate) {
        const touched = rows.filter((r) => r.updatedAt > sinceDate).map((r) => r.id)
        const trashedIds = (
          await db
            .select({ id: pages.id })
            .from(pages)
            .where(and(eq(pages.workspaceId, workspaceId), isNotNull(pages.deletedAt), gt(pages.deletedAt, sinceDate)))
            .limit(MAX_LIST)
        ).map((x) => x.id)
        const targets = [...touched, ...trashedIds]
        for (let i = 0; i < targets.length; i += 1000) {
          const refs = await db
            .select({ id: pageLinks.sourcePageId })
            .from(pageLinks)
            .where(inArray(pageLinks.targetPageId, targets.slice(i, i + 1000)))
          for (const r of refs) referrers.add(r.id)
        }
      }
      const changed = rows.filter(
        (r) => r.kind === 'doc' && (!sinceDate || r.updatedAt > sinceDate || referrers.has(r.id)),
      )
      const sigs = await linkSigs(changed.map((r) => r.id))
      const revisions = new Map<string, string>()
      const needState: typeof changed = []
      for (const r of changed) {
        const live = liveDoc(r.id)
        if (live) revisions.set(r.id, revisionFromDoc(live, metaHash(r.properties, r.aliases, sigs.get(r.id) ?? '')))
        else needState.push(r)
      }
      // page_docs in bounded chunks — only the state vector is derived, the doc is never built
      for (let i = 0; i < needState.length; i += 200) {
        const chunk = needState.slice(i, i + 200)
        const states = await db
          .select({ pageId: pageDocs.pageId, state: pageDocs.state })
          .from(pageDocs)
          .where(inArray(pageDocs.pageId, chunk.map((c) => c.id)))
        const byId = new Map(states.map((s) => [s.pageId, s.state]))
        for (const r of chunk) {
          revisions.set(r.id, revisionFromState(byId.get(r.id) ?? null, metaHash(r.properties, r.aliases, sigs.get(r.id) ?? '')))
        }
      }
      const hashes = new Map<string, { revision: string; contentHash: string }>()
      const ids = [...revisions.keys()]
      for (let i = 0; i < ids.length; i += 1000) {
        const cached = await db
          .select({
            pageId: pageSyncHashes.pageId,
            revision: pageSyncHashes.revision,
            contentHash: pageSyncHashes.contentHash,
          })
          .from(pageSyncHashes)
          .where(inArray(pageSyncHashes.pageId, ids.slice(i, i + 1000)))
        for (const c of cached) hashes.set(c.pageId, c)
      }

      let trashed: { id: string; deletedAt: string }[] = []
      if (sinceDate) {
        const t = await db
          .select({ id: pages.id, deletedAt: pages.deletedAt })
          .from(pages)
          .where(
            and(
              eq(pages.workspaceId, workspaceId),
              isNotNull(pages.deletedAt),
              gt(pages.deletedAt, sinceDate),
              visibleTo(user.id),
            ),
          )
          .limit(MAX_LIST)
        trashed = t.map((x) => ({ id: x.id, deletedAt: (x.deletedAt as Date).toISOString() }))
      }

      return {
        cursor,
        pages: rows.map((r) => {
          const revision = revisions.get(r.id) ?? null
          const cached = hashes.get(r.id)
          return {
            id: r.id,
            parentId: r.parentId,
            kind: r.kind,
            title: r.title,
            updatedAt: r.updatedAt.toISOString(),
            revision,
            contentHash: revision && cached?.revision === revision ? cached.contentHash : null,
          }
        }),
        trashed,
      }
    },
  )

  // ---------------------------------------------------------------------------
  // batch read
  // ---------------------------------------------------------------------------
  app.post(
    '/workspaces/:id/sync/read',
    { preHandler: requireUser, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const user = getUser(req)
      const workspaceId = idParam(req.params)
      await requireMembership(workspaceId, user.id)
      const { ids } = readBodySchema.parse(req.body)
      const rows = await db
        .select({
          id: pages.id,
          workspaceId: pages.workspaceId,
          kind: pages.kind,
          properties: pages.properties,
          aliases: pages.aliases,
        })
        .from(pages)
        .where(
          and(
            inArray(pages.id, ids),
            eq(pages.workspaceId, workspaceId),
            eq(pages.kind, 'doc'),
            isNull(pages.deletedAt),
            visibleTo(user.id),
          ),
        )
      const out = []
      for (const r of rows) out.push({ id: r.id, ...(await renderPage(r, user.id)) })
      const found = new Set(rows.map((r) => r.id))
      return { pages: out, missing: ids.filter((id) => !found.has(id)) }
    },
  )

  // ---------------------------------------------------------------------------
  // write with optimistic concurrency
  // ---------------------------------------------------------------------------
  app.put(
    '/pages/:id/sync/md',
    {
      preHandler: requireUser,
      bodyLimit: 4 * 1024 * 1024,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const body = writeBodySchema.parse(req.body)
      const page = await loadMetaRow(id, user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)
      if (page.kind !== 'doc') throw badRequest('Only document pages hold markdown')

      const expected = splitRevision(body.expectedRevision)
      // (1) metadata half of the token — properties/aliases
      if (expected.meta !== (await pageMetaHash(page))) {
        return preconditionFailed(reply, await renderPage(page, user.id))
      }

      // (2) parse outside the document lock (async BlockNote parser)
      const fm = parseFrontmatter(body.markdown)
      const meta = frontmatterToMeta(fm, page.properties, page.aliases)
      const incoming = await importBlocks(fm.body, page.workspaceId, user.id)
      blocksToStateBuffer(incoming) // throws on unconvertible input — live doc untouched

      // (3) compare-and-write on the live document in ONE synchronous Yjs section
      let mismatch = false
      const conn = await hocuspocus.openDirectConnection(id)
      try {
        await conn.transact((doc) => {
          const current = splitRevision(revisionFromDoc(doc, expected.meta)).doc
          if (current !== expected.doc) {
            mismatch = true
            return
          }
          const frag = doc.getXmlFragment('document')
          doc.transact(() => {
            frag.delete(0, frag.length)
            blocksToXmlFragment(incoming, frag)
          })
        })
      } finally {
        await conn.disconnect()
      }
      if (mismatch) return preconditionFailed(reply, await renderPage(page, user.id))

      // (4) metadata (frontmatter) — re-read what Postgres stored to hash its canonical jsonb
      const [updated] = await db
        .update(pages)
        .set({ properties: meta.properties, aliases: meta.aliases, updatedAt: new Date() })
        .where(eq(pages.id, id))
        .returning({
          id: pages.id,
          workspaceId: pages.workspaceId,
          kind: pages.kind,
          properties: pages.properties,
          aliases: pages.aliases,
        })
      const result = await renderPage(updated, user.id)
      return { ...result, droppedFrontmatterKeys: fm.dropped }
    },
  )

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  app.post(
    '/workspaces/:id/sync/pages',
    {
      preHandler: requireUser,
      bodyLimit: 4 * 1024 * 1024,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    },
    async (req) => {
      const user = getUser(req)
      const workspaceId = idParam(req.params)
      const role = await requireMembership(workspaceId, user.id)
      const body = createBodySchema.parse(req.body)

      const parentId = body.parentId ?? null
      if (parentId) {
        const parent = await findVisiblePage(parentId, user.id)
        if (!parent || parent.workspaceId !== workspaceId) throw badRequest('Invalid parent page')
      }

      let properties: unknown = []
      let aliases: unknown = []
      let blocks: AnyBlock[] = EMPTY_BLOCKS
      let dropped: string[] = []
      if (body.kind === 'doc' && body.markdown !== undefined) {
        const fm = parseFrontmatter(body.markdown)
        const meta = frontmatterToMeta(fm, [], [])
        properties = meta.properties
        aliases = meta.aliases
        dropped = fm.dropped
        blocks = await importBlocks(fm.body, workspaceId, user.id)
      }
      const state = body.kind === 'doc' ? blocksToStateBuffer(blocks) : null

      // Tree change: parent liveness, depth cap and public-folder rule under the tree lock
      // (docs/adr/0800-*).
      const created = await withTreeLock(workspaceId, async (tx) => {
        let scope: PageScope = 'shared'
        if (parentId) {
          const chain = await assertPlacement(tx, { workspaceId, parentId, role })
          scope = chain[0].scope
        }
        const parentCond = parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId)
        const [{ maxSort }] = await tx
          .select({ maxSort: max(pages.sortOrder) })
          .from(pages)
          .where(and(eq(pages.workspaceId, workspaceId), parentCond))
        const [row] = await tx
          .insert(pages)
          .values({
            workspaceId,
            parentId,
            kind: body.kind,
            scope,
            title: body.title,
            sortOrder: (maxSort ?? 0) + 1000,
            createdBy: user.id,
            properties,
            aliases,
          })
          .returning({
            id: pages.id,
            workspaceId: pages.workspaceId,
            parentId: pages.parentId,
            kind: pages.kind,
            title: pages.title,
            updatedAt: pages.updatedAt,
            properties: pages.properties,
            aliases: pages.aliases,
          })
        if (state) await tx.insert(pageDocs).values({ pageId: row.id, state })
        return row
      })
      if (body.kind !== 'doc') {
        return {
          page: {
            id: created.id,
            parentId: created.parentId,
            kind: created.kind,
            title: created.title,
            updatedAt: created.updatedAt.toISOString(),
          },
        }
      }
      await reindexAll(created.id, blocks)
      const result = await renderPage(created, user.id)
      return {
        page: {
          id: created.id,
          parentId: created.parentId,
          kind: created.kind,
          title: created.title,
          updatedAt: created.updatedAt.toISOString(),
        },
        ...result,
        droppedFrontmatterKeys: dropped,
      }
    },
  )

  // ---------------------------------------------------------------------------
  // delete (trash) — only a leaf page, only if unchanged since the client's last sync
  // ---------------------------------------------------------------------------
  app.delete(
    '/pages/:id/sync',
    { preHandler: requireUser, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const { expectedRevision } = deleteQuerySchema.parse(req.query)
      const page = await loadMetaRow(id, user.id)
      if (!page) throw notFound()
      await requireMembership(page.workspaceId, user.id)

      if (page.kind === 'doc') {
        if (!expectedRevision) throw badRequest('expectedRevision is required for documents')
        const { revision } = await snapshotPage(page)
        if (revision !== expectedRevision) return preconditionFailed(reply, await renderPage(page, user.id))
      }
      // Leaf check and trash in one transaction under the tree lock, so a child created
      // concurrently is either seen here (409) or refused by its own placement check.
      await withTreeLock(page.workspaceId, async (tx) => {
        const child = await tx
          .select({ id: pages.id })
          .from(pages)
          .where(and(eq(pages.parentId, id), isNull(pages.deletedAt)))
          .limit(1)
        if (child.length) {
          throw new AppError(409, 'HAS_CHILDREN', 'The page has sub-pages; delete them first')
        }
        await tx
          .update(pages)
          .set({ deletedAt: sql`now()` })
          .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
      })
      return reply.code(204).send()
    },
  )
}
