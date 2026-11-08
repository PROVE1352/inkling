import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { CollectionField } from '@inkling/shared'
import { db } from '../db/index'
import { env } from '../env'
import { AppError } from '../errors'
import { collections, files, pageDocs, pages, users } from '../db/schema'
import { visibleTo } from '../pageDto'
import { collectAssetRefs, collectPageRefs, stateToCanvasJson } from './canvas'
import type { StateToCanvasOptions } from './canvas'
import { blocksToMarkdown, stateToBlocks } from './convert'
import type { AnyBlock } from './convert'
import { extForMime, sanitizeName } from './mime'

interface TreePage {
  id: string
  parentId: string | null
  kind: 'doc' | 'folder' | 'canvas' | 'collection'
  title: string
  updatedAt: Date
}

const EMPTY_BLOCKS: AnyBlock[] = [{ type: 'paragraph', content: [] }]

function frontmatter(id: string, updatedAt: Date): string {
  return `---\ninkling-id: ${id}\nupdated: ${updatedAt.toISOString()}\n---\n\n`
}

/** Load a page's blocks (an empty paragraph if it has no document). */
async function loadBlocks(pageId: string): Promise<AnyBlock[]> {
  const row = (
    await db
      .select({ state: pageDocs.state })
      .from(pageDocs)
      .where(eq(pageDocs.pageId, pageId))
      .limit(1)
  )[0]
  if (!row) return EMPTY_BLOCKS
  return stateToBlocks(row.state)
}

/** Load a page's raw Yjs state (bytea) (null if none). */
async function loadState(pageId: string): Promise<Uint8Array | null> {
  const row = (
    await db
      .select({ state: pageDocs.state })
      .from(pageDocs)
      .where(eq(pageDocs.pageId, pageId))
      .limit(1)
  )[0]
  return row?.state ?? null
}

const EMPTY_STATE = new Uint8Array()

// ---------------------------------------------------------------------------
// collection page → GFM table dump
// ---------------------------------------------------------------------------

/** Safely escape pipes/newlines inside a GFM cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Turn a property value into a human-readable string according to the field type. */
function cellString(
  field: CollectionField,
  value: unknown,
  userNames: Map<string, string>,
  relTitles?: Map<string, string>,
): string {
  if (value === undefined || value === null) return ''
  switch (field.type) {
    // relation: titles of linked rows that pass the same visibility gate (never raw ids)
    case 'relation':
      return Array.isArray(value)
        ? value
            .map((id) => relTitles?.get(String(id)))
            .filter((t): t is string => t !== undefined)
            .join(', ')
        : ''
    // rollups are computed per viewer and never stored
    case 'rollup':
      return ''
    case 'checkbox':
      return value ? '✅' : '⬜'
    case 'select': {
      const opt = field.options?.find((o) => o.id === value)
      return opt ? opt.name : ''
    }
    case 'multiSelect': {
      if (!Array.isArray(value)) return ''
      return value
        .map((id) => field.options?.find((o) => o.id === id)?.name)
        .filter((n): n is string => Boolean(n))
        .join(', ')
    }
    case 'person':
      return userNames.get(String(value)) ?? '-'
    case 'number':
    case 'date':
    case 'text':
    case 'url':
    default:
      return String(value)
  }
}

/**
 * Collection page body = its live children (rows) dumped as a GFM table.
 * Header: Title + field names; cells: stringified values. With no fields/rows only a minimal table is produced.
 */
/** Authenticated export (member): gate the collection's child rows with visibleTo. */
async function collectionTableMd(pageId: string, userId: string): Promise<string> {
  return collectionTableMdCore(pageId, visibleTo(userId))
}

/**
 * For public sharing (M15, unauthenticated): gate child-row visibility directly with scope='shared'.
 * Public routes have no user context, and children of a shared collection are always shared via
 * scope inheritance, but since this is unauthenticated exposure it is stated defensively (blocks
 * edge-case leaks such as orphaned private rows).
 */
export async function collectionTableMdShared(pageId: string): Promise<string> {
  // relation titles are NOT resolved for anonymous viewers: a linked row may live outside the
  // publicly shared subtree, so its title must not leak (cells render empty).
  return collectionTableMdCore(pageId, eq(pages.scope, 'shared'), false)
}

