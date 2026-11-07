import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { z } from 'zod'
import {
  collectionFieldSchema,
  pagePropertySchema,
  ROW_TEMPLATES_MAX,
  templateCategorySchema,
  TEMPLATE_MAX_HEIGHT,
  TEMPLATE_MAX_PAGES,
  viewConfigSchema,
  viewTypeSchema,
} from '@inkling/shared'
import type { CollectionField, TemplateCategory, TemplateInputDTO } from '@inkling/shared'
import { AppError, badRequest } from '../errors'
import { stateToCanvasJson, canvasJsonToState } from '../md/canvas'
import type { CanvasData } from '../md/canvas'
import { blocksToMarkdown, blocksToStateBuffer, markdownToBlocks, stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { buildTitleResolver, readZipEntryCapped } from '../md/importer'
import { parseFrontmatter } from '../md/syncMd'
import { assertTreeLimits, walk } from './structure'
import { sanitizeTemplateProps } from '../rowTemplates'
import type { TRowTemplate } from '../rowTemplates'
import type { NodeKind, TNode } from './structure'

/**
 * Template export / import (docs/adr/0924-*, docs/TEMPLATES.md "File format").
 *
 * - A document template is one Markdown file whose frontmatter carries the template meta as flat
 *   keys (`inkling-template: 1`, name, description, category, icon, with-date, variables) — flat
 *   because the frontmatter reader is a YAML subset without nested maps.
 * - A structure template is a zip: `inkling-template.json` (meta + page tree with collection
 *   fields/views/rows) and one file per body under `pages/` (`.md` documents, `.canvas` JSON Canvas).
 *   Pages reference each other by `ref` (p0, p1, …), never by database id.
 *
 * Import never accepts block JSON or Yjs state: bodies come in as Markdown / JSON Canvas and go
 * through the same converters (and caps) as page imports — markdownToBlocks with a title resolver
 * limited to pages the importer can see, canvasJsonToState, readZipEntryCapped.
 */

export const TEMPLATE_FILE_MAX_BYTES = 25 * 1024 * 1024
const ZIP_MAX_ENTRIES = 300
const MANIFEST = 'inkling-template.json'

export interface TemplateFileMeta {
  name: string
  description: string | null
  category: TemplateCategory
  icon: string | null
  withDate: boolean
  inputs: TemplateInputDTO[]
}

const unb64 = (s: string | undefined): Uint8Array => (s ? new Uint8Array(Buffer.from(s, 'base64')) : new Uint8Array())

/** Double-quoted YAML scalar (JSON strings are valid YAML). */
const q = (s: string): string => JSON.stringify(s)

function frontmatter(meta: TemplateFileMeta): string {
  const lines = ['---', 'inkling-template: 1', `name: ${q(meta.name)}`]
  if (meta.description) lines.push(`description: ${q(meta.description)}`)
  lines.push(`category: ${meta.category}`)
  if (meta.icon) lines.push(`icon: ${q(meta.icon)}`)
  if (meta.withDate) lines.push('with-date: true')
  if (meta.inputs.length) {
    lines.push('variables:')
    for (const i of meta.inputs) lines.push(`  - ${q(i.default ? `${i.name}|${i.default}` : i.name)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

/** Internal links → `[[Target title]]` when the target is a page of the template, else `[[text]]`. */
async function docMarkdown(state: string | undefined, titles: Map<string, string>): Promise<string> {
  let blocks: AnyBlock[] = []
  try {
    blocks = stateToBlocks(unb64(state))
  } catch {
    blocks = []
  }
  // Rename link text to the target's title so the link resolves again on import.
  const visit = (list: AnyBlock[]): void => {
    for (const b of list) {
      const content = Array.isArray(b.content) ? b.content : []
      for (const inl of content as { type?: string; href?: string; content?: { text?: string }[] }[]) {
        if (inl.type !== 'link' || typeof inl.href !== 'string') continue
        const m = /\/p\/([0-9a-fA-F-]{36})$/.exec(inl.href)
        const title = m ? titles.get(m[1]) : undefined
        if (title) inl.content = [{ type: 'text', text: title, styles: {} } as never]
      }
      if (Array.isArray(b.children)) visit(b.children)
    }
  }
  visit(blocks)
  return (await blocksToMarkdown(blocks, { assetMode: 'absolute' })).markdown
}

/** Export a template tree. A single document → .md, anything else → .zip. */
export async function exportTemplate(
  root: TNode,
  meta: TemplateFileMeta,
): Promise<{ filename: string; contentType: string; body: Buffer }> {
  const safe = meta.name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ').trim() || 'template'
  const titles = new Map<string, string>()
  for (const { node } of walk(root)) titles.set(node.id, node.title)

  if (root.kind === 'doc' && root.children.length === 0) {
    const md = await docMarkdown(root.state, titles)
    return {
      filename: `${safe}.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(frontmatter(meta) + md, 'utf8'),
    }
  }

  const refs = new Map<string, string>()
  let n = 0
  for (const { node } of walk(root)) refs.set(node.id, `p${n++}`)
  const zip = new JSZip()

  const toManifest = async (node: TNode, parent: TNode | null): Promise<Record<string, unknown>> => {
    const ref = refs.get(node.id)!
    const out: Record<string, unknown> = { ref, kind: node.kind, title: node.title }
    if (node.icon) out.icon = node.icon
    if (node.properties?.length) out.properties = node.properties
    if (node.kind === 'doc') {
      const file = `pages/${ref}.md`
      zip.file(file, await docMarkdown(node.state, titles))
      out.file = file
    } else if (node.kind === 'canvas') {
      const file = `pages/${ref}.canvas`
      const canvas = stateToCanvasJson(unb64(node.state), {
        resolvePageFile: (pageId) => refs.get(pageId) ?? null,
        resolvePageTitle: (pageId) => titles.get(pageId) ?? null,
      })
      zip.file(file, JSON.stringify(canvas, null, 2))
      out.file = file
    } else if (node.kind === 'collection') {
      out.fields = (node.fields ?? []).map((f) =>
        f.type === 'relation' && f.relation
          ? { ...f, relation: { ...f.relation, targetPageId: refs.get(f.relation.targetPageId) ?? f.relation.targetPageId } }
          : f,
      )
      out.views = (node.views ?? []).map((v) => ({ name: v.name, type: v.type, config: v.config }))
      // Row templates (docs/adr/1183-*): one Markdown body each, next to the page files.
      if (node.rowTemplates?.length) {
        out.rowTemplates = await Promise.all(
          node.rowTemplates.map(async (t, i) => {
            const file = `pages/${ref}-t${i}.md`
            zip.file(file, await docMarkdown(t.state, titles))
            return {
              name: t.name,
              ...(t.icon ? { icon: t.icon } : {}),
              title: t.title,
              props: t.props,
              ...(t.isDefault ? { default: true } : {}),
              file,
            }
          }),
        )
      }
    }
    if (node.props && parent?.kind === 'collection') {
      const rel = new Set((parent.fields ?? []).filter((f) => f.type === 'relation').map((f) => f.id))
      const props: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node.props)) {
        props[k] = rel.has(k) && Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? (refs.get(x) ?? x) : x)) : v
      }
      out.props = props
    }
    out.children = await Promise.all(node.children.map((c) => toManifest(c, node)))
    return out
  }

  const manifest = {
    'inkling-template': 1,
    name: meta.name,
    description: meta.description,
    category: meta.category,
    icon: meta.icon,
    withDate: meta.withDate,
    variables: meta.inputs.map((i) => (i.default ? `${i.name}|${i.default}` : i.name)),
    root: await toManifest(root, null),
  }
  zip.file(MANIFEST, JSON.stringify(manifest, null, 2))
  const body = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { filename: `${safe}.zip`, contentType: 'application/zip', body }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

