/**
 * Formula fields (docs/adr/1823-*, 1824-*, 1825-*): a computed property of a collection row that
 * reads other properties of the same row.
 *
 *   if(prop("Done"), "✓", concat("due ", dateBetween(prop("Due"), now(), "days"), "d"))
 *   round(prop("Price") * prop("Qty") * 1.1, 2)
 *
 * One pure implementation for the server (GET /collection, query_rows, charts, exports) and the web
 * (cells after an optimistic edit), so both show the same value for the same row and the same `now`.
 * No eval / new Function: a hand-written tokenizer, a recursive-descent parser into a small AST and
 * a tree-walking evaluator with fixed caps (expression length, node count, nesting depth, string
 * length). Values are numbers, strings, booleans, dates and empty (null); dates leave the evaluator
 * as `YYYY-MM-DD` strings (date only) or `YYYY-MM-DDTHH:mmZ` (with a time), always in UTC.
 *
 * Grammar (lowest precedence first):
 *   or     := and (("or" | "||") and)*
 *   and    := not (("and" | "&&") not)*
 *   not    := ("not" | "!") not | cmp
 *   cmp    := add (("==" | "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=") add)?
 *   add    := mul (("+" | "-") mul)*
 *   mul    := unary (("*" | "/" | "%") unary)*
 *   unary  := "-" unary | primary
 *   primary:= number | string | true | false | name "(" args ")" | "(" or ")"
 */
import type { CollectionField } from './index'

// ---------------------------------------------------------------------------
// limits and public types
// ---------------------------------------------------------------------------

export const FORMULA_LIMITS = {
  /** characters of an expression */
  expression: 2000,
  /** AST nodes of one formula */
  nodes: 300,
  /** nesting depth (parentheses, calls, unary chains) */
  depth: 40,
  /** characters of any string value produced while evaluating */
  string: 10_000,
  /** arguments of one call (concat, min, max, and, or) */
  args: 50,
} as const

export const FORMULA_FUNCTIONS = [
  'if',
  'and',
  'or',
  'not',
  'concat',
  'length',
  'round',
  'min',
  'max',
  'abs',
  'now',
  'dateAdd',
  'dateBetween',
  'prop',
] as const
export type FormulaFunction = (typeof FORMULA_FUNCTIONS)[number]

/** Units of dateAdd / dateBetween (singular forms are accepted too). */
export const FORMULA_DATE_UNITS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes'] as const
export type FormulaDateUnit = (typeof FORMULA_DATE_UNITS)[number]

/** Short error codes shown in a cell (the web localizes them; agents see `#error(code)`). */
export type FormulaErrorCode =
  | 'syntax'
  | 'unknownProp'
  | 'ambiguousProp'
  | 'unknownFunction'
  | 'args'
  | 'cycle'
  | 'type'
  | 'divZero'
  | 'tooLong'
  | 'tooComplex'
  | 'badDate'
  | 'badUnit'

export type FormulaResultType = 'number' | 'text' | 'boolean' | 'date'

/** What a formula cell holds in a row DTO (errors are null; see FormulaRowResult.errors). */
export type FormulaValue = number | string | boolean | null

export class FormulaError extends Error {
  constructor(
    public readonly code: FormulaErrorCode,
    message: string,
    public readonly pos = 0,
  ) {
    super(message)
    this.name = 'FormulaError'
  }
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: 'num'; v: number; pos: number; end: number }
  | { t: 'str'; v: string; pos: number; end: number }
  | { t: 'name'; v: string; pos: number; end: number }
  | { t: 'op'; v: string; pos: number; end: number }
  | { t: '(' | ')' | ','; pos: number; end: number }

const OPS = ['==', '!=', '<>', '<=', '>=', '&&', '||', '<', '>', '=', '+', '-', '*', '/', '%', '!']

function tokenize(src: string): Tok[] {
  if (src.length > FORMULA_LIMITS.expression) {
    throw new FormulaError('tooLong', `A formula has at most ${FORMULA_LIMITS.expression} characters`)
  }
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c, pos: i, end: i + 1 })
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '“' || c === '”') {
      const close = c === '“' ? '”' : c
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== close && !(close === '”' && src[j] === '"')) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1]
          v += n === 'n' ? '\n' : n === 't' ? '\t' : n
          j += 2
          continue
        }
        v += src[j]
        j++
      }
      if (j >= src.length) throw new FormulaError('syntax', 'Unclosed string', i)
      out.push({ t: 'str', v, pos: i, end: j + 1 })
      i = j + 1
      continue
    }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64))
      const s = m ? m[0] : c
      const v = Number(s)
      if (!Number.isFinite(v)) throw new FormulaError('syntax', `Bad number "${s}"`, i)
      out.push({ t: 'num', v, pos: i, end: i + s.length })
      i += s.length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      out.push({ t: 'name', v: src.slice(i, j), pos: i, end: j })
      i = j
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (op) {
      out.push({ t: 'op', v: op, pos: i, end: i + op.length })
      i += op.length
      continue
    }
    throw new FormulaError('syntax', `Unexpected "${c}"`, i)
  }
  return out
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export type FormulaNode =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'prop'; name: string; pos: number }
  | { k: 'call'; fn: Exclude<FormulaFunction, 'prop'>; args: FormulaNode[]; pos: number }
  | { k: 'unary'; op: '-' | 'not'; e: FormulaNode }
  | { k: 'bin'; op: BinOp; a: FormulaNode; b: FormulaNode; pos: number }

