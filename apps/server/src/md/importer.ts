import { and, asc, eq, isNull, max } from 'drizzle-orm'
import JSZip from 'jszip'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/index'
import { env } from '../env'
import { badRequest } from '../errors'
import { files, pageDocs, pages } from '../db/schema'
import { pageColumns, visibleTo } from '../pageDto'
import type { PageRow } from '../pageDto'
import type { PageScope, WorkspaceRole } from '@inkling/shared'
import { assertPlacement, withTreeLock } from '../pageTree'
import type { Tx } from '../pageTree'
import { canvasJsonToState } from './canvas'
import type { CanvasData } from './canvas'
import {
  blocksToStateBuffer,
  markdownToBlocks,
  stripFrontmatter,
} from './convert'
import type { AnyBlock, ResolveAsset, ResolveTitle } from './convert'
import { reindexPageLinks } from './linkIndex'
import { reindexPageTags } from './tagIndex'
import { reindexPageTasks } from './taskIndex'
import { reindexPageChunks } from '../context/chunkIndex'
import { reindexPageText } from './textIndex'
import { mimeForExt } from './mime'
import { importLimits, mbLabel } from './importLimits'

// Caps guard against zip bombs / huge imports exhausting memory. All are env-configurable with the
// historical values as defaults (md/importLimits.ts, docs/adr/0961-*).
const MAX_ENTRIES = importLimits.maxFiles
const MAX_UNCOMPRESSED = importLimits.maxUnpackedBytes
/** Largest single entry once decompressed (same as a direct upload by default). */
const MAX_ENTRY_BYTES = importLimits.maxEntryBytes
/** Deepest folder nesting an import may create (C-H2b). */
export const IMPORT_MAX_FOLDER_DEPTH = 32
/** Most pages (folders + docs + canvases) one import may create; env IMPORT_MAX_PAGES. */
export const IMPORT_MAX_PAGES = importLimits.maxPages
export const EMPTY_BLOCKS: AnyBlock[] = [{ type: 'paragraph', content: [] }]

interface ImportArgs {
  buffer: Buffer
  filename: string
  workspaceId: string
  parentId: string | null
  userId: string
  /** Section of the created pages. An import under a parent takes the parent's scope; a root import is 'shared'. */
  scope: PageScope
  /** Importer's workspace role (public-folder rule of the placement check). */
  role: WorkspaceRole
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export async function nextSortOrderBase(
  tx: Pick<Tx, 'select'>,
  workspaceId: string,
  parentId: string | null,
): Promise<number> {
  const cond = parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId)
  const [{ maxSort }] = await tx
    .select({ maxSort: max(pages.sortOrder) })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), cond))
  return (maxSort ?? 0) + 1000
}

/**
 * [[title]] resolver: ① pages in this batch ② titles of live pages in the workspace
 * ③ aliases of workspace pages. All case-insensitive, most recent updatedAt wins.
 * Priority: batch > real title > alias (so an alias never shadows a real page title).
 */
export async function buildTitleResolver(
  workspaceId: string,
  batchMap: Map<string, string>,
  userId: string,
): Promise<ResolveTitle> {
  // Security (docs/adr/0756-*): only pages the importing user may see are link targets.
  // Without visibleTo, [[Someone's private page]] resolved to its id and leaked its existence.
  const wsRows = await db
    .select({ id: pages.id, title: pages.title, aliases: pages.aliases })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)))
    .orderBy(asc(pages.updatedAt)) // asc → the last (newest) one stays in the map
  const titleMap = new Map<string, string>()
  const aliasMap = new Map<string, string>()
  for (const r of wsRows) {
    if (r.title) titleMap.set(r.title.toLowerCase(), r.id)
    if (Array.isArray(r.aliases)) {
      for (const a of r.aliases as unknown[]) {
        if (typeof a !== 'string') continue
        const key = a.trim().toLowerCase()
        if (key) aliasMap.set(key, r.id)
      }
    }
  }
  return (title: string) => {
    const key = title.toLowerCase()
    const pid = batchMap.get(key) ?? titleMap.get(key) ?? aliasMap.get(key)
    return pid ? `/w/${workspaceId}/p/${pid}` : null
  }
}

// ---------------------------------------------------------------------------
// single .md
// ---------------------------------------------------------------------------