const refSchema = z.string().regex(/^p\d{1,4}$/)

interface ManifestNode {
  ref: string
  kind: NodeKind
  title: string
  icon?: string | null
  file?: string
  props?: Record<string, unknown>
  properties?: z.infer<typeof pagePropertySchema>[]
  fields?: unknown[]
  views?: { name: string; type: z.infer<typeof viewTypeSchema>; config?: unknown }[]
  rowTemplates?: ManifestRowTemplate[]
  children: ManifestNode[]
}

interface ManifestRowTemplate {
  name: string
  icon?: string | null
  title?: string
  props?: Record<string, unknown>
  default?: boolean
  file?: string
}

const manifestRowTemplateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(16).nullish(),
  title: z.string().max(300).optional(),
  props: z.record(z.string().max(40), z.unknown()).optional(),
  default: z.boolean().optional(),
  file: z.string().max(200).optional(),
})

const manifestNodeSchema: z.ZodType<ManifestNode> = z.lazy(() =>
  z.object({
    ref: refSchema,
    kind: z.enum(['doc', 'folder', 'canvas', 'collection']),
    title: z.string().max(300),
    icon: z.string().max(16).nullish(),
    file: z.string().max(200).optional(),
    props: z.record(z.string().max(40), z.unknown()).optional(),
    properties: z.array(pagePropertySchema).max(50).optional(),
    fields: z.array(z.unknown()).max(200).optional(),
    views: z
      .array(z.object({ name: z.string().trim().min(1).max(60), type: viewTypeSchema, config: z.unknown().optional() }))
      .max(20)
      .optional(),
    rowTemplates: z.array(manifestRowTemplateSchema).max(ROW_TEMPLATES_MAX).optional(),
    children: z.array(manifestNodeSchema).max(TEMPLATE_MAX_PAGES),
  }),
)

