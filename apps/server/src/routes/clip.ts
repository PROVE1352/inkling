import { createHash } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  CLIP_DATE_PROPERTY,
  CLIP_SOURCE_PROPERTY,
  clipRequestSchema,
  parseHttpUrl,
} from '@inkling/shared'
import type { ClipFallback, ClipLookupDTO, ClipMode, ClipResultDTO, PageProperty } from '@inkling/shared'
import { getUser, requireUser, SESSION_COOKIE } from '../auth'
import { articleBlocks, clipBodyBlocks, clipDate, clipSourceUrl } from '../clip/blocks'
import { extractArticle } from '../clip/extract'
import { fetchArticleHtml } from '../clip/fetchArticle'
import { acquireClipFetch } from '../clip/limits'
import { actorOf, withEditActor } from '../context/attribution'
import { reindexPageChunks } from '../context/chunkIndex'
import { db } from '../db/index'
import { pageDocs, pages } from '../db/schema'
import { actorFor, assertCan } from '../editLock'
import { AppError, badRequest } from '../errors'
import { requireMembership } from '../helpers'
import { requestLocale, type Locale } from '../i18n'
import { blocksToStateBuffer, stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { reindexPageLinks } from '../md/linkIndex'
import { reindexPageTags } from '../md/tagIndex'
import { reindexPageTasks } from '../md/taskIndex'
import { reindexPageText } from '../md/textIndex'
import { outboxCommitted } from '../outbox'
import { findVisiblePage, pageColumns, toPageDTO, visibleTo } from '../pageDto'
import { assertPlacement, withTreeLock } from '../pageTree'
import { rateLimitKey } from '../rateLimitKey'
import { assertTopLevelInRange } from '../tokenRange'
import { enqueueWebhookEvent } from '../webhooks'

/**
 * Web clipper (docs/adr/2260-* .. 2263-*).
 *
 *   POST /api/clip          save a link (+ selected text) or, in the browser, a page's article as a new page
 *   GET  /api/clip/lookup   pages already saved from a URL (the /clip screen asks before saving twice)
 *
 * The same checks as POST /pages: membership (guests under pages shared with them for editing), the
 * connection's range, a visible parent in the same workspace, the edit lock through assertPlacement
 * (inside the tree lock), suggest-only connections refused by requireMembership. They all run before
 * anything is fetched. `article` is for browser sessions only: a token (MCP connection or API token)
 * that could make the server GET any URL would be a way out for an agent steered by injected text
 * (docs/adr/2262-*). Not an MCP tool.
 *
 * The page is written like an imported Markdown file (md/importer.ts importMarkdown): the document
 * row and the derived indexes in the request, so the change feed logs the page as added when its
 * chunks are first indexed and the injection heuristics run on the clipped text as on any page.
 */

const NAMES = {
  en: {
    source: 'Source',
    clipped: 'Clipped',
    untitled: 'Untitled',
    saved: (when: string) => `Saved ${when} from`,
    savedNoUrl: (when: string) => `Saved ${when}`,
    truncated: 'The article was long; only its beginning was saved. The full text is at the source.',
  },
  ko: {
    source: '출처',
    clipped: '저장한 날',
    untitled: '제목 없음',
    saved: (when: string) => `${when}에 저장, 출처`,
    savedNoUrl: (when: string) => `${when}에 저장`,
    truncated: '본문이 길어 앞부분만 저장했습니다. 전체 글은 출처에서 볼 수 있습니다.',
  },
} satisfies Record<Locale, Record<string, unknown>>

/** Per-browser-session limiter key (like routes/linkPreview.ts); tokens and others by rateLimitKey. */
function clipKey(req: FastifyRequest): string {
  const sid = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE]
  return sid ? 'clip:' + createHash('sha256').update(sid).digest('base64url').slice(0, 22) : 'clip-' + rateLimitKey(req)
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const oneLine = (s: string) => s.replace(CONTROL, '').replace(/\s+/g, ' ').trim()

const lookupQuery = z.object({ workspaceId: z.uuid(), url: z.string().min(1).max(4096) })

export async function registerClipRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/clip',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: clipKey } },
    },
    async (req): Promise<ClipResultDTO> => {
      const user = getUser(req)
      const body = clipRequestSchema.parse(req.body)
      const url = clipSourceUrl(body.url)
      if (body.url?.trim() && !url) throw new AppError(400, 'CLIP_INVALID_URL', 'The URL must be an http or https address')
      const selection = body.text ? body.text.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim() : ''
      if (!url && !selection) throw badRequest('Nothing to save: give a URL or some text')
      if (body.mode === 'article' && !url) throw badRequest('Saving an article needs its URL')
      if (body.mode === 'article' && req.authVia !== 'cookie') {
        throw new AppError(
          403,
          'CLIP_ARTICLE_SESSION_ONLY',
          'Fetching a web page to save its article is only available in the web app; with a token, save it as a link (mode "link")',
        )
      }

      // Permissions first, before anything is fetched (same rules as POST /pages).
      const role = await requireMembership(body.workspaceId, user.id, { guests: true })
      const parentId = body.parentId ?? null
      if (!parentId) assertTopLevelInRange(body.workspaceId, user.id)
      else {
        const parent = await findVisiblePage(parentId, user.id)
        if (!parent || parent.workspaceId !== body.workspaceId) throw badRequest('Parent page is invalid')
        // early answer for a locked parent; assertPlacement checks again under the tree lock
        await assertCan(db, parentId, actorFor(user.id, role))
      }

      const locale = await requestLocale(req, user.id)
      const names = NAMES[locale]

      // Fetch and extract (article), falling back to a link clip that says why.
      let mode: ClipMode = 'link'
      let fallback: ClipFallback | undefined
      let truncated = false
      let article: AnyBlock[] | null = null
      let pageTitle: string | null = null
      if (body.mode === 'article' && url) {
        const release = acquireClipFetch(user.id)
        try {
          const fetched = await fetchArticleHtml(url, { acceptLanguage: locale === 'ko' ? 'ko,en;q=0.8' : 'en' })
          if (!fetched.ok) fallback = fetched.reason
          else {
            const extracted = extractArticle(fetched.html, fetched.url)
            pageTitle = extracted?.title ?? null
            if (!extracted) fallback = 'no_content'
            else {
              const built = await articleBlocks(extracted.html)
              if (built.blocks.length === 0) fallback = 'no_content'
              else {
                article = built.blocks
                mode = 'article'
                truncated = extracted.truncated || fetched.truncatedBytes || built.cut
              }
            }
          }
        } finally {
          release()
        }
      }

      const title = oneLine(body.title ?? '').slice(0, 300) || pageTitle?.slice(0, 300) || (url ? new URL(url).host : '') || names.untitled
      const now = new Date()
      const when = `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`
      const blocks = clipBodyBlocks({
        url,
        selection: selection || null,
        tags: body.tags ?? [],
        savedLine: url ? names.saved(when) : names.savedNoUrl(when),
        article,
        truncatedNote: truncated ? names.truncated : null,
      })
      const properties: PageProperty[] = [
        ...(url ? [{ id: CLIP_SOURCE_PROPERTY, name: names.source, type: 'url' as const, value: url }] : []),
        { id: CLIP_DATE_PROPERTY, name: names.clipped, type: 'date', value: clipDate(body.localDate, now) },
      ]

      const { queued, ...row } = await withTreeLock(body.workspaceId, async (tx) => {
        let scope: 'shared' | 'private' = 'shared'
        if (parentId) {
          const chain = await assertPlacement(tx, { workspaceId: body.workspaceId, parentId, role, userId: user.id })
          scope = chain[0].scope as 'shared' | 'private'
        }
        const parentCond = parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId)
        const [{ maxSort }] = await tx
          .select({ maxSort: sql<number | null>`max(${pages.sortOrder})` })
          .from(pages)
          .where(and(eq(pages.workspaceId, body.workspaceId), parentCond))
        const [page] = await tx
          .insert(pages)
          .values({
            workspaceId: body.workspaceId,
            parentId,
            kind: 'doc',
            scope,
            title,
            sortOrder: (maxSort ?? 0) + 1000,
            createdBy: user.id,
            createdVia: user.via ? user.via.slice(0, 100) : null,
            properties,
          })
          .returning(pageColumns)
        const queued =
          page.scope === 'shared'
            ? await enqueueWebhookEvent(tx, { type: 'page_created', workspaceId: body.workspaceId, pageId: page.id, actorId: user.id })
            : 0
        return { ...page, queued }
      })
      if (queued > 0) outboxCommitted(['webhook'])

      // The body, then the derived indexes (as an imported Markdown file). Indexing the chunks for the
      // first time logs page_added (with this request's actor) and computes the injection flags.
      const state = blocksToStateBuffer(blocks)
      await db.insert(pageDocs).values({ pageId: row.id, state })
      const stored = stateToBlocks(state)
      await withEditActor([row.id], actorOf(user), async () => {
        await reindexPageLinks(row.id, stored)
        await reindexPageText(row.id, stored)
        await reindexPageChunks(row.id, stored)
        await reindexPageTags(row.id, stored)
        await reindexPageTasks(row.id, stored)
      })

      return { page: toPageDTO(row), mode, ...(fallback ? { fallback } : {}), ...(truncated ? { truncated } : {}) }
    },
  )

  app.get('/clip/lookup', { preHandler: requireUser }, async (req): Promise<ClipLookupDTO> => {
    const user = getUser(req)
    const q = lookupQuery.parse(req.query)
    await requireMembership(q.workspaceId, user.id, { guests: true })
    const url = clipSourceUrl(q.url)
    if (!url) return { pages: [] }
    const match = JSON.stringify([{ id: CLIP_SOURCE_PROPERTY, value: url }])
    const rows = await db
      .select({ id: pages.id, title: pages.title, workspaceId: pages.workspaceId, createdAt: pages.createdAt })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, q.workspaceId),
          isNull(pages.deletedAt),
          visibleTo(user.id),
          sql`${pages.properties} @> ${match}::jsonb`,
        ),
      )
      .orderBy(desc(pages.createdAt))
      .limit(5)
    return { pages: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) }
  })
}
