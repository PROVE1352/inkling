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
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { fillAutoProps, formatUniqueId, formulaResultType, isAutoFieldType, isPersonLikeType, parseUniqueId, SUB_ITEMS_MAX_DEPTH, subItemsField } from '@inkling/shared'
import type { AutoSource, CollectionField, FormulaErrorCode } from '@inkling/shared'
import { autoPropsSql, autoSourceColumns, autoSourceSelectSql } from '../collectionQuery/autoValues'
import { descendantsSql } from '../collectionQuery/rowFields'
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
import type { Expr, ResolvedField, SortKey } from '../collectionQuery/filter'
import { formatCell } from '../collectionQuery/values'
import type { FieldSummary } from '../collectionQuery/values'
import { db } from '../db/index'
import { collections, pages, users } from '../db/schema'
import { AppError } from '../errors'
import { idParam, requireMembership } from '../helpers'
import { findVisiblePage, visibleTo } from '../pageDto'
import { requireCollectionPage } from './collections'
import { connectionKey } from '../leases'
import { agentCellLabels } from '../teamAgents'

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
  /**
   * User ids in the shown person cells of these rows, sorted (absent when none), so an agent can be
   * told those people's status once (docs/adr/1846-*, 1870-*).
   */
  people?: string[]
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

/** User ids held by the shown person columns of these rows (sorted, unique; the cell is the person also when an agent is assigned). */
function personIdsShown(columns: ResolvedField[], rows: RawRow[]): string[] {
  const personFields = columns.flatMap((c) => (c.kind === 'field' && c.field.type === 'person' ? [c.field.id] : []))
  if (!personFields.length) return []
  const ids = new Set<string>()
  for (const r of rows) {
    for (const fid of personFields) {
      const v = r.props?.[fid]
      if (typeof v === 'string') ids.add(v)
    }
  }
  return [...ids].sort()
}

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
    if (f.type === 'uniqueId') s.prefix = f.uniqueId?.prefix ?? ''
    if (f.type === 'relation' && f.relation?.subItems) s.subItems = true
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
  const nameFields = shown.filter((f) => isPersonLikeType(f.type))
  if (nameFields.length) {
    const ids = new Set<string>()
    for (const r of rows) for (const f of nameFields) if (typeof r.props[f.id] === 'string') ids.add(r.props[f.id] as string)
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
  // Sub-items (docs/adr/2144-*): the parent cell is short — the parent's ID (TASK-3) when the
  // collection has one, else its title (visible parents only, as for any relation).
  const parentField = subItemsField(fields)
  const uid = fields.find((f) => f.type === 'uniqueId')
  if (parentField && uid && shown.includes(parentField)) {
    const pids = [...new Set(rows.flatMap((r) => (Array.isArray(r.props[parentField.id]) ? (r.props[parentField.id] as string[]).slice(0, 1) : [])))].filter((x) => refTitles.has(x))
    if (pids.length) {
      const nums = await db.select({ id: pages.id, n: pages.rowNumber }).from(pages).where(inArray(pages.id, pids))
      for (const x of nums) if (x.n !== null) refTitles.set(x.id, formatUniqueId(uid, x.n))
    }
  }
  // A person cell assigned to the person's live agent connection reads `Name → Client (g:1a2b3c4d)`
  // (docs/adr/1864-*); every other cell is as before.
  const agents = personFields.length ? await agentCellLabels(workspaceId, personFields, rows) : null
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    version: r.version,
    cells: columns.map((c) => {
      const cell = formatCell(c, r.title, r.props, { refTitles, personNames, formulaErrors: formulaErrors.get(r.id) })
      const agent = agents && c.kind === 'field' && c.field.type === 'person' ? agents.get(`${r.id}|${c.field.id}`) : undefined
      return agent && cell ? `${cell} → ${agent}` : cell
    }),
  }))
}

