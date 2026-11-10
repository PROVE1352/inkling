import type { CollectionField } from './index'
// ---------------------------------------------------------------------------
// CSV (RFC 4180) parse/serialize + spreadsheet value helpers.
// Shared by the web importer/exporter and the server-side Google Sheets sync.
// Pure functions, no dependencies.
// ---------------------------------------------------------------------------

export interface CsvParseOptions {
  /** field delimiter; auto-detected from the first line when omitted (',', ';', '\t') */
  delimiter?: string
  /** stop after this many records (header included); extra rows set `truncated` */
  maxRows?: number
}

export interface CsvParseResult {
  rows: string[][]
  delimiter: string
  truncated: boolean
}

/** Guess the delimiter by counting candidates outside quotes in the first record. */
export function detectDelimiter(text: string): string {
  const candidates = [',', ';', '\t']
  const counts = new Map<string, number>(candidates.map((c) => [c, 0]))
  let inQuotes = false
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const ch = text[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break
    else if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  let best = ','
  let bestN = 0
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c
      bestN = n
    }
  }
  return best
}

/**
 * Parse CSV text into records. Handles quoted fields, escaped quotes (""), embedded
 * newlines, CRLF/LF/CR line endings and a leading UTF-8 BOM. Single pass, O(n).
 */
export function parseCsv(input: string, opts: CsvParseOptions = {}): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const delimiter = opts.delimiter ?? detectDelimiter(text)
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let truncated = false
  let i = 0
  const n = text.length

  const endRecord = () => {
    row.push(field)
    field = ''
    // skip completely empty lines (a lone empty field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      endRecord()
      if (ch === '\r' && text[i + 1] === '\n') i++
      i++
      if (rows.length >= maxRows) {
        truncated = i < n
        return { rows, delimiter, truncated }
      }
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || row.length > 0) endRecord()
  if (rows.length > maxRows) {
    rows.length = maxRows
    truncated = true
  }
  return { rows, delimiter, truncated }
}

/**
 * Neutralize spreadsheet formula injection (CWE-1236): cells starting with = + - @
 * (or a tab / carriage return) are prefixed with a single quote so spreadsheet apps
 * treat them as text. Plain negative numbers like "-12.5" are left alone.
 */
export function escapeFormula(value: string): string {
  if (value === '') return value
  const first = value[0]
  if (first === '\t' || first === '\r') return `'${value}`
  if (first === '=' || first === '+' || first === '@') return `'${value}`
  if (first === '-' && !/^-\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return `'${value}`
  return value
}

/** Quote one CSV field when needed (delimiter, quote, newline, surrounding spaces). */
export function csvField(value: string, delimiter = ','): string {
  if (
    value.includes('"') ||
    value.includes(delimiter) ||
    value.includes('\n') ||
    value.includes('\r') ||
    /^\s|\s$/.test(value)
  ) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** Serialize records to CSV (CRLF line endings, formula-escaped). */
export function toCsv(rows: string[][], delimiter = ','): string {
  return rows
    .map((r) => r.map((v) => csvField(escapeFormula(v), delimiter)).join(delimiter))
    .join('\r\n')
}

// ---------------------------------------------------------------------------
// Value coercion (used for type inference, paste and sync)
// ---------------------------------------------------------------------------

const TRUE_RE = /^(true|yes|y|1|x|✓|✔|☑|✅|checked|o)$/i
const FALSE_RE = /^(false|no|n|0|☐|⬜|unchecked|)$/i

export function parseBoolean(s: string): boolean | null {
  const t = s.trim()
  if (TRUE_RE.test(t)) return true
  if (FALSE_RE.test(t)) return false
  return null
}

/** Parse a number, tolerating thousands separators, currency symbols and percent. */
export function parseNumber(s: string): number | null {
  let t = s.trim()
  if (t === '') return null
  let pct = false
  if (t.endsWith('%')) {
    pct = true
    t = t.slice(0, -1)
  }
  t = t.replace(/^[$€£¥₩]\s?/, '').replace(/,(?=\d{3}(\D|$))/g, '')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return pct ? n / 100 : n
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/**
 * Normalize common date spellings to YYYY-MM-DD (null if not a date):
 * 2026-11-07, 2026/11/07, 2026.11.07, 2026-11-07T10:00:00Z, 11/07/2026 (US m/d/y).
 */
export function parseDate(s: string): string | null {
  const t = s.trim()
  if (t === '') return null
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\.?(?:[ T].*)?$/.exec(t)
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (m) return validYmd(Number(m[3]), Number(m[1]), Number(m[2]))
  return null
}

export type InferredType = 'number' | 'date' | 'select' | 'checkbox' | 'text'

/**
 * Infer a column type from sample values (empty cells ignored). A type wins only when
 * every non-empty sample parses. select = few distinct short values relative to the count.
 */
export function inferColumnType(values: string[]): InferredType {
  const sample: string[] = []
  for (const v of values) {
    const t = v.trim()
    if (t !== '') sample.push(t)
    if (sample.length >= 2000) break
  }
  if (sample.length === 0) return 'text'
  if (sample.every((v) => parseBoolean(v) !== null) && sample.some((v) => parseBoolean(v) === true))
    if (!sample.every((v) => /^[01]$/.test(v))) return 'checkbox'
  if (sample.every((v) => parseNumber(v) !== null)) return 'number'
  if (sample.every((v) => parseDate(v) !== null)) return 'date'
  const distinct = new Set(sample)
  if (
    distinct.size <= 20 &&
    sample.length >= 4 &&
    distinct.size <= sample.length / 2 &&
    [...distinct].every((v) => v.length <= 60)
  )
    return 'select'
  return 'text'
}

// ---------------------------------------------------------------------------
// Cell string → typed property value (paste, import, sheets sync)
// ---------------------------------------------------------------------------

export interface CoerceOptions {
  /** select/multiSelect: option id for a display name (create it if allowed); null = no match */
  resolveOption?: (field: CollectionField, name: string) => string | null
  /** person: user id for a display name/email; null = no match */
  resolvePerson?: (name: string) => string | null
}

/**
 * Convert one cell string to the stored value of `field`.
 * Returns null for an empty cell (= clear), undefined when the value cannot be represented
 * (caller skips the cell). Relation and rollup cells are never written this way.
 */
export function coerceCellValue(
  field: CollectionField,
  raw: string,
  opts: CoerceOptions = {},
): unknown {
  const t = raw.trim()
  if (field.type === 'relation' || field.type === 'rollup' || field.type === 'formula') return undefined
  if (t === '') return field.type === 'checkbox' ? false : null
  switch (field.type) {
    case 'number':
      return parseNumber(t) ?? undefined
    case 'checkbox':
      return parseBoolean(t) ?? undefined
    case 'date':
      return parseDate(t) ?? undefined
    case 'select':
      return opts.resolveOption?.(field, t) ?? undefined
    case 'multiSelect': {
      const ids = t
        .split(/\s*[,;]\s*/)
        .filter(Boolean)
        .map((name) => opts.resolveOption?.(field, name) ?? null)
        .filter((x): x is string => !!x)
      return [...new Set(ids)]
    }
    case 'person':
      return opts.resolvePerson?.(t) ?? undefined
    default:
      return raw
  }
}
