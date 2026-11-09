import { and, desc, eq, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  createPageFromTemplateSchema,
  createTemplateSchema,
  templateCategorySchema,
} from '@inkling/shared'
import type { PageProperty, TemplateCategory, TemplateDTO, TemplateInputDTO } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { db } from '../db/index'
import { templates, workspaces } from '../db/schema'
import { AppError, badRequest, forbidden, notFound } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { memberOrGuestSql } from '../pageGrants'
import { requestLocale } from '../i18n'
import type { Locale } from '../i18n'
import { findVisiblePage, toPageDTO } from '../pageDto'
import { markCreatedVia } from '../notify/provenance'
import { builtinTemplates, builtinTree, getBuiltinTemplate, isBuiltinKey } from '../templates/builtins'
import { exportTemplate, importTemplateFile, TEMPLATE_FILE_MAX_BYTES } from '../templates/io'
import {
  contentToTree,
  deriveMeta,
  instantiateTree,
  previewTree,
  snapshotTree,
  TEMPLATE_MAX_BYTES,
} from '../templates/structure'
import type { TemplateContentV2, TemplateMeta, TNode } from '../templates/structure'
import { formatDate, renderString, wallClock, withIsoDate } from '../templates/variables'
import type { VarContext } from '../templates/variables'
import { isManagerRole } from '../workspaceAdmin'

/**
 * Page templates (docs/adr/0920-0925, docs/TEMPLATES.md).
 *
 * Built-ins are code constants (templates/builtins.ts); custom templates are `templates` rows whose
 * `content` is a legacy block array or a v2 page tree, with meta in `default_props`.
 * Visibility: shared templates → every member; private ones → their creator only. Every route
 * starts with requireMembership, which also answers 404 for a deleted workspace (docs/adr/0910-*).
 */

/** Name of the date property set by withDate templates, in the creator's locale. */
const DATE_PROPERTY_NAME = { en: 'Date', ko: '날짜' } as const

/** Templates saved from a private page (or marked "only me") are visible to their creator only. */
function templateVisibleTo(userId: string): SQL {
  return or(eq(templates.scope, 'shared'), eq(templates.createdBy, userId)) as SQL
}

const tidParam = z.object({ id: z.uuid(), tid: z.string().min(1).max(64) })

function categoryOf(v: unknown): TemplateCategory {
  const r = templateCategorySchema.safeParse(v)
  return r.success ? r.data : 'custom'
}

type ListRow = {
  id: string
  name: string
  description: string | null
  icon: string | null
  defaultProps: unknown
  scope: 'shared' | 'private'
  createdBy: string | null
  /** Only for rows saved before v2 meta existed (null otherwise). */
  legacyContent: unknown
}

function toTemplateDTO(row: ListRow, userId: string): TemplateDTO {
  const meta = (row.defaultProps ?? {}) as TemplateMeta
  let kind = meta.kind
  let pageCount = meta.pageCount
  let inputs = meta.inputs
  if (!kind || pageCount === undefined || !inputs) {
    const derived = deriveMeta(contentToTree(row.legacyContent, row.name, row.icon))
    kind = derived.kind
    pageCount = derived.pageCount
    inputs = derived.inputs
  }
  return {
    id: row.id,
    builtin: false,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: categoryOf(meta.category),
    kind,
    pageCount,
    scope: row.scope,
    mine: row.createdBy === userId,
    withDate: meta.withDate === true,
    inputs,
  }
}

const listColumns = {
  id: templates.id,
  name: templates.name,
  description: templates.description,
  icon: templates.icon,
  defaultProps: templates.defaultProps,
  scope: templates.scope,
  createdBy: templates.createdBy,
  // The body is only needed to derive meta of rows saved before v2 (never for v2 rows).
  legacyContent: sql<unknown>`CASE WHEN ${templates.defaultProps} ? 'kind' THEN NULL ELSE ${templates.content} END`,
}

interface Resolved {
  root: TNode
  name: string
  description: string | null
  icon: string | null
  category: TemplateCategory
  withDate: boolean
  inputs: TemplateInputDTO[]
  builtin: boolean
}

/** A built-in key or a custom template id visible to `userId` in workspace `wsId` (404 otherwise). */
async function resolveTemplate(wsId: string, tid: string, userId: string, locale: Locale): Promise<Resolved> {
  if (isBuiltinKey(tid)) {
    const t = getBuiltinTemplate(tid, locale)!
    return {
      root: await builtinTree(t),
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      withDate: t.defaultProps.withDate === true,
      inputs: t.inputs,
      builtin: true,
    }
  }
  if (!z.uuid().safeParse(tid).success) throw notFound('TEMPLATE_NOT_FOUND', 'Template not found')
  const row = (
    await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, tid), eq(templates.workspaceId, wsId), templateVisibleTo(userId)))
      .limit(1)
  )[0]
  if (!row) throw notFound('TEMPLATE_NOT_FOUND', 'Template not found')
  const meta = (row.defaultProps ?? {}) as TemplateMeta
  const root = contentToTree(row.content, row.name, row.icon)
  return {
    root,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: categoryOf(meta.category),
    withDate: meta.withDate === true,
    inputs: meta.inputs ?? deriveMeta(root).inputs,
    builtin: false,
  }
}