/** `fields` param: JSON array, comma-separated names, or `*` (all). */
function parseColumns(param: string | undefined, fields: CollectionField[], extra: ResolvedField[]): ResolvedField[] {
  const resolver = fieldResolver(fields)
  let names: string[]
  if (param === undefined || param.trim() === '') {
    names = fields.slice(0, DEFAULT_EXTRA_COLUMNS).map((f) => `#${f.id}`)
    // the parent of a sub-item is always shown (docs/adr/2144-*)
    const parent = subItemsField(fields)
    if (parent && !names.includes(`#${parent.id}`)) names.push(`#${parent.id}`)
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
  /** sub-items (docs/adr/2144-*): only rows under this row (id, ID like TASK-3, or exact title) … */
  under: z.string().max(300).optional(),
  /** … down to this many levels (1 = its sub-items; default 1, max SUB_ITEMS_MAX_DEPTH) */
  depth: z.coerce.number().int().min(1).max(SUB_ITEMS_MAX_DEPTH).optional(),
})

/**
 * The rows of one collection as the filter compiler sees them: `pages` itself, or, when the filter or
 * the sort reads automatic values (docs/adr/2140-*), a derived table named pages whose props carry
 * those (so conditions and sort keys on them compile like on stored values) and whose stored_props
 * keeps the stored ones for the row version. Only the automatic fields the query reads are computed
 * there, and only then: building them for every row of a large collection on every call cost up to
 * 7x (query_rows on 20,000 rows, 28 → 200 ms p50; docs/adr/2192-*). The rows a call returns get all
 * their automatic values from a second read of those rows only (fillAutoProps).
 */
function rowSource(collectionId: string, used: CollectionField[]): { from: ReturnType<typeof sql>; stored: ReturnType<typeof sql> } {
  if (!used.length) return { from: sql`${pages}`, stored: sql`${pages.props}` }
  const cols = Object.values(getTableColumns(pages)).map((c) =>
    c.name === 'props' ? sql`(${pages.props} || ${autoPropsSql(used)}) AS "props"` : sql`${pages}.${sql.identifier(c.name)}`,
  )
  return {
    from: sql`(SELECT ${sql.join(cols, sql`, `)}, ${pages.props} AS "stored_props" FROM ${pages} WHERE ${pages.parentId} = ${collectionId}::uuid) AS "pages"`,
    stored: sql`"pages"."stored_props"`,
  }
}

/** Automatic fields a filter or a sort reads (formula conditions are decided in memory, ADR 1826). */
export function autoFieldsRead(ast: Expr | null, sort: SortKey[]): CollectionField[] {
  const out = new Map<string, CollectionField>()
  const add = (f: ResolvedField) => {
    if (f.kind === 'field' && isAutoFieldType(f.field.type)) out.set(f.field.id, f.field)
  }
  const walk = (e: Expr | null) => {
    if (!e) return
    if (e.k === 'cond') add(e.field)
    else if (e.k === 'not') walk(e.e)
    else e.items.forEach(walk)
  }
  walk(ast)
  for (const k of sort) add(k.field)
  return [...out.values()]
}

const invalidUnder = (m: string) => new AppError(400, 'INVALID_QUERY', m)

