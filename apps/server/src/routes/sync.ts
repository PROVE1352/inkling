import { assertWorkspaceRoom } from '../quota/room'
import { createHash } from 'node:crypto'
import { assertPlacement, withTreeLock } from '../pageTree'
import { assertPageEditable } from '../editLock'
import { applyDocumentReplace, buildEchoIndex, readBlocks } from '../context/sectionPatch'
import { and, eq, gt, inArray, isNull, isNotNull, max, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { PageScope } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { hocuspocus } from '../collab'
import { bumpDocGen } from '../docGen'
import { db } from '../db/index'
import { pageDocs, pageLinks, pages, pageSyncHashes } from '../db/schema'
import { AppError, badRequest, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { memberOrGuestSql } from '../pageGrants'
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
  hoistInlineImages,
  isLegacyRevision,
  linkTargets,
  metaHash,
  parseFrontmatter,
  renderSyncMarkdown,
  revisionFromDoc,
  revisionFromState,
  revisionSvPart,
  splitRevision,
  wikiTitleResolver,
} from '../md/syncMd'
import { reindexPageTags } from '../md/tagIndex'
import { reindexPageTasks } from '../md/taskIndex'
import { reindexPageChunks } from '../context/chunkIndex'
import { reindexPageText } from '../md/textIndex'
import { findVisiblePage, visibleTo } from '../pageDto'
import { assertTopLevelInRange } from '../tokenRange'
import { actorOf } from '../context/attribution'
import { recordPageEvents } from '../context/changeLog'
import { outboxCommitted } from '../outbox'
import type { ParsedFrontmatter } from '../md/syncMd'

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
  /** Retry key of this create (docs/adr/2166-*): the same key creates the page once. */
  clientKey: z.uuid().optional(),
})
const deleteQuerySchema = z.object({ expectedRevision: z.string().min(1).max(80).optional() })

/**
 * Page id of a vault-sync create with a client key (docs/adr/2166-*): derived from the workspace and
 * the key, so a retried create finds the page the lost first attempt made, and the CLI can tell that
 * page apart from others before asking. The CLI computes the same value (apps/cli/src/sync/vault.ts
 * `syncCreateId`). The key is a random UUID the client keeps until the create succeeded; nobody can
 * pick a key that lands on a given existing id.
 */