export async function importMarkdown(args: ImportArgs): Promise<PageRow[]> {
  const { buffer, filename, workspaceId, parentId, userId, role } = args
  const title = path.parse(filename).name || 'Untitled'
  const body = stripFrontmatter(buffer.toString('utf8'))

  const page = await withTreeLock(workspaceId, async (tx) => {
    const scope = parentId
      ? (await assertPlacement(tx, { workspaceId, parentId, role }))[0].scope
      : args.scope
    const sortOrder = await nextSortOrderBase(tx, workspaceId, parentId)
    const [row] = await tx
      .insert(pages)
      .values({ workspaceId, parentId, kind: 'doc', scope, title, sortOrder, createdBy: userId })
      .returning(pageColumns)
    return row
  })

  const batchMap = new Map<string, string>([[title.toLowerCase(), page.id]])
  const resolveTitle = await buildTitleResolver(workspaceId, batchMap, userId)
  let blocks = await markdownToBlocks(body, resolveTitle)
  if (blocks.length === 0) blocks = EMPTY_BLOCKS
  await db.insert(pageDocs).values({ pageId: page.id, state: blocksToStateBuffer(blocks) })
  await reindexPageLinks(page.id, blocks)
  await reindexPageText(page.id, blocks)
  await reindexPageChunks(page.id, blocks)
  await reindexPageTags(page.id, blocks)
  await reindexPageTasks(page.id, blocks)

  return [page]
}

// ---------------------------------------------------------------------------
// .zip (folder structure = parent relationships)
// ---------------------------------------------------------------------------

function isIgnored(name: string): boolean {
  const segs = name.split('/').filter(Boolean)
  if (segs.length === 0) return true
  if (segs[0] === '__MACOSX') return true
  return segs.some((s) => s.startsWith('.'))
}

function isAssetPath(name: string): boolean {
  const segs = name.split('/').filter(Boolean)
  return segs[0] === 'assets' && segs.length >= 2
}

interface TreeNode {
  nodePath: string
  title: string
  kind: 'doc' | 'folder' | 'canvas'
  mdEntryName?: string
  canvasEntryName?: string
  depth: number
  parentPath: string | null
}

/**
 * One file or directory of an import tree. Entries are read lazily, one at a time, so a folder
 * import never holds more than one file in memory (docs/adr/0751-*).
 */
export interface ImportEntry {
  name: string
  dir: boolean
  /** Uncompressed size in bytes (0 for directories). */
  size: number
  readBuffer(): Promise<Buffer>
  readText(): Promise<string>
  /** Optional zero-copy path: move the bytes to `dest` (same filesystem) instead of read+write. */
  moveTo?(dest: string): Promise<void>
}

export async function importZip(
  args: Omit<ImportArgs, 'filename'>,
): Promise<PageRow[]> {
  const { buffer, workspaceId, parentId, userId, scope, role } = args
  const zip = await JSZip.loadAsync(buffer)
  // The zip header's uncompressedSize is attacker-controlled (C-M6): the declared size is only a
  // first filter; every entry is decompressed through a stream that counts the real bytes and
  // aborts at the per-entry cap or when the import's running total passes MAX_UNCOMPRESSED.
  const meter = { total: 0 }
  const entries: ImportEntry[] = Object.values(zip.files).map((e) => {
    const read = () => readZipEntryCapped(e, meter)
    return {
      name: e.name,
      dir: e.dir,
      size:
        (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      readBuffer: read,
      readText: async () => (await read()).toString('utf8'),
    }
  })
  return importEntries({ entries, workspaceId, parentId, userId, scope, role })
}

/** Decompresses one zip entry while counting real output bytes (see importZip). */
export function readZipEntryCapped(
  e: JSZip.JSZipObject,
  meter: { total: number },
  limits: { entry: number; total: number } = { entry: MAX_ENTRY_BYTES, total: MAX_UNCOMPRESSED },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const stream = e.nodeStream('nodebuffer')
    const fail = (err: Error) => {
      if (done) return
      done = true
      ;(stream as unknown as { pause?: () => void }).pause?.()
      stream.removeAllListeners('data')
      reject(err)
    }
    stream.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      meter.total += chunk.length
      if (size > limits.entry) {
        return fail(badRequest(`A file in the archive is too large (max ${mbLabel(limits.entry)})`))
      }
      if (meter.total > limits.total) {
        return fail(badRequest(`Archive is too large when unpacked (max ${mbLabel(limits.total)})`))
      }
      chunks.push(chunk)
    })
    stream.on('error', (err: Error) => fail(err))
    stream.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks, size))
    })
  })
}

