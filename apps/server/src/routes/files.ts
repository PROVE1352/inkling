import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { currentRange, guestOutside, outOfRange } from '../tokenRange'
import { assertPageEditable, suggestionRight } from '../editLock'
import { createReadStream, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { FileDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { files } from '../db/schema'
import { AppError, badRequest, notFound } from '../errors'
import { env } from '../env'
import { idParam, requireMembership } from '../helpers'
import { memberOrGuestSql } from '../pageGrants'
import { findVisiblePage } from '../pageDto'
import { cutUploadError, streamToFile } from './exportImport'
import { AGENT_UPLOAD_MAX_BYTES, agentUploadMime } from '../uploadCheck'
import { assertAgentUploadsAllowed, assertDailyUploadBudget, mbText } from '../agentUploads'
import { currentConnectionKey } from '../agentAccess'

const MAX_FILE_BYTES = 25 * 1024 * 1024

const uploadQuerySchema = z.object({
  workspaceId: z.uuid(),
  pageId: z.uuid().optional(),
})

// Safe raster images that may render inline (cannot run scripts).
// SVG is an active (scriptable) type, so it is not here and is only served as an attachment.
const SAFE_INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

// Allowed upload MIME types: safe rasters + pdf + mp4/webm video + mpeg/mp4/wav audio + text/plain.
// No image/* shortcut (blocks active types such as svg). Everything but rasters downloads as an attachment.
const ALLOWED_MIME = new Set([
  ...SAFE_INLINE_MIME,
  'application/pdf',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'text/plain',
  // 0.16 (docs/adr/2045-*): agent results; attachments only, like every non-raster type
  'text/csv',
  'text/markdown',
  'application/json',
])

function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME.has(mime)
}

function isTooLargeError(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null
  return e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413
}

function uploadPath(id: string): string {
  return path.join(env.dataDir, 'uploads', id)
}

/** POST /api/files: registered inside the /api group */
export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/files', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { workspaceId, pageId } = uploadQuerySchema.parse(req.query)
    const role = await requireMembership(workspaceId, user.id, { guests: true })
    // A guest uploads only into a page shared with them that they can edit (docs/adr/1252-*).
    if (role === 'guest' && !pageId) throw guestOutside()

    // With a pageId, link the file only after checking the page is visible to the requester
    // (protects private attachments). If it is not visible or in another workspace, 404 to hide
    // that it exists. Without one, null (legacy compatibility).
    // A connection (MCP upload_file, API token; docs/adr/2044-*, 2045-*) uploads into a page it may
    // edit or suggest on — lock rules, people rows and its range apply — with a smaller cap, a daily
    // budget, and a type the server decides from the name and the bytes.
    const bearer = req.authVia === 'bearer'
    if (bearer && !pageId) throw badRequest('Uploads through a connection go into a page: pass pageId')
    // Server default and workspace switch (docs/adr/2065-*); people's uploads are not affected.
    if (bearer) await assertAgentUploadsAllowed(workspaceId)
    let filePageId: string | null = null
    if (pageId) {
      const page = await findVisiblePage(pageId, user.id)
      if (!page || page.workspaceId !== workspaceId) throw notFound()
      if (role === 'guest') await assertPageEditable(pageId, user.id, { role })
      if (bearer) {
        if (!(await suggestionRight(db, pageId, user.id, role))) await assertPageEditable(pageId, user.id, { role })
        await assertDailyUploadBudget(user.id)
      }
      filePageId = pageId
    }

    // a connection's cap may be above the browser's 25 MB (AGENT_UPLOAD_MAX_MB, docs/adr/2065-*)
    const mp = await req.file(bearer ? { limits: { fileSize: AGENT_UPLOAD_MAX_BYTES } } : undefined).catch((err: unknown) => {
      throw cutUploadError(err)
    })
    if (!mp) throw badRequest('No file to upload')

    let mime = mp.mimetype
    if (!bearer && !isAllowedMime(mime)) {
      mp.file.resume() // drain so the request can finish
      throw new AppError(415, 'UNSUPPORTED_TYPE', 'This file type is not supported')
    }

    const name = path.basename(mp.filename || 'file').slice(0, 200)
    const maxBytes = bearer ? AGENT_UPLOAD_MAX_BYTES : MAX_FILE_BYTES
    const tooLarge = () =>
      new AppError(413, 'PAYLOAD_TOO_LARGE', bearer ? `File is too large (max ${mbText(AGENT_UPLOAD_MAX_BYTES)} through a connection)` : 'File is too large (max 25MB)')

    // Stream straight to a temp file next to the final location, then rename (docs/adr/0751-*).
    // Previously toBuffer() held the whole file (up to 25 MB) per concurrent upload.
    const tmp = uploadPath(`.upload-${randomUUID()}`)
    let size: number
    try {
      size = await streamToFile(mp.file, tmp, maxBytes)
    } catch (err) {
      await rm(tmp, { force: true })
      if (isTooLargeError(err)) throw tooLarge()
      throw cutUploadError(err)
    }
    if (mp.file.truncated || size < 0 || size > maxBytes) {
      await rm(tmp, { force: true })
      throw tooLarge()
    }
    if (bearer) {
      const typed = agentUploadMime(name, await readFile(tmp))
      if ('error' in typed) {
        await rm(tmp, { force: true })
        throw new AppError(415, 'UNSUPPORTED_TYPE', `Not uploaded: ${typed.error}`)
      }
      mime = typed.mime
    }

    let row: { id: string }
    try {
      ;[row] = await db
        .insert(files)
        .values({
          workspaceId,
          pageId: filePageId,
          name,
          mime,
          size,
          createdBy: user.id,
          uploadedVia: bearer ? (currentConnectionKey() ?? 'bearer') : null,
        })
        .returning({ id: files.id })
      await rename(tmp, uploadPath(row.id))
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }

    const dto: FileDTO = {
      id: row.id,
      url: `/files/${row.id}`,
      name,
      mime,
      size,
    }
    return { file: dto }
  })

  // File metadata (for MCP read_file, docs/adr/1514-*): the download route's checks, without the
  // bytes, so an agent tool can decide by type and size before fetching. A connection limited to
  // a subtree gets no legacy file without a page (they belong to the whole workspace).
  app.get('/files/:id/meta', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const row = (
      await db.select().from(files).where(and(eq(files.id, id), memberOrGuestSql(files.workspaceId, user.id))).limit(1)
    )[0]
    if (!row) throw notFound()
    const role = await requireMembership(row.workspaceId, user.id, { guests: true })
    if (role === 'guest' && !row.pageId) throw notFound()
    if (row.pageId) {
      const page = await findVisiblePage(row.pageId, user.id)
      if (!page) throw notFound()
    } else if (currentRange(user.id)?.kind === 'subtree') {
      throw outOfRange()
    }
    if (!existsSync(uploadPath(id))) throw notFound()
    return {
      file: {
        id: row.id,
        url: `/files/${row.id}`,
        name: row.name,
        mime: row.mime,
        size: row.size,
        workspaceId: row.workspaceId,
        pageId: row.pageId,
        createdAt: row.createdAt.toISOString(),
      },
    }
  })
}

