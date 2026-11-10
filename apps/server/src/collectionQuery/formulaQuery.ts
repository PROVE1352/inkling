/**
 * Formula fields in query_rows filters and sorts (docs/adr/1826-*).
 *
 * Formula values are never stored, so SQL cannot compare them. When a filter or a sort names a
 * formula, the visible live rows of the collection are read once (id, title, props), rollups are
 * computed when a formula reads one, the formulas are evaluated with the shared engine, and the
 * outcome is handed to the SQL compiler as two keyed lookups:
 *
 *   - each formula condition → the ids of the rows it keeps   (jsonb_exists(ids, pages.id::text))
 *   - each formula sort key  → a dense rank per row's value    ((ranks ->> pages.id::text)::int)
 *
 * Everything else (the other conditions, keyset pagination, the cursor format) stays in SQL as it
 * was, so a query without formulas costs nothing more. Comparisons follow the SQL compiler's rules
 * for the formula's result kind (text: case-insensitive; dates: the YYYY-MM-DD prefix; an empty value
 * sorts last).
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { CollectionField, FormulaValue } from '@inkling/shared'
import { db } from '../db/index'
import { pages } from '../db/schema'
import { computeFormulas, formulasNeedLinks, resolveRelations } from '../collectionRelations'
import { visibleTo } from '../pageDto'
import type { FormulaRanks } from './compile'
import type { Cond, Expr, FormulaKind, SortKey } from './filter'

export function formulaConds(e: Expr | null, out: Cond[] = []): Cond[] {
  if (!e) return out
  if (e.k === 'cond') {
    if (e.fkind) out.push(e)
  } else if (e.k === 'not') formulaConds(e.e, out)
  else for (const x of e.items) formulaConds(x, out)
  return out
}

const isFormulaSort = (k: SortKey) => k.field.kind === 'field' && k.field.field.type === 'formula'

export function needsFormulaPass(ast: Expr | null, sort: SortKey[]): boolean {
  return formulaConds(ast).length > 0 || sort.some(isFormulaSort)
}

const dateOf = (v: FormulaValue): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)
const numOf = (v: FormulaValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const textOf = (v: FormulaValue): string => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v))

/** One formula condition against one computed value (mirrors compile.ts for the same kind). */
export function formulaCondMatches(c: Cond, v: FormulaValue): boolean {
  const kind = c.fkind as FormulaKind
  const val = c.value?.v
  switch (kind) {
    case 'text': {
      const t = textOf(v)
      const s = String(val ?? '')
      switch (c.op) {
        case '=':
          return t.toLowerCase() === s.toLowerCase()
        case '!=':
          return t.toLowerCase() !== s.toLowerCase()
        case '~':
          return t.toLowerCase().includes(s.toLowerCase())
        case '!~':
          return !t.toLowerCase().includes(s.toLowerCase())
        case 'empty':
          return t === ''
        case 'notEmpty':
          return t !== ''
      }
      return false
    }
    case 'number': {
      const n = numOf(v)
      if (c.op === 'empty') return n === null
      if (c.op === 'notEmpty') return n !== null
      const x = Number(val)
      if (c.op === '!=') return n === null || n !== x
      if (n === null) return false
      return cmp(n, x, c.op)
    }
    case 'date': {
      const d = dateOf(v)
      if (c.op === 'empty') return d === null
      if (c.op === 'notEmpty') return d !== null
      const x = String(val)
      if (c.op === '!=') return d === null || d !== x
      if (d === null) return false
      return cmp(d, x, c.op)
    }
    case 'checkbox': {
      const b = v === true
      return c.op === '=' ? b === val : b !== val
    }
  }
}

function cmp<T extends number | string>(a: T, b: T, op: string): boolean {
  switch (op) {
    case '=':
      return a === b
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
  }
  return false
}

/** Sort key of a computed value by kind; null = empty (sorts last, as in SQL). */
function sortValue(kind: FormulaKind, v: FormulaValue): number | string | null {
  switch (kind) {
    case 'number':
      return numOf(v)
    case 'date':
      return dateOf(v)
    case 'checkbox':
      return v === true ? 1 : 0
    case 'text': {
      const t = textOf(v)
      return t === '' ? null : t.toLowerCase()
    }
  }
}

/** Dense ranks (1, 2, …) of the rows' values; rows with an empty value are left out. */
export function denseRanks(values: Map<string, number | string | null>): Record<string, number> {
  const distinct = [...new Set([...values.values()].filter((x): x is number | string => x !== null))]
  distinct.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : a < b ? -1 : a > b ? 1 : 0))
  const rank = new Map(distinct.map((x, i) => [x, i + 1]))
  const out: Record<string, number> = {}
  for (const [id, x] of values) if (x !== null) out[id] = rank.get(x)!
  return out
}

export interface FormulaQueryInput {
  workspaceId: string
  collectionId: string
  fields: CollectionField[]
  userId: string
  ast: Expr | null
  sort: SortKey[]
  kindOf: (f: CollectionField) => FormulaKind
  now: Date
}

/** Evaluate the formulas the query needs over the viewer's rows; null when the query names none. */
export async function precomputeFormulaQuery(
  q: FormulaQueryInput,
): Promise<{ matches: Map<Cond, string>; ranks: FormulaRanks } | null> {
  const conds = formulaConds(q.ast)
  const sorts = q.sort.filter(isFormulaSort)
  if (!conds.length && !sorts.length) return null
  const raw = await db
    .select({ id: pages.id, title: pages.title, props: pages.props })
    .from(pages)
    .where(and(eq(pages.parentId, q.collectionId), isNull(pages.deletedAt), visibleTo(q.userId)))
  const rows = raw.map((r) => ({ id: r.id, title: r.title ?? '', props: { ...((r.props ?? {}) as Record<string, unknown>) } }))
  // rollups only when a formula reads one (the same per-viewer link rules as the response)
  if (formulasNeedLinks(q.fields)) await resolveRelations(q.workspaceId, q.fields, rows, q.userId, { now: q.now })
  else computeFormulas(q.fields, rows, q.now)

  const matches = new Map<Cond, string>()
  for (const c of conds) {
    const fid = (c.field as { field: CollectionField }).field.id
    const keep: Record<string, 1> = {}
    for (const r of rows) if (formulaCondMatches(c, (r.props[fid] ?? null) as FormulaValue)) keep[r.id] = 1
    matches.set(c, JSON.stringify(keep))
  }
  const ranks: FormulaRanks = new Map()
  for (const k of sorts) {
    const f = (k.field as { field: CollectionField }).field
    if (ranks.has(f.id)) continue
    const kind = q.kindOf(f)
    const values = new Map(rows.map((r) => [r.id, sortValue(kind, (r.props[f.id] ?? null) as FormulaValue)]))
    ranks.set(f.id, JSON.stringify(denseRanks(values)))
  }
  return { matches, ranks }
}
