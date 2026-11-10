/**
 * Automatic values of collection rows (docs/adr/2140-*, 2141-*): created / edited time, created /
 * edited by and the unique ID come from the row's page columns, never from props. Every reader that
 * serves rows fills them in, in JS (`fillAutoProps`) or in SQL (`autoPropsSql`), so sort, filter,
 * group, charts and formulas read them from props like stored values.
 */
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { fillAutoProps, isAutoFieldType, viaPropKey } from '@inkling/shared'
import type { AutoSource, CollectionField } from '@inkling/shared'
import { pages } from '../db/schema'

/** Drizzle select columns the automatic values need. */
export const autoSourceColumns = {
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt,
  createdBy: pages.createdBy,
  createdVia: pages.createdVia,
  editedBy: pages.editedBy,
  editedVia: pages.editedVia,
  rowNumber: pages.rowNumber,
} as const

export function autoFields(fields: CollectionField[]): CollectionField[] {
  return fields.filter((f) => isAutoFieldType(f.type))
}

/** Fill the automatic values into rows that carry the page columns (in place). */
export function fillRowsAuto<R extends Partial<AutoSource> & { props: Record<string, unknown> }>(fields: CollectionField[], rows: R[]): void {
  const auto = autoFields(fields)
  if (!auto.length) return
  for (const r of rows) {
    if (!r.createdAt || !r.updatedAt) continue
    fillAutoProps(auto, r.props, r as AutoSource)
  }
}

/** Fill the automatic values into DTOs from the page rows they were made from (same order). */
export function fillAutoInto(fields: CollectionField[], dtos: { props: Record<string, unknown> }[], src: AutoSource[]): void {
  const auto = autoFields(fields)
  if (!auto.length) return
  dtos.forEach((d, i) => {
    if (src[i]) fillAutoProps(auto, d.props, src[i])
  })
}

const isoSql = (col: SQL) => sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/**
 * Raw-SQL select list of the page columns fillAutoProps reads, named as AutoSource (timestamps as the
 * same ISO UTC text autoPropsSql writes), for a statement whose rows are filled in JS afterwards.
 */
export function autoSourceSelectSql(): SQL {
  const c = autoSourceColumns
  return sql`${isoSql(sql`${c.createdAt}`)} AS "createdAt", ${isoSql(sql`${c.updatedAt}`)} AS "updatedAt",
    ${c.createdBy} AS "createdBy", ${c.createdVia} AS "createdVia", ${c.editedBy} AS "editedBy",
    ${c.editedVia} AS "editedVia", ${c.rowNumber} AS "rowNumber"`
}

/**
 * jsonb object of the automatic values of `fields` for the unaliased `pages` row (or a derived table
 * named pages), the same values fillAutoProps serves (an empty one as JSON null); `'{}'` when there
 * are none. Use as `props || <this>`.
 */
export function autoPropsSql(fields: CollectionField[]): SQL {
  const auto = autoFields(fields)
  if (!auto.length) return sql`'{}'::jsonb`
  const c = autoSourceColumns
  const by = (f: CollectionField) => (f.type === 'createdBy' ? sql`${c.createdBy}::text` : sql`coalesce(${c.editedBy}, ${c.createdBy})::text`)
  const via = (f: CollectionField) =>
    f.type === 'createdBy' ? sql`${c.createdVia}` : sql`(CASE WHEN ${c.editedBy} IS NOT NULL THEN ${c.editedVia} ELSE ${c.createdVia} END)`
  const pairs: SQL[] = []
  for (const f of auto) {
    switch (f.type) {
      case 'createdTime':
        pairs.push(sql`${f.id}::text, ${isoSql(sql`${c.createdAt}`)}`)
        break
      case 'editedTime':
        pairs.push(sql`${f.id}::text, ${isoSql(sql`${c.updatedAt}`)}`)
        break
      case 'createdBy':
      case 'editedBy':
        pairs.push(sql`${f.id}::text, ${by(f)}`)
        pairs.push(sql`${viaPropKey(f.id)}::text, ${via(f)}`)
        break
      case 'uniqueId':
        pairs.push(sql`${f.id}::text, ${c.rowNumber}`)
        break
    }
  }
  // jsonb_build_object takes at most 100 arguments: chunk and concatenate
  const parts: SQL[] = []
  for (let i = 0; i < pairs.length; i += 40) parts.push(sql`jsonb_build_object(${sql.join(pairs.slice(i, i + 40), sql`, `)})`)
  return sql`(${sql.join(parts, sql` || `)})`
}
