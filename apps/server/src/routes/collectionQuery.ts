/**
 * Agent-oriented collection reads (docs/adr/0934-*), registered from registerCollectionExtRoutes:
 *
 *   GET /pages/:id/collection/query   filter / sort / page through the rows of a collection in SQL
 *                                      (?filter=&sort=&fields=&limit=&cursor=&describe=1)
 *   GET /pages/:id/row                one collection row with its collection's fields + version
 *
 * Both are GET so a read-only token can use them. Access: requireCollectionPage / findVisiblePage
 * (visibility + membership + live workspace), rows filtered with visibleTo once more, relation
 * cells reduced to visible links and rollups computed by resolveRelations (ADR 0300/0301).
 * Cells are display strings (option names, member names, linked row titles).
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { formulaResultType } from '@inkling/shared'
import type { CollectionField, FormulaErrorCode } from '@inkling/shared'
import { getUser, requireUser } from '../auth'
import { computeFormulas, formulasNeedLinks, isWorkspaceMember, resolveRelations } from '../collectionRelations'
import {
  afterCursor,
  compileFilter,
  CursorError,
  decodeCursor,
  encodeCursor,
  keySelect,
  orderBySql,
  orderKeys,
  querySignature,
  rowVersionSql,
} from '../collectionQuery/compile'
import { fieldResolver, FilterError, formulaKind, parseFilter, parseSort } from '../collectionQuery/filter'
import { precomputeFormulaQuery } from '../collectionQuery/formulaQuery'
import type { ResolvedField } from '../collectionQuery/filter'
import { formatCell } from '../collectionQuery/values'
import type { FieldSummary } from '../collectionQuery/values'
import { db } from '../db/index'
import { collections, pages, users } from '../db/schema'
import { AppError } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage, visibleTo } from '../pageDto'
import { requireCollectionPage } from './collections'

export const QUERY_DEFAULT_LIMIT = 25
export const QUERY_MAX_LIMIT = 200
/** fields shown by default after Title */
const DEFAULT_EXTRA_COLUMNS = 4
const STATEMENT_TIMEOUT_MS = 3000

export interface QueryRowsDTO {
  collection: { id: string; title: string }
  workspaceId: string
  fields: FieldSummary[]
  /** describe mode only: full field definitions (option ids etc.) for clients that map names to ids */
  definitions?: CollectionField[]
  /** column names; the first is always Title */
  columns: string[]
  rows: { id: string; version: string; cells: string[] }[]
  nextCursor: string | null
}

export interface CollectionRowDTO {
  collection: { id: string; title: string }
  workspaceId: string
  /** full field definitions (option ids etc.) for clients that map names to ids */
  fields: CollectionField[]
  columns: string[]
  row: { id: string; title: string; version: string; cells: string[] }
}

const invalidQuery = (message: string) => new AppError(400, 'INVALID_QUERY', message)

async function loadFields(collectionId: string): Promise<CollectionField[]> {
  const [row] = await db
    .select({ fields: collections.fields })
    .from(collections)
    .where(eq(collections.pageId, collectionId))
    .limit(1)
  return (row?.fields ?? []) as CollectionField[]
}

/** Field list for headers: relation target titles only for targets the viewer can see (one query). */
async function summarizeFields(fields: CollectionField[], userId: string): Promise<FieldSummary[]> {
  const targetIds = [
    ...new Set(fields.map((f) => (f.type === 'relation' ? f.relation?.targetPageId : undefined)).filter((x): x is string => !!x)),
  ]
  const titles = new Map<string, string>()
  if (targetIds.length) {
    const rows = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(and(inArray(pages.id, targetIds), sql`${pages.deletedAt} IS NULL`, visibleTo(userId)))
    for (const r of rows) titles.set(r.id, r.title || 'Untitled')
  }
  return fields.map((f) => {
    const s: FieldSummary = { id: f.id, name: f.name, type: f.type }
    if (f.type === 'select' || f.type === 'multiSelect') s.options = (f.options ?? []).map((o) => o.name)
    if (f.type === 'relation' && f.relation) s.target = titles.get(f.relation.targetPageId) ?? '(hidden collection)'
    if (f.type === 'rollup' && f.rollup) s.rollup = f.rollup.fn
    if (f.type === 'formula') s.formula = { expression: f.formula?.expression ?? '', result: formulaResultType(fields, f.id) }
    return s
  })
}

interface RawRow {
  id: string
  title: string
  props: Record<string, unknown> | null
  version: string
  [k: string]: unknown
}

