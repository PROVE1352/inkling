import { assertWorkspaceRoom } from '../quota/room'
import { dropFiles } from '../quota/files'
import { and, asc, eq, isNull, max } from 'drizzle-orm'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/index'
import { env } from '../env'
import { AppError, badRequest } from '../errors'
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
import { formerTitleMap } from '../formerTitles'
import { dropLeadingTitleHeading } from './titleHeading'
import { importLimits, mbLabel } from './importLimits'

// Caps guard against zip bombs / huge imports exhausting memory. All are env-configurable with the
// historical values as defaults (md/importLimits.ts, docs/adr/0961-*).
const MAX_ENTRIES = importLimits.maxFiles
const MAX_UNCOMPRESSED = importLimits.maxUnpackedBytes
/** Largest single entry once decompressed (same as a direct upload by default). */
const MAX_ENTRY_BYTES = importLimits.maxEntryBytes
/**
 * Zip bomb guard on top of the real-byte caps (docs/adr/2163-*): an entry that inflates past
 * MAX_ZIP_RATIO times its compressed size (and past ZIP_RATIO_FLOOR bytes, so small highly
 * repetitive files pass) stops the import at that point instead of at the size cap.
 */
export const MAX_ZIP_RATIO = 200
const ZIP_RATIO_FLOOR = 1024 * 1024
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
  /** Set for imports through a connection (MCP import_zip, a bearer API call): docs/adr/2162-*. */
  agent?: AgentImportRules
}

/**
 * The 0.16 upload rules for the attachments of an import made through a connection
 * (docs/adr/2044-*, 2065-*, 2162-*). Its Markdown is like import_folder; its attachments are uploads.
 */
export interface AgentImportRules {
  /** files.uploaded_via of the stored attachments, so they count toward the daily budget. */
  via: string
  /** Largest attachment (AGENT_UPLOAD_MAX_MB). Larger ones are skipped and reported. */
  maxFileBytes: number
  /** upload_file's type decision from the name and the bytes; refused types are skipped and reported. */
  typeOf(name: string, bytes: Buffer): { mime: string } | { error: string }
  /** Runs once before the first attachment is stored (the switch and the daily budget); throws to refuse. */
  beforeAttachments(): Promise<void>
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Hex SHA-256 of an attachment's bytes (import de-duplication, docs/adr/1122-*). */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

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
 * ③ aliases of workspace pages ④ former titles (renamed pages, docs/adr/1121-*). All
 * case-insensitive, most recent updatedAt wins (former titles: most recent holder of the name).
 * Priority: batch > real title > alias > former title (so neither an alias nor an old name ever
 * shadows a page's current title).
 */
export async function buildTitleResolver(
  workspaceId: string,
  batchMap: Map<string, string>,
  userId: string,
): Promise<ResolveTitle> {
  // Security (docs/adr/0756-*): only pages the importing user may see are link targets.
  // Without visibleTo, [[Someone's private page]] resolved to its id and leaked its existence.
  const [wsRows, formerMap] = await Promise.all([
    db
      .select({ id: pages.id, title: pages.title, aliases: pages.aliases, parentId: pages.parentId })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)))
      .orderBy(asc(pages.updatedAt)), // asc → the last (newest) one stays in the map
    formerTitleMap(workspaceId, userId),
  ])
  const titleMap = new Map<string, string>()
  const aliasMap = new Map<string, string>()
  // `[[Page#Heading]]`: a subpage of Page titled Heading (what a split leaves, docs/adr/1140-*).
  const childMap = new Map<string, string>()
  for (const r of wsRows) {
    if (r.title) titleMap.set(r.title.toLowerCase(), r.id)
    if (r.title && r.parentId) childMap.set(`${r.parentId}\u0000${r.title.toLowerCase()}`, r.id)
    if (Array.isArray(r.aliases)) {
      for (const a of r.aliases as unknown[]) {
        if (typeof a !== 'string') continue
        const key = a.trim().toLowerCase()
        if (key) aliasMap.set(key, r.id)
      }
    }
  }
  const lookup = (key: string) => batchMap.get(key) ?? titleMap.get(key) ?? aliasMap.get(key) ?? formerMap.get(key)
  return (title: string) => {
    const key = title.toLowerCase()
    let pid = lookup(key)
    // `[[Page#Heading]]` → the subpage made from that section after a split, else the page itself.
    const hash = key.indexOf('#')
    if (!pid && hash > 0) {
      const base = lookup(key.slice(0, hash).trim())
      if (base) pid = childMap.get(`${base}\u0000${key.slice(hash + 1).trim()}`) ?? base
    }
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
      ? (await assertPlacement(tx, { workspaceId, parentId, role, userId }))[0].scope
      : args.scope
    const sortOrder = await nextSortOrderBase(tx, workspaceId, parentId)
    await assertWorkspaceRoom(tx, workspaceId, { pages: 1, bytes: buffer.length }) // docs/adr/2505-*
    const [row] = await tx
      .insert(pages)
      .values({ workspaceId, parentId, kind: 'doc', scope, title, sortOrder, createdBy: userId })
      .returning(pageColumns)
    return row
  })

  const batchMap = new Map<string, string>([[title.toLowerCase(), page.id]])
  const resolveTitle = await buildTitleResolver(workspaceId, batchMap, userId)
  // `# <file name>` as the first line would repeat the page title (md/titleHeading.ts)
  let blocks = dropLeadingTitleHeading(await markdownToBlocks(body, resolveTitle), title)
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

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
let cp949: InstanceType<typeof TextDecoder> | null = null
try {
  // WHATWG "euc-kr" is Windows code page 949 (needs Node's ICU data; official builds have it).
  cp949 = new TextDecoder('euc-kr')
} catch {
  cp949 = null
}

