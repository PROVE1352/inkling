/**
 * Compact filter / sort language for collection rows (query_rows, docs/adr/0934-*).
 *
 *   Status = Done AND Due < 2026-12-01 AND Tags has urgent
 *   Title ~ "deploy" OR (Owner = me AND NOT Done = true)
 *   Due is empty
 *
 * Pure: no database access. Field names are resolved against the collection's field list at parse
 * time (case-insensitive, multi-word names need no quotes), operators are checked against the
 * field type, and values are converted to what the props store holds (option names → option ids,
 * `today` → a date). The SQL compiler (./compile.ts) only ever sees a fully resolved tree.
 */
import { formulaResultType } from '@inkling/shared'
import type { CollectionField, FieldType } from '@inkling/shared'

export class FilterError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message)
    this.name = 'FilterError'
  }
}

export const FILTER_MAX_LENGTH = 2000
export const FILTER_MAX_CONDITIONS = 30
export const SORT_MAX_KEYS = 3

export type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | '~' | '!~' | 'has' | '!has' | 'empty' | 'notEmpty'

/** The row title pseudo-field (always named "Title"; it wins over a user field of the same name). */
export const TITLE: ResolvedField = { kind: 'title', name: 'Title' }

export type ResolvedField = { kind: 'title'; name: 'Title' } | { kind: 'field'; name: string; field: CollectionField }

export type FieldKind = FieldType | 'title'

/** Bound values: what the compiler compares against (already in stored form). */
export type Value =
  | { t: 'text'; v: string }
  | { t: 'number'; v: number }
  | { t: 'date'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'option'; v: string }
  /** person: a user id, or a member name / email to resolve in SQL */
  | { t: 'personId'; v: string }
  | { t: 'personName'; v: string }
  /** relation: a row id or a row title to resolve in SQL (visible rows of the target only) */
  | { t: 'rowRef'; v: string }

export interface Cond {
  k: 'cond'
  field: ResolvedField
  op: Op
  value?: Value
  pos: number
  /** formula fields: the kind of what the formula yields (operators and values follow it) */
  fkind?: FormulaKind
}

/** How a formula field is filtered and sorted: by the type of its result (docs/adr/1826-*). */
export type FormulaKind = 'text' | 'number' | 'checkbox' | 'date'

export function formulaKind(field: CollectionField, fields: CollectionField[]): FormulaKind {
  const t = formulaResultType(fields, field.id)
  return t === 'boolean' ? 'checkbox' : t
}
export type Expr = Cond | { k: 'and' | 'or'; items: Expr[] } | { k: 'not'; e: Expr }

export interface ParseContext {
  fields: CollectionField[]
  /** current user id (for `me`) */
  userId: string
  /** YYYY-MM-DD used for `today` */
  today: string
}

/** Valid operators per field type (aliases such as `=` on multi-value fields are mapped below). */
export const OPS_BY_KIND: Record<FieldKind, Op[]> = {
  title: ['=', '!=', '~', '!~', 'empty', 'notEmpty'],
  text: ['=', '!=', '~', '!~', 'empty', 'notEmpty'],
  url: ['=', '!=', '~', '!~', 'empty', 'notEmpty'],
  number: ['=', '!=', '<', '<=', '>', '>=', 'empty', 'notEmpty'],
  date: ['=', '!=', '<', '<=', '>', '>=', 'empty', 'notEmpty'],
  checkbox: ['=', '!='],
  select: ['=', '!=', 'empty', 'notEmpty'],
  multiSelect: ['has', '!has', 'empty', 'notEmpty'],
  person: ['=', '!=', 'empty', 'notEmpty'],
  relation: ['has', '!has', 'empty', 'notEmpty'],
  rollup: [],
  /** never used as such: a formula takes the operators of its result's kind (formulaKind) */
  formula: [],
}

const OP_LABEL: Record<Op, string> = {
  '=': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '~': '~ (contains)',
  '!~': '!~',
  has: 'has',
  '!has': '!has',
  empty: 'is empty',
  notEmpty: 'is not empty',
}

export function kindOf(f: ResolvedField): FieldKind {
  return f.kind === 'title' ? 'title' : f.field.type
}

export function opsHelp(kind: FieldKind): string {
  return OPS_BY_KIND[kind].map((o) => OP_LABEL[o]).join(', ')
}

// ---------------------------------------------------------------------------
// field resolution (shared with sort parsing, column selection and update_row)
// ---------------------------------------------------------------------------

export interface FieldResolver {
  resolve(name: string, pos?: number): ResolvedField
  /** names an agent may use (Title first), for error messages */
  names(filter?: (f: ResolvedField) => boolean): string[]
}

