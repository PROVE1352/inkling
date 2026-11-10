/**
 * Collection field types of 0.17 and the view filter tree (docs/adr/2140-*, 2142-*, 2143-*).
 *
 *  - Automatic values (createdTime, editedTime, createdBy, editedBy, uniqueId) are never stored in a
 *    row's props: the server fills them from page columns into every row it serves (as it does for
 *    rollups), so sorting, filtering, grouping, charts and formulas read them from `props` like any
 *    other value. Writes to them are refused.
 *  - email / phone are stored text, like url.
 *  - The view filter tree (`viewConfig.filter`) adds OR groups and NOT to the flat AND list
 *    (`viewConfig.filters`, still read and still written when the tree is a plain AND list). One
 *    evaluator here serves the web views, charts and inline views and the server's chart aggregate.
 *  - Sub-items: a relation of a collection to itself marked `subItems` is the "Parent item" field.
 *
 * This file must not import values from './index' (index re-exports it); type imports are fine.
 */
import { z } from 'zod'
import { isFormulaErrorCell } from './formula'
import type { CollectionField, FieldType, RowDTO, ViewConfig } from './index'

// ---------------------------------------------------------------------------
// field types
// ---------------------------------------------------------------------------

/** Values the server fills in from the page itself; never stored in props, never written. */
export const AUTO_FIELD_TYPES = ['createdTime', 'editedTime', 'createdBy', 'editedBy', 'uniqueId'] as const
export type AutoFieldType = (typeof AUTO_FIELD_TYPES)[number]
const AUTO = new Set<string>(AUTO_FIELD_TYPES)

export function isAutoFieldType(t: string | undefined): t is AutoFieldType {
  return !!t && AUTO.has(t)
}

/** Fields whose value nobody writes: rollups, formulas and the automatic values. */
export function isReadOnlyFieldType(t: string | undefined): boolean {
  return t === 'rollup' || t === 'formula' || isAutoFieldType(t)
}

/** Field types that hold a member's user id (display: the member's name). */
export function isPersonLikeType(t: string | undefined): boolean {
  return t === 'person' || t === 'createdBy' || t === 'editedBy'
}

/** Field types whose value is a timestamp (ISO string, UTC, millisecond precision). */
export function isTimestampType(t: string | undefined): boolean {
  return t === 'createdTime' || t === 'editedTime'
}

/** Stored free-text types (text-like display, filters and sort). */
export function isTextLikeType(t: string | undefined): boolean {
  return t === 'text' || t === 'url' || t === 'email' || t === 'phone'
}

/**
 * Prop key next to a createdBy / editedBy cell with the agent connection's client name when an
 * agent made that change (same idea as the agent key next to a person cell, docs/adr/1861-*).
 */
export const VIA_PROP_PREFIX = 'via:'
export function viaPropKey(fieldId: string): string {
  return `${VIA_PROP_PREFIX}${fieldId}`
}

/** Unique ID prefix: letters and digits (any script), at most 12; empty = the bare number. */
export const UNIQUE_ID_PREFIX_RE = /^[\p{L}\p{N}]{0,12}$/u
export const uniqueIdConfigSchema = z.object({
  prefix: z.string().trim().max(12).regex(UNIQUE_ID_PREFIX_RE, 'Letters and digits only').optional(),
})
export type UniqueIdConfig = z.infer<typeof uniqueIdConfigSchema>

/** `TASK-12` (or `12` without a prefix); '' for a row without a number. */
export function formatUniqueId(field: Pick<CollectionField, 'uniqueId'>, n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  const p = field.uniqueId?.prefix
  return p ? `${p}-${n}` : String(n)
}

/** The number in `TASK-12`, `task-12`, `#12` or `12`; null for anything else. */
export function parseUniqueId(field: Pick<CollectionField, 'uniqueId'>, s: unknown): number | null {
  if (typeof s === 'number') return Number.isInteger(s) && s > 0 ? s : null
  if (typeof s !== 'string') return null
  let t = s.trim()
  const p = field.uniqueId?.prefix
  if (p && t.toLowerCase().startsWith(`${p.toLowerCase()}-`)) t = t.slice(p.length + 1)
  else if (t.startsWith('#')) t = t.slice(1)
  if (!/^\d{1,9}$/.test(t)) return null
  const n = Number(t)
  return n > 0 ? n : null
}

/** Light email check (the value is free text; this only decides the mailto: link and agent writes). */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

/** Phone numbers: digits with + ( ) - . / and spaces, at least 3 digits. */
export function looksLikePhone(s: string): boolean {
  const t = s.trim()
  return /^[+()0-9\-./\s]{3,40}$/.test(t) && (t.match(/\d/g)?.length ?? 0) >= 3
}

