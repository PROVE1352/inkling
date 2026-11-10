import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, max } from 'drizzle-orm'
import * as Y from 'yjs'
import type {
  CollectionField,
  PageProperty,
  PageScope,
  TemplateCursorDTO,
  TemplateInputDTO,
  TemplatePreviewBlockDTO,
  TemplatePreviewDTO,
  TemplatePreviewNodeDTO,
  ViewConfig,
  ViewType,
  WorkspaceRole,
} from '@inkling/shared'
import { TEMPLATE_MAX_HEIGHT, TEMPLATE_MAX_PAGES } from '@inkling/shared'
import { db } from '../db/index'
import { collectionViews, collections, pageDocs, pages } from '../db/schema'
import { AppError } from '../errors'
import { blocksToStateBuffer, stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { reindexPageLinks } from '../md/linkIndex'
import { reindexPageTags } from '../md/tagIndex'
import { reindexPageTasks } from '../md/taskIndex'
import { reindexPageChunks } from '../context/chunkIndex'
import { reindexPageText } from '../md/textIndex'
import { applyStoredState, toV1 } from '../yState'
import { pageColumns, visibleTo } from '../pageDto'
import type { PageRow } from '../pageDto'
import { assertPlacement, withTreeLock } from '../pageTree'
import { collectInputs, hasVariables, renderString } from './variables'
import type { VarContext } from './variables'
import { insertRowTemplates, snapshotRowTemplates } from '../rowTemplates'
import type { TRowTemplate } from '../rowTemplates'

/**
 * Template tree model (docs/adr/0920-*, 0921-*).
 *
 * `templates.content` holds either
 *   - an array of BlockNote blocks: a legacy single-document template (rows saved before v2), or
 *   - `{ v: 2, root: TNode }`: a page tree. Document and canvas bodies are kept as their Yjs state
 *     (base64), so blocks the server's editor schema does not know (callouts, …) survive.
 *
 * Node ids are local keys (uuid): the source page ids for a saved subtree, fresh uuids for built-ins
 * and imports. Instantiation maps every key to a new page id and rewrites the references that point
 * at keys: internal link hrefs (/w/<ws>/p/<key>), relation targets and values, canvas page nodes.
 */

export type NodeKind = 'doc' | 'folder' | 'canvas' | 'collection'

export interface TemplateView {
  name: string
  type: ViewType
  config: ViewConfig
  sortOrder: number
}

export interface TNode {
  id: string
  kind: NodeKind
  title: string
  icon: string | null
  /** Doc/canvas body: base64 Yjs update. Missing = empty body. */
  state?: string
  /** Row values when the parent is a collection (fieldId → value). */
  props?: Record<string, unknown>
  /** Page properties (frontmatter-like). */
  properties?: PageProperty[]
  /** Collection schema and views. */
  fields?: CollectionField[]
  views?: TemplateView[]
  /**
   * Row templates of a collection (docs/adr/1183-*). Their variables are kept as written: they
   * are filled when a row is created, so they are not inputs of this template.
   */
  rowTemplates?: TRowTemplate[]
  children: TNode[]
}

export interface TemplateContentV2 {
  v: 2
  root: TNode
}

/** Meta kept in templates.default_props (old rows only have `withDate`). */
export interface TemplateMeta {
  withDate?: boolean
  category?: string
  kind?: 'doc' | 'structure'
  pageCount?: number
  inputs?: TemplateInputDTO[]
}

/** Largest serialized template (bytes of JSON) accepted on save/import. */
export const TEMPLATE_MAX_BYTES = 20 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// with an optional section fragment (`#h=…`, docs/adr/2100-*), kept on the remapped link
const INTERNAL_HREF_RE =
  /^\/w\/[0-9a-fA-F-]{36}\/p\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(#.*)?$/

function tooLarge(message: string): AppError {
  return new AppError(400, 'TEMPLATE_TOO_LARGE', message)
}

// ---------------------------------------------------------------------------
// tree helpers
// ---------------------------------------------------------------------------

export function* walk(root: TNode, depth = 0, parent: TNode | null = null): Generator<{ node: TNode; depth: number; parent: TNode | null }> {
  yield { node: root, depth, parent }
  for (const c of root.children) yield* walk(c, depth + 1, root)
}

export function treeStats(root: TNode): { pages: number; height: number } {
  let pagesN = 0
  let height = 0
  for (const { depth } of walk(root)) {
    pagesN++
    if (depth > height) height = depth
  }
  return { pages: pagesN, height }
}

/** Throws 400 TEMPLATE_TOO_LARGE when the tree exceeds the page/height caps. */
export function assertTreeLimits(root: TNode): void {
  const { pages: n, height } = treeStats(root)
  if (n > TEMPLATE_MAX_PAGES) throw tooLarge(`A template can hold at most ${TEMPLATE_MAX_PAGES} pages`)
  if (height > TEMPLATE_MAX_HEIGHT) throw tooLarge(`A template can be at most ${TEMPLATE_MAX_HEIGHT} levels deep`)
}

const b64 = (buf: Uint8Array): string => Buffer.from(buf).toString('base64')
const unb64 = (s: string | undefined): Uint8Array => (s ? new Uint8Array(Buffer.from(s, 'base64')) : new Uint8Array())

/** Legacy content (blocks) or v2 → tree. The legacy root is a doc titled with the template name. */
export function contentToTree(content: unknown, name: string, icon: string | null): TNode {
  if (content && typeof content === 'object' && !Array.isArray(content) && (content as { v?: unknown }).v === 2) {
    const root = (content as TemplateContentV2).root
    if (root && typeof root === 'object' && Array.isArray(root.children)) return root
  }
  const blocks = Array.isArray(content) ? (structuredClone(content) as AnyBlock[]) : []
  return {
    id: randomUUID(),
    kind: 'doc',
    title: name,
    icon,
    state: b64(blocksToStateBuffer(blocks)),
    children: [],
  }
}

// ---------------------------------------------------------------------------
// Yjs walks
// ---------------------------------------------------------------------------

/** All text runs of a document state that substitution may touch (code excluded). */
export function docTexts(state: Uint8Array): string[] {
  const out: string[] = []
  if (state.length === 0) return out
  const doc = new Y.Doc()
  applyStoredState(doc, state)
  const visit = (n: Y.XmlElement | Y.XmlFragment | Y.XmlText): void => {
    if (n instanceof Y.XmlText) {
      for (const op of n.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof op.insert === 'string' && !op.attributes?.code) out.push(op.insert)
      }
      return
    }
    if (n instanceof Y.XmlElement && n.nodeName === 'codeBlock') return
    for (const c of n.toArray()) visit(c as Y.XmlElement | Y.XmlText)
  }
  visit(doc.getXmlFragment('document'))
  doc.destroy()
  return out
}

function canvasTexts(state: Uint8Array): string[] {
  if (state.length === 0) return []
  const doc = new Y.Doc()
  applyStoredState(doc, state)
  const nodes = Object.values(doc.getMap('cnodes').toJSON() as Record<string, { type?: string; text?: unknown }>)
  doc.destroy()
  return nodes.filter((n) => n?.type === 'text' && typeof n.text === 'string').map((n) => n.text as string)
}

/** Every string of a tree that may carry variables (titles, bodies, canvas text, row text). */
export function treeTexts(root: TNode): string[] {
  const out: string[] = []
  for (const { node } of walk(root)) {
    out.push(node.title)
    if (node.state) {
      const st = unb64(node.state)
      if (node.kind === 'doc') out.push(...docTexts(st))
      else if (node.kind === 'canvas') out.push(...canvasTexts(st))
    }
    for (const v of Object.values(node.props ?? {})) if (typeof v === 'string') out.push(v)
  }
  return out
}

/** Meta derived from a tree (stored with custom templates; computed once for built-ins). */
export function deriveMeta(root: TNode): Required<Pick<TemplateMeta, 'kind' | 'pageCount' | 'inputs'>> {
  const { pages: n } = treeStats(root)
  return {
    kind: n === 1 && root.kind === 'doc' ? 'doc' : 'structure',
    pageCount: n,
    inputs: collectInputs(treeTexts(root)),
  }
}

interface DocTransform {
  render: (s: string, allowCursor: boolean) => { text: string; cursor?: number }
  /** New href for an internal link, or null to keep it. */
  remapHref: (href: string) => string | null
  /** Look for {{cursor}} in this document. */
  wantCursor: boolean
  /**
   * New id for a page of the same template named by a page embed (inline database view), or null
   * to keep it (docs/adr/2381-*). Without it embeds are kept as they are.
   */
  remapPageId?: (id: string) => string | null
}

/**
 * Substitute variables and remap internal links directly on the Yjs XML of a document, so unknown
 * blocks, marks and link attributes are preserved exactly. Text is replaced run by run: a run is a
 * stretch of text with one set of marks, so a variable split across two formats is left alone.
 * Code blocks and inline code are never substituted.
 */
export function transformDocState(
  state: Uint8Array,
  t: DocTransform,
): { state: Buffer; cursor?: { blockId: string; offset: number } } {
  const doc = new Y.Doc()
  if (state.length > 0) applyStoredState(doc, state)
  let cursor: { blockId: string; offset: number } | undefined

  const visitText = (text: Y.XmlText, blockId: string | null, base: number): number => {
    const delta = text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]
    const edits: { index: number; len: number; text?: string; attrs: Record<string, unknown>; link?: Record<string, unknown> }[] = []
    let index = 0
    let newIndex = 0
    for (const op of delta) {
      if (typeof op.insert !== 'string') {
        index += 1
        newIndex += 1
        continue
      }
      const len = op.insert.length
      const attrs = op.attributes ?? {}
      let next: string | undefined
      if (!attrs.code && hasVariables(op.insert)) {
        const r = t.render(op.insert, t.wantCursor && !cursor && blockId !== null)
        if (r.text !== op.insert) next = r.text
        if (r.cursor !== undefined && blockId) cursor = { blockId, offset: base + newIndex + r.cursor }
      }
      let link: Record<string, unknown> | undefined
      const l = attrs.link as Record<string, unknown> | undefined
      if (l && typeof l.href === 'string') {
        const href = t.remapHref(l.href)
        if (href) link = { ...l, href }
      }
      if (next !== undefined || link) edits.push({ index, len, text: next, attrs, link })
      index += len
      newIndex += next !== undefined ? next.length : len
    }
    // Apply right to left so earlier indices stay valid.
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i]
      const attrs = e.link ? { ...e.attrs, link: e.link } : e.attrs
      if (e.text !== undefined) {
        text.delete(e.index, e.len)
        if (e.text) text.insert(e.index, e.text, attrs)
      } else if (e.link) {
        text.format(e.index, e.len, { link: e.link })
      }
    }
    return newIndex
  }

  const visit = (n: Y.XmlElement | Y.XmlFragment, blockId: string | null): void => {
    if (n instanceof Y.XmlElement && n.nodeName === 'codeBlock') return
    let inline = 0
    for (const c of n.toArray()) {
      if (c instanceof Y.XmlText) {
        inline += visitText(c, blockId, inline)
      } else if (c instanceof Y.XmlElement) {
        if (c.nodeName === 'pageEmbed' && t.remapPageId) {
          const old = c.getAttribute('pageId')
          const next = typeof old === 'string' && old ? t.remapPageId(old) : null
          if (next) c.setAttribute('pageId', next)
        }
        const id = c.nodeName === 'blockContainer' ? (c.getAttribute('id') as string | undefined) ?? blockId : blockId
        visit(c, id)
        inline += 1
      }
    }
  }

  doc.transact(() => visit(doc.getXmlFragment('document'), null))
  const out = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return cursor ? { state: out, cursor } : { state: out }
}