export function fieldResolver(fields: CollectionField[]): FieldResolver {
  const byName = new Map<string, CollectionField[]>()
  const byId = new Map<string, CollectionField>()
  for (const f of fields) {
    const key = f.name.trim().toLowerCase()
    const list = byName.get(key)
    if (list) list.push(f)
    else byName.set(key, [f])
    byId.set(f.id, f)
  }
  const all: ResolvedField[] = [TITLE, ...fields.map((f) => ({ kind: 'field' as const, name: f.name, field: f }))]
  const names = (filter?: (f: ResolvedField) => boolean) =>
    all.filter((f) => !filter || filter(f)).map((f) => (f.kind === 'field' && f.name.toLowerCase() === 'title' ? `#${f.field.id}` : f.name))
  return {
    names,
    resolve(raw, pos = 0) {
      const name = raw.trim()
      if (name.startsWith('#')) {
        const f = byId.get(name.slice(1))
        if (f) return { kind: 'field', name: f.name, field: f }
      }
      const key = name.toLowerCase()
      if (key === 'title') return TITLE
      const hit = byName.get(key)
      if (hit && hit.length === 1) return { kind: 'field', name: hit[0].name, field: hit[0] }
      if (hit && hit.length > 1) {
        throw new FilterError(
          `Field name "${name}" is ambiguous (${hit.length} fields share it); use #fieldId: ${hit.map((f) => `#${f.id}`).join(', ')}`,
          pos,
        )
      }
      throw new FilterError(
        `Unknown field "${name}". Valid fields: ${names().join(', ')}. Quote names with special characters ("My field") or use #fieldId.`,
        pos,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: 'word'; v: string; pos: number }
  /** quoted string ("…", '…') or back-ticked name */
  | { t: 'str'; v: string; pos: number }
  | { t: 'op'; v: '=' | '!=' | '<' | '<=' | '>' | '>=' | '~' | '!~' | '!has'; pos: number }
  | { t: '(' | ')'; pos: number }

const SPECIAL = new Set(['(', ')', '<', '>', '=', '~', '"', "'", '`'])

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const pos = i
    if (c === '(' || c === ')') {
      out.push({ t: c, pos })
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let v = ''
      i++
      let closed = false
      while (i < src.length) {
        const ch = src[i]
        if (ch === '\\' && c !== '`' && i + 1 < src.length) {
          v += src[i + 1]
          i += 2
          continue
        }
        if (ch === c) {
          closed = true
          i++
          break
        }
        v += ch
        i++
      }
      if (!closed) throw new FilterError(`Unclosed ${c} quote`, pos)
      out.push({ t: 'str', v, pos })
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '!=' || two === '!~' || two === '==' || two === '<>') {
      out.push({ t: 'op', v: two === '==' ? '=' : two === '<>' ? '!=' : two, pos })
      i += 2
      continue
    }
    if (c === '<' || c === '>' || c === '=' || c === '~') {
      out.push({ t: 'op', v: c, pos })
      i++
      continue
    }
    if (c === '!' && /^!has\b/i.test(src.slice(i))) {
      out.push({ t: 'op', v: '!has', pos })
      i += 4
      continue
    }
    let v = ''
    while (i < src.length && !/\s/.test(src[i]) && !SPECIAL.has(src[i])) {
      if (src[i] === '!' && (src[i + 1] === '=' || src[i + 1] === '~')) break
      v += src[i]
      i++
    }
    out.push({ t: 'word', v, pos })
  }
  return out
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

const lower = (t: Tok | undefined) => (t && t.t === 'word' ? t.v.toLowerCase() : '')
const FIELD_STOP = new Set(['has', 'is', 'contains', 'empty'])
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s)
  if (!m) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function shiftDate(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** `YYYY-MM-DD`, `today`, `today+7`, `today-3` → YYYY-MM-DD, or null */
export function parseDateValue(raw: string, today: string): string | null {
  const s = raw.trim().toLowerCase()
  const rel = /^today\s*(?:([+-])\s*(\d{1,5}))?$/.exec(s)
  if (rel) return rel[1] ? shiftDate(today, (rel[1] === '-' ? -1 : 1) * Number(rel[2])) : today
  return isValidDate(s) ? s : null
}

const TRUE_WORDS = new Set(['true', 'yes', 'checked', '1', 'on'])
const FALSE_WORDS = new Set(['false', 'no', 'unchecked', '0', 'off'])
export function parseBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  const s = String(raw).trim().toLowerCase()
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  return null
}

/** Option name (case-insensitive) or option id → option id, or null */
export function findOption(field: CollectionField, raw: string): string | null {
  const s = raw.trim().toLowerCase()
  const opts = field.options ?? []
  return (opts.find((o) => o.name.toLowerCase() === s) ?? opts.find((o) => o.id === raw.trim()))?.id ?? null
}

export function optionNames(field: CollectionField): string {
  const opts = field.options ?? []
  return opts.length ? opts.map((o) => o.name).join(', ') : '(no options defined)'
}

export function parseFilter(src: string, ctx: ParseContext): Expr | null {
  if (src.length > FILTER_MAX_LENGTH) throw new FilterError(`Filter is too long (max ${FILTER_MAX_LENGTH} characters)`, 0)
  const toks = tokenize(src)
  if (toks.length === 0) return null
  const resolver = fieldResolver(ctx.fields)
  let i = 0
  let conds = 0
  const peek = () => toks[i]
  const isKw = (t: Tok | undefined, kw: string) => lower(t) === kw && t?.t === 'word'
  const fail = (msg: string, t?: Tok): never => {
    throw new FilterError(msg, t ? t.pos : src.length)
  }

  const parseOr = (): Expr => {
    const items = [parseAnd()]
    while (isKw(peek(), 'or')) {
      i++
      items.push(parseAnd())
    }
    return items.length === 1 ? items[0] : { k: 'or', items }
  }
  const parseAnd = (): Expr => {
    const items = [parseUnary()]
    while (isKw(peek(), 'and')) {
      i++
      items.push(parseUnary())
    }
    return items.length === 1 ? items[0] : { k: 'and', items }
  }
  const parseUnary = (): Expr => {
    const t = peek()
    if (!t) return fail('Expected a condition, e.g. Status = Done')
    if (isKw(t, 'not')) {
      i++
      return { k: 'not', e: parseUnary() }
    }
    if (t.t === '(') {
      i++
      const e = parseOr()
      if (peek()?.t !== ')') fail('Missing )', peek())
      i++
      return e
    }
    return parseCond()
  }

  const parseCond = (): Cond => {
    const start = peek()!
    if (++conds > FILTER_MAX_CONDITIONS) fail(`Too many conditions (max ${FILTER_MAX_CONDITIONS})`, start)
    // ---- field: one quoted token, or bare words up to the operator
    let name: string
    if (start.t === 'str') {
      name = start.v
      i++
    } else {
      const words: string[] = []
      while (peek()?.t === 'word') {
        const w = lower(peek())
        if (words.length && FIELD_STOP.has(w)) break
        if (words.length && w === 'not' && FIELD_STOP.has(lower(toks[i + 1]))) break
        words.push((peek() as { v: string }).v)
        i++
      }
      if (!words.length) fail('Expected a field name, e.g. Status = Done', start)
      name = words.join(' ')
    }
    const field = resolver.resolve(name, start.pos)
    const fkind = field.kind === 'field' && field.field.type === 'formula' ? formulaKind(field.field, ctx.fields) : undefined
    const kind: FieldKind = fkind ?? kindOf(field)
    if (kind === 'rollup') {
      fail(`"${field.name}" is a rollup (computed, read-only) and cannot be filtered; filter on the related rows instead`, start)
    }
    // ---- operator
    const ot = peek()
    if (!ot) fail(`Expected an operator after "${field.name}". Valid for ${kind}: ${opsHelp(kind)}`)
    let op: Op | null = null
    if (ot.t === 'op') {
      op = ot.v
      i++
    } else if (ot.t === 'word') {
      const w = lower(ot)
      const next = lower(toks[i + 1])
      if (w === 'is' && next === 'empty') (op = 'empty'), (i += 2)
      else if (w === 'is' && next === 'not' && lower(toks[i + 2]) === 'empty') (op = 'notEmpty'), (i += 3)
      else if (w === 'is' && next === 'not') (op = '!='), (i += 2)
      else if (w === 'is') (op = '='), (i += 1)
      else if (w === 'empty') (op = 'empty'), (i += 1)
      else if (w === 'not' && next === 'empty') (op = 'notEmpty'), (i += 2)
      else if (w === 'has') (op = 'has'), (i += 1)
      else if (w === 'not' && next === 'has') (op = '!has'), (i += 2)
      else if (w === 'contains') (op = '~'), (i += 1)
      else if (w === 'not' && next === 'contains') (op = '!~'), (i += 2)
    }
    if (!op) return fail(`Expected an operator after "${field.name}". Valid for ${kind}: ${opsHelp(kind)}`, ot)
    // aliases: = / != on multi-value fields mean has / !has; has on a select means =
    if (kind === 'multiSelect' || kind === 'relation') {
      if (op === '=') op = 'has'
      else if (op === '!=') op = '!has'
    } else if (op === 'has') op = kind === 'title' || kind === 'text' || kind === 'url' ? '~' : '='
    else if (op === '!has') op = kind === 'title' || kind === 'text' || kind === 'url' ? '!~' : '!='
    if (!OPS_BY_KIND[kind].includes(op)) {
      fail(`Operator ${OP_LABEL[op]} is not valid for ${kind} field "${field.name}". Valid: ${opsHelp(kind)}`, ot)
    }
    if (op === 'empty' || op === 'notEmpty') return { k: 'cond', field, op, pos: start.pos, ...(fkind ? { fkind } : {}) }
    // ---- value: one quoted token, or bare words up to AND / OR / ) / end
    const vt = peek()
    let raw: string
    let quoted = false
    if (vt?.t === 'str') {
      raw = vt.v
      quoted = true
      i++
    } else {
      const words: string[] = []
      while (peek()?.t === 'word' && !isKw(peek(), 'and') && !isKw(peek(), 'or')) {
        words.push((peek() as { v: string }).v)
        i++
      }
      if (!words.length) fail(`Expected a value after "${field.name} ${OP_LABEL[op]}"`, vt)
      raw = words.join(' ')
    }
    return { k: 'cond', field, op, value: bindValue(field, kind, raw, quoted, vt?.pos ?? start.pos, ctx), pos: start.pos, ...(fkind ? { fkind } : {}) }
  }

  const expr = parseOr()
  if (i < toks.length) {
    const t = toks[i]
    fail(
      t.t === ')'
        ? 'Unbalanced )'
        : `Unexpected "${t.t === 'word' || t.t === 'str' || t.t === 'op' ? t.v : t.t}"; join conditions with AND / OR and quote values that contain operators`,
      t,
    )
  }
  return expr
}

function bindValue(field: ResolvedField, kind: FieldKind, raw: string, quoted: boolean, pos: number, ctx: ParseContext): Value {
  const name = field.name
  switch (kind) {
    case 'title':
    case 'text':
    case 'url':
      return { t: 'text', v: raw }
    case 'number': {
      const n = Number(raw.trim())
      if (raw.trim() === '' || !Number.isFinite(n)) throw new FilterError(`"${name}" is a number field; "${raw}" is not a number`, pos)
      return { t: 'number', v: n }
    }
    case 'date': {
      const d = parseDateValue(raw, ctx.today)
      if (!d) throw new FilterError(`"${name}" is a date field; use YYYY-MM-DD or today / today+N / today-N (got "${raw}")`, pos)
      return { t: 'date', v: d }
    }
    case 'checkbox': {
      const b = parseBool(raw)
      if (b === null) throw new FilterError(`"${name}" is a checkbox; use true or false (got "${raw}")`, pos)
      return { t: 'bool', v: b }
    }
    case 'select':
    case 'multiSelect': {
      const f = (field as { field: CollectionField }).field
      const id = findOption(f, raw)
      if (!id) throw new FilterError(`"${raw}" is not an option of "${name}". Options: ${optionNames(f)}`, pos)
      return { t: 'option', v: id }
    }
    case 'person': {
      const s = raw.trim()
      if (!quoted && s.toLowerCase() === 'me') return { t: 'personId', v: ctx.userId }
      if (UUID_RE.test(s)) return { t: 'personId', v: s.toLowerCase() }
      return { t: 'personName', v: s }
    }
    case 'relation':
      return { t: 'rowRef', v: raw.trim() }
    default:
      throw new FilterError(`"${name}" cannot be filtered`, pos)
  }
}

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

export const SORTABLE: FieldKind[] = ['title', 'text', 'url', 'number', 'date', 'select', 'checkbox', 'formula']

export interface SortKey {
  field: ResolvedField
  dir: 'asc' | 'desc'
}

/** `Due desc, Title` → keys. Empty values always sort last. */
export function parseSort(src: string, fields: CollectionField[]): SortKey[] {
  const resolver = fieldResolver(fields)
  const parts = src
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length > SORT_MAX_KEYS) throw new FilterError(`At most ${SORT_MAX_KEYS} sort keys`, 0)
  const sortable = (f: ResolvedField) => SORTABLE.includes(kindOf(f))
  return parts.map((p) => {
    let dir: 'asc' | 'desc' = 'asc'
    let name = p
    const m = /\s+(asc|desc)$/i.exec(p)
    if (m) {
      dir = m[1].toLowerCase() as 'asc' | 'desc'
      name = p.slice(0, m.index)
    }
    name = name.replace(/^["'`](.*)["'`]$/, '$1')
    const field = resolver.resolve(name)
    if (!sortable(field)) {
      throw new FilterError(
        `Cannot sort by ${kindOf(field)} field "${field.name}". Sortable fields: ${resolver.names(sortable).join(', ')}`,
        0,
      )
    }
    return { field, dir }
  })
}
