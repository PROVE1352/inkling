/**
 * Compiles a resolved filter tree (./filter.ts) and sort keys into SQL over the rows of ONE
 * collection (docs/adr/0934-*).
 *
 * The statement this feeds is `SELECT … FROM pages WHERE parent_id = $collection AND
 * deleted_at IS NULL AND visibleTo(user) AND <filter> AND <keyset> ORDER BY <keys> LIMIT n+1`.
 * Every fragment here therefore refers to the unaliased outer `pages` row; sub-queries that need
 * other pages (relation targets) open their own `FROM pages`, which shadows the outer name, so
 * the shared `visibleTo()` predicate applies to the linked rows without an alias.
 *
 * Safety: field ids, option ids, values and dates are bind parameters. The only raw SQL is fixed
 * text from this file (operators come from a closed set).
 */
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { CollectionField } from '@inkling/shared'
import { pages, users } from '../db/schema'
import { isWorkspaceMember } from '../collectionRelations'
import { visibleTo } from '../pageDto'
import { escapeLike } from '../util'
import { FilterError, kindOf } from './filter'
import type { Cond, Expr, SortKey, Value } from './filter'

export interface CompileCtx {
  workspaceId: string
  userId: string
}

/**
 * Row version used by query_rows / update_row: a hash of the stored props. The same expression
 * is used by the read routes and inside the FOR UPDATE transaction of PATCH /pages/:id/props, so
 * the two can never disagree (jsonb text output is canonical).
 */
export function rowVersionSql(props: SQL | typeof pages.props = pages.props): SQL {
  return sql`substr(md5(coalesce(${props}, '{}'::jsonb)::text), 1, 12)`
}

const prop = (fid: string) => sql`(${pages.props} -> ${fid}::text)`
const propText = (fid: string) => sql`(${pages.props} ->> ${fid}::text)`
const arr = (fid: string) =>
  sql`(CASE WHEN jsonb_typeof(${prop(fid)}) = 'array' THEN ${prop(fid)} ELSE '[]'::jsonb END)`
/** numeric value of a json number (or numeric string); NULL otherwise — never raises */
const num = (fid: string) =>
  sql`(CASE WHEN jsonb_typeof(${prop(fid)}) = 'number' THEN (${propText(fid)})::numeric
            WHEN jsonb_typeof(${prop(fid)}) = 'string' AND ${propText(fid)} ~ '^-?[0-9]{1,15}(\\.[0-9]{1,15})?$' THEN (${propText(fid)})::numeric END)`
/** YYYY-MM-DD prefix of a date string; NULL for anything else (compared as text, never cast) */
const date = (fid: string) =>
  sql`(CASE WHEN ${propText(fid)} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(${propText(fid)}, 10) END)`
const bool = (fid: string) => sql`coalesce(${prop(fid)} = 'true'::jsonb, false)`
const optIds = (f: CollectionField) => JSON.stringify((f.options ?? []).map((o) => o.id))

const CMP: Record<string, SQL> = {
  '=': sql.raw('='),
  '<': sql.raw('<'),
  '<=': sql.raw('<='),
  '>': sql.raw('>'),
  '>=': sql.raw('>='),
}

/** Visible, live rows of a relation's target collection (uncorrelated: evaluated once). */
function visibleTargetIds(f: CollectionField, ctx: CompileCtx, match?: string): SQL {
  const target = f.relation!.targetPageId
  const m = match
    ? sql` AND (${pages.id}::text = lower(${match}::text) OR lower(${pages.title}) = lower(${match}::text))`
    : sql``
  return sql`(SELECT ${pages.id}::text FROM ${pages}
               WHERE ${pages.parentId} = ${target}::uuid AND ${pages.workspaceId} = ${ctx.workspaceId}::uuid
                 AND ${pages.deletedAt} IS NULL AND ${visibleTo(ctx.userId)}${m})`
}

/** Workspace members matched by name / email (case-insensitive) — same member-only rule as display. */
function memberIdsByName(v: string, ctx: CompileCtx): SQL {
  return sql`(SELECT ${users.id}::text FROM ${users}
               WHERE (lower(${users.name}) = lower(${v}::text) OR lower(${users.email}) = lower(${v}::text))
                 AND ${isWorkspaceMember(ctx.workspaceId)})`
}