/**
 * Names of zip entries without the UTF-8 flag (docs/adr/2163-*): zips made by Windows Explorer on a
 * Korean system store names in code page 949, which JSZip's default (UTF-8) turns into U+FFFD. Try
 * strict UTF-8 first (most tools write UTF-8 even without the flag), then CP949, then Latin-1.
 */
export function decodeZipFileName(bytes: Uint8Array | number[] | string): string {
  if (typeof bytes === 'string') return bytes
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
  try {
    return utf8Strict.decode(u8)
  } catch {
    /* not UTF-8 */
  }
  if (cp949) {
    const s = cp949.decode(u8)
    if (!s.includes('\uFFFD')) return s
  }
  return Buffer.from(u8).toString('latin1')
}

/** JSZip.loadAsync with the file-name decoding above; every import path loads zips through it. */
export function loadZip(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer, { decodeFileName: decodeZipFileName as (b: string[] | Uint8Array | Buffer) => string })
}

/** A zip entry is a symbolic link (Unix mode S_IFLNK in the external attributes). */
export function isZipSymlink(e: JSZip.JSZipObject): boolean {
  const mode = e.unixPermissions
  return typeof mode === 'number' && (mode & 0o170000) === 0o120000
}

/**
 * One entry name as the import uses it (docs/adr/2163-*): NFC (macOS writes Hangul decomposed),
 * `\` as `/`, no leading `/` or drive letter, no `.` or empty segments, control characters dropped.
 * A `..` segment refuses the whole archive: nothing is written to disk by name, but such an archive
 * is crafted, and silently skipping its entries would hide that.
 */
export function normalizeEntryName(raw: string): string {
  const dir = /[\\/]$/.test(raw)
  const segs = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\//, '')
    .split('/')
    .filter((x) => x && x !== '.')
  if (segs.includes('..')) throw new AppError(400, 'ZIP_UNSAFE_PATH', `Unsafe path in the archive: ${raw.slice(0, 200)}`)
  const name = segs.join('/')
  return dir && name ? `${name}/` : name
}

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
  /** SHA-256 of the bytes without buffering them (disk-backed entries); used with `moveTo`. */
  sha256?(): Promise<string>
}

/** What an import merged or skipped, for the response (docs/adr/1122-*). */
export interface ImportStats {
  /** Attachments whose bytes equalled an earlier attachment of the same import: stored once. */
  duplicateAttachments: number
  /** Imports through a connection: attachments not stored, and why (docs/adr/2162-*). */
  skippedAttachments?: { name: string; reason: string }[]
}

