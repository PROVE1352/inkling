import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { workspaces } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { recordAudit, roleMeets } from '../workspaceAdmin'
import { exportPageCanvas, exportPageMd, exportZip } from '../md/exporter'
import { importEntries, importMarkdown, importZip } from '../md/importer'
import type { ImportEntry, ImportStats } from '../md/importer'
import { importLimits, mbLabel } from '../md/importLimits'
import { importNotionZip } from '../md/notionImport'
import { looksLikeNotionExport } from '../md/notionParse'
import { requestLocale } from '../i18n'
import JSZip from 'jszip'
import { env } from '../env'
import { findVisiblePage, toPageDTO } from '../pageDto'
import { markCreatedVia } from '../notify/provenance'
import type { PageScope } from '@inkling/shared'

// Import caps come from md/importLimits.ts (env-configurable, docs/adr/0961-*).
const MAX_FILE_BYTES = importLimits.maxUploadBytes
// Folder import: file count / total size / per-file limits (same caps as an archive import)
const MAX_FOLDER_FILES = importLimits.maxFiles
const MAX_FOLDER_BYTES = importLimits.maxUnpackedBytes
const MAX_FOLDER_FILE_BYTES = importLimits.maxEntryBytes
const exportQuerySchema = z.object({ format: z.enum(['md', 'zip', 'canvas']).optional() })
const importQuerySchema = z.object({
  parentId: z.uuid().optional(),
  /** zip only: 'notion' = Notion "Markdown & CSV" export, 'markdown' = plain folder zip, default = detect */
  source: z.enum(['auto', 'markdown', 'notion']).optional(),
})

function isTooLargeError(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null
  return e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413
}

function attachHeader(reply: { header: (k: string, v: string) => void }, filename: string): void {
  reply.header(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  )
}

/**
 * Streams `src` into `dest`, returning the byte count, or -1 (file removed) once more than
 * `budget` bytes arrive. Memory stays at one stream chunk regardless of the file size.
 */
export async function streamToFile(src: Readable, dest: string, budget: number): Promise<number> {
  let size = 0
  let over = false
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > budget) {
        over = true
        cb() // drop the rest; keep draining so busboy can move on
        return
      }
      cb(null, chunk)
    },
  })
  await pipeline(src, counter, createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
  if (over) {
    await rm(dest, { force: true })
    return -1
  }
  return size
}

function diskEntry(name: string, diskPath: string, size: number): ImportEntry {
  return {
    name,
    dir: false,
    size,
    readBuffer: () => readFile(diskPath),
    readText: () => readFile(diskPath, 'utf8'),
    moveTo: (dest) => rename(diskPath, dest),
    // Streamed so a de-duplication check never buffers a large attachment (docs/adr/1122-*).
    sha256: async () => {
      const h = createHash('sha256')
      for await (const chunk of createReadStream(diskPath)) h.update(chunk as Buffer)
      return h.digest('hex')
    },
  }
}

function dirEntry(name: string): ImportEntry {
  return {
    name,
    dir: true,
    size: 0,
    readBuffer: async () => Buffer.alloc(0),
    readText: async () => '',
  }
}

/**
 * Zip exports render every page before the first byte goes out (all guards run first), and the
 * server's 30 s idle socket timeout killed exports of ~1,000 documents mid-render. Give this
 * socket a longer idle window; the route is rate limited (20/min) (docs/adr/0751-*).
 */
const EXPORT_SOCKET_TIMEOUT_MS = 10 * 60_000
function relaxSocketTimeout(req: { raw: { socket?: { setTimeout?(ms: number): unknown } } }): void {
  // injected requests (MCP, tests) have a socket stub without setTimeout
  if (typeof req.raw.socket?.setTimeout === 'function') req.raw.socket.setTimeout(EXPORT_SOCKET_TIMEOUT_MS)
}