export function syncCreateId(workspaceId: string, clientKey: string): string {
  const h = createHash('sha256').update(`inkling-vault-sync-create\u0000${workspaceId.toLowerCase()}\u0000${clientKey.toLowerCase()}`).digest()
  h[6] = (h[6] & 0x0f) | 0x40
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

/**
 * Frontmatter keys of a note that the page does not store (docs/adr/2168-*): the parser's dropped
 * keys (nested maps, block scalars) plus keys that did not become a property (the reserved
 * `updated`, keys past the property limit). The CLI keeps them in the note instead of rewriting
 * them away.
 */
function droppedKeys(fm: ParsedFrontmatter, properties: { name: string }[]): string[] {
  const out = [...fm.dropped]
  const stored = new Set(properties.map((p) => p.name.toLowerCase()))
  for (const raw of fm.data.keys()) {
    const key = raw.trim()
    const lower = key.toLowerCase()
    if (!key || lower === 'inkling-id' || lower === 'aliases' || lower === 'alias') continue
    if (!stored.has(key.slice(0, 60).toLowerCase())) out.push(raw)
  }
  return out
}

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

/**
 * Format of the sync Markdown, part of every revision's metadata half: a token issued for another
 * format never matches, so a client holding text in the old form merges with the current form
 * instead of writing it over the page. `2` (0.17): blocks without a plain form as block tokens
 * (docs/adr/2169-*); before it the half had no marker.
 */
const SYNC_MD_FORMAT = 'md2'
const metaOf = (properties: unknown, aliases: unknown, sig: string) => metaHash(properties, aliases, `${SYNC_MD_FORMAT}|${sig}`)

async function pageMetaHash(page: MetaRow): Promise<string> {
  const sig = (await linkSigs([page.id])).get(page.id) ?? ''
  return metaOf(page.properties, page.aliases, sig)
}

/** The metadata half as servers before 0.17 wrote it (DELETE accepts it, docs/adr/2169-*). */
async function pageMetaHashBefore017(page: MetaRow): Promise<string> {
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
  const blocks = await markdownToBlocks(hoistInlineImages(markdownBody), resolve)
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
      // outside the workspace: "not found", like a missing id (docs/adr/1301-*)
      .where(and(eq(pages.id, pageId), isNull(pages.deletedAt), visibleTo(userId), memberOrGuestSql(pages.workspaceId, userId, false)))
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
        if (live) revisions.set(r.id, revisionFromDoc(live, metaOf(r.properties, r.aliases, sigs.get(r.id) ?? '')))
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
          revisions.set(r.id, revisionFromState(byId.get(r.id) ?? null, metaOf(r.properties, r.aliases, sigs.get(r.id) ?? '')))
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
      await assertPageEditable(id, user.id)
      if (page.kind !== 'doc') throw badRequest('Only document pages hold markdown')

      // A token from before 0.15.1 (no deletion half, docs/adr/1920-*) never matches below: the
      // client gets the current version with the 412 and merges, so a deletion it never saw survives.
      const expected = splitRevision(body.expectedRevision)

      // (1) parse outside the document lock (async BlockNote parser)
      const fm = parseFrontmatter(body.markdown)
      const meta = frontmatterToMeta(fm, page.properties, page.aliases)
      const incoming = await importBlocks(fm.body, page.workspaceId, user.id)
      blocksToStateBuffer(incoming) // throws on unconvertible input — live doc untouched

      // A stale token is refused (412 with the current version), except when the page already holds
      // exactly this note: a retried write whose first answer was lost (docs/adr/2166-*). Nothing is
      // written then, so nothing can be lost.
      const stale = async () => {
        const cur = await renderPage(page, user.id)
        const titles = await linkTitles(incoming, page.workspaceId, user.id)
        const asSent = await renderSyncMarkdown({ id: page.id, properties: meta.properties, aliases: meta.aliases }, incoming, titles)
        if (contentHashOf(asSent) === cur.contentHash) return { ...cur, droppedFrontmatterKeys: droppedKeys(fm, meta.properties) }
        return preconditionFailed(reply, cur)
      }

      // (2) metadata half of the token — properties/aliases
      if (expected.meta !== (await pageMetaHash(page))) return stale()

      // (3) compare-and-write on the live document in ONE synchronous Yjs section
      let mismatch = false
      let rewrote = false
      const conn = await hocuspocus.openDirectConnection(id)
      try {
        // Echo of the current blocks (async, before the synchronous section): lets the minimal
        // replace recognise blocks the note left alone through the Markdown round trip.
        const echo = conn.document
          ? await buildEchoIndex(readBlocks(conn.document), wikiTitleResolver(await buildTitleResolver(page.workspaceId, new Map(), user.id)), {}, incoming).catch(() => null)
          : null
        await conn.transact((doc) => {
          const current = splitRevision(revisionFromDoc(doc, expected.meta)).doc
          if (current !== expected.doc) {
            mismatch = true
            return
          }
          const frag = doc.getXmlFragment('document')
          // A minimal edit of the whole document (the update_page replace path, docs/adr/1500-*):
          // blocks the note did not change keep their nodes, so typing still on its way from a
          // browser into them survives instead of landing in deleted text (docs/adr/1920-*).
          if (frag.length > 0) {
            try {
              applyDocumentReplace(doc, incoming, echo)
              return
            } catch (err) {
              // validated on a copy first: nothing was written; rewrite as before
              console.warn(`[vault-sync] minimal replace not applied (${err instanceof Error ? err.message : String(err)}); rewriting the document`)
            }
          }
          rewrote = frag.length > 0
          doc.transact(() => {
            frag.delete(0, frag.length)
            blocksToXmlFragment(incoming, frag)
          })
        })
      } finally {
        await conn.disconnect()
      }
      if (mismatch) return stale()
      // a full rewrite takes the body away wholesale: device copies must not merge blindly (docs/adr/2201-*)
      if (rewrote) await bumpDocGen(id)

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
      return { ...result, droppedFrontmatterKeys: droppedKeys(fm, meta.properties) }
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
      // a subtree-limited connection creates only under its subtree (docs/adr/1202-*)
      if (!parentId) assertTopLevelInRange(workspaceId, user.id)
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
        dropped = droppedKeys(fm, meta.properties)
        blocks = await importBlocks(fm.body, workspaceId, user.id)
      }
      const state = body.kind === 'doc' ? blocksToStateBuffer(blocks) : null

      // A retried create (docs/adr/2166-*): the page the first attempt made is answered again, as it is
      // now. Only a live page of this workspace, kind and author counts; otherwise a fresh id is used.
      let wantedId = body.clientKey ? syncCreateId(workspaceId, body.clientKey) : null
      if (wantedId) {
        const prev = await findVisiblePage(wantedId, user.id)
        const [own] = prev
          ? await db.select({ createdBy: pages.createdBy }).from(pages).where(eq(pages.id, wantedId)).limit(1)
          : []
        if (prev && prev.workspaceId === workspaceId && prev.kind === body.kind && own?.createdBy === user.id) {
          const pageOut = { id: prev.id, parentId: prev.parentId, kind: prev.kind, title: prev.title, updatedAt: new Date(prev.updatedAt).toISOString() }
          if (body.kind !== 'doc') return { page: pageOut, replayed: true }
          const meta = await loadMetaRow(prev.id, user.id)
          if (meta) return { page: pageOut, replayed: true, ...(await renderPage(meta, user.id)), droppedFrontmatterKeys: dropped }
        }
        // the id is taken by something else (a trashed page, another kind): an ordinary new id
        if (prev || (await db.select({ id: pages.id }).from(pages).where(eq(pages.id, wantedId)).limit(1)).length) wantedId = null
      }

      // Tree change: parent liveness, depth cap and public-folder rule under the tree lock
      // (docs/adr/0800-*).
      const created = await withTreeLock(workspaceId, async (tx) => {
        let scope: PageScope = 'shared'
        if (parentId) {
          const chain = await assertPlacement(tx, { workspaceId, parentId, role, userId: user.id })
          scope = chain[0].scope
        }
        const parentCond = parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId)
        const [{ maxSort }] = await tx
          .select({ maxSort: max(pages.sortOrder) })
          .from(pages)
          .where(and(eq(pages.workspaceId, workspaceId), parentCond))
        await assertWorkspaceRoom(tx, workspaceId, { pages: 1 }) // docs/adr/2505-*
        const [row] = await tx
          .insert(pages)
          .values({
            ...(wantedId ? { id: wantedId } : {}),
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
      await assertPageEditable(id, user.id)

      if (page.kind === 'doc') {
        if (!expectedRevision) throw badRequest('expectedRevision is required for documents')
        const { revision } = await snapshotPage(page)
        // A token from before 0.15.1 has no deletion half (docs/adr/1920-*). Trashing is still safe
        // when nothing was inserted or reformatted since (same state vector, same metadata): only
        // deletions can have happened, and the whole page goes to the trash anyway.
        // A token from before 0.17 has the metadata half without the format marker (docs/adr/2169-*):
        // the same page state, so trashing is as safe as with a current token.
        const exp = splitRevision(expectedRevision)
        const cur = splitRevision(revision)
        const metaOk = exp.meta === cur.meta || exp.meta === (await pageMetaHashBefore017(page))
        const legacyOk =
          metaOk &&
          (exp.doc === cur.doc || (isLegacyRevision(expectedRevision) && revisionSvPart(expectedRevision) === revisionSvPart(revision)))
        if (revision !== expectedRevision && !legacyOk) return preconditionFailed(reply, await renderPage(page, user.id))
      }
      // Leaf check and trash in one transaction under the tree lock, so a child created
      // concurrently is either seen here (409) or refused by its own placement check.
      let trashed = 0
      await withTreeLock(page.workspaceId, async (tx) => {
        const child = await tx
          .select({ id: pages.id })
          .from(pages)
          .where(and(eq(pages.parentId, id), isNull(pages.deletedAt)))
          .limit(1)
        if (child.length) {
          throw new AppError(409, 'HAS_CHILDREN', 'The page has sub-pages; delete them first')
        }
        const rows = await tx
          .update(pages)
          .set({ deletedAt: sql`now()` })
          .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
          .returning({ id: pages.id })
        // the change feed sees a vault delete like a trash from the web app (docs/adr/1150-*)
        await recordPageEvents(rows.map((r) => ({ pageId: r.id, kind: 'page_trashed' as const })), actorOf(user), tx)
        trashed = rows.length
      })
      if (trashed) outboxCommitted(['change'])
      return reply.code(204).send()
    },
  )
}
