/**
 * Dataview-style query language (subset) — tokenizer + hand-written recursive-descent parser.
 *
 * Shared by the web editor (instant syntax errors inside the Query block) and the server
 * (which compiles the AST into parameterized SQL). No regular expression is ever applied to
 * the whole input: the tokenizer walks characters one at a time, so there is no backtracking
 * and no ReDoS surface. Input length, token count and AST depth are capped.
 *
 * Grammar (keywords are case-insensitive):
 *
 *   query   := head [FROM source] { WHERE expr | SORT sortItem {, sortItem} | LIMIT number }
 *   head    := TABLE [WITHOUT ID] [column {, column}] | LIST [expr] | TASK
 *   column  := expr [AS (identifier | string)]
 *   source  := sAnd { OR sAnd }
 *   sAnd    := sUnary { AND sUnary }
 *   sUnary  := (- | NOT) sUnary | ( source ) | #tag | "Folder/Path" | [[Page title]]
 *   expr    := and { (OR | ||) and }
 *   and     := not { (AND | &&) not }
 *   not     := (NOT | !) not | cmp
 *   cmp     := primary [ (= | == | != | < | <= | > | >=) primary ]
 *   primary := string | number | true | false | null | field | call | ( expr )
 *   field   := name { . name }          name = letters/digits/_/- or `back-ticked text`
 *   call    := date( today | tomorrow | yesterday | "YYYY-MM-DD" ) | contains( expr , expr )
 *   sortItem:= expr [ASC | DESC]
 */

export const QUERY_LIMITS = {
  /** Max characters in a query source. */
  maxLength: 2000,
  /** Max tokens produced by the tokenizer. */
  maxTokens: 400,
  /** Max nesting depth of expressions / sources. */
  maxDepth: 24,
  /** Max TABLE columns. */
  maxColumns: 20,
  /** Max SORT keys. */
  maxSort: 5,
  /** Hard cap for LIMIT (server also clamps). */
  maxRows: 500,
  /** Default row count when LIMIT is omitted. */
  defaultRows: 200,
} as const

/** Implicit page fields available as file.<name>. */
export const QUERY_FILE_FIELDS = [
  'name',
  'link',
  'ctime',
  'mtime',
  'cday',
  'mday',
  'tags',
  'folder',
  'path',
] as const

export type QueryType = 'TABLE' | 'LIST' | 'TASK'
export type CmpOp = '=' | '!=' | '<' | '<=' | '>' | '>='

export type QExpr =
  | { k: 'lit'; v: string | number | boolean | null; pos: number }
  | { k: 'date'; v: string; pos: number }
  | { k: 'field'; path: string[]; pos: number }
  | { k: 'contains'; a: QExpr; b: QExpr; pos: number }
  | { k: 'not'; e: QExpr; pos: number }
  | { k: 'and' | 'or'; a: QExpr; b: QExpr; pos: number }
  | { k: 'cmp'; op: CmpOp; a: QExpr; b: QExpr; pos: number }

export type QSource =
  | { k: 'tag'; tag: string; pos: number }
  | { k: 'folder'; path: string; pos: number }
  | { k: 'link'; title: string; pos: number }
  | { k: 'not'; s: QSource; pos: number }
  | { k: 'and' | 'or'; a: QSource; b: QSource; pos: number }

export interface QColumn {
  expr: QExpr
  label: string
}

export interface QSort {
  expr: QExpr
  dir: 'asc' | 'desc'
}

export interface QueryAst {
  type: QueryType
  withoutId: boolean
  columns: QColumn[]
  /** LIST <expr> — optional value shown after the page link */
  listExpr: QExpr | null
  from: QSource | null
  where: QExpr | null
  sort: QSort[]
  limit: number | null
}

export interface QueryErrorInfo {
  message: string
  /** 0-based offset into the source */
  pos: number
  /** 1-based line / column for display */
  line: number
  col: number
}

export class QuerySyntaxError extends Error {
  pos: number
  constructor(message: string, pos: number) {
    super(message)
    this.name = 'QuerySyntaxError'
    this.pos = pos
  }
}

