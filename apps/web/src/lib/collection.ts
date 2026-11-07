import type { CollectionField, FilterOp, RowDTO, ViewConfig } from '@inkling/shared'

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
      return memberName?.(String(value)) ?? String(value)
    case 'number':
      return typeof value === 'number' ? String(value) : ''
    default:
      return String(value)
  }
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
    case 'rollup':
      if (typeof value === 'number') return value
      if (Array.isArray(value)) return value.join(', ').toLowerCase()
      return typeof value === 'string' ? value.toLowerCase() : Number.NEGATIVE_INFINITY
    case 'date':
    case 'text':
    case 'url':
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

export function matchesFilter(
  field: CollectionField,
  value: unknown,
  op: FilterOp,
  target: string | number | boolean | undefined,
): boolean {
  const isEmpty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  switch (op) {
    case 'empty':
      return isEmpty
    case 'notEmpty':
      return !isEmpty
    case 'eq':
      if (field.type === 'multiSelect')
        return Array.isArray(value) && value.includes(target as string)
      return String(value ?? '') === String(target ?? '')
    case 'ne':
      if (field.type === 'multiSelect')
        return !(Array.isArray(value) && value.includes(target as string))
      return String(value ?? '') !== String(target ?? '')
    case 'contains':
      if (field.type === 'rollup' && Array.isArray(value))
        return value.some((v) =>
          String(v).toLowerCase().includes(String(target ?? '').toLowerCase()),
        )
      if (Array.isArray(value)) return value.includes(target as string)
      return String(value ?? '')
        .toLowerCase()
        .includes(String(target ?? '').toLowerCase())
    case 'gt':
    case 'lt': {
      if (field.type === 'number' || (field.type === 'rollup' && typeof value === 'number')) {
        const a = Number(value)
        const b = Number(target)
        if (Number.isNaN(a) || Number.isNaN(b)) return false
        return op === 'gt' ? a > b : a < b
      }
      // date/text etc. compare lexicographically as strings
      if (isEmpty) return false
      const a = String(value)
      const b = String(target ?? '')
      return op === 'gt' ? a > b : a < b
    }
    default:
      return true
  }
}

// Returns the rows with the view config applied: filter, then sort.
export function applyView(
  rows: RowDTO[],
  fields: CollectionField[],
  config: ViewConfig,
): RowDTO[] {
  const byId = new Map(fields.map((f) => [f.id, f]))
  let out = rows
  const filters = config.filters ?? []
  if (filters.length) {
    out = out.filter((row) =>
      filters.every((flt) => {
        const field = byId.get(flt.fieldId)
        if (!field) return true
        return matchesFilter(field, row.props[flt.fieldId], flt.op, flt.value)
      }),
    )
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