type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or'

const FN_LOWER = new Map<string, FormulaFunction>(FORMULA_FUNCTIONS.map((f) => [f.toLowerCase(), f]))

/** Fixed arity per function: [min, max]. */
const ARITY: Record<Exclude<FormulaFunction, 'prop'>, [number, number]> = {
  if: [3, 3],
  and: [1, FORMULA_LIMITS.args],
  or: [1, FORMULA_LIMITS.args],
  not: [1, 1],
  concat: [1, FORMULA_LIMITS.args],
  length: [1, 1],
  round: [1, 2],
  min: [1, FORMULA_LIMITS.args],
  max: [1, FORMULA_LIMITS.args],
  abs: [1, 1],
  now: [0, 0],
  dateAdd: [3, 3],
  dateBetween: [3, 3],
}

export interface ParsedFormula {
  ast: FormulaNode
  /** prop("…") names in order of appearance (deduplicated) */
  props: string[]
  nodes: number
}

/** Parse an expression; throws FormulaError (code 'syntax', 'unknownFunction', 'args', 'tooLong', 'tooComplex'). */
export function parseFormula(src: string): ParsedFormula {
  const toks = tokenize(src)
  let i = 0
  let nodes = 0
  let depth = 0
  const props: string[] = []
  const peek = () => toks[i]
  const fail = (msg: string, t?: Tok): never => {
    throw new FormulaError('syntax', msg, t?.pos ?? src.length)
  }
  const node = <T extends FormulaNode>(n: T): T => {
    if (++nodes > FORMULA_LIMITS.nodes) throw new FormulaError('tooComplex', `A formula has at most ${FORMULA_LIMITS.nodes} parts`)
    return n
  }
  const enter = () => {
    if (++depth > FORMULA_LIMITS.depth) throw new FormulaError('tooComplex', `A formula nests at most ${FORMULA_LIMITS.depth} levels`)
  }
  const isOp = (t: Tok | undefined, ...vs: string[]) => !!t && t.t === 'op' && vs.includes(t.v)
  // prefix word (not): a following "(" makes it a call; infix words (and / or) never are calls
  const isWord = (t: Tok | undefined, w: string) => !!t && t.t === 'name' && t.v.toLowerCase() === w && toks[i + 1]?.t !== '('
  const isInfix = (t: Tok | undefined, w: string) => !!t && t.t === 'name' && t.v.toLowerCase() === w

  const parseOr = (): FormulaNode => {
    let a = parseAnd()
    while (isOp(peek(), '||') || isInfix(peek(), 'or')) {
      const t = toks[i++]
      a = node({ k: 'bin', op: 'or', a, b: parseAnd(), pos: t.pos })
    }
    return a
  }
  const parseAnd = (): FormulaNode => {
    let a = parseNot()
    while (isOp(peek(), '&&') || isInfix(peek(), 'and')) {
      const t = toks[i++]
      a = node({ k: 'bin', op: 'and', a, b: parseNot(), pos: t.pos })
    }
    return a
  }
  const parseNot = (): FormulaNode => {
    if (isOp(peek(), '!') || isWord(peek(), 'not')) {
      i++
      enter()
      const e = parseNot()
      depth--
      return node({ k: 'unary', op: 'not', e })
    }
    return parseCmp()
  }
  const parseCmp = (): FormulaNode => {
    const a = parseAdd()
    const t = peek()
    if (isOp(t, '==', '=', '!=', '<>', '<', '<=', '>', '>=')) {
      i++
      const v = (t as { v: string }).v
      const op: BinOp = v === '=' || v === '==' ? '==' : v === '<>' || v === '!=' ? '!=' : (v as BinOp)
      const b = parseAdd()
      if (isOp(peek(), '==', '=', '!=', '<>', '<', '<=', '>', '>=')) fail('Use and / or to join comparisons', peek())
      return node({ k: 'bin', op, a, b, pos: t!.pos })
    }
    return a
  }
  const parseAdd = (): FormulaNode => {
    let a = parseMul()
    while (isOp(peek(), '+', '-')) {
      const t = toks[i++] as { v: string; pos: number }
      a = node({ k: 'bin', op: t.v as BinOp, a, b: parseMul(), pos: t.pos })
    }
    return a
  }
  const parseMul = (): FormulaNode => {
    let a = parseUnary()
    while (isOp(peek(), '*', '/', '%')) {
      const t = toks[i++] as { v: string; pos: number }
      a = node({ k: 'bin', op: t.v as BinOp, a, b: parseUnary(), pos: t.pos })
    }
    return a
  }
  const parseUnary = (): FormulaNode => {
    if (isOp(peek(), '-')) {
      i++
      enter()
      const e = parseUnary()
      depth--
      return node({ k: 'unary', op: '-', e })
    }
    if (isOp(peek(), '+')) {
      i++
      return parseUnary()
    }
    return parsePrimary()
  }
  const parsePrimary = (): FormulaNode => {
    const t = peek()
    if (!t) return fail('The formula ends too early')
    if (t.t === 'num') {
      i++
      return node({ k: 'num', v: t.v })
    }
    if (t.t === 'str') {
      i++
      return node({ k: 'str', v: t.v })
    }
    if (t.t === '(') {
      i++
      enter()
      const e = parseOr()
      depth--
      if (peek()?.t !== ')') fail('Missing )', peek())
      i++
      return e
    }
    if (t.t === 'name') {
      const lower = t.v.toLowerCase()
      if (toks[i + 1]?.t !== '(') {
        if (lower === 'true' || lower === 'false') {
          i++
          return node({ k: 'bool', v: lower === 'true' })
        }
        return fail(`Unknown name "${t.v}"; properties are read with prop("Name")`, t)
      }
      const fn = FN_LOWER.get(lower)
      if (!fn) throw new FormulaError('unknownFunction', `Unknown function "${t.v}"`, t.pos)
      i += 2
      enter()
      const args: FormulaNode[] = []
      if (peek()?.t !== ')') {
        for (;;) {
          args.push(parseOr())
          if (args.length > FORMULA_LIMITS.args) throw new FormulaError('args', `${fn}() takes at most ${FORMULA_LIMITS.args} arguments`, t.pos)
          if (peek()?.t === ',') {
            i++
            continue
          }
          break
        }
      }
      if (peek()?.t !== ')') fail(`Missing ) after the arguments of ${fn}()`, peek())
      i++
      depth--
      if (fn === 'prop') {
        const a = args[0]
        if (args.length !== 1 || a.k !== 'str') {
          throw new FormulaError('args', 'prop() takes one property name in quotes, e.g. prop("Status")', t.pos)
        }
        if (!props.includes(a.v)) props.push(a.v)
        nodes-- // the string literal and the call count as one part
        return node({ k: 'prop', name: a.v, pos: t.pos })
      }
      const [lo, hi] = ARITY[fn]
      if (args.length < lo || args.length > hi) {
        const want = lo === hi ? `${lo}` : hi >= FORMULA_LIMITS.args ? `at least ${lo}` : `${lo} or ${hi}`
        throw new FormulaError('args', `${fn}() takes ${want} argument${lo === 1 && hi === 1 ? '' : 's'}`, t.pos)
      }
      return node({ k: 'call', fn, args, pos: t.pos })
    }
    return fail(`Unexpected "${t.t === 'op' ? t.v : t.t}"`, t)
  }

  if (toks.length === 0) throw new FormulaError('syntax', 'The formula is empty')
  const ast = parseOr()
  if (i < toks.length) {
    const t = toks[i]
    fail(t.t === ')' ? 'Unbalanced )' : `Unexpected "${t.t === 'op' || t.t === 'name' ? t.v : t.t === 'num' ? t.v : t.t === 'str' ? t.v : t.t}"`, t)
  }
  return { ast, props, nodes }
}