/** Insert a custom template row from a tree (save-as and import). */
async function insertTemplate(args: {
  workspaceId: string
  userId: string
  root: TNode
  name: string
  description: string | null
  icon: string | null
  category: TemplateCategory
  withDate: boolean
  scope: 'shared' | 'private'
}): Promise<typeof templates.$inferSelect> {
  const content: TemplateContentV2 = { v: 2, root: args.root }
  if (JSON.stringify(content).length > TEMPLATE_MAX_BYTES) {
    throw new AppError(400, 'TEMPLATE_TOO_LARGE', 'The template is too large')
  }
  const meta: TemplateMeta = {
    ...(args.withDate ? { withDate: true } : {}),
    category: args.category,
    ...deriveMeta(args.root),
  }
  const [row] = await db
    .insert(templates)
    .values({
      workspaceId: args.workspaceId,
      name: args.name,
      description: args.description,
      icon: args.icon,
      content,
      defaultProps: meta,
      scope: args.scope,
      createdBy: args.userId,
    })
    .returning()
  return row
}

function rowDTO(row: typeof templates.$inferSelect, userId: string): TemplateDTO {
  return toTemplateDTO({ ...row, legacyContent: row.content }, userId)
}

function attach(reply: FastifyReply, filename: string): void {
  reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
}