/** Substitute canvas text nodes and remap page nodes. */
export function transformCanvasState(
  state: Uint8Array,
  render: (s: string) => string,
  remapId: (id: string) => string | null,
): Buffer {
  const doc = new Y.Doc()
  if (state.length > 0) applyStoredState(doc, state)
  const cnodes = doc.getMap<Record<string, unknown>>('cnodes')
  doc.transact(() => {
    for (const [key, raw] of [...cnodes.entries()]) {
      if (!raw || typeof raw !== 'object') continue
      const n = raw as Record<string, unknown>
      if (n.type === 'text' && typeof n.text === 'string' && hasVariables(n.text)) {
        cnodes.set(key, { ...n, text: render(n.text) })
      } else if (n.type === 'page' && typeof n.pageId === 'string') {
        const id = remapId(n.pageId)
        if (id) cnodes.set(key, { ...n, pageId: id })
      }
    }
  })
  const out = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return out
}

// ---------------------------------------------------------------------------
// snapshot: live pages → tree (Save as template)
// ---------------------------------------------------------------------------

type SnapRow = {
  id: string
  parentId: string | null
  kind: NodeKind
  title: string
  icon: string | null
  props: unknown
  properties: unknown
}

/**
 * Snapshot `rootId` (visible to `userId`) as a template tree. Sub-pages are included with
 * `includeSubpages`; collection rows (children of a collection) only with `includeRows`.
 * Person values are dropped (a template does not assign people). Relations that point outside
 * the snapshot become one-way (their pairing belongs to the original collection).
 */
