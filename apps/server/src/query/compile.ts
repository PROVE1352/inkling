import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { QUERY_LIMITS } from '@inkling/shared'
import type { CmpOp, QExpr, QSource, QueryAst } from '@inkling/shared'
import { visibleTo } from '../pageDto'
import { pageInRangeSql } from '../tokenRange'

/**
 * Compiles a parsed Dataview-subset query (QueryAst) into ONE parameterized SQL statement.
 *
 * Safety rules (see docs/adr/0203-query-block-sql-compilation.md):
 *  - Every user-supplied value (strings, numbers, tag names, folder paths, property names,
 *    dates) is passed as a bind parameter through drizzle's `sql` template. Identifiers in the
 *    generated SQL are fixed constants from this file — nothing from the query text is ever
 *    spliced into SQL text.
 *  - The row filter always includes workspace_id, deleted_at IS NULL and the shared
 *    visibleTo(userId) predicate (also inside the recursive folder CTE, so private titles
 *    never leak through file.folder).
 *  - Result size is capped (LIMIT ≤ QUERY_LIMITS.maxRows, +1 row to detect truncation);
 *    the caller runs the statement under SET LOCAL statement_timeout.
 */

export class QueryCompileError extends Error {
  pos: number
  constructor(message: string, pos: number) {
    super(message)
    this.name = 'QueryCompileError'
    this.pos = pos
  }
}

export interface CompileContext {
  workspaceId: string
  userId: string
  /** viewer's local date YYYY-MM-DD */
  today: string
  /** viewer's UTC offset in minutes */
  tzOffsetMinutes: number
}

export interface CompiledQuery {
  statement: SQL
  /** rows requested from SQL = limit + 1 */
  fetch: number
  limit: number
  columns: string[]
}

/** Typed SQL fragment. json = jsonb value, ts = timestamptz, date = resolved 'YYYY-MM-DD' literal, bool = boolean */
type Typed =
  | { t: 'json'; s: SQL }
  | { t: 'ts'; s: SQL }
  | { t: 'date'; s: SQL; d: string }
  | { t: 'bool'; s: SQL }
  | { t: 'lit'; s: SQL; v: string | number | boolean | null }

const FILE_FIELDS = new Set(['name', 'ctime', 'mtime', 'cday', 'mday', 'tags', 'folder', 'path', 'link'])
const TASK_FIELDS = new Set(['text', 'due', 'completed', 'checked'])