export async function registerTemplateRoutes(app: FastifyInstance): Promise<void> {
  // Built-ins in the viewer's language, then this workspace's custom templates visible to the viewer.
  app.get('/workspaces/:id/templates', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const id = idParam(req.params)
    await requireMembership(id, user.id)

    const custom = (await db
      .select(listColumns)
      .from(templates)
      .where(and(eq(templates.workspaceId, id), templateVisibleTo(user.id)))
      .orderBy(desc(templates.createdAt))) as ListRow[]

    const locale = await requestLocale(req, user.id)
    const builtin: TemplateDTO[] = builtinTemplates(locale).map((t) => ({
      id: t.key,
      builtin: true,
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      kind: t.kind,
      pageCount: t.pageCount,
      scope: 'shared',
      mine: false,
      withDate: t.defaultProps.withDate === true,
      inputs: t.inputs,
    }))

    return { templates: [...builtin, ...custom.map((r) => toTemplateDTO(r, user.id))] }
  })

  // Save a page (optionally with its sub-pages / collection rows) as a custom template.
  app.post(
    '/workspaces/:id/templates',
    {
      preHandler: requireUser,
      // Curb snapshot-amplification abuse: 30/min per authenticated member IP.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const user = getUser(req)
      const id = idParam(req.params)
      await requireMembership(id, user.id)
      const body = createTemplateSchema.parse(req.body)

      const page = await findVisiblePage(body.fromPageId, user.id)
      if (!page || page.workspaceId !== id) throw notFound('PAGE_NOT_FOUND', 'Source page not found')

      const root = await snapshotTree(page.id, user.id, {
        includeSubpages: body.includeSubpages === true,
        includeRows: body.includeRows === true,
      })
      const row = await insertTemplate({
        workspaceId: id,
        userId: user.id,
        root,
        name: body.name,
        description: body.description ?? null,
        // No icon given → fall back to the source page's icon.
        icon: body.icon ?? page.icon ?? null,
        category: body.category ?? 'custom',
        withDate: false,
        // A private page's content never becomes visible to others through a template.
        scope: page.scope === 'private' || body.private ? 'private' : 'shared',
      })
      return { template: rowDTO(row, user.id) }
    },
  )

  // Preview: first blocks of the root document + the page outline.
  app.get('/workspaces/:id/templates/:tid/preview', { preHandler: requireUser }, async (req) => {
    const user = getUser(req)
    const { id, tid } = tidParam.parse(req.params)
    await requireMembership(id, user.id)
    const t = await resolveTemplate(id, tid, user.id, await requestLocale(req, user.id))
    return { preview: previewTree(t.root) }
  })

  // Export as .md (one document) or .zip (structure).
  app.get(
    '/workspaces/:id/templates/:tid/export',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = getUser(req)
      const { id, tid } = tidParam.parse(req.params)
      await requireMembership(id, user.id)
      const t = await resolveTemplate(id, tid, user.id, await requestLocale(req, user.id))
      const file = await exportTemplate(t.root, {
        name: t.name,
        description: t.description,
        category: t.category,
        icon: t.icon,
        withDate: t.withDate,
        inputs: t.inputs,
      })
      reply.header('Content-Type', file.contentType)
      attach(reply, file.filename)
      return reply.send(file.body)
    },
  )

  // Import a template file (.md / .zip). ?private=1 keeps it to the importer.
  app.post(
    '/workspaces/:id/templates/import',
    { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req: FastifyRequest) => {
      const user = getUser(req)
      const id = idParam(req.params)
      await requireMembership(id, user.id)
      const q = z.object({ private: z.enum(['0', '1', 'true', 'false']).optional() }).parse(req.query)

      const mp = await req.file()
      if (!mp) throw badRequest('No files to upload')
      let buffer: Buffer
      try {
        buffer = await mp.toBuffer()
      } catch (err) {
        const e = err as { code?: string; statusCode?: number }
        if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413) {
          throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'File is too large (max 25MB)')
        }
        throw err
      }
      if (mp.file.truncated || buffer.length > TEMPLATE_FILE_MAX_BYTES) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'File is too large (max 25MB)')
      }
      const name = mp.filename || 'template.md'
      if (!/\.(md|markdown|txt|zip)$/i.test(name)) {
        throw new AppError(415, 'UNSUPPORTED_TYPE', 'Only .md or .zip files can be imported')
      }
      const parsed = await importTemplateFile({ buffer, filename: name, workspaceId: id, userId: user.id })
      const row = await insertTemplate({
        workspaceId: id,
        userId: user.id,
        root: parsed.root,
        name: parsed.name,
        description: parsed.description,
        icon: parsed.icon,
        category: parsed.category,
        withDate: parsed.withDate,
        scope: q.private === '1' || q.private === 'true' ? 'private' : 'shared',
      })
      return { template: rowDTO(row, user.id) }
    },
  )

  // Delete a custom template; built-ins (code constants) cannot be deleted.
  app.delete('/templates/:id', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req)
    const raw = (req.params as { id?: string }).id ?? ''
    if (isBuiltinKey(raw)) throw forbidden("Built-in templates can't be deleted")

    const id = idParam(req.params)
    const row = (
      await db
        .select({ id: templates.id, workspaceId: templates.workspaceId, createdBy: templates.createdBy, builtin: templates.builtin })
        .from(templates)
        // a template of a workspace the caller is not in is "not found", like a missing id (docs/adr/1301-*)
        .where(and(eq(templates.id, id), templateVisibleTo(user.id), memberOrGuestSql(templates.workspaceId, user.id, false)))
        .limit(1)
    )[0]
    if (!row) throw notFound('TEMPLATE_NOT_FOUND', 'Template not found')
    if (row.builtin === '1') throw forbidden("Built-in templates can't be deleted")
    const role = await requireMembership(row.workspaceId, user.id)
    // Only the author or a workspace owner/admin may delete a template (C-L11, docs/adr/0945-*).
    if (row.createdBy !== user.id && !isManagerRole(role)) {
      throw forbidden('Only the template creator, an owner or an admin can delete it')
    }
    await db.delete(templates).where(eq(templates.id, id))
    return reply.code(204).send()
  })

  // New page (tree) from a template. Variables are substituted on the server at this moment
  // (docs/adr/0922-*); placement, scope and caps follow regular page creation (docs/adr/0921-*).
  app.post(
    '/pages/from-template',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const user = getUser(req)
      const body = createPageFromTemplateSchema.parse(req.body)
      const role = await requireMembership(body.workspaceId, user.id)
      const locale = await requestLocale(req, user.id)

      const t = await resolveTemplate(body.workspaceId, (body.builtinKey ?? body.templateId)!, user.id, locale)

      const parentId = body.parentId ?? null
      if (parentId) {
        const parent = await findVisiblePage(parentId, user.id)
        if (!parent || parent.workspaceId !== body.workspaceId) throw badRequest('Parent page is invalid')
      }

      const ws = (
        await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, body.workspaceId)).limit(1)
      )[0]
      const now = withIsoDate(wallClock(new Date(), body.tz), body.date)
      const ctx: VarContext = {
        title: t.name,
        author: user.name,
        workspace: ws?.name ?? '',
        locale,
        now,
        inputs: body.inputs ?? {},
      }
      // Root title: what the user typed, else the template's root title (variables allowed there).
      const rootTitle = (body.title?.trim() || renderString(t.root.title, ctx).text.trim() || t.name).slice(0, 300)
      ctx.title = rootTitle

      const rootProperty: PageProperty | undefined = t.withDate
        ? { id: 'date', name: DATE_PROPERTY_NAME[locale], type: 'date', value: formatDate(now, 'YYYY-MM-DD', locale) }
        : undefined

      const result = await instantiateTree({
        root: t.root,
        workspaceId: body.workspaceId,
        parentId,
        scope: body.scope ?? 'shared',
        role,
        userId: user.id,
        ctx,
        rootTitle,
        rootProperty,
      })
      await markCreatedVia(result.pages.map((p) => p.id), user)
      const dtos = result.pages.map(toPageDTO)
      return { page: dtos[0], pages: dtos, ...(result.cursor ? { cursor: result.cursor } : {}) }
    },
  )
}