async function collectionTableMdCore(
  pageId: string,
  rowFilter: SQL,
  resolveRelationTitles = true,
): Promise<string> {
  const col = (
    await db
      .select({ fields: collections.fields })
      .from(collections)
      .where(eq(collections.pageId, pageId))
      .limit(1)
  )[0]
  const fields = (col?.fields ?? []) as CollectionField[]

  // The caller decides the child-row visibility gate via rowFilter:
  //  - authenticated export: visibleTo(userId) (H4 defense-in-depth)
  //  - public share:         scope='shared' (unauthenticated)
  const rows = (await db
    .select({ title: pages.title, props: pages.props })
    .from(pages)
    .where(and(eq(pages.parentId, pageId), isNull(pages.deletedAt), rowFilter))
    .orderBy(asc(pages.sortOrder), asc(pages.createdAt))) as {
    title: string
    props: Record<string, unknown>
  }[]

  // Look up names of userIds referenced by person field values
  const personFieldIds = fields.filter((f) => f.type === 'person').map((f) => f.id)
  const userNames = new Map<string, string>()
  if (personFieldIds.length > 0) {
    const userIds = new Set<string>()
    for (const r of rows) {
      for (const fid of personFieldIds) {
        const v = r.props?.[fid]
        if (typeof v === 'string' && v) userIds.add(v)
      }
    }
    if (userIds.size > 0) {
      // Members of the collection's workspace only (C-L11).
      const found = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(
          and(
            inArray(users.id, [...userIds]),
            sql`exists (select 1 from workspace_members m join pages p on p.workspace_id = m.workspace_id
                         where p.id = ${pageId} and m.user_id = ${users.id})`,
          ),
        )
      for (const u of found) userNames.set(u.id, u.name)
    }
  }

  // relation cells → only titles of target rows passing the same visibility gate (rowFilter); hidden/deleted rows are blank
  const relTitles = new Map<string, string>()
  const relFields = fields.filter((f) => f.type === 'relation')
  if (relFields.length > 0 && resolveRelationTitles) {
    const ids = new Set<string>()
    for (const r of rows)
      for (const f of relFields) {
        const v = r.props?.[f.id]
        if (Array.isArray(v))
          for (const id of v)
            if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) ids.add(id)
      }
    const list = [...ids]
    for (let i = 0; i < list.length; i += 5000) {
      const found = await db
        .select({ id: pages.id, title: pages.title })
        .from(pages)
        .where(and(inArray(pages.id, list.slice(i, i + 5000)), isNull(pages.deletedAt), rowFilter))
      for (const t of found) relTitles.set(t.id, t.title || 'Untitled')
    }
  }

  const header = ['Title', ...fields.map((f) => escapeCell(f.name))]
  const sep = header.map(() => '---')
  const lines = [`| ${header.join(' | ')} |`, `| ${sep.join(' | ')} |`]
  for (const r of rows) {
    const cells = [
      escapeCell(r.title ?? ''),
      ...fields.map((f) => escapeCell(cellString(f, r.props?.[f.id], userNames, relTitles))),
    ]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// single page md (assetMode 'absolute' — /files/... kept)
// ---------------------------------------------------------------------------

export interface ExportedMd {
  filename: string
  body: string
}

export async function exportPageMd(
  page: {
    id: string
    title: string
    updatedAt: Date
    kind?: string
  },
  userId: string,
): Promise<ExportedMd> {
  const markdown =
    page.kind === 'collection'
      ? await collectionTableMd(page.id, userId)
      : (
          await blocksToMarkdown(await loadBlocks(page.id), { assetMode: 'absolute' })
        ).markdown
  const body = frontmatter(page.id, page.updatedAt) + markdown
  return { filename: `${sanitizeName(page.title)}.md`, body }
}

// ---------------------------------------------------------------------------
// single canvas page → .canvas (JSON Canvas 1.0)
// ---------------------------------------------------------------------------

export interface ExportedCanvas {
  filename: string
  body: string
}

/**
 * Single canvas page export. There is no zip path map, so a page node uses the referenced page's
 * `<title>.md` as its file path (it connects if the Obsidian vault has a file with that name).
 * Deleted pages fall back to text ([[title]]).
 */
export async function exportPageCanvas(
  page: {
    id: string
    workspaceId: string
    title: string
  },
  userId: string,
): Promise<ExportedCanvas> {
  const filename = `${sanitizeName(page.title)}.canvas`
  const state = await loadState(page.id)
  if (!state) {
    return { filename, body: JSON.stringify({ nodes: [], edges: [] }, null, 2) }
  }

  // Prefetch titles of referenced page nodes (live + visibleTo pages only).
  // Hardening H4 (defense-in-depth): match the live routes' visibility rules.
  const refIds = collectPageRefs(state)
  const titleMap = new Map<string, string>()
  if (refIds.length > 0) {
    const rows = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      // Same workspace only: a canvas node naming another workspace's page id must not read its title
      // (visibleTo alone does not check membership; found in the guest audit, docs/adr/1252-*).
      .where(and(inArray(pages.id, refIds), eq(pages.workspaceId, page.workspaceId), isNull(pages.deletedAt), visibleTo(userId)))
    for (const r of rows) titleMap.set(r.id, r.title)
  }

  const opts: StateToCanvasOptions = {
    resolvePageFile: (pid) => {
      const t = titleMap.get(pid)
      return t != null ? `${sanitizeName(t)}.md` : null
    },
    resolvePageTitle: (pid) => titleMap.get(pid) ?? null,
  }
  const canvas = stateToCanvasJson(state, opts)
  return { filename, body: JSON.stringify(canvas, null, 2) }
}

// ---------------------------------------------------------------------------
// tree zip
// ---------------------------------------------------------------------------

/**
 * A Readable that opens `file` only when first read. JSZip binds every entry's stream up front
 * and reads them one after another, so eager createReadStream() held one fd per entry.
 */
export function lazyFileStream(file: string): Readable {
  let inner: ReadStream | null = null
  const out: Readable = new Readable({
    read() {
      if (inner) {
        inner.resume()
        return
      }
      inner = createReadStream(file)
      inner.on('data', (chunk) => {
        if (!out.push(chunk)) inner?.pause()
      })
      inner.on('end', () => out.push(null))
      inner.on('error', (err) => out.destroy(err))
    },
    destroy(err, cb) {
      inner?.destroy()
      cb(err)
    },
  })
  return out
}

export interface ExportedZip {
  filename: string
  /**
   * The zip. Destroying it (fastify does when the client disconnects) closes every entry stream,
   * removes the temp dir and calls `onFinish` (docs/adr/1241-*).
   */
  stream: NodeJS.ReadableStream & { destroy(err?: Error): unknown }
}

/** JSZip's Node output stream (readable-stream 2.x): `_helper` drives the worker chain. */
type ZipOutput = Readable & { _helper?: { pause(): unknown } }

// Export size guards (protects a small host from load) — caps on total attachment bytes and page count.
const MAX_EXPORT_BYTES = 300 * 1024 * 1024
const MAX_EXPORT_PAGES = 5000

interface ZipContext {
  zip: JSZip
  /** Spill a rendered entry to disk and register it lazily (docs/adr/0751-*). */
  put: (zipPath: string, content: string) => Promise<void>
  fileMimeMap: Map<string, string>
  usedAssets: Set<string>
  /** Resolvers for canvas page nodes — pageId → relative file path inside the zip / title. */
  canvasOpts: StateToCanvasOptions
  /** The exporting user — used for the visibleTo gate on collection child rows (H4). */
  userId: string
}

export async function exportZip(opts: {
  workspaceId: string
  rootPageId: string | null
  zipBaseName: string
  /** The exporting user — private pages are included in the tree only for their owner. */
  userId: string
  /**
   * Called once when the export is over: the stream ended, failed or was destroyed, or exportZip
   * threw. The heavy-job slot is released here (docs/adr/1240-*).
   */
  onFinish?: () => void
}): Promise<ExportedZip> {
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    opts.onFinish?.()
  }
  try {
    return await buildZip(opts, finish)
  } catch (err) {
    finish()
    throw err
  }
}