/** Add `days` to a YYYY-MM-DD date (UTC arithmetic — pure calendar math). */
function shiftDate(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Cut the LIMIT + 1 rows fetched by the compiled statement down to LIMIT. `truncated` is true only
 * when the extra row came back, i.e. more rows matched; a result that exactly fills LIMIT is complete.
 * The web block shows "Showing the first N" from this flag alone.
 */
export function takeLimit<T>(raw: readonly T[], limit: number): { rows: T[]; truncated: boolean } {
  return { rows: raw.slice(0, limit), truncated: raw.length > limit }
}

export function compileQuery(ast: QueryAst, ctx: CompileContext): CompiledQuery {
  const isTask = ast.type === 'TASK'
  let needTree = false
  let needTags = false
  // distinct property lookups → one LATERAL column each (evaluated once per row)
  const propIndex = new Map<string, number>()
  const propNames: string[] = []

  // -------------------------------------------------------------------------
  // field / expression compilation
  // -------------------------------------------------------------------------

  const offset = sql`make_interval(mins => ${ctx.tzOffsetMinutes}::int)`

  const fieldSql = (path: string[], pos: number): Typed => {
    const head = path[0].toLowerCase()
    if (head === 'file' && path.length === 2) {
      const f = path[1].toLowerCase()
      if (!FILE_FIELDS.has(f)) {
        throw new QueryCompileError(
          `Unknown field file.${path[1]} — supported: ${[...FILE_FIELDS].map((x) => `file.${x}`).join(', ')}`,
          pos,
        )
      }
      switch (f) {
        case 'name':
        case 'link':
          return { t: 'json', s: sql`to_jsonb("pages"."title")` }
        case 'ctime':
          return { t: 'ts', s: sql`"pages"."created_at"` }
        case 'mtime':
          return { t: 'ts', s: sql`"pages"."updated_at"` }
        case 'cday':
          return {
            t: 'json',
            s: sql`to_jsonb(to_char("pages"."created_at" + ${offset}, 'YYYY-MM-DD'))`,
          }
        case 'mday':
          return {
            t: 'json',
            s: sql`to_jsonb(to_char("pages"."updated_at" + ${offset}, 'YYYY-MM-DD'))`,
          }
        case 'tags':
          needTags = true
          return { t: 'json', s: sql`"fv"."tags"` }
        case 'folder':
          needTree = true
          return { t: 'json', s: sql`to_jsonb("tree"."folder")` }
        case 'path':
          needTree = true
          return { t: 'json', s: sql`to_jsonb("tree"."path")` }
      }
    }
    if (head === 'file') {
      throw new QueryCompileError('Use file.<field>, e.g. file.name', pos)
    }
    if (isTask && path.length === 1 && TASK_FIELDS.has(head)) {
      switch (head) {
        case 'text':
          return { t: 'json', s: sql`to_jsonb("page_tasks"."text")` }
        case 'due':
          return { t: 'json', s: sql`to_jsonb("page_tasks"."due")` }
        default:
          return { t: 'bool', s: sql`"page_tasks"."checked"` }
      }
    }
    const name = path.join('.')
    let idx = propIndex.get(name.toLowerCase())
    if (idx === undefined) {
      idx = propNames.length
      propIndex.set(name.toLowerCase(), idx)
      propNames.push(name)
      if (propNames.length > 24) throw new QueryCompileError('Too many distinct fields', pos)
    }
    return { t: 'json', s: sql`${sql.raw(`"fv"."p${idx}"`)}` }
  }

  const asJson = (x: Typed): SQL => {
    switch (x.t) {
      case 'json':
        return x.s
      case 'ts':
        return sql`to_jsonb(${x.s})`
      case 'date':
        return sql`to_jsonb(${x.d}::text)`
      case 'bool':
        return sql`to_jsonb(${x.s})`
      case 'lit':
        return litJson(x.v)
    }
  }

  const litJson = (v: string | number | boolean | null): SQL => {
    if (v === null) return sql`'null'::jsonb`
    if (typeof v === 'string') return sql`to_jsonb(${v}::text)`
    if (typeof v === 'number') return sql`to_jsonb(${v}::numeric)`
    return sql`to_jsonb(${v}::boolean)`
  }

  const truthy = (x: Typed): SQL => {
    switch (x.t) {
      case 'bool':
        return sql`coalesce(${x.s}, false)`
      case 'ts':
      case 'date':
        return sql`(${x.s} IS NOT NULL)`
      case 'lit':
        return x.v === null || x.v === false || x.v === '' || x.v === 0 ? sql`false` : sql`true`
      case 'json':
        return sql`coalesce(${x.s} NOT IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb, '0'::jsonb), false)`
    }
  }

  const sqlOp = (op: CmpOp): SQL => sql.raw(op === '=' ? '=' : op === '!=' ? '<>' : op)
  const mirror = (op: CmpOp): CmpOp =>
    op === '<' ? '>' : op === '>' ? '<' : op === '<=' ? '>=' : op === '>=' ? '<=' : op

  /** Local midnight of `day` as timestamptz. `day` is produced by us (validated) — safe to cast. */
  const dayStart = (day: string): SQL =>
    sql`((${day}::date)::timestamp - ${offset}) AT TIME ZONE 'UTC'`

  const jsonNum = (j: SQL): SQL =>
    sql`(CASE WHEN jsonb_typeof(${j}) = 'number' THEN (${j} #>> '{}')::numeric
              WHEN jsonb_typeof(${j}) = 'string' AND (${j} #>> '{}') ~ '^-?[0-9]{1,15}(\\.[0-9]{1,15})?$' THEN (${j} #>> '{}')::numeric END)`
  // Date part of a json string value ('YYYY-MM-DD…'); compared as text — never cast, so a malformed
  // value can't make the whole statement fail.
  const jsonDay = (j: SQL): SQL =>
    sql`(CASE WHEN jsonb_typeof(${j}) = 'string' AND (${j} #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(${j} #>> '{}', 1, 10) END)`

  const compare = (op: CmpOp, a: Typed, b: Typed): SQL => {
    // normalise so that a literal / date sits on the right
    if ((a.t === 'lit' || a.t === 'date') && b.t !== 'lit' && b.t !== 'date') {
      return compare(mirror(op), b, a)
    }
    // timestamp column vs date literal
    if (a.t === 'ts' && b.t === 'date') {
      const start = dayStart(b.d)
      const end = dayStart(shiftDate(b.d, 1))
      switch (op) {
        case '=':
          return sql`(${a.s} >= ${start} AND ${a.s} < ${end})`
        case '!=':
          return sql`NOT (${a.s} >= ${start} AND ${a.s} < ${end})`
        case '<':
          return sql`(${a.s} < ${start})`
        case '>=':
          return sql`(${a.s} >= ${start})`
        case '<=':
          return sql`(${a.s} < ${end})`
        case '>':
          return sql`(${a.s} >= ${end})`
      }
    }
    if (a.t === 'ts' && b.t === 'ts') return sql`(${a.s} ${sqlOp(op)} ${b.s})`
    if (a.t === 'ts' && b.t === 'lit' && typeof b.v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.v)) {
      return compare(op, a, { t: 'date', s: sql``, d: b.v })
    }
    // json (or ts/bool coerced) vs date
    if (b.t === 'date') {
      const day = jsonDay(asJson(a))
      if (op === '!=') return sql`coalesce(${day} <> ${b.d}, true)`
      return sql`coalesce(${day} ${sqlOp(op)} ${b.d}, false)`
    }
    const left = asJson(a)
    if (b.t === 'lit') {
      const v = b.v
      if (v === null) {
        const isNull = sql`(${left} IS NULL OR ${left} = 'null'::jsonb)`
        return op === '!=' ? sql`NOT ${isNull}` : op === '=' ? isNull : sql`false`
      }
      if (typeof v === 'boolean') {
        const isTrue = sql`coalesce(${left} = 'true'::jsonb, false)`
        const eq = v ? isTrue : sql`NOT ${isTrue}`
        return op === '!=' ? sql`NOT (${eq})` : op === '=' ? eq : sql`false`
      }
      if (op === '=' || op === '!=') {
        // scalar equality OR array membership (jsonb @> treats ["x"] @> "x" as true)
        let eq = sql`coalesce(${left} @> ${litJson(v)}, false)`
        if (typeof v === 'number') {
          eq = sql`(${eq} OR coalesce(${jsonNum(left)} = ${v}::numeric, false))`
        }
        return op === '=' ? eq : sql`NOT (${eq})`
      }
      if (typeof v === 'number') {
        return sql`coalesce(${jsonNum(left)} ${sqlOp(op)} ${v}::numeric, false)`
      }
      return sql`coalesce(CASE WHEN jsonb_typeof(${left}) = 'string' THEN (${left} #>> '{}') ${sqlOp(op)} ${v}::text END, false)`
    }
    const right = asJson(b)
    if (op === '=') return sql`coalesce(${left} = ${right}, false)`
    if (op === '!=') return sql`(${left} IS DISTINCT FROM ${right})`
    return sql`coalesce(${left} ${sqlOp(op)} ${right}, false)`
  }

  const expr = (e: QExpr): Typed => {
    switch (e.k) {
      case 'lit':
        return { t: 'lit', s: litJson(e.v), v: e.v }
      case 'date': {
        const d =
          e.v === 'today'
            ? ctx.today
            : e.v === 'tomorrow'
              ? shiftDate(ctx.today, 1)
              : e.v === 'yesterday'
                ? shiftDate(ctx.today, -1)
                : e.v
        return { t: 'date', s: sql`to_jsonb(${d}::text)`, d }
      }
      case 'field':
        return fieldSql(e.path, e.pos)
      case 'contains': {
        const a = asJson(expr(e.a))
        const b = asJson(expr(e.b))
        return {
          t: 'bool',
          s: sql`coalesce(CASE jsonb_typeof(${a})
                   WHEN 'array' THEN ${a} @> jsonb_build_array(${b})
                   WHEN 'string' THEN strpos(${a} #>> '{}', ${b} #>> '{}') > 0
                   ELSE false END, false)`,
        }
      }
      case 'not':
        return { t: 'bool', s: sql`NOT ${truthy(expr(e.e))}` }
      case 'and':
        return { t: 'bool', s: sql`(${truthy(expr(e.a))} AND ${truthy(expr(e.b))})` }
      case 'or':
        return { t: 'bool', s: sql`(${truthy(expr(e.a))} OR ${truthy(expr(e.b))})` }
      case 'cmp':
        return { t: 'bool', s: compare(e.op, expr(e.a), expr(e.b)) }
    }
  }

  // -------------------------------------------------------------------------
  // FROM
  // -------------------------------------------------------------------------

  const source = (s: QSource): SQL => {
    switch (s.k) {
      case 'tag': {
        // case-insensitive; #a also matches nested #a/b (Dataview semantics)
        const t = s.tag.toLowerCase()
        return sql`(EXISTS (SELECT 1 FROM "page_tags" "pt" WHERE "pt"."page_id" = "pages"."id"
                              AND (lower("pt"."tag") = ${t} OR starts_with(lower("pt"."tag"), ${`${t}/`})))
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("pages"."properties") = 'array' THEN "pages"."properties" ELSE '[]'::jsonb END) "pp"
                               CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof("pp"->'value') = 'array' THEN "pp"->'value' ELSE '[]'::jsonb END) "tv"(v)
                               WHERE lower("pp"->>'name') IN ('tags', 'tag')
                                 AND (lower(ltrim("tv".v, '#')) = ${t} OR starts_with(lower(ltrim("tv".v, '#')), ${`${t}/`}))))`
      }
      case 'folder':
        needTree = true
        return sql`("tree"."path" = ${s.path} OR starts_with("tree"."path", ${`${s.path}/`}))`
      case 'link':
        // pages that link TO the named page (Dataview: FROM [[Page]])
        return sql`EXISTS (SELECT 1 FROM "page_links" "pl" JOIN "pages" "tp" ON "tp"."id" = "pl"."target_page_id"
                           WHERE "pl"."source_page_id" = "pages"."id"
                             AND "tp"."workspace_id" = ${ctx.workspaceId}
                             AND "tp"."deleted_at" IS NULL
                             -- the target must be visible to the viewer (pageDto.visibleTo):
                             -- otherwise FROM [[title]] is an oracle for others' private titles
                             AND ("tp"."scope" = 'shared' OR "tp"."created_by" = ${ctx.userId})
                             -- and in a limited connection's range (docs/adr/1200-*)
                             AND ${pageInRangeSql(sql`"tp"."id"`, sql`"tp"."workspace_id"`, ctx.userId)}
                             AND lower("tp"."title") = ${s.title.toLowerCase()})`
      case 'not':
        return sql`NOT ${source(s.s)}`
      case 'and':
        return sql`(${source(s.a)} AND ${source(s.b)})`
      case 'or':
        return sql`(${source(s.a)} OR ${source(s.b)})`
    }
  }

  // -------------------------------------------------------------------------
  // assemble
  // -------------------------------------------------------------------------

  const columns: string[] = []
  const cellExprs: SQL[] = []
  if (ast.type === 'TABLE') {
    for (const c of ast.columns) {
      columns.push(c.label)
      cellExprs.push(asJson(expr(c.expr)))
    }
  } else if (ast.type === 'LIST' && ast.listExpr) {
    columns.push('value')
    cellExprs.push(asJson(expr(ast.listExpr)))
  }
  const fromSql = ast.from ? source(ast.from) : sql`true`
  const whereSql = ast.where ? truthy(expr(ast.where)) : sql`true`
  const orderParts: SQL[] = ast.sort.map((s) => {
    const x = expr(s.expr)
    const v = x.t === 'ts' ? x.s : asJson(x)
    return s.dir === 'desc' ? sql`${v} DESC NULLS LAST` : sql`${v} ASC NULLS LAST`
  })
  if (isTask) orderParts.push(sql`"page_tasks"."due" ASC`)
  orderParts.push(sql`lower("pages"."title") ASC`, sql`"pages"."id" ASC`)
  if (isTask) orderParts.push(sql`"page_tasks"."block_id" ASC`)

  const limit = Math.min(ast.limit ?? QUERY_LIMITS.defaultRows, QUERY_LIMITS.maxRows)
  const fetch = limit + 1

  // per-row lateral values: tags (always cheap: PK prefix scan) + one column per property name
  const propCols: SQL[] = propNames.map(
    (name, i) => sql`COALESCE(
        (SELECT "pp"->'value' FROM jsonb_array_elements(CASE WHEN jsonb_typeof("pages"."properties") = 'array' THEN "pages"."properties" ELSE '[]'::jsonb END) "pp"
          WHERE lower("pp"->>'name') = ${name.toLowerCase()} OR "pp"->>'id' = ${name} LIMIT 1),
        (SELECT CASE "f"->>'type'
                  WHEN 'select' THEN (SELECT "o"->'name' FROM jsonb_array_elements(CASE WHEN jsonb_typeof("f"->'options') = 'array' THEN "f"->'options' ELSE '[]'::jsonb END) "o"
                                       WHERE "o"->>'id' = "pages"."props"->>("f"->>'id') LIMIT 1)
                  WHEN 'multiSelect' THEN (SELECT jsonb_agg("o"->'name') FROM jsonb_array_elements(CASE WHEN jsonb_typeof("f"->'options') = 'array' THEN "f"->'options' ELSE '[]'::jsonb END) "o"
                                       WHERE coalesce("pages"."props"->("f"->>'id'), '[]'::jsonb) @> to_jsonb("o"->>'id'))
                  ELSE "pages"."props"->("f"->>'id') END
           FROM "collections" "c" CROSS JOIN LATERAL jsonb_array_elements("c"."fields") "f"
          WHERE "c"."page_id" = "pages"."parent_id" AND lower("f"->>'name') = ${name.toLowerCase()} LIMIT 1)
      ) AS ${sql.raw(`"p${i}"`)}`,
  )
  const tagsCol = sql`(SELECT coalesce(jsonb_agg(DISTINCT '#' || x.tag), '[]'::jsonb) FROM (
          SELECT "pt"."tag" AS tag FROM "page_tags" "pt" WHERE "pt"."page_id" = "pages"."id"
          UNION
          SELECT ltrim("tv".v, '#') FROM jsonb_array_elements(CASE WHEN jsonb_typeof("pages"."properties") = 'array' THEN "pages"."properties" ELSE '[]'::jsonb END) "pp"
            CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof("pp"->'value') = 'array' THEN "pp"->'value' ELSE '[]'::jsonb END) "tv"(v)
           WHERE lower("pp"->>'name') IN ('tags', 'tag')
        ) x) AS "tags"`
  // only the columns the query references are computed (per row, once)
  const lateralCols = [...(needTags ? [tagsCol] : []), ...propCols]
  const lateral = lateralCols.length
    ? // OFFSET 0 keeps the planner from flattening the lateral select into every reference
      // (WHERE, SORT, columns) — each value is computed once per row
      sql`LEFT JOIN LATERAL (SELECT ${sql.join(lateralCols, sql`, `)} OFFSET 0) "fv" ON true`
    : sql``

  const vis = visibleTo(ctx.userId)
  const treeCte = needTree
    ? sql`WITH RECURSIVE "tree"(id, path, folder, depth) AS (
          SELECT "pages"."id", "pages"."title"::text, ''::text, 0 FROM "pages"
           WHERE "pages"."workspace_id" = ${ctx.workspaceId} AND "pages"."parent_id" IS NULL
             AND "pages"."deleted_at" IS NULL AND ${vis}
          UNION ALL
          SELECT "pages"."id", "tree"."path" || '/' || "pages"."title", "tree"."path", "tree"."depth" + 1
            FROM "pages" JOIN "tree" ON "pages"."parent_id" = "tree"."id"
           WHERE "pages"."deleted_at" IS NULL AND ${vis} AND "tree"."depth" < 64
        ) `
    : sql``
  const treeJoin = needTree ? sql`JOIN "tree" ON "tree"."id" = "pages"."id"` : sql``
  const cells = cellExprs.length ? sql`jsonb_build_array(${sql.join(cellExprs, sql`, `)})` : sql`'[]'::jsonb`
  const order = sql.join(orderParts, sql`, `)

  const common = sql`"pages"."workspace_id" = ${ctx.workspaceId}
        AND "pages"."deleted_at" IS NULL
        AND ${vis}
        AND ${fromSql}
        AND ${whereSql}`

  const statement = isTask
    ? sql`${treeCte}SELECT "pages"."id" AS "id", "pages"."title" AS "title", ${cells} AS "cells",
              "page_tasks"."block_id" AS "block_id", "page_tasks"."text" AS "text",
              "page_tasks"."due" AS "due", "page_tasks"."checked" AS "checked"
         FROM "page_tasks" JOIN "pages" ON "pages"."id" = "page_tasks"."page_id"
         ${treeJoin}
         ${lateral}
        WHERE "page_tasks"."workspace_id" = ${ctx.workspaceId} AND ${common}
        ORDER BY ${order}
        LIMIT ${fetch}`
    : sql`${treeCte}SELECT "pages"."id" AS "id", "pages"."title" AS "title", ${cells} AS "cells"
         FROM "pages"
         ${treeJoin}
         ${lateral}
        WHERE "pages"."kind" = 'doc' AND ${common}
        ORDER BY ${order}
        LIMIT ${fetch}`

  return { statement, fetch, limit, columns }
}
