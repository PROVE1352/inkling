// Notion "Markdown & CSV" export importer (docs/adr/0960-*).
//
// Three phases:
//   A) plan (no writes): flatten the archive (one level of nested part zips), strip the 32-hex ids
//      from names, build the page tree, turn CSV databases into collections with typed fields and
//      pre-assign every page id so links and relations can be resolved before anything exists.
//   B) one transaction under the workspace tree lock: pages, collections and their table views.
//   C) one document at a time: Markdown → blocks, relative/Notion links → internal links, referenced
//      attachments uploaded, indexes rebuilt. A failure here deletes everything created so far
//      (pages cascade, uploaded files are removed), so an import either lands whole or not at all.
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import JSZip from 'jszip'
import { parseCsv, parseBoolean, parseNumber } from '@inkling/shared'
import type { CollectionField, PageScope, SelectOption, WorkspaceRole } from '@inkling/shared'
import { db } from '../db/index'
import { collections, collectionViews, files, pageDocs, pages } from '../db/schema'
import { env } from '../env'
import { badRequest } from '../errors'
import { pageColumns } from '../pageDto'
import type { PageRow } from '../pageDto'
import { assertPlacement, withTreeLock } from '../pageTree'
import { reindexPageChunks } from '../context/chunkIndex'
import {
  blocksToStateBuffer,
  mapBlockInlines,
  markdownToBlocks,
  stripFrontmatter,
  visitAssetBlocks,
} from './convert'
import type { AnyBlock, Inline, LinkInline } from './convert'
import {
  buildTitleResolver,
  EMPTY_BLOCKS,
  IMPORT_MAX_FOLDER_DEPTH,
  nextSortOrderBase,
  readZipEntryCapped,
} from './importer'
import { importLimits, mbLabel } from './importLimits'
import type { ImportLimits } from './importLimits'
import { reindexPageLinks } from './linkIndex'
import { mimeForExt } from './mime'
import {
  candidatePaths,
  decodeHref,
  hashFromNotionUrl,
  hashInPath,
  inferNotionColumn,
  isExternalHref,
  isNotionExportWrapper,
  isNotionPartArchive,
  looseKey,
  nfc,
  parseNotionDate,
  parseNotionName,
  parseRelationToken,
  preprocessNotionMarkdown,
  splitLeadingTitle,
  splitMulti,
  splitRelationCell,
  stripRowProperties,
  uniqueTitle,
} from './notionParse'
import { dropLeadingTitleHeading } from './titleHeading'
import type { NotionColumnType } from './notionParse'
import { reindexPageTags } from './tagIndex'
import { reindexPageTasks } from './taskIndex'
import { reindexPageText } from './textIndex'

/** Longest list kept in the report per category (the counts stay exact). */
const REPORT_LIST_CAP = 200
const MAX_FIELDS = 200
const MAX_OPTIONS = 50
const OPTION_COLORS: SelectOption['color'][] = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink']
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'])

export interface NotionImportReport {
  source: 'notion'
  /** 'explicit' = the client asked for a Notion import; 'auto' = detected from the file names. */
  detected: 'explicit' | 'auto'
  /** Every created page: documents + folders + collections + rows. */
  pages: number
  documents: number
  folders: number
  collections: number
  rows: number
  attachments: number
  /** Relative links, attachment paths and notion.so URLs found in the documents. */
  links: { total: number; resolved: number }
  brokenLinks: { page: string; href: string }[]
  brokenLinkCount: number
  skipped: { path: string; reason: string }[]
  skippedCount: number
  /** Sibling pages renamed "Title (2)" because their titles collided. */
  renamed: number
  /** Notion callouts imported as quotes / equations imported as code. */
  callouts: number
  equations: number
}

export interface NotionImportArgs {
  buffer: Buffer
  /** Already-parsed archive (the route parses it once for detection). */
  zip?: JSZip
  workspaceId: string
  parentId: string | null
  userId: string
  scope: PageScope
  role: WorkspaceRole
  detected: 'explicit' | 'auto'
  /** Name of the default table view of each imported database (locale of the importer). */
  tableViewName?: string
  limits?: ImportLimits
}

interface SrcEntry {
  path: string
  size: number
  read(): Promise<Buffer>
}

interface PlanNode {
  key: string
  id: string
  kind: 'doc' | 'folder' | 'collection'
  title: string
  fileTitle: string
  parentKey: string | null
  hash: string | null
  mdPath?: string
  csvPath?: string
  /** Folder whose Markdown files are the database's row pages. */
  rowsDir?: string
  isRow?: boolean
  rowOf?: string
  rowIndex?: number
  props?: Record<string, unknown>
  renamed?: boolean
  depth: number
}