export async function snapshotTree(
  rootId: string,
  userId: string,
  opts: { includeSubpages: boolean; includeRows: boolean },
): Promise<TNode> {
  const cols = {
    id: pages.id,
    parentId: pages.parentId,
    kind: pages.kind,
    title: pages.title,
    icon: pages.icon,
    props: pages.props,
    properties: pages.properties,
  }
  const [rootRow] = (await db
    .select(cols)
    .from(pages)
    .where(and(eq(pages.id, rootId), isNull(pages.deletedAt), visibleTo(userId)))
    .limit(1)) as SnapRow[]
  if (!rootRow) throw new AppError(404, 'PAGE_NOT_FOUND', 'Source page not found')

  const nodes = new Map<string, TNode>()
  const rowById = new Map<string, SnapRow>([[rootRow.id, rootRow]])
  const mk = (r: SnapRow, isRoot: boolean): TNode => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    ...(!isRoot && r.props && typeof r.props === 'object' && Object.keys(r.props).length
      ? { props: structuredClone(r.props as Record<string, unknown>) }
      : {}),
    ...(Array.isArray(r.properties) && r.properties.length
      ? { properties: structuredClone(r.properties as PageProperty[]) }
      : {}),
    children: [],
  })
  const root = mk(rootRow, true)
  nodes.set(root.id, root)

  // BFS, parents before children; each level filtered by what the options include.
  let frontier = [rootRow]
  let depth = 0
  while (frontier.length > 0) {
    const want = frontier.filter((p) => (p.kind === 'collection' ? opts.includeRows : opts.includeSubpages))
    if (want.length === 0) break
    if (++depth > TEMPLATE_MAX_HEIGHT) throw tooLarge(`A template can be at most ${TEMPLATE_MAX_HEIGHT} levels deep`)
    const children = (await db
      .select(cols)
      .from(pages)
      .where(
        and(
          inArray(pages.parentId, want.map((p) => p.id)),
          isNull(pages.deletedAt),
          visibleTo(userId),
        ),
      )
      .orderBy(asc(pages.sortOrder), asc(pages.createdAt))) as SnapRow[]
    const next: SnapRow[] = []
    for (const c of children) {
      if (nodes.has(c.id)) continue
      const n = mk(c, false)
      nodes.set(c.id, n)
      rowById.set(c.id, c)
      nodes.get(c.parentId as string)!.children.push(n)
      next.push(c)
    }
    if (nodes.size > TEMPLATE_MAX_PAGES) throw tooLarge(`A template can hold at most ${TEMPLATE_MAX_PAGES} pages`)
    frontier = next
  }

  const ids = [...nodes.keys()]
  // Bodies (docs and canvases).
  const bodyIds = ids.filter((id) => {
    const k = nodes.get(id)!.kind
    return k === 'doc' || k === 'canvas'
  })
  if (bodyIds.length > 0) {
    const docs = await db
      .select({ pageId: pageDocs.pageId, state: pageDocs.state })
      .from(pageDocs)
      .where(inArray(pageDocs.pageId, bodyIds))
    let bytes = 0
    for (const d of docs) {
      // Template trees are a file format (export/import): their states stay V1 (docs/adr/1101-*).
      const v1 = toV1(d.state)
      bytes += v1.length
      if (bytes > TEMPLATE_MAX_BYTES) throw tooLarge('The pages are too large to save as a template')
      nodes.get(d.pageId)!.state = b64(v1)
    }
  }

  // Collections: fields + views.
  const collIds = ids.filter((id) => nodes.get(id)!.kind === 'collection')
  if (collIds.length > 0) {
    const fieldRows = await db
      .select({ pageId: collections.pageId, fields: collections.fields })
      .from(collections)
      .where(inArray(collections.pageId, collIds))
    for (const f of fieldRows) {
      const fields = (Array.isArray(f.fields) ? structuredClone(f.fields) : []) as CollectionField[]
      for (const field of fields) {
        if (field.type === 'relation' && field.relation && !nodes.has(field.relation.targetPageId)) {
          field.relation = { targetPageId: field.relation.targetPageId }
        }
      }
      nodes.get(f.pageId)!.fields = fields
    }
    const viewRows = await db
      .select({
        pageId: collectionViews.pageId,
        name: collectionViews.name,
        type: collectionViews.type,
        config: collectionViews.config,
        sortOrder: collectionViews.sortOrder,
      })
      .from(collectionViews)
      .where(inArray(collectionViews.pageId, collIds))
      .orderBy(asc(collectionViews.sortOrder), asc(collectionViews.createdAt))
    for (const v of viewRows) {
      const n = nodes.get(v.pageId)!
      ;(n.views ??= []).push({ name: v.name, type: v.type, config: (v.config ?? {}) as ViewConfig, sortOrder: v.sortOrder })
    }
    // Row templates travel with their collection (docs/adr/1183-*).
    const rts = await snapshotRowTemplates(collIds, (cid) => nodes.get(cid)?.fields ?? [])
    for (const [cid, list] of rts) nodes.get(cid)!.rowTemplates = list
    // Rows: drop person values.
    for (const id of collIds) {
      const coll = nodes.get(id)!
      const personIds = new Set((coll.fields ?? []).filter((f) => f.type === 'person').map((f) => f.id))
      if (personIds.size === 0) continue
      for (const row of coll.children) {
        if (!row.props) continue
        for (const k of Object.keys(row.props)) if (personIds.has(k)) delete row.props[k]
      }
    }
  }
  return root
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