const manifestSchema = z.object({
  'inkling-template': z.literal(1),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(300).nullish(),
  category: z.string().optional(),
  icon: z.string().max(16).nullish(),
  withDate: z.boolean().optional(),
  variables: z.array(z.string().max(500)).max(50).optional(),
  root: manifestNodeSchema,
})

function category(v: unknown): TemplateCategory {
  const r = templateCategorySchema.safeParse(v)
  return r.success ? r.data : 'custom'
}

function invalid(message: string): AppError {
  return new AppError(400, 'TEMPLATE_INVALID', message)
}

export interface ImportedTemplate {
  root: TNode
  name: string
  description: string | null
  category: TemplateCategory
  icon: string | null
  withDate: boolean
}

/** Doc body: markdown → blocks (template titles first, then pages the importer can see) → state. */
async function mdToState(md: string, resolve: (title: string) => string | null): Promise<string> {
  let blocks = await markdownToBlocks(md, resolve)
  if (blocks.length === 0) blocks = [{ type: 'paragraph', content: [] }]
  return blocksToStateBuffer(blocks).toString('base64')
}

/** Parse an uploaded template file (.md or .zip) into a tree. Nothing is written to the database. */
export async function importTemplateFile(args: {
  buffer: Buffer
  filename: string
  workspaceId: string
  userId: string
}): Promise<ImportedTemplate> {
  const { buffer, filename, workspaceId, userId } = args
  const lower = filename.toLowerCase()
  const isZip = lower.endsWith('.zip') || buffer.subarray(0, 2).toString('latin1') === 'PK'
  const wsResolve = await buildTitleResolver(workspaceId, new Map(), userId)

  if (!isZip) {
    const fm = parseFrontmatter(buffer.toString('utf8'))
    const data = fm.data
    const fileTitle = filename.replace(/\.(md|markdown|txt)$/i, '').trim()
    const name = (typeof data.get('name') === 'string' ? (data.get('name') as string) : fileTitle).trim().slice(0, 60) || 'Template'
    const description = typeof data.get('description') === 'string' ? (data.get('description') as string).slice(0, 300) : null
    const icon = typeof data.get('icon') === 'string' ? (data.get('icon') as string).slice(0, 16) : null
    const id = randomUUID()
    const root: TNode = {
      id,
      kind: 'doc',
      title: name,
      icon,
      state: await mdToState(fm.present ? fm.body : buffer.toString('utf8'), wsResolve),
      children: [],
    }
    return {
      root,
      name,
      description,
      category: category(data.get('category')),
      icon,
      withDate: data.get('with-date') === true,
    }
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw badRequest('Could not read the zip file')
  }
  const entries = Object.values(zip.files).filter((e) => !e.dir)
  if (entries.length > ZIP_MAX_ENTRIES) throw badRequest(`Too many files in the archive (max ${ZIP_MAX_ENTRIES})`)
  const meter = { total: 0 }
  const read = async (name: string): Promise<string | null> => {
    const e = zip.file(name)
    if (!e || e.dir) return null
    return (await readZipEntryCapped(e, meter)).toString('utf8')
  }
  const raw = await read(MANIFEST)
  if (raw === null) throw invalid(`Not a template archive (${MANIFEST} is missing)`)
  let parsed: z.infer<typeof manifestSchema>
  try {
    parsed = manifestSchema.parse(JSON.parse(raw))
  } catch {
    throw invalid('The template manifest is not valid')
  }

  // refs → fresh ids; reject duplicates and oversized trees before reading any body.
  const ids = new Map<string, string>()
  let count = 0
  let height = 0
  const index = (n: ManifestNode, depth: number): void => {
    if (ids.has(n.ref)) throw invalid('The template manifest is not valid')
    ids.set(n.ref, randomUUID())
    if (++count > TEMPLATE_MAX_PAGES) throw new AppError(400, 'TEMPLATE_TOO_LARGE', `A template can hold at most ${TEMPLATE_MAX_PAGES} pages`)
    if (depth > height) height = depth
    if (height > TEMPLATE_MAX_HEIGHT) throw new AppError(400, 'TEMPLATE_TOO_LARGE', `A template can be at most ${TEMPLATE_MAX_HEIGHT} levels deep`)
    for (const c of n.children) index(c, depth + 1)
  }
  index(parsed.root, 0)

  const byTitle = new Map<string, string>()
  const collect = (n: ManifestNode): void => {
    const k = n.title.toLowerCase()
    if (!byTitle.has(k)) byTitle.set(k, ids.get(n.ref)!)
    n.children.forEach(collect)
  }
  collect(parsed.root)
  const resolve = (title: string): string | null => {
    const id = byTitle.get(title.toLowerCase())
    return id ? `/w/${workspaceId}/p/${id}` : wsResolve(title)
  }
  const sanitizeFields = (rawFields: unknown[]): CollectionField[] => {
    const fields: CollectionField[] = []
    for (const raw of rawFields) {
      // Relation targets are template refs (p3) in the file: map them before validating.
      let f = raw
      let outside = false
      if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'relation') {
        const rel = (raw as { relation?: { targetPageId?: unknown } }).relation
        const target = typeof rel?.targetPageId === 'string' ? ids.get(rel.targetPageId) : undefined
        if (target) f = { ...raw, relation: { ...rel, targetPageId: target } }
        else outside = true
      }
      if (outside) {
        // Points outside the template: keep the column as plain text.
        const r = collectionFieldSchema.safeParse({ ...(raw as object), type: 'text', relation: undefined })
        if (r.success) fields.push({ id: r.data.id, name: r.data.name, type: 'text' })
        continue
      }
      const r = collectionFieldSchema.safeParse(f)
      if (r.success) fields.push(r.data)
    }
    // Rollups need a relation field of this collection.
    const relIds = new Set(fields.filter((f) => f.type === 'relation').map((f) => f.id))
    return fields.filter((f) => f.type !== 'rollup' || (f.rollup && relIds.has(f.rollup.relationFieldId)))
  }

  const build = async (n: ManifestNode, parent: TNode | null): Promise<TNode> => {
    const node: TNode = { id: ids.get(n.ref)!, kind: n.kind, title: n.title, icon: n.icon ?? null, children: [] }
    if (n.properties?.length) node.properties = n.properties
    if (n.file && !/^pages\/[^/]+\.(md|canvas)$/.test(n.file)) throw invalid('The template manifest is not valid')
    if (n.kind === 'doc') {
      const md = n.file ? await read(n.file) : ''
      node.state = await mdToState(parseFrontmatter(md ?? '').body, resolve)
    } else if (n.kind === 'canvas' && n.file) {
      const text = await read(n.file)
      let canvas: CanvasData = { nodes: [], edges: [] }
      try {
        canvas = text ? (JSON.parse(text) as CanvasData) : canvas
      } catch {
        throw invalid('A canvas file in the template is not valid JSON')
      }
      node.state = canvasJsonToState(canvas, {
        resolveFile: (file) => ids.get(file) ?? null,
      }).toString('base64')
    } else if (n.kind === 'collection') {
      node.fields = sanitizeFields(n.fields ?? [])
      node.views = (n.views ?? []).map((v, i) => {
        const c = viewConfigSchema.safeParse(v.config ?? {})
        return { name: v.name, type: v.type, config: c.success ? c.data : {}, sortOrder: i * 1000 }
      })
      if (n.rowTemplates?.length) {
        const list: TRowTemplate[] = []
        let seenDefault = false
        for (const t of n.rowTemplates) {
          if (t.file && !/^pages\/[^/]+\.md$/.test(t.file)) throw invalid('The template manifest is not valid')
          const md = t.file ? await read(t.file) : null
          // Person defaults other than 'me' name people of another workspace: dropped.
          const props = sanitizeTemplateProps(node.fields, t.props)
          for (const f of node.fields) if (f.type === 'person' && props[f.id] !== 'me') delete props[f.id]
          list.push({
            name: t.name,
            icon: t.icon ?? null,
            title: t.title ?? '',
            props,
            ...(md ? { state: await mdToState(parseFrontmatter(md).body, resolve) } : {}),
            isDefault: t.default === true && !seenDefault,
          })
          if (t.default) seenDefault = true
        }
        node.rowTemplates = list
      }
    }
    if (n.props && parent?.kind === 'collection') {
      const fields = new Map((parent.fields ?? []).map((f) => [f.id, f]))
      const props: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(n.props)) {
        const f = fields.get(k)
        if (!f || f.type === 'person' || f.type === 'rollup') continue
        if (f.type === 'relation') {
          if (Array.isArray(v)) props[k] = v.map((x) => (typeof x === 'string' ? ids.get(x) : undefined)).filter(Boolean)
          continue
        }
        if (typeof v === 'string') props[k] = v.slice(0, 10_000)
        else if (typeof v === 'number' || typeof v === 'boolean') props[k] = v
        else if (Array.isArray(v)) props[k] = v.filter((x) => typeof x === 'string').slice(0, 100)
      }
      node.props = props
    }
    for (const c of n.children) node.children.push(await build(c, node))
    return node
  }

  const root = await build(parsed.root, null)
  assertTreeLimits(root)
  return {
    root,
    name: parsed.name,
    description: parsed.description ?? null,
    category: category(parsed.category),
    icon: parsed.icon ?? null,
    withDate: parsed.withDate === true,
  }
}