/** `tel:` target of a phone value (digits and a leading +). */
export function phoneHref(s: string): string {
  const t = s.trim()
  return `tel:${t.startsWith('+') ? '+' : ''}${t.replace(/\D/g, '')}`
}

/**
 * What each field type supports (docs/adr/2140-*). The web and the server read these sets instead
 * of keeping their own lists.
 */
export const FIELD_CAPS: Record<FieldType, { sort: boolean; filter: boolean; group: boolean; form: boolean; write: boolean }> = {
  text: { sort: true, filter: true, group: false, form: true, write: true },
  number: { sort: true, filter: true, group: false, form: true, write: true },
  select: { sort: true, filter: true, group: true, form: true, write: true },
  multiSelect: { sort: true, filter: true, group: false, form: true, write: true },
  date: { sort: true, filter: true, group: false, form: true, write: true },
  checkbox: { sort: true, filter: true, group: true, form: true, write: true },
  person: { sort: true, filter: true, group: true, form: true, write: true },
  url: { sort: true, filter: true, group: false, form: true, write: true },
  email: { sort: true, filter: true, group: false, form: true, write: true },
  phone: { sort: true, filter: true, group: false, form: true, write: true },
  relation: { sort: true, filter: true, group: false, form: false, write: true },
  rollup: { sort: true, filter: true, group: false, form: false, write: false },
  formula: { sort: true, filter: true, group: false, form: false, write: false },
  createdTime: { sort: true, filter: true, group: false, form: false, write: false },
  editedTime: { sort: true, filter: true, group: false, form: false, write: false },
  createdBy: { sort: true, filter: true, group: true, form: false, write: false },
  editedBy: { sort: true, filter: true, group: true, form: false, write: false },
  uniqueId: { sort: true, filter: true, group: false, form: false, write: false },
}

/** Raw page columns the automatic values come from. */
export interface AutoSource {
  createdAt: string | Date
  updatedAt: string | Date
  createdBy?: string | null
  createdVia?: string | null
  editedBy?: string | null
  editedVia?: string | null
  rowNumber?: number | null
}

const iso = (d: string | Date): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString())

/**
 * Fill the automatic values of `fields` into `props` (in place) from the page's own columns.
 * Last editor = the newest logged edit's actor (pages.edited_by), else the creator; its via the same
 * way. Whatever a row's props held under those ids before is replaced (they are never stored).
 */
export function fillAutoProps(fields: CollectionField[], props: Record<string, unknown>, src: AutoSource): void {
  for (const f of fields) {
    switch (f.type) {
      case 'createdTime':
        props[f.id] = iso(src.createdAt)
        break
      case 'editedTime':
        props[f.id] = iso(src.updatedAt)
        break
      case 'createdBy':
        props[f.id] = src.createdBy ?? null
        if (src.createdVia) props[viaPropKey(f.id)] = src.createdVia
        else delete props[viaPropKey(f.id)]
        break
      case 'editedBy': {
        const by = src.editedBy ?? src.createdBy ?? null
        const via = src.editedBy ? src.editedVia : src.createdVia
        props[f.id] = by
        if (via) props[viaPropKey(f.id)] = via
        else delete props[viaPropKey(f.id)]
        break
      }
      case 'uniqueId':
        props[f.id] = typeof src.rowNumber === 'number' ? src.rowNumber : null
        break
    }
  }
}

// ---------------------------------------------------------------------------
// view filter tree
// ---------------------------------------------------------------------------

export const filterOpSchema = z.enum(['contains', 'eq', 'ne', 'empty', 'notEmpty', 'gt', 'lt'])
export type FilterOp = z.infer<typeof filterOpSchema>

/** Items per level of the tree (top level and each group), as the flat list allowed before. */
export const VIEW_FILTER_MAX_ITEMS = 10

export const filterConditionSchema = z.object({
  fieldId: z.string(),
  op: filterOpSchema,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** negate this condition */
  not: z.boolean().optional(),
})
export type FilterCondition = z.infer<typeof filterConditionSchema>

/** A group of conditions (one level of nesting only: a group holds conditions, never groups). */
export const filterGroupSchema = z.object({
  mode: z.enum(['and', 'or']),
  not: z.boolean().optional(),
  items: z.array(filterConditionSchema).max(VIEW_FILTER_MAX_ITEMS),
})
export type FilterGroup = z.infer<typeof filterGroupSchema>