// ---------------------------------------------------------------------------
// property names (prop("…") → field), renames
// ---------------------------------------------------------------------------

/** The row title, readable as prop("Title") unless a property has that name. */
export const FORMULA_TITLE_PROP = 'title'

/**
 * Field id for a prop("…") name: exact name first, then case-insensitive; 'title' for "Title" when
 * no property is called that. Throws unknownProp / ambiguousProp.
 */
export function resolveFormulaProp(fields: Pick<CollectionField, 'id' | 'name'>[], name: string): string {
  const exact = fields.filter((f) => f.name === name)
  if (exact.length === 1) return exact[0].id
  if (exact.length > 1) throw new FormulaError('ambiguousProp', `Several properties are called "${name}"; rename one`)
  const lower = name.trim().toLowerCase()
  const loose = fields.filter((f) => f.name.trim().toLowerCase() === lower)
  if (loose.length === 1) return loose[0].id
  if (loose.length > 1) throw new FormulaError('ambiguousProp', `Several properties are called "${name}"; rename one`)
  if (lower === 'title') return FORMULA_TITLE_PROP
  throw new FormulaError('unknownProp', `No property "${name}"`)
}

/**
 * Rewrite prop("…") names after properties were renamed: each name is resolved against the old
 * field list and replaced by the new name of the same field id. Everything else in the text (spacing,
 * other strings) is kept. Names that did not resolve stay as written.
 */