const PREVIEW_BLOCKS = 14

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c: { type?: string; text?: string; content?: { text?: string }[] }) =>
      c.type === 'text' ? (c.text ?? '') : c.type === 'link' ? (c.content ?? []).map((x) => x.text ?? '').join('') : '',
    )
    .join('')
}

function previewBlocks(blocks: AnyBlock[]): { blocks: TemplatePreviewBlockDTO[]; truncated: boolean } {
  const out: TemplatePreviewBlockDTO[] = []
  let truncated = false
  const visit = (list: AnyBlock[], depth: number): void => {
    for (const b of list) {
      if (out.length >= PREVIEW_BLOCKS) {
        truncated = true
        return
      }
      let type: TemplatePreviewBlockDTO['type'] = 'other'
      let text = inlineText(b.content)
      const level = Number(b.props?.level ?? 1)
      switch (b.type) {
        case 'heading':
          type = level >= 3 ? 'h3' : level === 2 ? 'h2' : 'h1'
          break
        case 'paragraph':
          type = 'p'
          break
        case 'bulletListItem':
          type = 'bullet'
          break
        case 'numberedListItem':
          type = 'number'
          break
        case 'checkListItem':
          type = 'check'
          break
        case 'quote':
          type = 'quote'
          break
        case 'codeBlock':
          type = 'code'
          break
        case 'table': {
          type = 'table'
          const rows = (b.content as { rows?: { cells: unknown[] }[] } | undefined)?.rows ?? []
          text = rows
            .slice(0, 4)
            .map((r) =>
              r.cells
                .map((c) => inlineText(Array.isArray(c) ? c : (c as { content?: unknown })?.content))
                .join(' | '),
            )
            .join('\n')
          break
        }
      }
      if (type === 'p' && !text.trim() && depth === 0) continue
      out.push({ type, text: text.slice(0, 300), depth, ...(b.type === 'checkListItem' ? { checked: b.props?.checked === true } : {}) })
      if (Array.isArray(b.children) && b.children.length) visit(b.children, depth + 1)
    }
  }
  visit(blocks, 0)
  return { blocks: out, truncated }
}