interface CollectionPlan {
  key: string
  header: string[]
  body: string[][]
  fields: CollectionField[]
}

function isIgnoredPath(p: string): boolean {
  const segs = p.split('/').filter(Boolean)
  if (segs.length === 0) return true
  if (segs[0] === '__MACOSX') return true
  return segs.some((s) => s.startsWith('.'))
}

function cleanEntryPath(name: string): string | null {
  const segs = nfc(name.replace(/\\/g, '/'))
    .split('/')
    .filter((s) => s && s !== '.')
  if (segs.length === 0 || segs.includes('..')) return null
  return segs.join('/')
}

function declaredSize(e: JSZip.JSZipObject): number {
  return (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
}

function newFieldId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

function dirOf(p: string): string | null {
  const d = path.posix.dirname(p)
  return d === '.' ? null : d
}

class Report {
  r: NotionImportReport
  constructor(detected: 'explicit' | 'auto') {
    this.r = {
      source: 'notion',
      detected,
      pages: 0,
      documents: 0,
      folders: 0,
      collections: 0,
      rows: 0,
      attachments: 0,
      links: { total: 0, resolved: 0 },
      brokenLinks: [],
      brokenLinkCount: 0,
      skipped: [],
      skippedCount: 0,
      renamed: 0,
      callouts: 0,
      equations: 0,
    }
  }
  skip(p: string, reason: string): void {
    this.r.skippedCount++
    if (this.r.skipped.length < REPORT_LIST_CAP) this.r.skipped.push({ path: p, reason })
  }
  broken(page: string, href: string): void {
    this.r.brokenLinkCount++
    if (this.r.brokenLinks.length < REPORT_LIST_CAP) this.r.brokenLinks.push({ page, href })
  }
}

// ---------------------------------------------------------------------------
// A1) archive → flat entry list (nested part archives unpacked once)
// ---------------------------------------------------------------------------

async function collectEntries(zip: JSZip, limits: ImportLimits, report: Report): Promise<SrcEntry[]> {
  const meter = { total: 0 }
  const archiveMeter = { total: 0 }
  const entryLimits = { entry: limits.maxEntryBytes, total: limits.maxUnpackedBytes }
  const out: SrcEntry[] = []
  const seen = new Set<string>()
  let declared = 0

  const add = (e: JSZip.JSZipObject): void => {
    if (e.dir || isIgnoredPath(e.name)) return
    const p = cleanEntryPath(e.name)
    if (!p) {
      report.skip(e.name, 'unsafe path')
      return
    }
    if (seen.has(p)) {
      report.skip(p, 'duplicate path in the archive')
      return
    }
    seen.add(p)
    const size = declaredSize(e)
    declared += size
    out.push({ path: p, size, read: () => readZipEntryCapped(e, meter, entryLimits) })
    if (out.length > limits.maxFiles) throw badRequest(`Too many files in the archive (max ${limits.maxFiles})`)
  }

  const outer = Object.values(zip.files).filter((e) => !e.dir && !isIgnoredPath(e.name))
  const hasDocs = outer.some((e) => /\.(md|csv)$/i.test(e.name))
  for (const e of outer) {
    const nested = /\.zip$/i.test(e.name) && (!hasDocs || isNotionPartArchive(e.name))
    if (!nested) {
      add(e)
      continue
    }
    // Notion splits large exports into part archives inside the download. Their compressed bytes
    // are held in memory, bounded by the upload cap (a second copy of the upload at most).
    const buf = await readZipEntryCapped(e, archiveMeter, {
      entry: limits.maxUploadBytes,
      total: limits.maxUploadBytes,
    })
    let inner: JSZip
    try {
      inner = await JSZip.loadAsync(buf)
    } catch {
      report.skip(e.name, 'not a readable zip archive')
      continue
    }
    for (const ie of Object.values(inner.files)) add(ie)
  }
  if (declared > limits.maxUnpackedBytes) {
    throw badRequest(`Archive is too large when unpacked (max ${mbLabel(limits.maxUnpackedBytes)})`)
  }
  return out
}

// ---------------------------------------------------------------------------
// A2) plan the tree
// ---------------------------------------------------------------------------

interface Plan {
  nodes: Map<string, PlanNode>
  ordered: PlanNode[]
  collectionsByKey: Map<string, CollectionPlan>
  pathToNode: Map<string, PlanNode>
  hashToNode: Map<string, PlanNode>
  assetByPath: Map<string, SrcEntry>
  assetsByBase: Map<string, string[]>
  entryByPath: Map<string, SrcEntry>
  roots: string[]
  maxDepth: number
}

async function planTree(entries: SrcEntry[], report: Report, limits: ImportLimits): Promise<Plan> {
  const nodes = new Map<string, PlanNode>()
  const pathToNode = new Map<string, PlanNode>()
  const hashToNode = new Map<string, PlanNode>()
  const assetByPath = new Map<string, SrcEntry>()
  const assetsByBase = new Map<string, string[]>()
  const entryByPath = new Map(entries.map((e) => [e.path, e]))

  const mds = entries.filter((e) => e.path.toLowerCase().endsWith('.md'))
  const csvs = entries.filter((e) => e.path.toLowerCase().endsWith('.csv'))
  for (const e of entries) {
    const lower = e.path.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.csv')) continue
    assetByPath.set(e.path, e)
    const base = path.posix.basename(e.path)
    assetsByBase.set(base, [...(assetsByBase.get(base) ?? []), e.path])
  }

  // Single top-level `Export-<uuid>` folder: not a page; links may be written relative to it.
  const firstSegs = new Set(entries.map((e) => e.path.split('/')[0]))
  const wrapper =
    firstSegs.size === 1 && entries.every((e) => e.path.includes('/')) && isNotionExportWrapper([...firstSegs][0])
      ? [...firstSegs][0]
      : null
  const roots = wrapper ? ['', wrapper] : ['']

  const tooMany = () => badRequest(`Too many pages to import (max ${limits.maxPages})`)
  const addNode = (n: Omit<PlanNode, 'id' | 'depth'>): PlanNode => {
    if (nodes.size >= limits.maxPages) throw tooMany()
    const node: PlanNode = { ...n, id: randomUUID(), depth: 0 }
    nodes.set(node.key, node)
    return node
  }
  const parentKeyOf = (key: string): string | null => {
    const d = dirOf(key)
    return d && d !== wrapper ? d : null
  }
  const ensureFolderChain = (dir: string | null): void => {
    if (!dir || dir === wrapper) return
    const segs = dir.split('/')
    if (segs.length > IMPORT_MAX_FOLDER_DEPTH + 1) {
      throw badRequest(`Folders are nested too deeply (max ${IMPORT_MAX_FOLDER_DEPTH} levels)`)
    }
    for (let i = 1; i <= segs.length; i++) {
      const k = segs.slice(0, i).join('/')
      if (k === wrapper || nodes.has(k)) continue
      const name = parseNotionName(segs[i - 1], true)
      addNode({ key: k, kind: 'folder', title: name.title, fileTitle: name.title, parentKey: parentKeyOf(k), hash: name.hash })
    }
  }

  // Markdown pages: `X <hash>.md` and folder `X <hash>/` share the key → one page with children.
  for (const e of mds) {
    const key = e.path.slice(0, -3)
    const name = parseNotionName(path.posix.basename(e.path))
    const existing = nodes.get(key)
    if (existing) {
      existing.kind = 'doc'
      existing.mdPath = e.path
      existing.title = name.title
      existing.fileTitle = name.title
    } else {
      addNode({ key, kind: 'doc', title: name.title, fileTitle: name.title, parentKey: parentKeyOf(key), hash: name.hash, mdPath: e.path })
    }
    ensureFolderChain(dirOf(e.path))
  }

  // Databases: prefer `X_all.csv` (every row and property) over the view-filtered `X.csv`.
  const csvByKey = new Map<string, SrcEntry>()
  for (const e of csvs) {
    const name = parseNotionName(path.posix.basename(e.path))
    const dir = dirOf(e.path)
    const stem = path.posix.basename(e.path).slice(0, -4).replace(/_all$/i, '')
    const key = dir ? `${dir}/${stem}` : stem
    const prev = csvByKey.get(key)
    if (prev) {
      const prevAll = parseNotionName(path.posix.basename(prev.path)).isAll
      if (name.isAll && !prevAll) {
        report.skip(prev.path, 'database view export (the _all.csv variant was used)')
        csvByKey.set(key, e)
      } else {
        report.skip(e.path, 'database view export (the _all.csv variant was used)')
      }
      continue
    }
    csvByKey.set(key, e)
  }
  const collectionsByKey = new Map<string, CollectionPlan>()
  for (const [rowsKey, e] of csvByKey) {
    const name = parseNotionName(path.posix.basename(e.path))
    const clash = nodes.get(rowsKey)
    let node: PlanNode
    if (clash && clash.kind === 'doc') {
      // A page and a database with the same name: the database becomes a child of the page.
      node = addNode({ key: `${rowsKey}\u0000db`, kind: 'collection', title: name.title, fileTitle: name.title, parentKey: rowsKey, hash: name.hash, csvPath: e.path, rowsDir: rowsKey })
    } else if (clash) {
      clash.kind = 'collection'
      clash.csvPath = e.path
      clash.rowsDir = rowsKey
      clash.title = name.title
      clash.fileTitle = name.title
      clash.hash = name.hash ?? clash.hash
      node = clash
    } else {
      node = addNode({ key: rowsKey, kind: 'collection', title: name.title, fileTitle: name.title, parentKey: parentKeyOf(rowsKey), hash: name.hash, csvPath: e.path, rowsDir: rowsKey })
    }
    ensureFolderChain(dirOf(e.path))
    const parsed = parseCsv((await e.read()).toString('utf8'))
    const [header = [], ...body] = parsed.rows
    collectionsByKey.set(node.key, { key: node.key, header, body, fields: [] })
  }

  // Rows: match CSV rows to the row pages in the database folder (title, then truncated prefix).
  for (const [ckey, cp] of collectionsByKey) {
    const coll = nodes.get(ckey)!
    const candidates = [...nodes.values()].filter((n) => n.parentKey === coll.rowsDir && n.kind === 'doc' && !n.isRow)
    const used = new Set<PlanNode>()
    const findRowPage = (title: string): PlanNode | undefined => {
      const k = looseKey(title)
      return (
        candidates.find((c) => !used.has(c) && looseKey(c.fileTitle) === k) ??
        candidates.find((c) => {
          const ck = looseKey(c.fileTitle)
          return !used.has(c) && ck.length >= 8 && k.startsWith(ck)
        })
      )
    }
    cp.body.forEach((cells, i) => {
      const title = (cells[0] ?? '').trim() || 'Untitled'
      const page = findRowPage(title)
      if (page) {
        used.add(page)
        page.isRow = true
        page.rowOf = ckey
        page.rowIndex = i
        page.parentKey = ckey
        page.title = title
      } else {
        addNode({ key: `${ckey}\u0000row${i}`, kind: 'doc', title, fileTitle: title, parentKey: ckey, hash: null, isRow: true, rowOf: ckey, rowIndex: i })
      }
    })
    // Row pages without a CSV row (e.g. a filtered view export) stay rows with empty properties.
    if (coll.rowsDir === ckey) {
      let extra = cp.body.length
      for (const c of candidates) {
        if (used.has(c)) continue
        c.isRow = true
        c.rowOf = ckey
        c.rowIndex = extra++
      }
    }
  }

  // Link targets: archive paths and Notion ids → planned pages.
  for (const n of nodes.values()) {
    if (n.mdPath) pathToNode.set(n.mdPath, n)
    if (n.kind === 'folder' || n.kind === 'doc') pathToNode.set(n.key, n)
    if (n.kind === 'collection') {
      if (!pathToNode.has(n.rowsDir!)) pathToNode.set(n.rowsDir!, n)
      if (!n.key.includes('\u0000')) pathToNode.set(n.key, n)
    }
    // a page's id also names its folder: prefer the page over a bare folder
    const prev = n.hash ? hashToNode.get(n.hash) : undefined
    if (n.hash && (!prev || prev.kind === 'folder')) hashToNode.set(n.hash, n)
  }
  for (const [key, e] of csvByKey) {
    const coll = [...nodes.values()].find((n) => n.csvPath === e.path)
    if (!coll) continue
    pathToNode.set(e.path, coll)
    pathToNode.set(`${key}.csv`, coll)
    pathToNode.set(`${key}_all.csv`, coll)
  }

  // Depth + order (parents first; rows in CSV order, other siblings by title) + sibling de-dup.
  const children = new Map<string | null, PlanNode[]>()
  for (const n of nodes.values()) {
    const list = children.get(n.parentKey) ?? []
    list.push(n)
    children.set(n.parentKey, list)
  }
  const ordered: PlanNode[] = []
  let maxDepth = 0
  const walk = (parentKey: string | null, depth: number): void => {
    const list = children.get(parentKey)
    if (!list) return
    list.sort((a, b) => {
      if (a.isRow && b.isRow) return (a.rowIndex ?? 0) - (b.rowIndex ?? 0)
      if (a.isRow !== b.isRow) return a.isRow ? 1 : -1
      return a.title.localeCompare(b.title)
    })
    const taken = new Set<string>()
    for (const n of list) {
      if (!n.isRow) {
        const t = uniqueTitle(n.title, taken)
        if (t !== n.title) {
          n.title = t
          n.renamed = true
          report.r.renamed++
        }
      }
      n.depth = depth
      maxDepth = Math.max(maxDepth, depth)
      if (depth > IMPORT_MAX_FOLDER_DEPTH) {
        throw badRequest(`Folders are nested too deeply (max ${IMPORT_MAX_FOLDER_DEPTH} levels)`)
      }
      ordered.push(n)
      walk(n.key, depth + 1)
    }
  }
  walk(null, 0)
  if (ordered.length > limits.maxPages) throw tooMany()

  // Assets referenced nowhere are reported later; Markdown/CSV that never became a page:
  return { nodes, ordered, collectionsByKey, pathToNode, hashToNode, assetByPath, assetsByBase, entryByPath, roots, maxDepth }
}

// ---------------------------------------------------------------------------
// A3) link / relation resolution against the plan
// ---------------------------------------------------------------------------

type Target = { kind: 'page'; node: PlanNode } | { kind: 'asset'; path: string } | null

function resolveTarget(plan: Plan, fromPath: string, href: string): Target {
  const notionHash = hashFromNotionUrl(href)
  if (notionHash) {
    const node = plan.hashToNode.get(notionHash)
    return node ? { kind: 'page', node } : null
  }
  const decoded = decodeHref(href)
  if (!decoded) return null
  const cands: string[] = []
  for (const root of plan.roots) {
    const from = root && !fromPath.startsWith(`${root}/`) ? `${root}/${fromPath}` : fromPath
    for (const c of candidatePaths(from, decoded)) if (!cands.includes(c)) cands.push(c)
    if (root) for (const c of candidatePaths('', `${root}/${decoded}`)) if (!cands.includes(c)) cands.push(c)
  }
  for (const c of cands) {
    const node = plan.pathToNode.get(c)
    if (node) return { kind: 'page', node }
    if (plan.assetByPath.has(c)) return { kind: 'asset', path: c }
  }
  const ext = path.posix.extname(decoded).toLowerCase()
  if (ext === '.md' || ext === '.csv' || ext === '') {
    const h = hashInPath(decoded)
    const node = h ? plan.hashToNode.get(h) : undefined
    if (node) return { kind: 'page', node }
    return null
  }
  const same = plan.assetsByBase.get(path.posix.basename(decoded))
  if (same && same.length === 1) return { kind: 'asset', path: same[0] }
  return null
}

function buildCollectionFields(plan: Plan, report: Report): void {
  // row title index across the whole import (relation fallback by title)
  const rowsByTitle = new Map<string, PlanNode[]>()
  for (const n of plan.nodes.values()) {
    if (!n.isRow) continue
    const k = looseKey(n.title)
    rowsByTitle.set(k, [...(rowsByTitle.get(k) ?? []), n])
  }

  for (const cp of plan.collectionsByKey.values()) {
    const coll = plan.nodes.get(cp.key)!
    const rowNodes = new Map<number, PlanNode>()
    for (const n of plan.nodes.values()) if (n.rowOf === cp.key && n.rowIndex !== undefined) rowNodes.set(n.rowIndex, n)
    const width = Math.max(cp.header.length, ...cp.body.map((r) => r.length), 0)

    for (let col = 1; col < width; col++) {
      if (cp.fields.length >= MAX_FIELDS) break
      const values = cp.body.map((r) => (r[col] ?? '').trim())
      const name = (cp.header[col] ?? '').trim().slice(0, 60) || `Column ${col + 1}`
      let type: NotionColumnType | 'relation' = inferNotionColumn(values)
      const field: CollectionField = { id: newFieldId(), name, type: 'text' }
      const cellValue = new Map<number, unknown>()

      // relation: every token resolves to a row of one collection of this import
      if (type === 'text' || type === 'select' || type === 'multiSelect') {
        let target: string | null = null
        let ok = values.some((v) => v !== '')
        const resolved = new Map<number, string[]>()
        for (let i = 0; i < values.length && ok; i++) {
          if (!values[i]) continue
          const ids: string[] = []
          for (const token of splitRelationCell(values[i])) {
            const { title, href } = parseRelationToken(token)
            let row: PlanNode | undefined
            if (href) {
              const t = resolveTarget(plan, coll.csvPath!, href)
              if (t?.kind === 'page' && t.node.isRow) row = t.node
            }
            if (!row) {
              const byTitle = (rowsByTitle.get(looseKey(title)) ?? []).filter((r) => !target || r.rowOf === target)
              if (byTitle.length >= 1 && new Set(byTitle.map((r) => r.rowOf)).size === 1) row = byTitle[0]
            }
            if (!row || (target && row.rowOf !== target)) {
              ok = false
              break
            }
            target = row.rowOf!
            ids.push(row.id)
          }
          resolved.set(i, [...new Set(ids)])
        }
        if (ok && target) {
          type = 'relation'
          field.type = 'relation'
          field.relation = { targetPageId: plan.nodes.get(target)!.id }
          for (const [i, ids] of resolved) cellValue.set(i, ids)
        }
      }

      if (type === 'select' || type === 'multiSelect') {
        const names: string[] = []
        for (const v of values) {
          if (!v) continue
          for (const n of type === 'multiSelect' ? splitMulti(v) : [v]) if (!names.includes(n)) names.push(n)
        }
        if (names.length > MAX_OPTIONS || names.some((n) => n.length > 60)) {
          type = 'text'
        } else {
          field.type = type
          field.options = names.map((n, i) => ({ id: newFieldId(), name: n, color: OPTION_COLORS[i % OPTION_COLORS.length] }))
          const idOf = new Map(field.options.map((o) => [o.name, o.id]))
          values.forEach((v, i) => {
            if (!v) return
            cellValue.set(i, type === 'multiSelect' ? [...new Set(splitMulti(v).map((n) => idOf.get(n)!))] : idOf.get(v))
          })
        }
      }
      if (type === 'number' || type === 'date' || type === 'checkbox' || type === 'url') {
        field.type = type
        values.forEach((v, i) => {
          if (!v && type !== 'checkbox') return
          const parsed =
            type === 'number' ? parseNumber(v)
            : type === 'date' ? parseNotionDate(v)
            : type === 'checkbox' ? v === 'Yes' || parseBoolean(v) === true
            : v
          if (parsed !== null && parsed !== undefined) cellValue.set(i, parsed)
        })
      }
      if (type === 'text' || type === 'email') {
        field.type = 'text'
        values.forEach((v, i) => {
          if (!v) return
          // a relation that did not resolve: keep the titles, drop the export paths
          const tokens = splitRelationCell(v)
          const clean = tokens.every((t) => /\([^()]+\.md\)$/i.test(t))
            ? tokens.map((t) => parseRelationToken(t).title).join(', ')
            : v
          cellValue.set(i, clean)
        })
      }

      cp.fields.push(field)
      for (const [i, value] of cellValue) {
        const row = rowNodes.get(i)
        if (!row) continue
        row.props = { ...(row.props ?? {}), [field.id]: value }
      }
    }
    if (width - 1 > MAX_FIELDS) report.skip(coll.csvPath!, `columns after the first ${MAX_FIELDS} were not imported`)
  }
}

async function planNotion(zip: JSZip, limits: ImportLimits, report: Report): Promise<Plan> {
  const entries = await collectEntries(zip, limits, report)
  const plan = await planTree(entries, report, limits)
  buildCollectionFields(plan, report)
  return plan
}

/** Phase A only (no database): the planned tree, for tests and dry runs. */
export async function planNotionExport(
  zip: JSZip,
  limits: ImportLimits = importLimits,
): Promise<{
  pages: { title: string; kind: string; parent: string | null; isRow: boolean; props: Record<string, unknown> }[]
  collections: { title: string; fields: CollectionField[]; rows: number }[]
  skipped: NotionImportReport['skipped']
  renamed: number
}> {
  const report = new Report('explicit')
  const plan = await planNotion(zip, limits, report)
  const titleOf = (key: string | null) => (key ? plan.nodes.get(key)!.title : null)
  return {
    pages: plan.ordered.map((n) => ({ title: n.title, kind: n.kind, parent: titleOf(n.parentKey), isRow: !!n.isRow, props: n.props ?? {} })),
    collections: [...plan.collectionsByKey.values()].map((c) => ({
      title: plan.nodes.get(c.key)!.title,
      fields: c.fields,
      rows: plan.ordered.filter((n) => n.rowOf === c.key).length,
    })),
    skipped: report.r.skipped,
    renamed: report.r.renamed,
  }
}

// ---------------------------------------------------------------------------
// C) documents: links, attachments
// ---------------------------------------------------------------------------

function linkText(l: LinkInline): string {
  return (l.content ?? []).map((c) => c.text ?? '').join('')
}

function collectRefs(blocks: AnyBlock[]): string[] {
  const refs: string[] = []
  mapBlockInlines(blocks, (inlines) => {
    for (const inl of inlines) {
      if (inl.type === 'link' && typeof (inl as LinkInline).href === 'string') refs.push((inl as LinkInline).href)
    }
    return inlines
  })
  visitAssetBlocks(blocks, (b) => {
    if (typeof b.props?.url === 'string') refs.push(b.props.url)
  })
  return refs
}

/** Paragraphs made only of one attachment link become file / image blocks. */
function promoteAttachmentParagraphs(blocks: AnyBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (Array.isArray(b.children) && b.children.length) promoteAttachmentParagraphs(b.children)
    if (b.type !== 'paragraph' || !Array.isArray(b.content)) continue
    const parts = (b.content as Inline[]).filter(
      (x) => !(x.type === 'text' && typeof (x as { text?: string }).text === 'string' && !(x as { text: string }).text.trim()),
    )
    if (parts.length !== 1 || parts[0].type !== 'link') continue
    const link = parts[0] as LinkInline
    if (!link.href.startsWith('/files/')) continue
    const name = linkText(link)
    const isImage = IMAGE_EXT.has(path.posix.extname(name).toLowerCase())
    blocks[i] = {
      id: b.id,
      type: isImage ? 'image' : 'file',
      props: { url: link.href, name, caption: '' },
      children: b.children ?? [],
    }
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function importNotionZip(args: NotionImportArgs): Promise<{ pages: PageRow[]; report: NotionImportReport }> {
  const { workspaceId, parentId, userId, role } = args
  const limits = args.limits ?? importLimits
  const report = new Report(args.detected)

  let zip = args.zip
  if (!zip) {
    try {
      zip = await JSZip.loadAsync(args.buffer)
    } catch {
      throw badRequest('Not a readable zip archive')
    }
  }

  // ---- A) plan
  const plan = await planNotion(zip, limits, report)
  if (plan.ordered.length === 0) throw badRequest('No Notion pages found in the archive')

  // ---- B) pages, collections, views — one transaction
  const created: PageRow[] = await withTreeLock(workspaceId, async (tx) => {
    let scope = args.scope
    if (parentId) {
      const chain = await assertPlacement(tx, { workspaceId, parentId, role, userId, height: plan.maxDepth })
      scope = chain[0].scope
    }
    const topBase = await nextSortOrderBase(tx, workspaceId, parentId)
    const counters = new Map<string, number>()
    const values = plan.ordered.map((n) => {
      const parent = n.parentKey ? plan.nodes.get(n.parentKey)! : null
      const pk = n.parentKey ?? '\u0000root'
      const sort = counters.get(pk) ?? (parent ? 1000 : topBase)
      counters.set(pk, sort + 1000)
      return {
        id: n.id,
        workspaceId,
        parentId: parent ? parent.id : parentId,
        kind: n.kind,
        scope,
        title: n.title.slice(0, 500),
        sortOrder: sort,
        createdBy: userId,
        props: n.props ?? {},
      }
    })
    const rows: PageRow[] = []
    for (let i = 0; i < values.length; i += 500) {
      rows.push(...(await tx.insert(pages).values(values.slice(i, i + 500)).returning(pageColumns)))
    }
    const colls = [...plan.collectionsByKey.values()]
    if (colls.length) {
      await tx.insert(collections).values(colls.map((c) => ({ pageId: plan.nodes.get(c.key)!.id, fields: c.fields })))
      await tx.insert(collectionViews).values(
        colls.map((c) => ({
          pageId: plan.nodes.get(c.key)!.id,
          name: args.tableViewName ?? 'Table',
          type: 'table' as const,
          config: {},
          sortOrder: 1000,
        })),
      )
    }
    return rows
  })

  const createdById = new Map(created.map((r) => [r.id, r]))
  const topIds = plan.ordered.filter((n) => !n.parentKey).map((n) => n.id)
  const uploaded = new Map<string, string>() // archive path → file id
  const uploadedPaths: string[] = []
  try {
    // ---- C) documents, one at a time
    const batchMap = new Map<string, string>()
    for (const n of plan.ordered) batchMap.set(n.title.toLowerCase(), n.id)
    const resolveTitle = await buildTitleResolver(workspaceId, batchMap, userId)
    const pageHref = (n: PlanNode) => `/w/${workspaceId}/p/${n.id}`

    const upload = async (p: string, ownerPageId: string): Promise<string> => {
      const have = uploaded.get(p)
      if (have) return `/files/${have}`
      const entry = plan.assetByPath.get(p)!
      const data = await entry.read()
      const id = randomUUID()
      const dest = path.join(env.dataDir, 'uploads', id)
      await writeFile(dest, data, { flag: 'wx' })
      uploadedPaths.push(dest)
      await db.insert(files).values({
        id,
        workspaceId,
        pageId: ownerPageId,
        name: path.posix.basename(p),
        mime: mimeForExt(path.posix.extname(p)),
        size: data.length,
        createdBy: userId,
      })
      uploaded.set(p, id)
      return `/files/${id}`
    }

    for (const n of plan.ordered) {
      if (n.kind !== 'doc' || !n.mdPath) continue
      const entry = plan.entryByPath.get(n.mdPath)!
      const raw = stripFrontmatter((await entry.read()).toString('utf8'))
      const lead = splitLeadingTitle(raw, n.fileTitle)
      let body = lead.body
      if (n.isRow) body = stripRowProperties(body, plan.collectionsByKey.get(n.rowOf!)?.header ?? [])
      const pre = preprocessNotionMarkdown(body)
      report.r.callouts += pre.stats.callouts
      report.r.equations += pre.stats.equations
      // Safety net after splitLeadingTitle: a first H1 that still equals the title (md/titleHeading.ts)
      let blocks = dropLeadingTitleHeading(await markdownToBlocks(pre.md, resolveTitle), lead.title ?? n.title)

      // resolve every relative / Notion reference, uploading the attachments it points at
      const resolved = new Map<string, string | null>()
      for (const href of collectRefs(blocks)) {
        if (resolved.has(href)) continue
        if (isExternalHref(href) && !hashFromNotionUrl(href)) continue
        if (href.startsWith('/files/') || href.startsWith(`/w/${workspaceId}/`)) continue
        report.r.links.total++
        const t = resolveTarget(plan, n.mdPath, href)
        let url: string | null = null
        if (t?.kind === 'page') url = pageHref(t.node)
        else if (t?.kind === 'asset') url = await upload(t.path, n.id)
        if (url) report.r.links.resolved++
        else report.broken(n.title, href)
        resolved.set(href, url)
      }
      if (resolved.size) {
        mapBlockInlines(blocks, (inlines) =>
          inlines.map((inl) => {
            if (inl.type !== 'link') return inl
            const l = inl as LinkInline
            const url = resolved.get(l.href)
            return url ? ({ ...l, href: url } as Inline) : inl
          }),
        )
        visitAssetBlocks(blocks, (b) => {
          const url = typeof b.props?.url === 'string' ? resolved.get(b.props.url) : null
          if (url) b.props!.url = url
        })
        promoteAttachmentParagraphs(blocks)
      }
      if (blocks.length === 0) blocks = EMPTY_BLOCKS

      await db.insert(pageDocs).values({ pageId: n.id, state: blocksToStateBuffer(blocks) }).onConflictDoNothing()
      if (lead.title && !n.renamed && !n.isRow && lead.title !== n.title) {
        await db.update(pages).set({ title: lead.title.slice(0, 500) }).where(eq(pages.id, n.id))
        const row = createdById.get(n.id)
        if (row) row.title = lead.title.slice(0, 500)
      }
      await reindexPageLinks(n.id, blocks)
      await reindexPageText(n.id, blocks)
      await reindexPageChunks(n.id, blocks)
      await reindexPageTags(n.id, blocks)
      await reindexPageTasks(n.id, blocks)
    }
  } catch (err) {
    // Compensate: nothing of a failed import stays behind (pages cascade to docs, rows, indexes).
    const ids = [...uploaded.values()]
    if (ids.length) await db.delete(files).where(inArray(files.id, ids)).catch(() => {})
    for (const p of uploadedPaths) await rm(p, { force: true }).catch(() => {})
    if (topIds.length) await db.delete(pages).where(inArray(pages.id, topIds)).catch(() => {})
    throw err
  }

  for (const p of plan.assetByPath.keys()) {
    if (!uploaded.has(p)) report.skip(p, 'attachment not referenced by any page')
  }
  for (const n of plan.ordered) {
    if (n.kind === 'folder') report.r.folders++
    else if (n.kind === 'collection') report.r.collections++
    else if (n.isRow) report.r.rows++
    else report.r.documents++
  }
  report.r.pages = plan.ordered.length
  report.r.attachments = uploaded.size
  return { pages: created, report: report.r }
}