/** Imports a folder tree (zip or disk-backed upload): folders → folder pages, .md → docs, assets/ → files. */
export async function importEntries(
  args: Omit<ImportArgs, 'filename' | 'buffer'> & { entries: ImportEntry[] },
): Promise<PageRow[]> {
  const { workspaceId, parentId, userId, role } = args
  const allEntries = args.entries.filter((e) => !isIgnored(e.name))
  const fileEntries = allEntries.filter((e) => !e.dir)

  // size guards
  if (fileEntries.length > MAX_ENTRIES) {
    throw badRequest(`Too many files in the archive (max ${MAX_ENTRIES})`)
  }
  let totalUncompressed = 0
  for (const e of fileEntries) totalUncompressed += e.size
  if (totalUncompressed > MAX_UNCOMPRESSED) {
    throw badRequest(`Archive is too large when unpacked (max ${mbLabel(MAX_UNCOMPRESSED)})`)
  }

  const entryByName = new Map(fileEntries.map((e) => [e.name, e]))

  // 1) upload assets/ → entryName → /files/<newId>
  const assetMap = new Map<string, string>()
  const assetIds: string[] = []
  for (const e of fileEntries) {
    if (!isAssetPath(e.name)) continue
    const ext = path.extname(e.name)
    // Zip entries are decompressed (and measured) before the row exists.
    const data = e.moveTo ? null : await e.readBuffer()
    const [row] = await db
      .insert(files)
      .values({
        workspaceId,
        name: path.basename(e.name),
        mime: mimeForExt(ext),
        size: data ? data.length : e.size,
        createdBy: userId,
      })
      .returning({ id: files.id })
    const dest = path.join(env.dataDir, 'uploads', row.id)
    if (e.moveTo) await e.moveTo(dest)
    else await writeFile(dest, data!)
    assetMap.set(e.name, `/files/${row.id}`)
    assetIds.push(row.id)
  }

  // 2) build tree nodes
  const nodes = new Map<string, TreeNode>()

  const tooDeep = () =>
    badRequest(`Folders are nested too deeply (max ${IMPORT_MAX_FOLDER_DEPTH} levels)`)
  const tooMany = () => badRequest(`Too many pages to import (max ${IMPORT_MAX_PAGES})`)
  const ensureFolderChain = (dirPath: string): void => {
    if (!dirPath) return
    const segs = dirPath.split('/').filter(Boolean)
    if (segs.length > IMPORT_MAX_FOLDER_DEPTH) throw tooDeep()
    if (nodes.size > IMPORT_MAX_PAGES) throw tooMany()
    for (let i = 0; i < segs.length; i++) {
      const p = segs.slice(0, i + 1).join('/')
      if (!nodes.has(p)) {
        nodes.set(p, {
          nodePath: p,
          title: segs[i] || 'Untitled',
          kind: 'folder',
          depth: i,
          parentPath: i === 0 ? null : segs.slice(0, i).join('/'),
        })
      }
    }
  }

  // md nodes (a folder already at the same path is promoted to a doc)
  for (const e of fileEntries) {
    if (isAssetPath(e.name)) continue
    if (!e.name.toLowerCase().endsWith('.md')) continue
    const segs = e.name.split('/').filter(Boolean)
    const fileSeg = segs[segs.length - 1]
    const title = fileSeg.replace(/\.md$/i, '') || 'Untitled'
    const dirSegs = segs.slice(0, -1)
    const dirPath = dirSegs.join('/')
    ensureFolderChain(dirPath)
    const nodePath = dirPath ? `${dirPath}/${title}` : title
    nodes.set(nodePath, {
      nodePath,
      title,
      kind: 'doc',
      mdEntryName: e.name,
      depth: dirSegs.length,
      parentPath: dirPath || null,
    })
  }

  // canvas nodes (a folder/doc already at the same path is promoted to a canvas)
  for (const e of fileEntries) {
    if (isAssetPath(e.name)) continue
    if (!e.name.toLowerCase().endsWith('.canvas')) continue
    const segs = e.name.split('/').filter(Boolean)
    const fileSeg = segs[segs.length - 1]
    const title = fileSeg.replace(/\.canvas$/i, '') || 'Untitled'
    const dirSegs = segs.slice(0, -1)
    const dirPath = dirSegs.join('/')
    ensureFolderChain(dirPath)
    const nodePath = dirPath ? `${dirPath}/${title}` : title
    nodes.set(nodePath, {
      nodePath,
      title,
      kind: 'canvas',
      canvasEntryName: e.name,
      depth: dirSegs.length,
      parentPath: dirPath || null,
    })
  }

  // explicit directory entries → folder (assets excluded)
  for (const e of allEntries) {
    if (!e.dir) continue
    const clean = e.name.replace(/\/+$/, '')
    const segs = clean.split('/').filter(Boolean)
    if (segs.length === 0 || segs[0] === 'assets') continue
    ensureFolderChain(clean)
  }

  // 3) create pages (ascending depth → parents first) — one transaction under the workspace tree lock,
  //    after the depth / page-count caps (C-H2b, docs/adr/0800-*).
  if (nodes.size > IMPORT_MAX_PAGES) throw tooMany()
  const ordered = [...nodes.values()].sort((a, b) => a.depth - b.depth)
  const maxDepth = ordered.reduce((m, n) => Math.max(m, n.depth), 0)
  if (maxDepth > IMPORT_MAX_FOLDER_DEPTH) throw tooDeep()
  const createdIdByPath = new Map<string, string>()
  const created: PageRow[] = await withTreeLock(workspaceId, async (tx) => {
    let scope = args.scope
    if (parentId) {
      const chain = await assertPlacement(tx, { workspaceId, parentId, role, height: maxDepth })
      scope = chain[0].scope
    }
    const out: PageRow[] = []
    const sortCounters = new Map<string, number>()
    for (const node of ordered) {
      const parentDbId = node.parentPath
        ? createdIdByPath.get(node.parentPath) ?? parentId
        : parentId
      const parentKey = parentDbId ?? '__root__'
      let sort = sortCounters.get(parentKey)
      if (sort === undefined) sort = await nextSortOrderBase(tx, workspaceId, parentDbId)
      sortCounters.set(parentKey, sort + 1000)

      const [row] = await tx
        .insert(pages)
        .values({
          workspaceId,
          parentId: parentDbId,
          kind: node.kind,
          scope,
          title: node.title,
          sortOrder: sort,
          createdBy: userId,
        })
        .returning(pageColumns)
      createdIdByPath.set(node.nodePath, row.id)
      out.push(row)
    }
    return out
  })

  // 4) second pass: finalize doc blocks / canvas state + save + backlink index
  const batchMap = new Map<string, string>()
  for (const row of created) batchMap.set(row.title.toLowerCase(), row.id)
  const resolveTitle = await buildTitleResolver(workspaceId, batchMap, userId)
  // Imported attachments get the page that first references them (or the first created page) as
  // their pageId, so the file gate applies that page's visibility instead of plain membership —
  // a private import's assets stay private (C-L11).
  let currentPageId: string | null = null
  const assetOwner = new Map<string, string>()
  const resolveAsset: ResolveAsset = (relPath) => {
    const url = assetMap.get(relPath) ?? assetMap.get(relPath.replace(/^\.\//, '')) ?? null
    if (url && currentPageId && !assetOwner.has(url)) assetOwner.set(url, currentPageId)
    return url
  }

  // For mapping canvas file nodes to pages: zip entry path (md/canvas) → created pageId
  const fileToPageId = new Map<string, string>()
  for (const node of ordered) {
    const pid = createdIdByPath.get(node.nodePath)
    if (!pid) continue
    if (node.mdEntryName) fileToPageId.set(node.mdEntryName, pid)
    if (node.canvasEntryName) fileToPageId.set(node.canvasEntryName, pid)
  }
  const resolveFile = (filePath: string): string | null => {
    const clean = filePath.replace(/^\.?\//, '')
    return fileToPageId.get(filePath) ?? fileToPageId.get(clean) ?? null
  }

  for (const node of ordered) {
    const pageId = createdIdByPath.get(node.nodePath)
    if (!pageId) continue
    currentPageId = pageId

    if (node.kind === 'doc' && node.mdEntryName) {
      const entry = entryByName.get(node.mdEntryName)
      const raw = entry ? await entry.readText() : ''
      const body = stripFrontmatter(raw)
      let blocks = await markdownToBlocks(body, resolveTitle, resolveAsset)
      if (blocks.length === 0) blocks = EMPTY_BLOCKS
      await db
        .insert(pageDocs)
        .values({ pageId, state: blocksToStateBuffer(blocks) })
        .onConflictDoNothing()
      await reindexPageLinks(pageId, blocks)
      await reindexPageText(pageId, blocks)
      await reindexPageChunks(pageId, blocks)
      await reindexPageTags(pageId, blocks)
      await reindexPageTasks(pageId, blocks)
    } else if (node.kind === 'canvas' && node.canvasEntryName) {
      const entry = entryByName.get(node.canvasEntryName)
      const raw = entry ? await entry.readText() : ''
      let canvas: CanvasData
      try {
        canvas = JSON.parse(raw) as CanvasData
      } catch {
        canvas = { nodes: [], edges: [] }
      }
      const state = canvasJsonToState(canvas, { resolveFile })
      await db.insert(pageDocs).values({ pageId, state }).onConflictDoNothing()
      // Canvases are not part of the blocks-based backlink index (v1)
    }
  }

  const fallbackOwner = created[0]?.id ?? parentId
  for (const id of assetIds) {
    const owner = assetOwner.get(`/files/${id}`) ?? fallbackOwner
    if (owner) await db.update(files).set({ pageId: owner }).where(eq(files.id, id))
  }

  return created
}
