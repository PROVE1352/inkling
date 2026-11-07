import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { files, pageDocs } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { env } from '../env'
import { idParam, requireMembership } from '../helpers'
import type { AnyBlock } from '../md/convert'
import { markdownToBlocks, stateToBlocks, stripFrontmatter } from '../md/convert'
import { exportPageMd } from '../md/exporter'
import type { PageRow } from '../pageDto'
import { findVisiblePage } from '../pageDto'
import { NotionClient, extractNotionPageId } from '../notion/client'
import type { NotionBlock } from '../notion/mapper'
import { blocksToNotion, countBlocks, toPreview, toWire } from '../notion/mapper'

const publishSchema = z.object({
  parentUrl: z.string().trim().min(1),
  dryRun: z.boolean().optional(),
})

/** Notion append allows 100 children per request. */
const APPEND_BATCH = 100

/** Loads the page body blocks. Collections parse their table Markdown; everything else parses the Yjs state. */
async function loadPageBlocks(page: PageRow, userId: string): Promise<AnyBlock[]> {
  if (page.kind === 'collection') {
    const { body } = await exportPageMd(page, userId)
    return markdownToBlocks(stripFrontmatter(body), () => null)
  }
  const row = (
    await db
      .select({ state: pageDocs.state })
      .from(pageDocs)
      .where(eq(pageDocs.pageId, page.id))
      .limit(1)
  )[0]
  if (!row) return []
  try {
    return stateToBlocks(row.state)
  } catch {
    return []
  }
}

/** Uploader for internal attached images — check the file row + read from disk → Notion file_upload id. */
function makeUploader(
  client: NotionClient,
  workspaceId: string,
  userId: string,
): (asset: { fileId: string; name: string }) => Promise<string | null> {
  return async ({ fileId, name }) => {
    const row = (
      await db
        .select({
          mime: files.mime,
          name: files.name,
          workspaceId: files.workspaceId,
          pageId: files.pageId,
        })
        .from(files)
        .where(eq(files.id, fileId))
        .limit(1)
    )[0]
    if (!row || row.workspaceId !== workspaceId) return null
    // Hardening H3: a file attached to a page is uploaded only if that page is visible to the requester
    // (same as the files.ts download gate; a null pageId is legacy and allowed). Otherwise fall back to null.
    if (row.pageId) {
      const filePage = await findVisiblePage(row.pageId, userId)
      if (!filePage) return null
    }
    const diskPath = path.join(env.dataDir, 'uploads', fileId)
    let buffer: Buffer
    try {
      buffer = await readFile(diskPath)
    } catch {
      return null
    }
    return client.uploadFile(buffer, name || row.name || 'image', row.mime)
  }
}

/** Appends in chunks of 100 + recurses into nested children (__children). Table rows go inline in table.children. */
async function appendAll(
  client: NotionClient,
  parentBlockId: string,
  blocks: NotionBlock[],
): Promise<void> {
  for (let i = 0; i < blocks.length; i += APPEND_BATCH) {
    const slice = blocks.slice(i, i + APPEND_BATCH)
    const res = await client.appendChildren(parentBlockId, slice.map(toWire))
    const ids = res.results ?? []
    for (let j = 0; j < slice.length; j++) {
      const kids = slice[j].__children
      const childId = ids[j]?.id
      if (Array.isArray(kids) && kids.length > 0 && childId) {
        await appendAll(client, childId, kids)
      }
    }
  }
}

export async function registerNotionRoutes(app: FastifyInstance): Promise<void> {
  // Upload a page as a Notion child page. dryRun=true only checks the mapping, no token needed.
  //  The NOTION_TOKEN is one instance-wide credential: real uploads are limited to workspace
  //  owners and rate-limited (C-L11). Dry runs (mapping check, no token) stay open to members.
  app.post(
    '/pages/:id/publish/notion',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const body = publishSchema.parse(req.body)
    const dryRun = body.dryRun === true

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    const role = await requireMembership(page.workspaceId, user.id)
    if (!dryRun && role !== 'owner') {
      throw forbidden('Only workspace owners can upload to Notion')
    }

    // a real upload needs the token — without it the feature is disabled (501)
    if (!dryRun && !env.notionToken) {
      throw new AppError(
        501,
        'NOTION_DISABLED',
        'Notion upload is disabled. Set NOTION_TOKEN in the server .env.',
      )
    }

    const blocks = await loadPageBlocks(page, user.id)

    // dryRun: return the mapping snapshot without calling Notion (no token needed)
    if (dryRun) {
      const { blocks: mapped, warnings } = await blocksToNotion(blocks)
      return {
        mapped: countBlocks(mapped),
        warnings,
        preview: mapped.slice(0, 3).map(toPreview),
      }
    }

    // real upload
    const parentId = extractNotionPageId(body.parentUrl)
    if (!parentId) {
      throw badRequest('Could not find a page id in the Notion parent page URL.')
    }

    const client = new NotionClient(env.notionToken as string)
    const { blocks: mapped, warnings } = await blocksToNotion(blocks, {
      uploadImage: makeUploader(client, page.workspaceId, user.id),
    })

    const created = await client.createPage(parentId, page.title)
    await appendAll(client, created.id, mapped)

    return { url: created.url, blockCount: countBlocks(mapped), warnings }
    },
  )
}
