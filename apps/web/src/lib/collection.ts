import {
  formatUniqueId,
  isFormulaErrorCell,
  matchesFilter,
  matchesViewFilter,
  viewFilterOf,
} from '@inkling/shared'
import { formulaText } from './formulas'
import type { CollectionField, MemberDTO, RowDTO, ViewConfig } from '@inkling/shared'

// Builds the displayed field order by applying the view's columnOrder/hiddenFields.
export function orderedFields(
  fields: CollectionField[],
  config: ViewConfig,
): CollectionField[] {
  const hidden = new Set(config.hiddenFields ?? [])
  const order = config.columnOrder ?? []
  const byId = new Map(fields.map((f) => [f.id, f]))
  const out: CollectionField[] = []
  const seen = new Set<string>()
  for (const id of order) {
    const f = byId.get(id)
    if (f && !seen.has(id)) {
      seen.add(id)
      out.push(f)
    }
  }
  // Fields missing from columnOrder are appended in their original order.
  for (const f of fields) {
    if (!seen.has(f.id)) {
      seen.add(f.id)
      out.push(f)
    }
  }
  return out.filter((f) => !hidden.has(f.id))
}

// ---------------------------------------------------------------------------
// Value → display string (when plain text is needed rather than a badge: sort fallback, search, …)
// ---------------------------------------------------------------------------

export function formatValue(
  field: CollectionField,
  value: unknown,
  memberName?: (id: string) => string | undefined,
  refTitle?: (id: string) => string | undefined,
): string {
  if (value === undefined || value === null || value === '') return ''
  switch (field.type) {
    case 'formula':
      return formulaText(value)
    case 'relation':
      if (!Array.isArray(value)) return ''
      return value
        .map((id) => refTitle?.(String(id)) ?? '')
        .filter(Boolean)
        .join(', ')
    case 'rollup':
      if (Array.isArray(value)) return value.map(String).join(', ')
      if (typeof value === 'number') return formatNumber(value)
      return String(value)
    case 'checkbox':
      return value ? '✅' : ''
    case 'select':
      return field.options?.find((o) => o.id === value)?.name ?? ''
    case 'multiSelect':
      if (!Array.isArray(value)) return ''
      return value
        .map((id) => field.options?.find((o) => o.id === id)?.name)
        .filter((n): n is string => !!n)
        .join(', ')
    case 'person':
    case 'createdBy':
    case 'editedBy':
      return memberName?.(String(value)) ?? String(value)
    case 'createdTime':
    case 'editedTime':
      return formatTimestamp(value)
    case 'uniqueId':
      return formatUniqueId(field, value)
    case 'number':
      return typeof value === 'number' ? String(value) : ''
    default:
      return String(value)
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * An automatic timestamp (ISO UTC string) as local date and time, `2026-11-10 18:12` — the same
 * YYYY-MM-DD the date cells show, plus the time. '' for anything that is not a date.
 */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * The workspace member list with the names a guest's collection response carries (`people`, user id →
 * name; guests cannot read the member list). Only for showing names: never offer it as a picker.
 */
export function membersWithPeople(
  members: MemberDTO[] | undefined,
  people: Record<string, string> | undefined | null,
): MemberDTO[] | undefined {
  if (!people) return members
  const have = new Set((members ?? []).map((m) => m.id))
  const extra = Object.entries(people)
    .filter(([id]) => !have.has(id))
    .map(([id, name]): MemberDTO => ({ id, name, email: '', role: 'member' }))
  return extra.length ? [...(members ?? []), ...extra] : members
}

/** Number display without float noise (rollup averages etc.). */
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)
}

// ---------------------------------------------------------------------------
// Client-side sort/filter
// ---------------------------------------------------------------------------

function sortKey(field: CollectionField, value: unknown): number | string {
  switch (field.type) {
    case 'formula':
      // numbers by value, checkboxes as 0/1, text and dates by text; empty and errors first (as numbers do)
      if (typeof value === 'number') return value
      if (typeof value === 'boolean') return value ? 1 : 0
      if (value === null || value === undefined || isFormulaErrorCell(value)) return Number.NEGATIVE_INFINITY
      return String(value).toLowerCase()
    case 'number':
      return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY
    case 'checkbox':
      return value ? 1 : 0
    case 'select': {
      // Compare by option definition order (unset/orphaned values go last)
      const idx = field.options?.findIndex((o) => o.id === value) ?? -1
      return idx < 0 ? Number.POSITIVE_INFINITY : idx
    }
    case 'multiSelect': {
      if (!Array.isArray(value) || value.length === 0) return ''
      return field.options?.find((o) => o.id === value[0])?.name ?? ''
    }
    case 'relation':
      return Array.isArray(value) ? value.length : 0
    case 'uniqueId':
      return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY
    case 'createdTime':
    case 'editedTime':
      // ISO UTC strings sort as text (full precision)
      return typeof value === 'string' ? value : ''
    case 'rollup':
      if (typeof value === 'number') return value
      if (Array.isArray(value)) return value.join(', ').toLowerCase()
      return typeof value === 'string' ? value.toLowerCase() : Number.NEGATIVE_INFINITY
    case 'date':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
    // person-like cells sort by the stored user id, as person always has
    case 'person':
    case 'createdBy':
    case 'editedBy':
      return typeof value === 'string' ? value.toLowerCase() : ''
    default:
      return typeof value === 'string' ? value.toLowerCase() : ''
  }
}

function compareRows(
  field: CollectionField,
  a: RowDTO,
  b: RowDTO,
  dir: 'asc' | 'desc',
): number {
  const ka = sortKey(field, a.props[field.id])
  const kb = sortKey(field, b.props[field.id])
  let cmp: number
  if (typeof ka === 'number' && typeof kb === 'number') cmp = ka - kb
  else cmp = String(ka).localeCompare(String(kb), 'ko')
  return dir === 'asc' ? cmp : -cmp
}

// One view filter against a stored value: shared with the server's chart aggregate, so a chart view
// counts the rows the other views show (packages/shared/src/charts.ts, docs/adr/1602-*).
export { matchesFilter }

// Returns the rows with the view config applied: filter (the 0.17 tree, or the legacy flat AND list
// read as one, docs/adr/2142-*), then sort.
export function applyView(
  rows: RowDTO[],
  fields: CollectionField[],
  config: ViewConfig,
): RowDTO[] {
  const byId = new Map(fields.map((f) => [f.id, f]))
  let out = rows
  const tree = viewFilterOf(config)
  if (tree && tree.items.length) {
    out = out.filter((row) => matchesViewFilter(row.props, byId, tree))
  }
  const sorts = config.sorts ?? []
  if (sorts.length) {
    out = [...out].sort((a, b) => {
      for (const s of sorts) {
        const field = byId.get(s.fieldId)
        if (!field) continue
        const cmp = compareRows(field, a, b, s.dir)
        if (cmp !== 0) return cmp
      }
      return 0
    })
  }
  return out
}