function compileCond(c: Cond, ctx: CompileCtx): SQL {
  const kind = kindOf(c.field)
  const f = c.field.kind === 'field' ? c.field.field : null
  const fid = f?.id ?? ''
  const v = c.value as Value | undefined
  const val = v?.v
  switch (kind) {
    case 'title':
    case 'text':
    case 'url': {
      const t = kind === 'title' ? sql`coalesce(${pages.title}, '')` : sql`coalesce(${propText(fid)}, '')`
      switch (c.op) {
        case '=':
          return sql`(lower(${t}) = lower(${String(val)}::text))`
        case '!=':
          return sql`(lower(${t}) <> lower(${String(val)}::text))`
        case '~':
          return sql`(${t} ILIKE ${`%${escapeLike(String(val))}%`}::text)`
        case '!~':
          return sql`(${t} NOT ILIKE ${`%${escapeLike(String(val))}%`}::text)`
        case 'empty':
          return sql`(${t} = '')`
        case 'notEmpty':
          return sql`(${t} <> '')`
      }
      break
    }
    case 'number': {
      const n = num(fid)
      if (c.op === 'empty') return sql`(${n} IS NULL)`
      if (c.op === 'notEmpty') return sql`(${n} IS NOT NULL)`
      if (c.op === '!=') return sql`(${n} IS DISTINCT FROM ${val}::numeric)`
      return sql`coalesce(${n} ${CMP[c.op]} ${val}::numeric, false)`
    }
    case 'date': {
      const d = date(fid)
      if (c.op === 'empty') return sql`(${d} IS NULL)`
      if (c.op === 'notEmpty') return sql`(${d} IS NOT NULL)`
      if (c.op === '!=') return sql`(${d} IS DISTINCT FROM ${val}::text)`
      return sql`coalesce(${d} ${CMP[c.op]} ${val}::text, false)`
    }
    case 'checkbox':
      return c.op === '=' ? sql`(${bool(fid)} = ${val}::boolean)` : sql`(${bool(fid)} <> ${val}::boolean)`
    case 'select': {
      // a stale option id (option deleted) displays as empty, so it counts as empty here too
      const set = sql`jsonb_exists(${optIds(f!)}::jsonb, coalesce(${propText(fid)}, ''))`
      if (c.op === 'empty') return sql`(NOT ${set})`
      if (c.op === 'notEmpty') return set
      const eq = sql`coalesce(${propText(fid)} = ${val}::text, false)`
      return c.op === '=' ? eq : sql`(NOT ${eq})`
    }
    case 'multiSelect': {
      const any = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${arr(fid)}) e(v) WHERE jsonb_exists(${optIds(f!)}::jsonb, e.v))`
      if (c.op === 'empty') return sql`(NOT ${any})`
      if (c.op === 'notEmpty') return any
      const has = sql`jsonb_exists(${arr(fid)}, ${val}::text)`
      return c.op === 'has' ? has : sql`(NOT ${has})`
    }
    case 'person': {
      const p = sql`coalesce(${propText(fid)}, '')`
      if (c.op === 'empty') return sql`(${p} = '')`
      if (c.op === 'notEmpty') return sql`(${p} <> '')`
      const match =
        v!.t === 'personId' ? sql`(${p} = ${String(val)}::text)` : sql`(${p} IN ${memberIdsByName(String(val), ctx)})`
      return c.op === '=' ? match : sql`(NOT ${match})`
    }
    case 'relation': {
      // only links to rows the viewer can see count (hidden links are never revealed, ADR 0300)
      const linked = (match?: string) =>
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${arr(fid)}) e(v) WHERE e.v IN ${visibleTargetIds(f!, ctx, match)})`
      if (c.op === 'empty') return sql`(NOT ${linked()})`
      if (c.op === 'notEmpty') return linked()
      return c.op === 'has' ? linked(String(val)) : sql`(NOT ${linked(String(val))})`
    }
  }
  throw new FilterError(`"${c.field.name}" cannot be filtered`, c.pos)
}

export function compileFilter(e: Expr | null, ctx: CompileCtx): SQL {
  if (!e) return sql`true`
  switch (e.k) {
    case 'cond':
      return compileCond(e, ctx)
    case 'not':
      return sql`(NOT ${compileFilter(e.e, ctx)})`
    case 'and':
    case 'or':
      return sql`(${sql.join(
        e.items.map((x) => compileFilter(x, ctx)),
        sql.raw(e.k === 'and' ? ' AND ' : ' OR '),
      )})`
  }
}

// ---------------------------------------------------------------------------
// sort + keyset pagination
// ---------------------------------------------------------------------------

type Cast = 'text' | 'numeric' | 'float8' | 'int' | 'uuid'
export interface KeyPart {
  expr: SQL
  cast: Cast
  dir: 'asc' | 'desc'
}

function sortExpr(k: SortKey): { expr: SQL; cast: Cast; fallback: SQL } {
  const kind = kindOf(k.field)
  const f = k.field.kind === 'field' ? k.field.field : null
  const fid = f?.id ?? ''
  switch (kind) {
    case 'title':
      return { expr: sql`lower(nullif(${pages.title}, ''))`, cast: 'text', fallback: sql`''` }
    case 'text':
    case 'url':
      return { expr: sql`lower(nullif(${propText(fid)}, ''))`, cast: 'text', fallback: sql`''` }
    case 'number':
      return { expr: num(fid), cast: 'numeric', fallback: sql`0::numeric` }
    case 'date':
      return { expr: date(fid), cast: 'text', fallback: sql`''` }
    case 'checkbox':
      // unchecked is a value, not "empty": never NULL
      return { expr: sql`(CASE WHEN ${bool(fid)} THEN 1 ELSE 0 END)`, cast: 'int', fallback: sql`0` }
    case 'select':
      // option order as defined in the collection (like the board columns)
      return {
        expr: sql`(SELECT o.i::int FROM jsonb_array_elements_text(${optIds(f!)}::jsonb) WITH ORDINALITY o(v, i) WHERE o.v = ${propText(fid)})`,
        cast: 'int',
        fallback: sql`0`,
      }
  }
  throw new FilterError(`Cannot sort by "${k.field.name}"`, 0)
}