/** GET /files/:id: registered outside the /api prefix (at the root) */
export async function registerFileDownloadRoute(app: FastifyInstance): Promise<void> {
  app.get('/files/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)

    // A file of a workspace the caller is neither a member nor a guest of is "not found", like a
    // missing id (docs/adr/1301-*).
    const row = (
      await db.select().from(files).where(and(eq(files.id, id), memberOrGuestSql(files.workspaceId, user.id))).limit(1)
    )[0]
    if (!row) throw notFound()
    const role = await requireMembership(row.workspaceId, user.id, { guests: true })
    // A guest gets only files of pages shared with them (findVisiblePage below is narrowed); legacy
    // files without a page belong to the whole workspace (docs/adr/1252-*).
    if (role === 'guest' && !row.pageId) throw notFound()

    // If the file is linked to a page, download only when that page is visible to the requester
    // now (automatic protection when it moves shared→private). Legacy (null) needs membership only.
    if (row.pageId) {
      const page = await findVisiblePage(row.pageId, user.id)
      if (!page) throw notFound()
    }

    const filePath = uploadPath(id)
    if (!existsSync(filePath)) throw notFound()

    // Active render types (svg/text/pdf etc.) are never inline: nosniff + CSP
    // (default-src none; sandbox) + attachment neutralize them even if a browser renders them.
    const inline = SAFE_INLINE_MIME.has(row.mime)
    reply.header('Content-Type', row.mime)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    reply.header(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    )
    reply.header('Cache-Control', 'private, max-age=31536000, immutable')
    reply.header('ETag', row.id)
    return reply.send(createReadStream(filePath))
  })
}