async function buildZip(
  opts: { workspaceId: string; rootPageId: string | null; zipBaseName: string; userId: string },
  finish: () => void,
): Promise<ExportedZip> {
  const { workspaceId, rootPageId, userId } = opts

  // 1) every live page in the workspace that is visible to me
  //    (other people's private pages are never collected, so they drop out of the tree, assets and canvas refs)
  const allPages = (await db
    .select({
      id: pages.id,
      parentId: pages.parentId,
      kind: pages.kind,
      title: pages.title,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(
      and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt), visibleTo(userId)),
    )
    .orderBy(asc(pages.sortOrder), asc(pages.createdAt))) as TreePage[]


  const byId = new Map<string, TreePage>()
  const childrenMap = new Map<string | null, TreePage[]>()
  for (const p of allPages) {
    byId.set(p.id, p)
    const key = p.parentId
    const arr = childrenMap.get(key) ?? []
    arr.push(p)
    childrenMap.set(key, arr)
  }

  // 2) assign unique file names per sibling group (case-insensitive duplicates → " (2)")
  const nameMap = new Map<string, string>()
  for (const group of childrenMap.values()) {
    const used = new Set<string>()
    for (const p of group) {
      const raw = sanitizeName(p.title)
      let name = raw
      let n = 2
      while (used.has(name.toLowerCase())) name = `${raw} (${n++})`
      used.add(name.toLowerCase())
      nameMap.set(p.id, name)
    }
  }

  // 3) asset mime/size/pageId maps (all workspace files)
  //    Hardening H3: also carry each fileId's owning pageId so that, before a blob goes into the zip,
  //    we gate on whether that file's page is visible to the requester (same as the files.ts download gate).
  const fileRows = await db
    .select({ id: files.id, mime: files.mime, size: files.size, pageId: files.pageId })
    .from(files)
    .where(eq(files.workspaceId, workspaceId))
  const fileMimeMap = new Map<string, string>()
  const fileSizeMap = new Map<string, number>()
  const filePageMap = new Map<string, string | null>()
  for (const f of fileRows) {
    fileMimeMap.set(f.id, f.mime)
    fileSizeMap.set(f.id, f.size)
    filePageMap.set(f.id, f.pageId)
  }

  // 4) pick the roots
  const roots =
    rootPageId != null
      ? byId.has(rootPageId)
        ? [byId.get(rootPageId)!]
        : []
      : childrenMap.get(null) ?? []

  // 5) precompute the path map for canvas page-node refs (same nameMap/structure as walk).
  //    doc/collection → <path>.md, canvas → <path>.canvas. Folders have no file.
  const pagePathMap = new Map<string, string>()
  const computePaths = (page: TreePage, parentDir: string): void => {
    const base = nameMap.get(page.id) ?? sanitizeName(page.title)
    const childDir = parentDir ? `${parentDir}/${base}` : base
    if (page.kind === 'doc' || page.kind === 'collection') {
      pagePathMap.set(page.id, parentDir ? `${parentDir}/${base}.md` : `${base}.md`)
    } else if (page.kind === 'canvas') {
      pagePathMap.set(page.id, parentDir ? `${parentDir}/${base}.canvas` : `${base}.canvas`)
    }
    for (const child of childrenMap.get(page.id) ?? []) computePaths(child, childDir)
  }
  for (const root of roots) computePaths(root, '')

  // Page count guard (mirrors the import guard) — counts the exported subtree, not the whole workspace:
  // a 20-page folder in a 15k-page workspace used to be refused with 413.
  let exported = 0
  const countTree = (page: TreePage): void => {
    exported++
    for (const child of childrenMap.get(page.id) ?? []) countTree(child)
  }
  for (const root of roots) countTree(root)
  if (exported > MAX_EXPORT_PAGES) {
    throw new AppError(413, 'EXPORT_TOO_LARGE', 'Export is too large')
  }

  const canvasOpts: StateToCanvasOptions = {
    resolvePageFile: (pid) => pagePathMap.get(pid) ?? null,
    resolvePageTitle: (pid) => byId.get(pid)?.title ?? null,
    // Canvas image cards → copies under assets/ in the zip. Attachments not in the workspace give null
    // (the 5a visibility gate filters what is actually included once more).
    resolveAssetFile: (fileId) => {
      const mime = fileMimeMap.get(fileId)
      return mime ? `assets/${fileId}${extForMime(mime)}` : null
    },
  }

  // Rendered markdown/canvas entries are spilled to a private temp dir and read back lazily by
  // the zip stream, so the export holds one page in memory instead of the whole tree
  // (docs/adr/0751-*). Guards below still run before the response starts.
  const tmpDir = path.join(env.dataDir, 'tmp', `export-${randomUUID()}`)
  await mkdir(tmpDir, { recursive: true })
  const cleanup = (): void => {
    void rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
  let seq = 0
  const zip = new JSZip()
  // Every entry stream, so an aborted download can close the one JSZip is reading (B-M1).
  const entries = new Set<Readable>()
  const entry = (file: string): Readable => {
    const s = lazyFileStream(file)
    entries.add(s)
    s.once('close', () => entries.delete(s))
    return s
  }
  const ctx: ZipContext = {
    zip,
    put: async (zipPath, content) => {
      const file = path.join(tmpDir, String(++seq))
      await writeFile(file, content, { mode: 0o600 })
      zip.file(zipPath, entry(file))
    },
    fileMimeMap,
    usedAssets: new Set(),
    canvasOpts,
    userId,
  }

  try {
    for (const root of roots) {
      await walk(root, '', ctx, nameMap, childrenMap)
    }
  } catch (err) {
    cleanup()
    throw err
  }

  // 5a) Hardening H3: per-file visibility gate (fail-closed).
  //     So that embedding another user's private-page attachment UUID in a visible page cannot leak
  //     the blob, an attachment is included only if its owning pageId is in this export's visible page
  //     set (byId) or its pageId is null (legacy). Files not in the workspace (absent from the map) are excluded too.
  const includedAssets: string[] = []
  for (const fileId of ctx.usedAssets) {
    if (!filePageMap.has(fileId)) continue
    const ownerPageId = filePageMap.get(fileId) ?? null
    if (ownerPageId !== null && !byId.has(ownerPageId)) continue
    includedAssets.push(fileId)
  }

  // 5b) export size guard — refuse if the attachment bytes actually included exceed the cap
  let assetBytes = 0
  for (const fileId of includedAssets) assetBytes += fileSizeMap.get(fileId) ?? 0
  if (assetBytes > MAX_EXPORT_BYTES) {
    cleanup()
    throw new AppError(413, 'EXPORT_TOO_LARGE', 'Export is too large')
  }

  // 6) add asset files as disk streams (avoids loading whole Buffers).
  //    Missing files are skipped (logged as before) — checked up front so a stream error cannot break the zip mid-way.
  for (const fileId of includedAssets) {
    const mime = ctx.fileMimeMap.get(fileId)
    if (!mime) continue
    const ext = extForMime(mime)
    const diskPath = path.join(env.dataDir, 'uploads', fileId)
    if (!existsSync(diskPath)) {
      console.warn('[inkling] export: asset file missing on disk, skipping', fileId)
      continue
    }
    ctx.zip.file(`assets/${fileId}${ext}`, entry(diskPath))
  }

  const stream = ctx.zip.generateNodeStream({ streamFiles: true }) as unknown as ZipOutput
  let cleaned = false
  const once = (): void => {
    if (cleaned) return
    cleaned = true
    // An aborted download leaves JSZip paused in the middle of an entry: stop its worker chain and
    // close every entry stream (the one being read holds an fd), then drop the spilled pages.
    stream._helper?.pause()
    for (const s of entries) s.destroy()
    entries.clear()
    cleanup()
    finish()
  }
  stream.on('end', once)
  stream.on('error', once)
  stream.on('close', once)
  // readable-stream 2.x (JSZip's output) emits no 'close' on destroy(); fastify destroys the payload
  // when the response closes early, so the teardown hooks _destroy as well.
  const destroyOrig = stream._destroy.bind(stream)
  stream._destroy = (err: Error | null, cb: (err?: Error | null) => void) => {
    once()
    destroyOrig(err, cb)
  }
  return { filename: `${sanitizeName(opts.zipBaseName)}.zip`, stream }
}

async function walk(
  page: TreePage,
  parentDir: string,
  ctx: ZipContext,
  nameMap: Map<string, string>,
  childrenMap: Map<string | null, TreePage[]>,
): Promise<void> {
  const base = nameMap.get(page.id) ?? sanitizeName(page.title)
  const mdPath = parentDir ? `${parentDir}/${base}.md` : `${base}.md`
  const childDir = parentDir ? `${parentDir}/${base}` : base
  const children = childrenMap.get(page.id) ?? []

  if (page.kind === 'doc') {
    const blocks = await loadBlocks(page.id)
    const { markdown, assetIds } = await blocksToMarkdown(blocks, {
      assetMode: 'relative',
      resolveAssetPath: (fileId) =>
        `assets/${fileId}${extForMime(ctx.fileMimeMap.get(fileId) ?? '')}`,
    })
    for (const a of assetIds) ctx.usedAssets.add(a)
    await ctx.put(mdPath, frontmatter(page.id, page.updatedAt) + markdown)
  } else if (page.kind === 'collection') {
    // A collection dumps its rows as a GFM table instead of a body. Row pages are still walked as children.
    const table = await collectionTableMd(page.id, ctx.userId)
    await ctx.put(mdPath, frontmatter(page.id, page.updatedAt) + table)
  } else if (page.kind === 'canvas') {
    // Canvas → <title>.canvas (JSON Canvas 1.0). Same location as mdPath, only the extension differs.
    const canvasPath = parentDir ? `${parentDir}/${base}.canvas` : `${base}.canvas`
    const state = await loadState(page.id)
    // Image attachments the canvas references go into the zip too, just like a doc body's.
    for (const fileId of collectAssetRefs(state ?? EMPTY_STATE)) ctx.usedAssets.add(fileId)
    const canvas = stateToCanvasJson(state ?? EMPTY_STATE, ctx.canvasOpts)
    await ctx.put(canvasPath, JSON.stringify(canvas, null, 2))
  }
  // folder: no file — children, if any, are created under childDir (empty folders are omitted)

  for (const child of children) {
    await walk(child, childDir, ctx, nameMap, childrenMap)
  }
}