export async function importZip(
  args: Omit<ImportArgs, 'filename'>,
  stats?: ImportStats,
): Promise<PageRow[]> {
  const { buffer, workspaceId, parentId, userId, scope, role, agent } = args
  const zip = await loadZip(buffer)
  // The zip header's uncompressedSize is attacker-controlled (C-M6): the declared size is only a
  // first filter; every entry is decompressed through a stream that counts the real bytes and
  // aborts at the per-entry cap or when the import's running total passes MAX_UNCOMPRESSED.
  const meter = { total: 0 }
  const entries: ImportEntry[] = Object.values(zip.files).map((e) => {
    if (isZipSymlink(e)) throw new AppError(400, 'ZIP_SYMLINK', `The archive contains a symbolic link (${e.name.slice(0, 200)}); links are not imported`)
    const read = () => readZipEntryCapped(e, meter)
    return {
      // JSZip already collapses `..` in e.name (its zip-slip guard); the name as stored in the archive
      // is checked so a crafted one is refused instead of landing somewhere else in the tree.
      name: normalizeEntryName((e as { unsafeOriginalName?: string }).unsafeOriginalName ?? e.name),
      dir: e.dir,
      size:
        (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      readBuffer: read,
      readText: async () => (await read()).toString('utf8'),
    }
  })
  return importEntries({ entries, workspaceId, parentId, userId, scope, role, agent }, stats)
}

/** Decompresses one zip entry while counting real output bytes (see importZip). */
export function readZipEntryCapped(
  e: JSZip.JSZipObject,
  meter: { total: number },
  limits: { entry: number; total: number; ratio?: number } = { entry: MAX_ENTRY_BYTES, total: MAX_UNCOMPRESSED },
): Promise<Buffer> {
  // `ratio` defaults to MAX_ZIP_RATIO for every caller; tests of the byte meter pass Infinity.
  const ratio = limits.ratio ?? MAX_ZIP_RATIO
  const compressed = (e as unknown as { _data?: { compressedSize?: number } })._data?.compressedSize
  const ratioCap = typeof compressed === 'number' ? Math.max(ZIP_RATIO_FLOOR, compressed * ratio) : Infinity
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
      if (size > ratioCap) {
        return fail(new AppError(400, 'ZIP_RATIO', `A file in the archive inflates more than ${ratio} times its packed size; not imported`))
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
  stats: ImportStats = { duplicateAttachments: 0 },
): Promise<PageRow[]> {
  const { workspaceId, parentId, userId, role, agent } = args
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
  // Limits (docs/adr/2505-*): a first check before anything is written; the real one, under the
  // locks, is in the page transaction below (attachments written before it are removed if it fails).
  await assertWorkspaceRoom(db, workspaceId, { pages: 1, bytes: totalUncompressed, reserve: false })

  // 1) upload assets/ → entryName → /files/<newId>
  //    Same bytes under two names (a picture pasted into several notes) are stored once: the first
  //    entry is the representative and later ones map to its /files url (docs/adr/1122-*). One key
  //    (the content hash) decides, so a Map from hash to the representative is the whole
  //    "union-find" here — every set has depth 1 by construction.
  const assetMap = new Map<string, string>()
  const assetIds: string[] = []
  const byHash = new Map<string, string>()
  if (agent && fileEntries.some((e) => isAssetPath(e.name))) await agent.beforeAttachments()
  for (const e of fileEntries) {
    if (!isAssetPath(e.name)) continue
    const ext = path.extname(e.name)
    // Zip entries are decompressed (and measured) before the row exists. Through a connection the
    // bytes are always read: the type is decided from them (bounded by the per-entry cap).
    const data = e.moveTo && !agent ? null : await e.readBuffer()
    let mime = mimeForExt(ext)
    if (agent) {
      const skip = (reason: string) => (stats.skippedAttachments ??= []).push({ name: e.name, reason })
      if (data!.length > agent.maxFileBytes) {
        skip(`larger than ${mbLabel(agent.maxFileBytes)}, the per-file limit for uploads through a connection`)
        continue
      }
      const typed = agent.typeOf(path.basename(e.name), data!)
      if ('error' in typed) {
        skip(typed.error)
        continue
      }
      mime = typed.mime
    }
    const hash = data ? sha256(data) : e.sha256 ? await e.sha256() : null
    const same = hash ? byHash.get(hash) : undefined
    if (same) {
      assetMap.set(e.name, same)
      stats.duplicateAttachments++
      continue
    }
    const [row] = await db
      .insert(files)
      .values({
        workspaceId,
        name: path.basename(e.name),
        mime,
        size: data ? data.length : e.size,
        createdBy: userId,
        uploadedVia: agent?.via ?? null,
      })
      .returning({ id: files.id })
    const dest = path.join(env.dataDir, 'uploads', row.id)
    if (e.moveTo && !data) await e.moveTo(dest)
    else await writeFile(dest, data!)
    assetMap.set(e.name, `/files/${row.id}`)
    if (hash) byHash.set(hash, `/files/${row.id}`)
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
      const chain = await assertPlacement(tx, { workspaceId, parentId, role, userId, height: maxDepth })
      scope = chain[0].scope
    }
    await assertWorkspaceRoom(tx, workspaceId, { pages: ordered.length, bytes: totalUncompressed }) // all pages or none
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
  }).catch(async (err: unknown) => {
    // no page was made: the attachments written above would be orphans (rows and blobs)
    await dropFiles(assetIds)
    throw err
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
      let blocks = dropLeadingTitleHeading(await markdownToBlocks(body, resolveTitle, resolveAsset), node.title)
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