/**
 * Display cells for `columns`. Set-wise: one resolveRelations pass (relation visibility + rollups)
 * and one member-name query, whatever the number of rows.
 */
async function formatRows(
  workspaceId: string,
  fields: CollectionField[],
  columns: ResolvedField[],
  raw: RawRow[],
  userId: string,
  now: Date,
): Promise<{ id: string; title: string; version: string; cells: string[] }[]> {
  const rows = raw.map((r) => ({ id: r.id, title: r.title ?? '', version: r.version, props: { ...((r.props ?? {}) as Record<string, unknown>) } }))
  const shown = columns.filter((c): c is Extract<ResolvedField, { kind: 'field' }> => c.kind === 'field').map((c) => c.field)
  const refTitles = new Map<string, string>()
  let formulaErrors = new Map<string, Record<string, FormulaErrorCode>>()
  const formulas = shown.some((f) => f.type === 'formula')
  if (shown.some((f) => f.type === 'relation' || f.type === 'rollup') || (formulas && formulasNeedLinks(fields))) {
    const res = await resolveRelations(workspaceId, fields, rows, userId, { now })
    for (const [id, ref] of Object.entries(res.refs)) refTitles.set(id, ref.title)
    formulaErrors = res.formulaErrors
  } else if (formulas) {
    formulaErrors = computeFormulas(fields, rows, now)
  }
  const personNames = new Map<string, string>()
  const personFields = shown.filter((f) => f.type === 'person')
  if (personFields.length) {
    const ids = new Set<string>()
    for (const r of rows) for (const f of personFields) if (typeof r.props[f.id] === 'string') ids.add(r.props[f.id] as string)
    const valid = [...ids].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    if (valid.length) {
      // member names only: a person cell holding any other user's id must not reveal that user (C-L11)
      const us = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(inArray(users.id, valid), isWorkspaceMember(workspaceId)))
      for (const u of us) personNames.set(u.id, u.name)
    }
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    version: r.version,
    cells: columns.map((c) => formatCell(c, r.title, r.props, { refTitles, personNames, formulaErrors: formulaErrors.get(r.id) })),
  }))
}

/** `fields` param: JSON array, comma-separated names, or `*` (all). */
function parseColumns(param: string | undefined, fields: CollectionField[], extra: ResolvedField[]): ResolvedField[] {
  const resolver = fieldResolver(fields)
  let names: string[]
  if (param === undefined || param.trim() === '') {
    names = fields.slice(0, DEFAULT_EXTRA_COLUMNS).map((f) => `#${f.id}`)
  } else if (param.trim() === '*' || param.trim() === '["*"]') {
    names = fields.map((f) => `#${f.id}`)
  } else if (param.trim().startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(param)
    } catch {
      throw invalidQuery('fields must be a JSON array of field names')
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw invalidQuery('fields must be a JSON array of field names')
    }
    names = parsed as string[]
  } else {
    names = param.split(',').map((s) => s.trim()).filter(Boolean)
  }
  const out: ResolvedField[] = [{ kind: 'title', name: 'Title' }]
  const seen = new Set<string>(['title'])
  const add = (f: ResolvedField) => {
    const key = f.kind === 'title' ? 'title' : f.field.id
    if (!seen.has(key)) {
      seen.add(key)
      out.push(f)
    }
  }
  for (const n of names.slice(0, 200)) add(resolver.resolve(n))
  for (const f of extra) add(f)
  return out
}

const queryParams = z.object({
  filter: z.string().max(2000).optional(),
  sort: z.string().max(300).optional(),
  fields: z.string().max(8000).optional(),
  limit: z.coerce.number().int().min(1).max(QUERY_MAX_LIMIT).optional(),
  cursor: z.string().max(8000).optional(),
  describe: z.enum(['1', 'true', '0', 'false']).optional(),
})

const today = () => new Date().toISOString().slice(0, 10)