export function renameFormulaProps(
  src: string,
  oldFields: Pick<CollectionField, 'id' | 'name'>[],
  newFields: Pick<CollectionField, 'id' | 'name'>[],
): string {
  let toks: Tok[]
  try {
    toks = tokenize(src)
  } catch {
    return src
  }
  const newName = new Map(newFields.map((f) => [f.id, f.name]))
  let out = ''
  let last = 0
  for (let i = 0; i + 3 < toks.length + 1; i++) {
    const a = toks[i]
    const b = toks[i + 1]
    const c = toks[i + 2]
    const d = toks[i + 3]
    if (a?.t !== 'name' || a.v.toLowerCase() !== 'prop' || b?.t !== '(' || c?.t !== 'str' || d?.t !== ')') continue
    let id: string
    try {
      id = resolveFormulaProp(oldFields, c.v)
    } catch {
      continue
    }
    const next = newName.get(id)
    if (next === undefined || next === c.v) continue
    out += src.slice(last, c.pos) + JSON.stringify(next)
    last = c.end
  }
  return last === 0 ? src : out + src.slice(last)
}

// ---------------------------------------------------------------------------
// compiling a collection's formulas (dependencies, cycles, order)
// ---------------------------------------------------------------------------

type ResolvedNode =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'prop'; id: string }
  | { k: 'call'; fn: Exclude<FormulaFunction, 'prop'>; args: ResolvedNode[] }
  | { k: 'unary'; op: '-' | 'not'; e: ResolvedNode }
  | { k: 'bin'; op: BinOp; a: ResolvedNode; b: ResolvedNode }

export interface CompiledFormula {
  fieldId: string
  /** null when the formula cannot be evaluated (see error) */
  ast: ResolvedNode | null
  /** field ids read through prop() */
  deps: string[]
  error: FormulaError | null
}

export interface CompiledFormulas {
  /** formulas in evaluation order (dependencies first); broken ones included (they yield errors) */
  list: CompiledFormula[]
  byId: Map<string, CompiledFormula>
  fields: Map<string, CollectionField>
}

function resolveNode(n: FormulaNode, fields: CollectionField[], deps: Set<string>): ResolvedNode {
  switch (n.k) {
    case 'num':
    case 'str':
    case 'bool':
      return n
    case 'prop': {
      const id = resolveFormulaProp(fields, n.name)
      deps.add(id)
      return { k: 'prop', id }
    }
    case 'call':
      return { k: 'call', fn: n.fn, args: n.args.map((a) => resolveNode(a, fields, deps)) }
    case 'unary':
      return { k: 'unary', op: n.op, e: resolveNode(n.e, fields, deps) }
    case 'bin':
      return { k: 'bin', op: n.op, a: resolveNode(n.a, fields, deps), b: resolveNode(n.b, fields, deps) }
  }
}

/** Formula fields of a list (with an expression). */
export function formulaFields(fields: CollectionField[]): CollectionField[] {
  return fields.filter((f) => f.type === 'formula')
}

/**
 * Parse and resolve every formula of a collection once (per request), detect cycles and order them
 * so a formula reading another formula is evaluated after it. A formula on a cycle, or reading one
 * that is broken, gets an error instead of an AST.
 */
export function compileFormulas(fields: CollectionField[]): CompiledFormulas {
  const list: CompiledFormula[] = []
  const byId = new Map<string, CompiledFormula>()
  for (const f of formulaFields(fields)) {
    const deps = new Set<string>()
    let c: CompiledFormula
    try {
      const parsed = parseFormula(f.formula?.expression ?? '')
      const ast = resolveNode(parsed.ast, fields, deps)
      c = { fieldId: f.id, ast, deps: [...deps], error: null }
    } catch (err) {
      const e = err instanceof FormulaError ? err : new FormulaError('syntax', String(err))
      c = { fieldId: f.id, ast: null, deps: [...deps], error: e }
    }
    byId.set(f.id, c)
  }
  // depth-first topological order; grey = on the current path → cycle
  const state = new Map<string, 'grey' | 'black'>()
  const visit = (id: string, path: string[]): void => {
    const c = byId.get(id)
    if (!c) return
    const s = state.get(id)
    if (s === 'black') return
    if (s === 'grey') {
      const from = path.indexOf(id)
      for (const x of path.slice(from)) {
        const cx = byId.get(x)!
        if (!cx.error || cx.error.code !== 'cycle') {
          cx.error = new FormulaError('cycle', 'This formula refers to itself through other formulas')
          cx.ast = null
        }
      }
      return
    }
    state.set(id, 'grey')
    for (const d of c.deps) visit(d, [...path, id])
    state.set(id, 'black')
    list.push(c)
  }
  for (const id of byId.keys()) visit(id, [])
  return { list, byId, fields: new Map(fields.map((f) => [f.id, f])) }
}

