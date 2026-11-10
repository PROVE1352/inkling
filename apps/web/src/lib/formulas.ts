/**
 * Formula fields on the web (docs/adr/1823-*, 1825-*): the same engine as the server
 * (packages/shared/src/formula.ts), run again after an optimistic edit so a formula cell never shows
 * a stale value while the server answers. An error becomes a marker in the row's props (the server
 * sends null for it), which the cells show and filters, sorts and exports read as empty.
 */
import { compileFormulas, evaluateRowFormulas, formatFormulaNumber, isFormulaErrorCell } from '@inkling/shared'
import type { CollectionField, FormulaErrorCode, RowDTO } from '@inkling/shared'

/** Rows with every formula computed from their current props (the same objects when there is none). */
export function withFormulas(rows: RowDTO[], fields: CollectionField[], now: Date = new Date()): RowDTO[] {
  if (!fields.some((f) => f.type === 'formula')) return rows
  const compiled = compileFormulas(fields)
  return rows.map((r) => {
    const res = evaluateRowFormulas(compiled, { title: r.title, props: r.props }, { now })
    const props: Record<string, unknown> = { ...r.props, ...res.values }
    for (const [k, code] of Object.entries(res.errors)) props[k] = { formulaError: code }
    return { ...r, props }
  })
}

/** Plain text of a computed formula value ('' for empty and for an error). */
export function formulaText(value: unknown): string {
  if (value === null || value === undefined || isFormulaErrorCell(value)) return ''
  if (typeof value === 'number') return formatFormulaNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

export function formulaErrorOf(value: unknown): FormulaErrorCode | null {
  return isFormulaErrorCell(value) ? value.formulaError : null
}