export async function registerCollectionQueryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pages/:id/collection/query', { preHandler: requireUser }, async (req): Promise<QueryRowsDTO> => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await requireCollectionPage(id, user.id)
    const q = queryParams.parse(req.query)
    const fields = await loadFields(id)
    const summary = await summarizeFields(fields, user.id)
    const collection = { id, title: page.title }
    if (q.describe === '1' || q.describe === 'true') {
      return { collection, workspaceId: page.workspaceId, fields: summary, definitions: fields, columns: [], rows: [], nextCursor: null }
    }

    const limit = q.limit ?? QUERY_DEFAULT_LIMIT
    const filterSrc = q.filter ?? ''
    const sortSrc = q.sort ?? ''
    let filterSql: SQL
    let columns: ResolvedField[]
    let parts: ReturnType<typeof orderKeys>
    let after: SQL = sql`true`
    // one instant for every formula of this request (deterministic output, docs/adr/0937-*)
    const now = new Date()
    try {
      const ast = parseFilter(filterSrc, { fields, userId: user.id, today: today() })
      const sort = parseSort(sortSrc, fields)
      // formula conditions and sort keys are decided in memory first (docs/adr/1826-*)
      const pre = await precomputeFormulaQuery({
        workspaceId: page.workspaceId,
        collectionId: id,
        fields,
        userId: user.id,
        ast,
        sort,
        kindOf: (f) => formulaKind(f, fields),
        now,
      })
      filterSql = compileFilter(ast, { workspaceId: page.workspaceId, userId: user.id, formulaMatches: pre?.matches })
      parts = orderKeys(sort, pre?.ranks)
      columns = parseColumns(q.fields, fields, sort.map((s) => s.field))
      if (q.cursor) {
        const values = decodeCursor(q.cursor, querySignature(id, filterSrc, sortSrc), parts)
        after = afterCursor(parts, values)
      }
    } catch (err) {
      if (err instanceof FilterError || err instanceof CursorError) throw invalidQuery(err.message)
      throw err
    }

    let raw: RawRow[]
    try {
      raw = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`))
        await tx.execute(sql.raw('SET LOCAL jit = off'))
        return (await tx.execute(sql`
          SELECT ${pages.id} AS id, ${pages.title} AS title, ${pages.props} AS props,
                 ${rowVersionSql()} AS version, ${keySelect(parts)}
            FROM ${pages}
           WHERE ${pages.parentId} = ${id}::uuid
             AND ${pages.deletedAt} IS NULL
             AND ${visibleTo(user.id)}
             AND ${filterSql}
             AND ${after}
           ORDER BY ${orderBySql(parts)}
           LIMIT ${limit + 1}
        `)) as unknown as RawRow[]
      })
    } catch (err) {
      if ((err as { code?: string }).code === '57014') {
        throw new AppError(400, 'QUERY_TIMEOUT', 'The query took too long; narrow the filter or drop the sort')
      }
      throw err
    }
    const pageRows = raw.slice(0, limit)
    const last = pageRows[pageRows.length - 1]
    const nextCursor =
      raw.length > limit && last
        ? encodeCursor(
            querySignature(id, filterSrc, sortSrc),
            parts.map((_, i) => String(last[`k${i}`])),
          )
        : null
    const rows = await formatRows(page.workspaceId, fields, columns, pageRows, user.id, now)
    return {
      collection,
      workspaceId: page.workspaceId,
      fields: summary,
      columns: columns.map((c) => c.name),
      rows: rows.map((r) => ({ id: r.id, version: r.version, cells: r.cells })),
      nextCursor,
    }
  })

  app.get('/pages/:id/row', { preHandler: requireUser }, async (req): Promise<CollectionRowDTO> => {
    const user = getUser(req)
    const id = idParam(req.params)
    const page = await findVisiblePage(id, user.id)
    if (!page) throw new AppError(404, 'NOT_FOUND', 'Not found')
    await requireMembership(page.workspaceId, user.id)
    const parent = page.parentId ? await findVisiblePage(page.parentId, user.id) : null
    if (!parent || parent.kind !== 'collection') {
      throw new AppError(400, 'NOT_A_ROW', 'This page is not a row of a collection')
    }
    const fields = await loadFields(parent.id)
    const raw = (await db.execute(sql`
      SELECT ${pages.id} AS id, ${pages.title} AS title, ${pages.props} AS props, ${rowVersionSql()} AS version
        FROM ${pages} WHERE ${pages.id} = ${id}::uuid
    `)) as unknown as RawRow[]
    const columns: ResolvedField[] = [
      { kind: 'title', name: 'Title' },
      ...fields.map((f) => ({ kind: 'field' as const, name: f.name, field: f })),
    ]
    const [row] = await formatRows(page.workspaceId, fields, columns, raw, user.id, new Date())
    return {
      collection: { id: parent.id, title: parent.title },
      workspaceId: page.workspaceId,
      fields,
      columns: columns.map((c) => c.name),
      row,
    }
  })
}