/** Static check for one formula against the collection's fields (used when fields are saved). */
export function checkFormula(fields: CollectionField[], fieldId: string): FormulaError | null {
  return compileFormulas(fields).byId.get(fieldId)?.error ?? null
}

// ---------------------------------------------------------------------------
// static result type
// ---------------------------------------------------------------------------

const ROLLUP_NUMBER = new Set(['count', 'sum', 'avg', 'min', 'max', 'percentChecked'])

function fieldResultType(f: CollectionField | undefined, compiled: CompiledFormulas, seen: Set<string>): FormulaResultType | null {
  if (!f) return 'text'
  switch (f.type) {
    case 'number':
      return 'number'
    case 'checkbox':
      return 'boolean'
    case 'date':
      return 'date'
    case 'rollup':
      if (!f.rollup) return null
      if (ROLLUP_NUMBER.has(f.rollup.fn)) return 'number'
      if (f.rollup.fn === 'earliest' || f.rollup.fn === 'latest') return 'date'
      return 'text'
    case 'formula': {
      const c = compiled.byId.get(f.id)
      if (!c?.ast || seen.has(f.id)) return null
      seen.add(f.id)
      return nodeType(c.ast, compiled, seen)
    }
    default:
      return 'text'
  }
}

function nodeType(n: ResolvedNode, compiled: CompiledFormulas, seen: Set<string>): FormulaResultType | null {
  switch (n.k) {
    case 'num':
      return 'number'
    case 'str':
      return 'text'
    case 'bool':
      return 'boolean'
    case 'prop':
      return n.id === FORMULA_TITLE_PROP && !compiled.fields.has(n.id) ? 'text' : fieldResultType(compiled.fields.get(n.id), compiled, new Set(seen))
    case 'unary':
      return n.op === '-' ? 'number' : 'boolean'
    case 'bin':
      if (n.op === '+') {
        const a = nodeType(n.a, compiled, seen)
        const b = nodeType(n.b, compiled, seen)
        return a === 'text' || b === 'text' ? 'text' : 'number'
      }
      return ['-', '*', '/', '%'].includes(n.op) ? 'number' : 'boolean'
    case 'call':
      switch (n.fn) {
        case 'if': {
          const a = nodeType(n.args[1], compiled, seen)
          const b = nodeType(n.args[2], compiled, seen)
          return a === b ? a : a === null ? b : b === null ? a : 'text'
        }
        case 'and':
        case 'or':
        case 'not':
          return 'boolean'
        case 'concat':
          return 'text'
        case 'now':
        case 'dateAdd':
          return 'date'
        default:
          return 'number'
      }
  }
}