/**
 * Key parts of the ORDER BY: for each user key `(expr IS NULL) ASC, coalesce(expr, ·) <dir>` (empty
 * values last in both directions), then the collection's manual order (sort_order, created_at) and
 * the id as the unique tie-breaker the keyset needs.
 */
export function orderKeys(sort: SortKey[]): KeyPart[] {
  const parts: KeyPart[] = []
  for (const k of sort) {
    const { expr, cast, fallback } = sortExpr(k)
    parts.push({ expr: sql`(CASE WHEN ${expr} IS NULL THEN 1 ELSE 0 END)`, cast: 'int', dir: 'asc' })
    parts.push({ expr: sql`coalesce(${expr}, ${fallback})`, cast, dir: k.dir })
  }
  parts.push({ expr: sql`${pages.sortOrder}`, cast: 'float8', dir: 'asc' })
  parts.push({ expr: sql`extract(epoch from ${pages.createdAt})`, cast: 'numeric', dir: 'asc' })
  parts.push({ expr: sql`${pages.id}`, cast: 'uuid', dir: 'asc' })
  return parts
}

export function orderBySql(parts: KeyPart[]): SQL {
  return sql.join(
    parts.map((p) => sql`${p.expr} ${sql.raw(p.dir === 'desc' ? 'DESC' : 'ASC')}`),
    sql`, `,
  )
}

/** SELECT list fragment `k0, k1, …` (text) for building the next cursor. */
export function keySelect(parts: KeyPart[]): SQL {
  return sql.join(
    parts.map((p, i) => sql`(${p.expr})::text AS ${sql.raw(`"k${i}"`)}`),
    sql`, `,
  )
}

const castSql = (v: string, c: Cast): SQL => sql`${v}::${sql.raw(c)}`

/** Row-after-cursor predicate: (a > ca) OR (a = ca AND b > cb) OR … (directions may be mixed). */
export function afterCursor(parts: KeyPart[], values: string[]): SQL {
  const ors: SQL[] = []
  for (let i = 0; i < parts.length; i++) {
    const ands: SQL[] = []
    for (let j = 0; j < i; j++) ands.push(sql`${parts[j].expr} = ${castSql(values[j], parts[j].cast)}`)
    const p = parts[i]
    ands.push(sql`${p.expr} ${sql.raw(p.dir === 'desc' ? '<' : '>')} ${castSql(values[i], p.cast)}`)
    ors.push(sql`(${sql.join(ands, sql` AND `)})`)
  }
  return sql`(${sql.join(ors, sql` OR `)})`
}

// ---------------------------------------------------------------------------
// opaque cursor
// ---------------------------------------------------------------------------

/** Binds a cursor to the collection + filter + sort it was produced for. */
export function querySignature(collectionId: string, filter: string, sort: string): string {
  return createHash('sha1').update(`${collectionId}\n${filter.trim()}\n${sort.trim()}`).digest('base64url').slice(0, 10)
}

export function encodeCursor(sig: string, keys: string[]): string {
  return Buffer.from(JSON.stringify({ s: sig, k: keys })).toString('base64url')
}

export class CursorError extends Error {}

const CAST_RE: Record<Cast, RegExp> = {
  text: /^[\s\S]*$/,
  numeric: /^-?\d{1,40}(\.\d{1,40})?$/,
  float8: /^(-?\d+(\.\d+)?(e[+-]?\d+)?|-?Infinity|NaN)$/i,
  int: /^-?\d{1,10}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}

/** Decode and validate a cursor against the key layout (a forged value never reaches a SQL cast). */
export function decodeCursor(cursor: string, sig: string, parts: Pick<KeyPart, 'cast'>[]): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new CursorError('Invalid cursor; call again without a cursor to start from the first page')
  }
  const p = parsed as { s?: unknown; k?: unknown }
  if (p.s !== sig) {
    throw new CursorError('This cursor belongs to a different filter or sort; repeat the original filter/sort or start again without a cursor')
  }
  if (
    !Array.isArray(p.k) ||
    p.k.length !== parts.length ||
    !p.k.every((x, i) => typeof x === 'string' && x.length <= 2000 && CAST_RE[parts[i].cast].test(x))
  ) {
    throw new CursorError('Invalid cursor; call again without a cursor to start from the first page')
  }
  return p.k as string[]
}