/** Offset → 1-based line/column. */
export function queryErrorInfo(source: string, message: string, pos: number): QueryErrorInfo {
  const p = Math.max(0, Math.min(pos, source.length))
  let line = 1
  let col = 1
  for (let i = 0; i < p; i++) {
    if (source.charCodeAt(i) === 10) {
      line++
      col = 1
    } else {
      col++
    }
  }
  return { message, pos: p, line, col }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'ident' | 'string' | 'number' | 'tag' | 'link' | 'op' | 'punct' | 'eof'

interface Token {
  kind: TokKind
  /** ident/op/punct: raw text; string/link/tag: decoded value; number: digits */
  text: string
  pos: number
}

// Single-character class tests. Each regex is applied to exactly one character,
// so evaluation is O(1) and cannot backtrack.
const LETTER_RE = /[\p{L}\p{N}_]/u
const TAG_CHAR_RE = /[\p{L}\p{N}_/-]/u

function isIdentStart(ch: string): boolean {
  return LETTER_RE.test(ch)
}
function isIdentChar(ch: string): boolean {
  return LETTER_RE.test(ch) || ch === '-'
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const n = src.length
  const push = (t: Token) => {
    out.push(t)
    if (out.length > QUERY_LIMITS.maxTokens) {
      throw new QuerySyntaxError(`Query is too long (max ${QUERY_LIMITS.maxTokens} tokens)`, t.pos)
    }
  }
  while (i < n) {
    const ch = src[i]
    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    // line comment: // ... (Dataview allows comments in some contexts; harmless here)
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    const start = i
    // string literal "..." with \" and \\ escapes
    if (ch === '"') {
      i++
      let s = ''
      let closed = false
      while (i < n) {
        const c = src[i]
        if (c === '\\' && i + 1 < n) {
          s += src[i + 1]
          i += 2
          continue
        }
        if (c === '"') {
          closed = true
          i++
          break
        }
        if (c === '\n') break
        s += c
        i++
      }
      if (!closed) throw new QuerySyntaxError('Unterminated string', start)
      push({ kind: 'string', text: s, pos: start })
      continue
    }
    // back-ticked identifier `My field`
    if (ch === '`') {
      i++
      let s = ''
      while (i < n && src[i] !== '`' && src[i] !== '\n') s += src[i++]
      if (src[i] !== '`') throw new QuerySyntaxError('Unterminated `quoted name`', start)
      i++
      if (!s.trim()) throw new QuerySyntaxError('Empty `quoted name`', start)
      push({ kind: 'ident', text: s, pos: start })
      continue
    }
    // [[Page title]]
    if (ch === '[' && src[i + 1] === '[') {
      i += 2
      let s = ''
      while (i < n && !(src[i] === ']' && src[i + 1] === ']') && src[i] !== '\n') s += src[i++]
      if (!(src[i] === ']' && src[i + 1] === ']')) {
        throw new QuerySyntaxError('Unterminated [[link]]', start)
      }
      i += 2
      // [[Title|alias]] / [[Title#heading]] → page title only
      const bar = s.indexOf('|')
      if (bar >= 0) s = s.slice(0, bar)
      const hash = s.indexOf('#')
      if (hash >= 0) s = s.slice(0, hash)
      s = s.trim()
      if (!s) throw new QuerySyntaxError('Empty [[link]]', start)
      push({ kind: 'link', text: s, pos: start })
      continue
    }
    // #tag
    if (ch === '#') {
      i++
      let s = ''
      while (i < n && TAG_CHAR_RE.test(src[i])) s += src[i++]
      if (!s) throw new QuerySyntaxError('Expected a tag name after #', start)
      push({ kind: 'tag', text: s.slice(0, 80), pos: start })
      continue
    }
    // number (no sign — unary minus is not supported in expressions)
    if (isDigit(ch)) {
      let s = ''
      while (i < n && isDigit(src[i])) s += src[i++]
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        s += src[i++]
        while (i < n && isDigit(src[i])) s += src[i++]
      }
      if (s.length > 15) throw new QuerySyntaxError('Number is too long', start)
      push({ kind: 'number', text: s, pos: start })
      continue
    }
    // identifiers / keywords
    if (isIdentStart(ch)) {
      let s = ''
      while (i < n && isIdentChar(src[i])) s += src[i++]
      if (s.length > 100) throw new QuerySyntaxError('Name is too long', start)
      push({ kind: 'ident', text: s, pos: start })
      continue
    }
    // operators
    const two = src.slice(i, i + 2)
    if (two === '!=' || two === '<=' || two === '>=' || two === '==' || two === '&&' || two === '||') {
      i += 2
      push({ kind: 'op', text: two, pos: start })
      continue
    }
    if (ch === '=' || ch === '<' || ch === '>' || ch === '!' || ch === '-') {
      i++
      push({ kind: 'op', text: ch, pos: start })
      continue
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === '.') {
      i++
      push({ kind: 'punct', text: ch, pos: start })
      continue
    }
    throw new QuerySyntaxError(`Unexpected character '${ch}'`, start)
  }
  out.push({ kind: 'eof', text: '', pos: n })
  return out
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const CLAUSE_KEYWORDS = new Set(['FROM', 'WHERE', 'SORT', 'LIMIT'])
const RESERVED = new Set([
  'TABLE',
  'LIST',
  'TASK',
  'FROM',
  'WHERE',
  'SORT',
  'LIMIT',
  'AND',
  'OR',
  'NOT',
  'AS',
  'ASC',
  'DESC',
  'WITHOUT',
])

class Parser {
  private i = 0
  private depth = 0
  constructor(private toks: Token[]) {}

  private peek(off = 0): Token {
    return this.toks[Math.min(this.i + off, this.toks.length - 1)]
  }
  private next(): Token {
    const t = this.toks[this.i]
    if (this.i < this.toks.length - 1) this.i++
    return t
  }
  private isKw(t: Token, kw: string): boolean {
    return t.kind === 'ident' && t.text.toUpperCase() === kw
  }
  private acceptKw(kw: string): Token | null {
    const t = this.peek()
    if (this.isKw(t, kw)) return this.next()
    return null
  }
  private expectPunct(p: string, what: string): Token {
    const t = this.peek()
    if (t.kind === 'punct' && t.text === p) return this.next()
    throw new QuerySyntaxError(`Expected ${what}`, t.pos)
  }
  private enter(pos: number): void {
    if (++this.depth > QUERY_LIMITS.maxDepth) {
      throw new QuerySyntaxError('Query is nested too deeply', pos)
    }
  }
  private leave(): void {
    this.depth--
  }

  parseQuery(): QueryAst {
    const head = this.next()
    const kw = head.kind === 'ident' ? head.text.toUpperCase() : ''
    if (kw !== 'TABLE' && kw !== 'LIST' && kw !== 'TASK') {
      throw new QuerySyntaxError('Query must start with TABLE, LIST or TASK', head.pos)
    }
    const ast: QueryAst = {
      type: kw,
      withoutId: false,
      columns: [],
      listExpr: null,
      from: null,
      where: null,
      sort: [],
      limit: null,
    }

    if (kw === 'TABLE') {
      if (this.acceptKw('WITHOUT')) {
        const id = this.peek()
        if (!this.isKw(id, 'ID')) throw new QuerySyntaxError('Expected ID after WITHOUT', id.pos)
        this.next()
        ast.withoutId = true
      }
      if (!this.atClauseOrEnd()) {
        for (;;) {
          const startTok = this.peek()
          const expr = this.parseExpr()
          let label = exprLabel(expr)
          if (this.acceptKw('AS')) {
            const l = this.next()
            if (l.kind !== 'ident' && l.kind !== 'string') {
              throw new QuerySyntaxError('Expected a column name after AS', l.pos)
            }
            label = l.text
          }
          ast.columns.push({ expr, label })
          if (ast.columns.length > QUERY_LIMITS.maxColumns) {
            throw new QuerySyntaxError(`Too many columns (max ${QUERY_LIMITS.maxColumns})`, startTok.pos)
          }
          const t = this.peek()
          if (t.kind === 'punct' && t.text === ',') {
            this.next()
            continue
          }
          break
        }
      }
    } else if (kw === 'LIST') {
      if (!this.atClauseOrEnd()) ast.listExpr = this.parseExpr()
    }

    const seen = new Set<string>()
    while (this.peek().kind !== 'eof') {
      const t = this.peek()
      const clause = t.kind === 'ident' ? t.text.toUpperCase() : ''
      if (!CLAUSE_KEYWORDS.has(clause)) {
        throw new QuerySyntaxError(
          ast.type === 'TABLE' && ast.columns.length > 0
            ? `Unexpected '${t.text}' — expected ',' or FROM / WHERE / SORT / LIMIT`
            : `Unexpected '${t.text}' — expected FROM, WHERE, SORT or LIMIT`,
          t.pos,
        )
      }
      if (clause === 'FROM' && seen.size > 0) {
        throw new QuerySyntaxError('FROM must come before WHERE / SORT / LIMIT', t.pos)
      }
      if (seen.has(clause)) throw new QuerySyntaxError(`Duplicate ${clause} clause`, t.pos)
      seen.add(clause)
      this.next()
      if (clause === 'FROM') {
        ast.from = this.parseSource()
      } else if (clause === 'WHERE') {
        ast.where = this.parseExpr()
      } else if (clause === 'SORT') {
        for (;;) {
          const st = this.peek()
          const expr = this.parseExpr()
          let dir: 'asc' | 'desc' = 'asc'
          if (this.acceptKw('DESC') || this.acceptKw('DESCENDING')) dir = 'desc'
          else if (this.acceptKw('ASC') || this.acceptKw('ASCENDING')) dir = 'asc'
          ast.sort.push({ expr, dir })
          if (ast.sort.length > QUERY_LIMITS.maxSort) {
            throw new QuerySyntaxError(`Too many SORT keys (max ${QUERY_LIMITS.maxSort})`, st.pos)
          }
          const c = this.peek()
          if (c.kind === 'punct' && c.text === ',') {
            this.next()
            continue
          }
          break
        }
      } else if (clause === 'LIMIT') {
        const num = this.next()
        if (num.kind !== 'number' || num.text.includes('.')) {
          throw new QuerySyntaxError('LIMIT expects a whole number', num.pos)
        }
        const v = Number(num.text)
        if (v < 1) throw new QuerySyntaxError('LIMIT must be at least 1', num.pos)
        if (v > QUERY_LIMITS.maxRows) {
          throw new QuerySyntaxError(`LIMIT may not exceed ${QUERY_LIMITS.maxRows}`, num.pos)
        }
        ast.limit = v
      }
    }
    return ast
  }

  private atClauseOrEnd(): boolean {
    const t = this.peek()
    return t.kind === 'eof' || (t.kind === 'ident' && CLAUSE_KEYWORDS.has(t.text.toUpperCase()))
  }

  // ---- FROM sources -------------------------------------------------------

  private parseSource(): QSource {
    const start = this.peek()
    this.enter(start.pos)
    let left = this.parseSourceAnd()
    for (;;) {
      const t = this.peek()
      if (this.isKw(t, 'OR') || (t.kind === 'op' && t.text === '||')) {
        this.next()
        const right = this.parseSourceAnd()
        left = { k: 'or', a: left, b: right, pos: t.pos }
      } else break
    }
    this.leave()
    return left
  }

  private parseSourceAnd(): QSource {
    let left = this.parseSourceUnary()
    for (;;) {
      const t = this.peek()
      if (this.isKw(t, 'AND') || (t.kind === 'op' && t.text === '&&')) {
        this.next()
        const right = this.parseSourceUnary()
        left = { k: 'and', a: left, b: right, pos: t.pos }
      } else break
    }
    return left
  }

  private parseSourceUnary(): QSource {
    const t = this.peek()
    if ((t.kind === 'op' && (t.text === '-' || t.text === '!')) || this.isKw(t, 'NOT')) {
      this.next()
      this.enter(t.pos)
      const s = this.parseSourceUnary()
      this.leave()
      return { k: 'not', s, pos: t.pos }
    }
    if (t.kind === 'punct' && t.text === '(') {
      this.next()
      const s = this.parseSource()
      this.expectPunct(')', "')'")
      return s
    }
    if (t.kind === 'tag') {
      this.next()
      return { k: 'tag', tag: t.text, pos: t.pos }
    }
    if (t.kind === 'string') {
      this.next()
      const path = normalizeFolder(t.text)
      if (!path) throw new QuerySyntaxError('Folder path is empty', t.pos)
      return { k: 'folder', path, pos: t.pos }
    }
    if (t.kind === 'link') {
      this.next()
      return { k: 'link', title: t.text, pos: t.pos }
    }
    throw new QuerySyntaxError('Expected #tag, "Folder/Path" or [[Page]] after FROM', t.pos)
  }

  // ---- expressions --------------------------------------------------------

  parseExpr(): QExpr {
    const start = this.peek()
    this.enter(start.pos)
    let left = this.parseAnd()
    for (;;) {
      const t = this.peek()
      if (this.isKw(t, 'OR') || (t.kind === 'op' && t.text === '||')) {
        this.next()
        const right = this.parseAnd()
        left = { k: 'or', a: left, b: right, pos: t.pos }
      } else break
    }
    this.leave()
    return left
  }

  private parseAnd(): QExpr {
    let left = this.parseNot()
    for (;;) {
      const t = this.peek()
      if (this.isKw(t, 'AND') || (t.kind === 'op' && t.text === '&&')) {
        this.next()
        const right = this.parseNot()
        left = { k: 'and', a: left, b: right, pos: t.pos }
      } else break
    }
    return left
  }

  private parseNot(): QExpr {
    const t = this.peek()
    if (this.isKw(t, 'NOT') || (t.kind === 'op' && t.text === '!')) {
      this.next()
      this.enter(t.pos)
      const e = this.parseNot()
      this.leave()
      return { k: 'not', e, pos: t.pos }
    }
    return this.parseCmp()
  }

  private parseCmp(): QExpr {
    const a = this.parsePrimary()
    const t = this.peek()
    if (t.kind === 'op' && ['=', '==', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.next()
      const b = this.parsePrimary()
      const op = (t.text === '==' ? '=' : t.text) as CmpOp
      const after = this.peek()
      if (after.kind === 'op' && ['=', '==', '!=', '<', '<=', '>', '>='].includes(after.text)) {
        throw new QuerySyntaxError('Chained comparisons are not supported — use AND', after.pos)
      }
      return { k: 'cmp', op, a, b, pos: t.pos }
    }
    return a
  }

  private parsePrimary(): QExpr {
    const t = this.peek()
    switch (t.kind) {
      case 'string':
        this.next()
        return { k: 'lit', v: t.text, pos: t.pos }
      case 'number':
        this.next()
        return { k: 'lit', v: Number(t.text), pos: t.pos }
      case 'punct':
        if (t.text === '(') {
          this.next()
          const e = this.parseExpr()
          this.expectPunct(')', "')'")
          return e
        }
        break
      case 'ident': {
        const upper = t.text.toUpperCase()
        // literals
        if (upper === 'TRUE' || upper === 'FALSE') {
          this.next()
          return { k: 'lit', v: upper === 'TRUE', pos: t.pos }
        }
        if (upper === 'NULL') {
          this.next()
          return { k: 'lit', v: null, pos: t.pos }
        }
        // function call?
        const after = this.peek(1)
        if (after.kind === 'punct' && after.text === '(') {
          return this.parseCall()
        }
        if (RESERVED.has(upper)) {
          throw new QuerySyntaxError(`Expected a value or field name, got keyword ${upper}`, t.pos)
        }
        return this.parseField()
      }
      case 'eof':
        throw new QuerySyntaxError('Unexpected end of query — expected a value', t.pos)
      default:
        break
    }
    throw new QuerySyntaxError(`Unexpected '${t.text}' — expected a value or field name`, t.pos)
  }

  private parseField(): QExpr {
    const first = this.next()
    const path = [first.text]
    for (;;) {
      const dot = this.peek()
      if (dot.kind === 'punct' && dot.text === '.') {
        this.next()
        const name = this.next()
        if (name.kind !== 'ident') throw new QuerySyntaxError('Expected a name after "."', name.pos)
        path.push(name.text)
        if (path.length > 4) throw new QuerySyntaxError('Field path is too long', name.pos)
      } else break
    }
    if (path[0].toLowerCase() === 'file') {
      const f = path[1]?.toLowerCase()
      if (path.length !== 2 || !f || !QUERY_FILE_FIELDS.includes(f as (typeof QUERY_FILE_FIELDS)[number])) {
        throw new QuerySyntaxError(
          `Unknown field ${path.join('.')} — supported: ${QUERY_FILE_FIELDS.map((x) => `file.${x}`).join(', ')}`,
          first.pos,
        )
      }
    }
    return { k: 'field', path, pos: first.pos }
  }

  private parseCall(): QExpr {
    const name = this.next()
    const fn = name.text.toLowerCase()
    this.expectPunct('(', "'('")
    if (fn === 'date') {
      const arg = this.next()
      let v: string
      if (arg.kind === 'ident' && ['today', 'tomorrow', 'yesterday', 'now'].includes(arg.text.toLowerCase())) {
        v = arg.text.toLowerCase() === 'now' ? 'today' : arg.text.toLowerCase()
      } else if (arg.kind === 'string' && isIsoDate(arg.text)) {
        v = arg.text
      } else {
        throw new QuerySyntaxError('date() expects today, tomorrow, yesterday or "YYYY-MM-DD"', arg.pos)
      }
      this.expectPunct(')', "')'")
      return { k: 'date', v, pos: name.pos }
    }
    if (fn === 'contains') {
      this.enter(name.pos)
      const a = this.parseExpr()
      this.expectPunct(',', "','")
      const b = this.parseExpr()
      this.expectPunct(')', "')'")
      this.leave()
      return { k: 'contains', a, b, pos: name.pos }
    }
    throw new QuerySyntaxError(`Unknown function ${name.text}() — supported: date(), contains()`, name.pos)
  }
}

function isIsoDate(s: string): boolean {
  if (s.length !== 10 || s[4] !== '-' || s[7] !== '-') return false
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (!isDigit(s[i])) return false
  const m = Number(s.slice(5, 7))
  const d = Number(s.slice(8, 10))
  return m >= 1 && m <= 12 && d >= 1 && d <= 31
}

function normalizeFolder(p: string): string {
  return p
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/')
}

function exprLabel(e: QExpr): string {
  switch (e.k) {
    case 'field':
      return e.path.join('.')
    case 'lit':
      return String(e.v)
    case 'date':
      return `date(${e.v})`
    case 'contains':
      return 'contains'
    default:
      return 'value'
  }
}

/** Parses a query or throws QuerySyntaxError (with a 0-based position). */
export function parseQuery(source: string): QueryAst {
  if (source.length > QUERY_LIMITS.maxLength) {
    throw new QuerySyntaxError(
      `Query is too long (max ${QUERY_LIMITS.maxLength} characters)`,
      QUERY_LIMITS.maxLength,
    )
  }
  if (!source.trim()) throw new QuerySyntaxError('Query is empty', 0)
  return new Parser(tokenize(source)).parseQuery()
}

/** Non-throwing variant for UIs. */
export function tryParseQuery(
  source: string,
): { ok: true; ast: QueryAst } | { ok: false; error: QueryErrorInfo } {
  try {
    return { ok: true, ast: parseQuery(source) }
  } catch (err) {
    if (err instanceof QuerySyntaxError) {
      return { ok: false, error: queryErrorInfo(source, err.message, err.pos) }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

export interface QueryRequest {
  source: string
  /** Viewer's local date (YYYY-MM-DD) used for date(today). Defaults to server UTC date. */
  today?: string
  /** Viewer's UTC offset in minutes (e.g. 540 for UTC+9) — used to compare file.ctime/mtime. */
  tzOffsetMinutes?: number
}

export interface QueryRowDTO {
  pageId: string
  title: string
  /** TABLE: one value per column. LIST: [value] when LIST <expr> is used, else []. */
  cells: unknown[]
  /** TASK rows only */
  task?: { blockId: string; text: string; due: string; checked: boolean }
}

export interface QueryResultDTO {
  type: QueryType
  withoutId: boolean
  columns: string[]
  rows: QueryRowDTO[]
  /** true when more rows matched than were returned (LIMIT or server cap) */
  truncated: boolean
  /** server execution time in ms (for diagnostics) */
  elapsedMs: number
}

export interface QueryErrorDTO {
  error: { code: 'QUERY_SYNTAX' | string; message: string; pos?: number; line?: number; col?: number }
}
