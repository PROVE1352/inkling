/**
 * A collection view's columns, filters and sorts applied on the server, for the tables that stand
 * for an inline database view outside the app (file export, public pages; docs/adr/2121-*, 2122-*).
 * Same rules as the web views (apps/web/src/lib/collection.ts orderedFields / applyView): the view's
 * filter tree (OR groups and NOT included, `viewFilterOf` / `matchesViewFilter`, as the web and the
 * chart aggregate), sorts by option order / number / text (IDs by number, timestamps as ISO text),
 * columns by `columnOrder` with `hiddenFields` left out.
 */
import { isFormulaErrorCell, matchesViewFilter, viewFilterOf } from '@inkling/shared'
import type { CollectionField, ViewConfig } from '@inkling/shared'

/** Fields in the view's column order, hidden ones left out (web orderedFields). */
export function viewFields(fields: CollectionField[], config: ViewConfig): CollectionField[] {
  const hidden = new Set(config.hiddenFields ?? [])
  const byId = new Map(fields.map((f) => [f.id, f]))
  const out: CollectionField[] = []
  const seen = new Set<string>()
  for (const id of config.columnOrder ?? []) {
    const f = byId.get(id)
    if (f && !seen.has(id)) {
      seen.add(id)
      out.push(f)
    }
  }
  for (const f of fields) if (!seen.has(f.id)) out.push(f)
  return out.filter((f) => !hidden.has(f.id))
}

function sortKey(field: CollectionField, value: unknown): number | string {
  switch (field.type) {
    case 'formula':
      if (typeof value === 'number') return value
      if (typeof value === 'boolean') return value ? 1 : 0
      if (value === null || value === undefined || isFormulaErrorCell(value)) return Number.NEGATIVE_INFINITY
      return String(value).toLowerCase()
    case 'number':
      return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY
    case 'checkbox':
      return value ? 1 : 0
    case 'select': {
      const idx = field.options?.findIndex((o) => o.id === value) ?? -1
      return idx < 0 ? Number.POSITIVE_INFINITY : idx
    }
    case 'multiSelect':
      if (!Array.isArray(value) || value.length === 0) return ''
      return field.options?.find((o) => o.id === value[0])?.name ?? ''
    case 'relation':
      return Array.isArray(value) ? value.length : 0
    // 0.17 types, as the web's sortKey (docs/adr/2140-*): IDs by number, timestamps as ISO text
    case 'uniqueId':
      return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY
    case 'createdTime':
    case 'editedTime':
      return typeof value === 'string' ? value : ''
    case 'rollup':
      if (typeof value === 'number') return value
      if (Array.isArray(value)) return value.join(', ').toLowerCase()
      return typeof value === 'string' ? value.toLowerCase() : Number.NEGATIVE_INFINITY
    default:
      return typeof value === 'string' ? value.toLowerCase() : ''
  }
}

/** Rows the view keeps, in the view's order (filters, then a stable sort). */
export function applyViewRows<R extends { props: Record<string, unknown> }>(rows: R[], fields: CollectionField[], config: ViewConfig): R[] {
  const tree = viewFilterOf(config)
  let out = tree ? rows.filter((r) => matchesViewFilter(r.props, fields, tree)) : rows
  const sorts = (config.sorts ?? []).map((s) => ({ s, f: fields.find((x) => x.id === s.fieldId) })).filter((x) => !!x.f)
  if (sorts.length) {
    out = [...out].sort((a, b) => {
      for (const { s, f } of sorts) {
        const ka = sortKey(f!, a.props[f!.id])
        const kb = sortKey(f!, b.props[f!.id])
        const cmp = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), 'ko')
        if (cmp !== 0) return s.dir === 'asc' ? cmp : -cmp
      }
      return 0
    })
  }
  return out
}