/** `under` → a row id of this collection the viewer can see: row id, unique ID (TASK-3) or exact title. */
async function resolveUnder(collectionId: string, fields: CollectionField[], ref: string, userId: string): Promise<string> {
  const r = ref.trim()
  const base = and(eq(pages.parentId, collectionId), sql`${pages.deletedAt} IS NULL`, visibleTo(userId))
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r)) {
    const [hit] = await db.select({ id: pages.id }).from(pages).where(and(base, eq(pages.id, r.toLowerCase()))).limit(1)
    if (hit) return hit.id
    throw invalidUnder(`under: no visible row ${r} in this collection`)
  }
  const uid = fields.find((f) => f.type === 'uniqueId')
  const n = uid ? parseUniqueId(uid, r) : null
  if (n !== null) {
    const [hit] = await db.select({ id: pages.id }).from(pages).where(and(base, eq(pages.rowNumber, n))).limit(1)
    if (hit) return hit.id
  }
  const hits = await db.select({ id: pages.id }).from(pages).where(and(base, sql`lower(${pages.title}) = lower(${r})`)).limit(3)
  if (hits.length === 1) return hits[0].id
  if (hits.length > 1) throw invalidUnder(`under: ${hits.length} rows are titled "${r}"; pass a row id`)
  throw invalidUnder(`under: no row "${r}" in this collection (row id, ${uid ? 'ID, ' : ''}or exact title)`)
}

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
    // the cursor is bound to the sub-item scope as well
    const underKey = q.under !== undefined ? `\nunder:${q.under}|${q.depth ?? 1}` : ''
    const sortSrc = q.sort ?? ''
    let filterSql: SQL
    let underSql: SQL = sql`true`
    const parentField = subItemsField(fields, id)
    if (q.under !== undefined || q.depth !== undefined) {
      if (!parentField) throw invalidQuery('under / depth need sub-items: this collection has no Parent item property')
      if (q.under === undefined) throw invalidQuery('depth needs under (the row whose sub-items to list)')
      const root = await resolveUnder(id, fields, q.under, user.id)
      underSql = sql`${pages.id} IN ${descendantsSql(id, parentField, root, q.depth ?? 1)}`
    }
    let columns: ResolvedField[]
    let parts: ReturnType<typeof orderKeys>
    let after: SQL = sql`true`
    let autoRead: CollectionField[] = []
    // one instant for every formula of this request (deterministic output, docs/adr/0937-*)
    const now = new Date()
    try {
      const ast = parseFilter(filterSrc, { fields, userId: user.id, today: today(), connection: connectionKey(user) || null })
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
      autoRead = autoFieldsRead(ast, sort)
      parts = orderKeys(sort, pre?.ranks)
      columns = parseColumns(q.fields, fields, sort.map((s) => s.field))
      if (q.cursor) {
        const values = decodeCursor(q.cursor, querySignature(id, filterSrc + underKey, sortSrc), parts)
        after = afterCursor(parts, values)
      }
    } catch (err) {
      if (err instanceof FilterError || err instanceof CursorError) throw invalidQuery(err.message)
      throw err
    }

    let raw: RawRow[]
    const src = rowSource(id, autoRead)
    const hasAuto = fields.some((f) => isAutoFieldType(f.type))
    try {
      raw = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`))
        await tx.execute(sql.raw('SET LOCAL jit = off'))
        const found = (await tx.execute(sql`
          SELECT ${pages.id} AS id, ${pages.title} AS title, ${pages.props} AS props,
                 ${rowVersionSql(src.stored)} AS version, ${keySelect(parts)}
            FROM ${src.from}
           WHERE ${pages.parentId} = ${id}::uuid
             AND ${pages.deletedAt} IS NULL
             AND ${visibleTo(user.id)}
             AND ${filterSql}
             AND ${underSql}
             AND ${after}
           ORDER BY ${orderBySql(parts)}
           LIMIT ${limit + 1}
        `)) as unknown as RawRow[]
        // the automatic values of the rows shown, read for those rows only (in the sorted statement
        // above the formatting ran for every row that passed the filter); the version stays the hash
        // of the stored props
        const shown = found.slice(0, limit)
        if (hasAuto && shown.length) {
          const srcRows = (await tx.execute(sql`
            SELECT ${pages.id} AS id, ${autoSourceSelectSql()} FROM ${pages}
             WHERE ${pages.id} IN (${sql.join(shown.map((r) => sql`${r.id}::uuid`), sql`, `)})
          `)) as unknown as (AutoSource & { id: string })[]
          const byId = new Map(srcRows.map((r) => [r.id, r]))
          for (const r of shown) {
            r.props = { ...(r.props ?? {}) }
            const a = byId.get(r.id)
            if (a) fillAutoProps(fields, r.props, a)
          }
        }
        return found
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
            querySignature(id, filterSrc + underKey, sortSrc),
            parts.map((_, i) => String(last[`k${i}`])),
          )
        : null
    const rows = await formatRows(page.workspaceId, fields, columns, pageRows, user.id, now)
    const people = personIdsShown(columns, pageRows)
    return {
      collection,
      workspaceId: page.workspaceId,
      fields: summary,
      columns: columns.map((c) => c.name),
      rows: rows.map((r) => ({ id: r.id, version: r.version, cells: r.cells })),
      nextCursor,
      ...(people.length ? { people } : {}),
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
    const [one] = await db
      .select({ id: pages.id, title: pages.title, props: pages.props, version: rowVersionSql(), ...autoSourceColumns })
      .from(pages)
      .where(eq(pages.id, id))
      .limit(1)
    const props = { ...((one?.props ?? {}) as Record<string, unknown>) }
    // automatic values (docs/adr/2140-*); the version stays the hash of the stored props
    if (one) fillAutoProps(fields, props, one)
    const raw: RawRow[] = one ? [{ id: one.id, title: one.title, props, version: one.version as string }] : []
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