export const viewFilterSchema = z.object({
  /** and = every item must match ("all"), or = any item ("any") */
  mode: z.enum(['and', 'or']),
  items: z.array(z.union([filterConditionSchema, filterGroupSchema])).max(VIEW_FILTER_MAX_ITEMS),
})
export type ViewFilter = z.infer<typeof viewFilterSchema>
export type ViewFilterItem = ViewFilter['items'][number]

export function isFilterGroup(item: ViewFilterItem): item is FilterGroup {
  return Array.isArray((item as FilterGroup).items)
}

/**
 * The filter a view applies. `config.filter` (0.17) wins; without it the flat list (`filters`, every
 * condition must match) is read as an AND tree, so views saved before 0.17 need no migration.
 */
export function viewFilterOf(config: Pick<ViewConfig, 'filter' | 'filters'> | undefined | null): ViewFilter | null {
  if (config?.filter) return config.filter
  const flat = config?.filters
  return flat?.length ? { mode: 'and', items: flat.map((f) => ({ fieldId: f.fieldId, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) })) } : null
}

/** A tree a 0.16 client understands: AND of plain conditions (no OR, no NOT, no groups). */
export function isFlatAndFilter(tree: ViewFilter | null): boolean {
  return !tree || (tree.mode === 'and' && tree.items.every((i) => !isFilterGroup(i) && !i.not))
}

/**
 * Config keys to save for a tree: a plain AND list is stored as `filters` (what 0.16 reads) and
 * `filter` is dropped; anything else is stored as `filter` and `filters` is emptied, so a 0.16
 * client shows the rows unfiltered instead of applying half of an OR (docs/adr/2142-*).
 */
export function viewFilterPatch(tree: ViewFilter | null): Pick<ViewConfig, 'filter' | 'filters'> {
  if (!tree || tree.items.length === 0) return { filters: [], filter: undefined }
  if (isFlatAndFilter(tree)) {
    return {
      filters: (tree.items as FilterCondition[]).map((c) => ({ fieldId: c.fieldId, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) })),
      filter: undefined,
    }
  }
  return { filter: tree, filters: [] }
}

/** Every field id a tree reads. */
export function viewFilterFieldIds(tree: ViewFilter | null): string[] {
  if (!tree) return []
  const out = new Set<string>()
  for (const i of tree.items) {
    if (isFilterGroup(i)) for (const c of i.items) out.add(c.fieldId)
    else out.add(i.fieldId)
  }
  return [...out]
}

/** Number of conditions in a tree (groups count their conditions). */
export function viewFilterCount(tree: ViewFilter | null): number {
  if (!tree) return 0
  return tree.items.reduce((n, i) => n + (isFilterGroup(i) ? i.items.length : 1), 0)
}

const dayOf = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 10) : '')