/** What a formula field yields (for filter operators, sorting, chart measures); text when unclear. */
export function formulaResultType(fields: CollectionField[], fieldId: string, compiled = compileFormulas(fields)): FormulaResultType {
  const c = compiled.byId.get(fieldId)
  if (!c?.ast) return 'text'
  return nodeType(c.ast, compiled, new Set([fieldId])) ?? 'text'
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

/** A date inside the evaluator: epoch ms (UTC) and whether it carries a time of day. */
interface DateVal {
  d: number
  time: boolean
}
type V = number | string | boolean | null | DateVal

const isDate = (v: V): v is DateVal => typeof v === 'object' && v !== null
const DAY = 86_400_000

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** Parse a stored date (`YYYY-MM-DD`, optionally with a time, offset or Z). Null for anything else. */
export function parseFormulaDate(s: string): { d: number; time: boolean } | null {
  const m = DATE_RE.exec(s.trim())
  if (!m) return null
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null
  let t = Date.UTC(y, mo - 1, da)
  if (new Date(t).getUTCDate() !== da) return null
  if (m[4] === undefined) return { d: t, time: false }
  const [h, mi, se] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (h > 23 || mi > 59 || se > 59) return null
  t += ((h * 60 + mi) * 60 + se) * 1000
  const z = m[7]
  if (z && z !== 'Z') {
    const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(z)!
    const off = (Number(zm[2]) * 60 + Number(zm[3])) * 60_000
    t -= zm[1] === '+' ? off : -off
  }
  return { d: t, time: true }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Output form of a date: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mmZ` with a time (UTC). */
export function formatFormulaDate(v: { d: number; time: boolean }): string {
  const x = new Date(v.d)
  const day = `${pad(x.getUTCFullYear(), 4)}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`
  return v.time ? `${day}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}Z` : day
}

/** Number display without float noise (also used for concat). */
export function formatFormulaNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(Math.round(n * 1e10) / 1e10)
}

function toText(v: V): string {
  if (v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return formatFormulaNumber(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return formatFormulaDate(v)
}

function truthy(v: V): boolean {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  return true
}

const typeErr = (msg: string) => new FormulaError('type', msg)

function toNum(v: V, what: string): number | null {
  if (v === null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return null
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  throw typeErr(`${what} needs a number`)
}

function toDate(v: V, what: string): DateVal | null {
  if (v === null || v === '') return null
  if (isDate(v)) return v
  if (typeof v === 'string') {
    const d = parseFormulaDate(v)
    if (d) return d
    throw new FormulaError('badDate', `${what}: "${v.slice(0, 40)}" is not a date (YYYY-MM-DD)`)
  }
  throw typeErr(`${what} needs a date`)
}

function checkLen(s: string): string {
  if (s.length > FORMULA_LIMITS.string) throw new FormulaError('tooLong', `Text longer than ${FORMULA_LIMITS.string} characters`)
  return s
}

function finite(n: number): number {
  if (!Number.isFinite(n)) throw typeErr('The result is not a finite number')
  return n
}

function unitOf(v: V): FormulaDateUnit {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  const u = (s.endsWith('s') ? s : `${s}s`) as FormulaDateUnit
  if (!FORMULA_DATE_UNITS.includes(u)) throw new FormulaError('badUnit', `Unit must be one of ${FORMULA_DATE_UNITS.join(', ')}`)
  return u
}

const MAX_DATE_MS = 8_640_000_000_000_000

function addMonths(ms: number, months: number): number {
  const x = new Date(ms)
  const y = x.getUTCFullYear()
  const m = x.getUTCMonth() + months
  const ty = y + Math.floor(m / 12)
  const tm = ((m % 12) + 12) % 12
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  const day = Math.min(x.getUTCDate(), last)
  const rest = ms - Date.UTC(y, x.getUTCMonth(), x.getUTCDate())
  return Date.UTC(ty, tm, day) + rest
}

function dateAdd(d: DateVal, n: number, unit: FormulaDateUnit): DateVal {
  if (!Number.isFinite(n) || Math.abs(n) > 1e7) throw new FormulaError('badDate', 'dateAdd amount is out of range')
  const k = Math.trunc(n)
  let out: number
  let time = d.time
  switch (unit) {
    case 'years':
      out = addMonths(d.d, k * 12)
      break
    case 'months':
      out = addMonths(d.d, k)
      break
    case 'weeks':
      out = d.d + k * 7 * DAY
      break
    case 'days':
      out = d.d + k * DAY
      break
    case 'hours':
      out = d.d + k * 3_600_000
      time = true
      break
    case 'minutes':
      out = d.d + k * 60_000
      time = true
      break
  }
  if (!Number.isFinite(out) || Math.abs(out) > MAX_DATE_MS) throw new FormulaError('badDate', 'The date is out of range')
  return { d: out, time }
}

/** a − b in whole units, truncated toward zero (months/years by the calendar). */
function dateBetween(a: DateVal, b: DateVal, unit: FormulaDateUnit): number {
  const diff = a.d - b.d
  switch (unit) {
    case 'minutes':
      return Math.trunc(diff / 60_000)
    case 'hours':
      return Math.trunc(diff / 3_600_000)
    case 'days':
      return Math.trunc(diff / DAY)
    case 'weeks':
      return Math.trunc(diff / (7 * DAY))
    case 'months':
    case 'years': {
      const sign = diff < 0 ? -1 : 1
      const [hi, lo] = sign > 0 ? [a.d, b.d] : [b.d, a.d]
      const x = new Date(hi)
      const y = new Date(lo)
      let months = (x.getUTCFullYear() - y.getUTCFullYear()) * 12 + (x.getUTCMonth() - y.getUTCMonth())
      if (addMonths(lo, months) > hi) months--
      const r = unit === 'years' ? Math.trunc(months / 12) : months
      return r === 0 ? 0 : sign * r
    }
  }
}

function compare(a: V, b: V, op: '<' | '<=' | '>' | '>='): boolean {
  if (a === null || b === null) return false
  let x: number | string
  let y: number | string
  if (isDate(a) || isDate(b)) {
    const da = toDate(a, 'Comparison')
    const db = toDate(b, 'Comparison')
    if (!da || !db) return false
    x = da.d
    y = db.d
  } else if (typeof a === 'number' || typeof b === 'number') {
    const na = toNum(a, 'Comparison')
    const nb = toNum(b, 'Comparison')
    if (na === null || nb === null) return false
    x = na
    y = nb
  } else if (typeof a === 'string' && typeof b === 'string') {
    x = a
    y = b
  } else {
    throw typeErr('Only numbers, text and dates can be ordered')
  }
  switch (op) {
    case '<':
      return x < y
    case '<=':
      return x <= y
    case '>':
      return x > y
    case '>=':
      return x >= y
  }
}

function equal(a: V, b: V): boolean {
  if (a === null || b === null) return (a === null || a === '') && (b === null || b === '')
  if (isDate(a) || isDate(b)) {
    try {
      const da = toDate(a, '=')
      const db = toDate(b, '=')
      return !!da && !!db && da.d === db.d
    } catch {
      return false
    }
  }
  if (typeof a === 'number' && typeof b === 'string') return b.trim() !== '' && Number(b) === a
  if (typeof b === 'number' && typeof a === 'string') return a.trim() !== '' && Number(a) === b
  return a === b
}

export interface FormulaContext {
  /** "now" for the whole request / render, so every row sees the same instant */
  now: Date
}

interface RowInput {
  title: string
  props: Record<string, unknown>
}

/** A stored property value as a formula value. */
function fromProp(f: CollectionField | undefined, raw: unknown): V {
  if (raw === undefined || raw === null) return f?.type === 'checkbox' ? false : null
  if (!f) return typeof raw === 'string' ? raw : null
  switch (f.type) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    case 'checkbox':
      return raw === true
    case 'date': {
      const s = typeof raw === 'string' ? raw : typeof raw === 'object' && typeof (raw as { start?: unknown }).start === 'string' ? (raw as { start: string }).start : null
      if (!s) return null
      return parseFormulaDate(s)
    }
    case 'select':
      return f.options?.find((o) => o.id === raw)?.name ?? null
    case 'multiSelect':
      if (!Array.isArray(raw)) return null
      return raw
        .map((id) => f.options?.find((o) => o.id === id)?.name)
        .filter((n): n is string => !!n)
        .join(', ')
    case 'rollup':
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
      if (Array.isArray(raw)) return raw.map(String).join(', ')
      if (typeof raw === 'string') {
        if (f.rollup?.fn === 'earliest' || f.rollup?.fn === 'latest') return parseFormulaDate(raw) ?? raw
        return raw
      }
      return null
    case 'formula':
      // another formula is read from the evaluator's own results, never from stored props
      return null
    // person and relation cells are ids: a formula does not read them (names would differ between
    // viewers and are not known to the evaluator) — docs/adr/1824-*
    case 'person':
    case 'relation':
      return null
    default:
      return typeof raw === 'string' ? raw : typeof raw === 'number' ? raw : null
  }
}

function evalNode(n: ResolvedNode, get: (id: string) => V, ctx: FormulaContext): V {
  switch (n.k) {
    case 'num':
      return n.v
    case 'str':
      return n.v
    case 'bool':
      return n.v
    case 'prop':
      return get(n.id)
    case 'unary': {
      const v = evalNode(n.e, get, ctx)
      if (n.op === 'not') return !truthy(v)
      const x = toNum(v, 'Minus')
      return x === null ? null : finite(-x)
    }
    case 'bin': {
      if (n.op === 'and') return truthy(evalNode(n.a, get, ctx)) && truthy(evalNode(n.b, get, ctx))
      if (n.op === 'or') return truthy(evalNode(n.a, get, ctx)) || truthy(evalNode(n.b, get, ctx))
      const a = evalNode(n.a, get, ctx)
      const b = evalNode(n.b, get, ctx)
      switch (n.op) {
        case '==':
          return equal(a, b)
        case '!=':
          return !equal(a, b)
        case '<':
        case '<=':
        case '>':
        case '>=':
          return compare(a, b, n.op)
        case '+': {
          if (typeof a === 'string' || typeof b === 'string') return checkLen(toText(a) + toText(b))
          if (isDate(a) || isDate(b)) throw typeErr('Add to a date with dateAdd()')
          const x = toNum(a, '+')
          const y = toNum(b, '+')
          if (x === null && y === null) return null
          return finite((x ?? 0) + (y ?? 0))
        }
        default: {
          if (isDate(a) || isDate(b)) throw typeErr(`Dates cannot be used with ${n.op}; use dateBetween() / dateAdd()`)
          const x = toNum(a, n.op)
          const y = toNum(b, n.op)
          if (n.op === '-') {
            if (x === null && y === null) return null
            return finite((x ?? 0) - (y ?? 0))
          }
          if (x === null || y === null) return null
          if (n.op === '*') return finite(x * y)
          if (y === 0) throw new FormulaError('divZero', 'Division by zero')
          return finite(n.op === '/' ? x / y : x % y)
        }
      }
    }
    case 'call': {
      const arg = (i: number) => evalNode(n.args[i], get, ctx)
      switch (n.fn) {
        case 'if':
          return truthy(arg(0)) ? arg(1) : arg(2)
        case 'and':
          return n.args.every((_, i) => truthy(arg(i)))
        case 'or':
          return n.args.some((_, i) => truthy(arg(i)))
        case 'not':
          return !truthy(arg(0))
        case 'concat': {
          let s = ''
          for (let i = 0; i < n.args.length; i++) s = checkLen(s + toText(arg(i)))
          return s
        }
        case 'length': {
          const v = arg(0)
          return v === null ? 0 : Array.from(toText(v)).length
        }
        case 'round': {
          const x = toNum(arg(0), 'round()')
          const p = n.args.length > 1 ? toNum(arg(1), 'round() digits') ?? 0 : 0
          if (x === null) return null
          const digits = Math.max(0, Math.min(10, Math.trunc(p)))
          const f = 10 ** digits
          return finite(Math.round(x * f) / f)
        }
        case 'min':
        case 'max': {
          let best: number | null = null
          for (let i = 0; i < n.args.length; i++) {
            const x = toNum(arg(i), `${n.fn}()`)
            if (x === null) continue
            if (best === null || (n.fn === 'min' ? x < best : x > best)) best = x
          }
          return best
        }
        case 'abs': {
          const x = toNum(arg(0), 'abs()')
          return x === null ? null : Math.abs(x)
        }
        case 'now':
          return { d: ctx.now.getTime(), time: true }
        case 'dateAdd': {
          const d = toDate(arg(0), 'dateAdd()')
          const k = toNum(arg(1), 'dateAdd() amount')
          const u = unitOf(arg(2))
          if (!d || k === null) return null
          return dateAdd(d, k, u)
        }
        case 'dateBetween': {
          const a = toDate(arg(0), 'dateBetween()')
          const b = toDate(arg(1), 'dateBetween()')
          const u = unitOf(arg(2))
          if (!a || !b) return null
          return dateBetween(a, b, u)
        }
      }
    }
  }
}

export interface FormulaRowResult {
  /** value per formula field id (null on error) */
  values: Record<string, FormulaValue>
  /** error code per formula field id that failed */
  errors: Record<string, FormulaErrorCode>
}

function outValue(v: V): FormulaValue {
  if (isDate(v)) return formatFormulaDate(v)
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return v
}

/**
 * Evaluate every formula of one row. Formulas read stored properties, rollups already computed into
 * `props` and other formulas (evaluated first). Errors stay local to the formula that failed and the
 * formulas that read it.
 */
export function evaluateRowFormulas(compiled: CompiledFormulas, row: RowInput, ctx: FormulaContext): FormulaRowResult {
  const values: Record<string, FormulaValue> = {}
  const errors: Record<string, FormulaErrorCode> = {}
  const inner = new Map<string, V>()
  const get = (id: string): V => {
    if (inner.has(id)) return inner.get(id)!
    const f = compiled.fields.get(id)
    if (!f && id === FORMULA_TITLE_PROP) return row.title
    if (f?.type === 'formula') {
      if (errors[id]) throw new FormulaError(errors[id], 'A formula this one reads has an error')
      return null
    }
    return fromProp(f, row.props[id])
  }
  for (const c of compiled.list) {
    if (!c.ast) {
      errors[c.fieldId] = c.error?.code ?? 'syntax'
      values[c.fieldId] = null
      continue
    }
    try {
      const v = evalNode(c.ast, get, ctx)
      if (typeof v === 'string') checkLen(v)
      inner.set(c.fieldId, v)
      values[c.fieldId] = outValue(v)
    } catch (err) {
      errors[c.fieldId] = err instanceof FormulaError ? err.code : 'type'
      values[c.fieldId] = null
    }
  }
  return { values, errors }
}

/**
 * Compute formula values into the rows' props, in place (server read paths, the web after an edit).
 * Returns the error codes by row id (only rows with an error are listed).
 */
export function applyFormulas(
  fields: CollectionField[],
  rows: { id: string; title: string; props: Record<string, unknown> }[],
  ctx: FormulaContext,
  compiled?: CompiledFormulas,
): Map<string, Record<string, FormulaErrorCode>> {
  const errs = new Map<string, Record<string, FormulaErrorCode>>()
  const c = compiled ?? compileFormulas(fields)
  if (c.list.length === 0) return errs
  for (const r of rows) {
    const res = evaluateRowFormulas(c, r, ctx)
    for (const [k, v] of Object.entries(res.values)) r.props[k] = v
    if (Object.keys(res.errors).length) errs.set(r.id, res.errors)
  }
  return errs
}

/** Agent / plain-text form of an error cell. */
export function formulaErrorText(code: FormulaErrorCode): string {
  return `#error(${code})`
}

/**
 * The web keeps a formula's error in the row's props as this marker (the server sends null and the
 * error separately), so a cell can show it; filters, sorts and exports read it as empty.
 */
export interface FormulaErrorCell {
  formulaError: FormulaErrorCode
}

export function isFormulaErrorCell(v: unknown): v is FormulaErrorCell {
  return typeof v === 'object' && v !== null && typeof (v as { formulaError?: unknown }).formulaError === 'string'
}