export function previewTree(root: TNode): TemplatePreviewDTO {
  let blocks: TemplatePreviewBlockDTO[] = []
  let truncated = false
  if (root.kind === 'doc' && root.state) {
    try {
      ;({ blocks, truncated } = previewBlocks(stateToBlocks(unb64(root.state))))
    } catch {
      blocks = []
    }
  }
  const outline: TemplatePreviewNodeDTO[] = []
  for (const { node, depth } of walk(root)) {
    if (outline.length >= 60) break
    const item: TemplatePreviewNodeDTO = { kind: node.kind, title: node.title, icon: node.icon, depth }
    if (node.kind === 'collection') {
      item.fields = node.fields?.length ?? 0
      item.views = (node.views ?? []).map((v) => v.type)
      item.rows = node.children.length
    }
    outline.push(item)
  }
  return { blocks, truncated, outline }
}

// ---------------------------------------------------------------------------
// instantiate
// ---------------------------------------------------------------------------

export interface InstantiateArgs {
  root: TNode
  workspaceId: string
  parentId: string | null
  /** Section for a root-level instance (under a parent the parent's section wins). */
  scope: PageScope
  role: WorkspaceRole
  userId: string
  ctx: VarContext
  /** Title of the created root page (already chosen by the caller; not substituted again). */
  rootTitle: string
  /** Extra page property on the root (withDate templates). */
  rootProperty?: PageProperty
}