/** One condition against a row's value (the value as served: automatic values filled in). */
export function matchesFilter(
  field: CollectionField,
  value: unknown,
  op: FilterOp,
  target: string | number | boolean | undefined,
): boolean {
  // a formula error (web marker) reads as an empty value
  if (isFormulaErrorCell(value)) value = null
  const isEmpty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
  switch (op) {
    case 'empty':
      return isEmpty
    case 'notEmpty':
      return !isEmpty
  }
  // timestamps compare by their UTC day against YYYY-MM-DD (the server's `today` is UTC as well)
  if (isTimestampType(field.type)) {
    if (isEmpty) return op === 'ne'
    const a = dayOf(value)
    const b = String(target ?? '').slice(0, 10)
    switch (op) {
      case 'eq':
        return a === b
      case 'ne':
        return a !== b
      case 'gt':
        return a > b
      case 'lt':
        return a < b
      case 'contains':
        return String(value).includes(String(target ?? ''))
    }
    return true
  }
  if (field.type === 'uniqueId') {
    const n = typeof value === 'number' ? value : null
    const t = parseUniqueId(field, target)
    switch (op) {
      case 'eq':
        return n !== null && n === t
      case 'ne':
        return n === null || n !== t
      case 'gt':
        return n !== null && t !== null && n > t
      case 'lt':
        return n !== null && t !== null && n < t
      case 'contains':
        return formatUniqueId(field, n).toLowerCase().includes(String(target ?? '').toLowerCase())
    }
    return true
  }
  switch (op) {
    case 'eq':
      if (field.type === 'multiSelect') return Array.isArray(value) && value.includes(target as string)
      return String(value ?? '') === String(target ?? '')
    case 'ne':
      if (field.type === 'multiSelect') return !(Array.isArray(value) && value.includes(target as string))
      return String(value ?? '') !== String(target ?? '')
    case 'contains':
      if (field.type === 'rollup' && Array.isArray(value))
        return value.some((v) => String(v).toLowerCase().includes(String(target ?? '').toLowerCase()))
      if (Array.isArray(value)) return value.includes(target as string)
      return String(value ?? '')
        .toLowerCase()
        .includes(String(target ?? '').toLowerCase())
    case 'gt':
    case 'lt': {
      if (field.type === 'number' || ((field.type === 'rollup' || field.type === 'formula') && typeof value === 'number')) {
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

/** true / false, or null when the condition names a field that no longer exists (ignored). */
function evalCondition(c: FilterCondition, props: Record<string, unknown>, byId: Map<string, CollectionField>): boolean | null {
  const field = byId.get(c.fieldId)
  if (!field) return null
  const hit = matchesFilter(field, props[c.fieldId], c.op, c.value)
  return c.not ? !hit : hit
}

function combine(mode: 'and' | 'or', results: (boolean | null)[]): boolean | null {
  const known = results.filter((r): r is boolean => r !== null)
  if (known.length === 0) return null
  return mode === 'and' ? known.every(Boolean) : known.some(Boolean)
}

/**
 * Does a row match a view's filter tree? Conditions on deleted fields are ignored (as before); a
 * group left with no known condition is ignored too, and an empty tree matches everything.
 */
export function matchesViewFilter(
  props: Record<string, unknown>,
  fields: CollectionField[] | Map<string, CollectionField>,
  tree: ViewFilter | null,
): boolean {
  if (!tree || tree.items.length === 0) return true
  const byId = fields instanceof Map ? fields : new Map(fields.map((f) => [f.id, f]))
  const results = tree.items.map((item) => {
    if (!isFilterGroup(item)) return evalCondition(item, props, byId)
    const r = combine(item.mode, item.items.map((c) => evalCondition(c, props, byId)))
    return r === null ? null : item.not ? !r : r
  })
  return combine(tree.mode, results) ?? true
}

// ---------------------------------------------------------------------------
// sub-items (docs/adr/2144-*)
// ---------------------------------------------------------------------------

/** The collection's "Parent item" field: a relation to itself marked subItems (at most one). */
export function subItemsField(fields: CollectionField[], collectionId?: string): CollectionField | null {
  return (
    fields.find(
      (f) => f.type === 'relation' && f.relation?.subItems === true && (!collectionId || f.relation.targetPageId === collectionId),
    ) ?? null
  )
}

/** The parent id stored in a row (first link of the parent field), or null. */
export function parentOf(props: Record<string, unknown>, field: CollectionField | null): string | null {
  if (!field) return null
  const v = props[field.id]
  return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null
}

/** Deepest nesting shown and followed (MCP depth, table indentation). */
export const SUB_ITEMS_MAX_DEPTH = 8

export interface TreeRow<R> {
  row: R
  depth: number
  /** visible children in this list */
  childCount: number
}

/**
 * Order rows as a tree: each row followed by its children (in the order of `rows`), depth-first. A
 * row whose parent is not in `rows` (filtered out, trashed, hidden from the viewer) is a top-level
 * row. `collapsed` row ids hide their descendants. Rows past SUB_ITEMS_MAX_DEPTH stay flat at that
 * depth. A cycle (should never be stored; the server refuses one) breaks at the first repeat.
 */
export function treeRows<R extends Pick<RowDTO, 'id' | 'props'>>(
  rows: R[],
  field: CollectionField | null,
  collapsed: ReadonlySet<string> = new Set(),
): TreeRow<R>[] {
  if (!field) return rows.map((row) => ({ row, depth: 0, childCount: 0 }))
  const ids = new Set(rows.map((r) => r.id))
  const children = new Map<string, R[]>()
  const roots: R[] = []
  for (const r of rows) {
    const p = parentOf(r.props, field)
    if (p && p !== r.id && ids.has(p)) {
      const list = children.get(p)
      if (list) list.push(r)
      else children.set(p, [r])
    } else roots.push(r)
  }
  const out: TreeRow<R>[] = []
  const seen = new Set<string>()
  const walk = (r: R, depth: number) => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    const kids = children.get(r.id) ?? []
    out.push({ row: r, depth: Math.min(depth, SUB_ITEMS_MAX_DEPTH), childCount: kids.length })
    if (collapsed.has(r.id)) {
      // hidden descendants still count as placed (they are not orphans)
      const hide = (x: R) => {
        if (seen.has(x.id)) return
        seen.add(x.id)
        for (const k of children.get(x.id) ?? []) hide(k)
      }
      for (const k of kids) hide(k)
      return
    }
    for (const k of kids) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  // rows only reachable through a cycle: shown at the top level
  for (const r of rows) if (!seen.has(r.id)) walk(r, 0)
  return out
}