export async function registerExportImportRoutes(app: FastifyInstance): Promise<void> {
  // Single-page export (md = this page only / zip = with its subtree)
  app.get(
    '/pages/:id/export',
    {
      preHandler: requireUser,
      // Hardening H5: throttle subtree zip export amplification — 20/min per authenticated member IP.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const { format } = exportQuerySchema.parse(req.query)

    const page = await findVisiblePage(id, user.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, user.id)

    if (format === 'zip') {
      relaxSocketTimeout(req)
      const { filename, stream } = await exportZip({
        workspaceId: page.workspaceId,
        rootPageId: id,
        zipBaseName: page.title,
        userId: user.id,
      })
      reply.header('Content-Type', 'application/zip')
      attachHeader(reply, filename)
      return reply.send(stream)
    }

    // Canvas pages always export as .canvas instead of md (whatever the format, zip excluded).
    if (page.kind === 'canvas') {
      const { filename, body } = await exportPageCanvas(page, user.id)
      reply.header('Content-Type', 'application/json; charset=utf-8')
      attachHeader(reply, filename)
      return reply.send(body)
    }
    if (format === 'canvas') {
      throw badRequest('The canvas format is only available for canvas pages')
    }

    const { filename, body } = await exportPageMd(page, user.id)
    reply.header('Content-Type', 'text/markdown; charset=utf-8')
    attachHeader(reply, filename)
    return reply.send(body)
  })

  // Whole-workspace export (zip)
  app.get(
    '/workspaces/:id/export',
    {
      preHandler: requireUser,
      // Hardening H5: throttle whole-workspace zip export amplification — 20/min per IP.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)

    const ws = (
      await db
        .select({ name: workspaces.name, exportPolicy: workspaces.exportPolicy })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1)
    )[0]
    if (!ws) throw notFound()
    // Export policy (docs/adr/0950-*). Per-page exports (/pages/:id/export) stay open to members:
    // read_page and the editor's own export use them, and they cover one visible page at a time.
    if (!roleMeets(role, ws.exportPolicy)) throw forbidden('The workspace settings do not allow you to export it')
    // A streamed download has no transaction to share: the event is written before streaming starts.
    await recordAudit(db, {
      workspaceId: id,
      actor: user,
      action: 'export.downloaded',
      target: { type: 'workspace', id, label: ws.name },
      after: { format: 'zip' },
    })

    relaxSocketTimeout(req)
    const { filename, stream } = await exportZip({
      workspaceId: id,
      rootPageId: null,
      zipBaseName: ws.name,
      userId: user.id,
    })
    reply.header('Content-Type', 'application/zip')
    attachHeader(reply, filename)
    return reply.send(stream)
  })

  // Folder import: several multipart 'files' parts. Each part's filename is encodeURIComponent(relative path)
  // (busboy strips paths down to the basename by default, so '/' is sent encoded).
  // The server zips them and runs importZip unchanged → folders = folder pages, .md = documents, assets/ = attachments.
  app.post(
    '/workspaces/:id/import-folder',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      const role = await requireMembership(id, user.id)

      const { parentId: parentQuery } = importQuerySchema.parse(req.query)
      let parentId: string | null = null
      let scope: PageScope = 'shared'
      if (parentQuery) {
        const parent = await findVisiblePage(parentQuery, user.id)
        if (!parent || parent.workspaceId !== id) {
          throw badRequest('Parent page is invalid')
        }
        parentId = parentQuery
        scope = parent.scope
      }

      // Each part is streamed to a private temp dir and imported entry by entry
      // (docs/adr/0751-*). Previously every part was buffered, re-zipped with JSZip, the zip
      // buffered again and re-parsed — a 50 MB folder peaked at ~3–4x its size in RSS.
      const tmpDir = path.join(env.dataDir, 'tmp', `import-${randomUUID()}`)
      await mkdir(tmpDir, { recursive: true })
      try {
        const entries: ImportEntry[] = []
        let count = 0
        let total = 0
        try {
          for await (const part of req.parts({ limits: { files: MAX_FOLDER_FILES + 1, fileSize: MAX_FOLDER_FILE_BYTES, fields: 20, fieldSize: 100 * 1024, parts: MAX_FOLDER_FILES + 21, headerPairs: 200 } })) {
            if (part.type !== 'file') continue
            count++
            if (count > MAX_FOLDER_FILES) {
              part.file.resume()
              throw badRequest(`Too many files (max ${MAX_FOLDER_FILES})`)
            }
            let rel: string
            try {
              rel = decodeURIComponent(part.filename || '')
            } catch {
              part.file.resume()
              throw badRequest('Could not read the file path')
            }
            const segs = rel.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')
            if (segs.length === 0 || segs.includes('..')) {
              part.file.resume()
              throw badRequest(`Invalid file path: ${rel}`)
            }
            // Disk name is an index — the user-supplied path never touches the filesystem.
            const diskPath = path.join(tmpDir, String(count))
            const budget = MAX_FOLDER_BYTES - total
            const size = await streamToFile(part.file, diskPath, budget)
            if (part.file.truncated) {
              throw new AppError(413, 'PAYLOAD_TOO_LARGE', `A file is too large (max ${mbLabel(MAX_FOLDER_FILE_BYTES)})`)
            }
            if (size < 0) {
              throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Folder is too large (max ${mbLabel(MAX_FOLDER_BYTES)})`)
            }
            total += size
            entries.push(diskEntry(segs.join('/'), diskPath, size))
          }
        } catch (err) {
          if (isTooLargeError(err)) {
            throw new AppError(413, 'PAYLOAD_TOO_LARGE', `A file is too large (max ${mbLabel(MAX_FOLDER_FILE_BYTES)})`)
          }
          throw err
        }
        if (count === 0) throw badRequest('No files to upload')

        // Parity with the former JSZip round-trip: zip.file() created an entry for every parent
        // directory (createFolders), and importEntries turns explicit directories into folders.
        const dirs = new Set<string>()
        for (const e of entries) {
          const segs = e.name.split('/')
          for (let i = 1; i < segs.length; i++) dirs.add(`${segs.slice(0, i).join('/')}/`)
        }
        for (const d of dirs) entries.push(dirEntry(d))

        const stats: ImportStats = { duplicateAttachments: 0 }
        const created = await importEntries({ entries, workspaceId: id, parentId, userId: user.id, scope, role }, stats)
        if (created.length === 0) {
          throw badRequest('No .md files to import')
        }
        await markCreatedVia(created.map((p) => p.id), user)
        return { pages: created.map(toPageDTO), duplicateAttachments: stats.duplicateAttachments }
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    },
  )

  // import: multipart file = a single .md or a .zip (a Notion "Markdown & CSV" export is detected
  // from its file names or requested with ?source=notion; docs/adr/0960-*)
  app.post(
    '/workspaces/:id/import',
    {
      preHandler: requireUser,
      // Hardening H5: throttle bulk zip import amplification — 20/min per authenticated member IP.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    const role = await requireMembership(id, user.id)

    const { parentId: parentQuery, source } = importQuerySchema.parse(req.query)
    let parentId: string | null = null
    // scope of imported pages: inherit the parent's when given; root imports are shared.
    let scope: PageScope = 'shared'
    if (parentQuery) {
      const parent = await findVisiblePage(parentQuery, user.id)
      if (!parent || parent.workspaceId !== id) {
        throw badRequest('Parent page is invalid')
      }
      parentId = parentQuery
      scope = parent.scope
    }

    // Per-request cap overrides the global multipart fileSize (IMPORT_MAX_UPLOAD_MB).
    const mp = await req.file({ limits: { fileSize: MAX_FILE_BYTES } })
    if (!mp) throw badRequest('No files to upload')

    let buffer: Buffer
    try {
      buffer = await mp.toBuffer()
    } catch (err) {
      if (isTooLargeError(err)) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', `File is too large (max ${mbLabel(MAX_FILE_BYTES)})`)
      }
      throw err
    }
    if (mp.file.truncated || buffer.length > MAX_FILE_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `File is too large (max ${mbLabel(MAX_FILE_BYTES)})`)
    }

    const filename = mp.filename || 'import'
    const mime = mp.mimetype
    const lower = filename.toLowerCase()
    const isZip =
      lower.endsWith('.zip') ||
      mime === 'application/zip' ||
      mime === 'application/x-zip-compressed'
    const isMd =
      lower.endsWith('.md') ||
      lower.endsWith('.markdown') ||
      lower.endsWith('.txt') ||
      mime === 'text/markdown' ||
      mime === 'text/plain'

    if (source === 'notion' && !isZip) {
      throw new AppError(415, 'UNSUPPORTED_TYPE', 'A Notion export is imported as its .zip file')
    }
    if (!isZip && !isMd) {
      throw new AppError(415, 'UNSUPPORTED_TYPE', 'Only .md or .zip files can be imported')
    }

    if (isZip && source !== 'markdown') {
      let zip: JSZip
      try {
        zip = await JSZip.loadAsync(buffer)
      } catch {
        throw badRequest('Not a readable zip archive')
      }
      const names = Object.values(zip.files).filter((e) => !e.dir).map((e) => e.name)
      if (source === 'notion' || looksLikeNotionExport(names)) {
        const locale = await requestLocale(req, user.id)
        const { pages, report } = await importNotionZip({
          buffer,
          zip,
          workspaceId: id,
          parentId,
          userId: user.id,
          scope,
          role,
          detected: source === 'notion' ? 'explicit' : 'auto',
          tableViewName: locale === 'ko' ? '표' : 'Table',
        })
        return { pages: pages.map(toPageDTO), report }
      }
    }

    const stats: ImportStats = { duplicateAttachments: 0 }
    const created = isZip
      ? await importZip({ buffer, workspaceId: id, parentId, userId: user.id, scope, role }, stats)
      : await importMarkdown({
          buffer,
          filename,
          workspaceId: id,
          parentId,
          userId: user.id,
          scope,
          role,
        })

    await markCreatedVia(created.map((p) => p.id), user)
    // `report` stays reserved for the Notion importer's report (its presence tells the client which
    // importer ran); the zip/folder importers only add the de-duplication count (docs/adr/1122-*).
    return isZip
      ? { pages: created.map(toPageDTO), duplicateAttachments: stats.duplicateAttachments }
      : { pages: created.map(toPageDTO) }
  })
}