export interface InstantiateResult {
  pages: PageRow[]
  cursor?: TemplateCursorDTO
}

interface Prepared {
  id: string
  parentId: string | null
  kind: NodeKind
  title: string
  icon: string | null
  props: Record<string, unknown>
  properties: PageProperty[]
  sortOrder: number
  state?: Buffer
  fields?: CollectionField[]
  views?: TemplateView[]
  rowTemplates?: TRowTemplate[]
}

/**
 * Create the pages of a template tree under `parentId` in one transaction holding the workspace
 * tree lock (docs/adr/0800-*): either every page, body, collection and view is created or none is.
 * Bodies are converted before the transaction, so a conversion failure creates nothing either.
 */
export async function instantiateTree(a: InstantiateArgs): Promise<InstantiateResult> {
  assertTreeLimits(a.root)
  const { height } = treeStats(a.root)

  const idMap = new Map<string, string>()
  for (const { node } of walk(a.root)) {
    if (!UUID_RE.test(node.id) || idMap.has(node.id)) throw new AppError(400, 'TEMPLATE_INVALID', 'Template is damaged')
    idMap.set(node.id, randomUUID())
  }
  const remapId = (id: string): string | null => idMap.get(id.toLowerCase()) ?? idMap.get(id) ?? null
  const remapHref = (href: string): string | null => {
    const m = INTERNAL_HREF_RE.exec(href)
    if (!m) return null
    const id = remapId(m[1])
    return id ? `/w/${a.workspaceId}/p/${id}${m[2] ?? ''}` : null
  }
  const text = (s: string): string => renderString(s, a.ctx).text

  const prepared: Prepared[] = []
  let cursor: TemplateCursorDTO | undefined
  for (const { node, parent } of walk(a.root)) {
    const id = idMap.get(node.id)!
    const isRoot = parent === null
    const p: Prepared = {
      id,
      parentId: parent ? idMap.get(parent.id)! : null,
      kind: node.kind,
      title: isRoot ? a.rootTitle : text(node.title).slice(0, 300),
      icon: node.icon,
      props: {},
      properties: structuredClone(node.properties ?? []),
      sortOrder: isRoot ? 0 : (parent!.children.indexOf(node) + 1) * 1000,
    }
    if (isRoot && a.rootProperty) {
      p.properties = [...p.properties.filter((x) => x.id !== a.rootProperty!.id), a.rootProperty]
    }

    // Row values: substitute text, remap relation targets that are part of the template.
    if (node.props && parent?.kind === 'collection') {
      const fieldsById = new Map((parent.fields ?? []).map((f) => [f.id, f]))
      for (const [k, v] of Object.entries(node.props)) {
        const f = fieldsById.get(k)
        if (!f || f.type === 'rollup' || f.type === 'formula' || f.type === 'person') continue
        if (f.type === 'relation') {
          if (!Array.isArray(v)) continue
          const internal = f.relation ? idMap.has(f.relation.targetPageId) : false
          p.props[k] = v
            .filter((x): x is string => typeof x === 'string')
            .map((x) => remapId(x) ?? (internal ? null : x))
            .filter((x): x is string => x !== null)
        } else if (typeof v === 'string') {
          p.props[k] = text(v)
        } else {
          p.props[k] = structuredClone(v)
        }
      }
    }

    if (node.kind === 'doc') {
      const r = transformDocState(unb64(node.state), {
        render: (s, allowCursor) => renderString(s, a.ctx, allowCursor),
        remapHref,
        wantCursor: !cursor,
        remapPageId: remapId,
      })
      p.state = r.state
      if (r.cursor && !cursor) cursor = { pageId: id, ...r.cursor }
    } else if (node.kind === 'canvas') {
      p.state = transformCanvasState(unb64(node.state), text, remapId)
    } else if (node.kind === 'collection') {
      p.fields = structuredClone(node.fields ?? []).map((f) => {
        if (f.type === 'relation' && f.relation) {
          const target = remapId(f.relation.targetPageId)
          if (target) f.relation = { ...f.relation, targetPageId: target }
        }
        return f
      })
      p.views = structuredClone(node.views ?? [])
      if (node.rowTemplates?.length) p.rowTemplates = node.rowTemplates
    }
    prepared.push(p)
  }

  const created = await withTreeLock(a.workspaceId, async (tx) => {
    let scope: PageScope = a.scope
    if (a.parentId) {
      const chain = await assertPlacement(tx, { workspaceId: a.workspaceId, parentId: a.parentId, role: a.role, userId: a.userId, height })
      scope = chain[0].scope
    }
    const parentCond = a.parentId ? eq(pages.parentId, a.parentId) : isNull(pages.parentId)
    const [{ maxSort }] = await tx
      .select({ maxSort: max(pages.sortOrder) })
      .from(pages)
      .where(and(eq(pages.workspaceId, a.workspaceId), parentCond))
    const rootSort = (maxSort ?? 0) + 1000

    const inserted: PageRow[] = []
    // Parents precede children (walk order); FKs are checked per statement, chunks keep params bounded.
    for (let i = 0; i < prepared.length; i += 100) {
      const chunk = prepared.slice(i, i + 100)
      inserted.push(
        ...(await tx
          .insert(pages)
          .values(
            chunk.map((p) => ({
              id: p.id,
              workspaceId: a.workspaceId,
              parentId: p.parentId ?? a.parentId,
              kind: p.kind,
              scope,
              title: p.title,
              icon: p.icon,
              props: p.props,
              properties: p.properties,
              sortOrder: p.parentId === null ? rootSort : p.sortOrder,
              createdBy: a.userId,
            })),
          )
          .returning(pageColumns)),
      )
    }
    const docs = prepared.filter((p) => p.state)
    for (let i = 0; i < docs.length; i += 50) {
      await tx.insert(pageDocs).values(docs.slice(i, i + 50).map((p) => ({ pageId: p.id, state: p.state! })))
    }
    const colls = prepared.filter((p) => p.kind === 'collection')
    if (colls.length > 0) {
      await tx.insert(collections).values(colls.map((p) => ({ pageId: p.id, fields: p.fields ?? [] })))
      const views = colls.flatMap((p) =>
        (p.views ?? []).map((v) => ({ pageId: p.id, name: v.name, type: v.type, config: v.config, sortOrder: v.sortOrder })),
      )
      if (views.length > 0) await tx.insert(collectionViews).values(views)
      await insertRowTemplates(
        tx,
        colls
          .filter((p) => p.rowTemplates?.length)
          .map((p) => ({ collectionId: p.id, templates: p.rowTemplates!, userId: a.userId, remapHref })),
      )
    }
    const byId = new Map(inserted.map((r) => [r.id, r]))
    return prepared.map((p) => byId.get(p.id)!)
  })

  // Indexing after commit (best-effort, like page creation elsewhere): search, tags, tasks, links.
  for (const p of prepared) {
    if (p.kind !== 'doc' || !p.state) continue
    try {
      const blocks = stateToBlocks(p.state)
      await reindexPageText(p.id, blocks)
      await reindexPageChunks(p.id, blocks)
      await reindexPageTags(p.id, blocks)
      await reindexPageTasks(p.id, blocks)
      await reindexPageLinks(p.id, blocks)
    } catch (err) {
      console.error('[inkling] template: indexing failed', p.id, err)
    }
  }
  return cursor ? { pages: created, cursor } : { pages: created }
}
