/**
 * Sub-items in the table and list views (docs/adr/2144-*): the rows a view shows (filtered and
 * sorted by applyView) ordered as a tree with the shared `treeRows`, plus the per-browser collapse
 * state. A row whose parent is filtered out is a top-level row (treeRows does that).
 */
import { subItemsField, treeRows } from '@inkling/shared'
import type { CollectionField, RowDTO, ViewConfig } from '@inkling/shared'

export interface RowTreeMeta {
  depth: number
  /** visible children in this list (a collapsed row still counts its children) */
  childCount: number
}

export interface ViewTree<R> {
  /** rows in display order, descendants of collapsed rows left out */
  rows: R[]
  /** depth and child count by row id; null when the view shows rows flat */
  meta: Map<string, RowTreeMeta> | null
  /** the collection's "Parent item" field, or null */
  parentField: CollectionField | null
}

/**
 * Display rows of a table or list view. Nested (the default when the collection has a sub-items
 * field) unless the view says `subItems: 'flat'`; `collectionId` narrows the field to a relation to
 * this collection itself.
 */
export function viewTree<R extends Pick<RowDTO, 'id' | 'props'>>(
  rows: R[],
  fields: CollectionField[],
  config: Pick<ViewConfig, 'subItems'>,
  collapsed: ReadonlySet<string> = new Set(),
  collectionId?: string,
): ViewTree<R> {
  const parentField = subItemsField(fields, collectionId)
  if (!parentField || config.subItems === 'flat') return { rows, meta: null, parentField }
  const tree = treeRows(rows, parentField, collapsed)
  const meta = new Map<string, RowTreeMeta>()
  for (const t of tree) meta.set(t.row.id, { depth: t.depth, childCount: t.childCount })
  return { rows: tree.map((t) => t.row), meta, parentField }
}

const COLLAPSE_KEY = (viewId: string) => `inkling.subitems.collapsed.${viewId}`
/** ids kept per view (oldest dropped) so the stored list stays small */
const COLLAPSE_MAX = 500

/** Collapsed rows of a view in this browser (empty when storage is unavailable). */
export function loadCollapsed(viewId: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSE_KEY(viewId))
    const list: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveCollapsed(viewId: string, ids: ReadonlySet<string>): void {
  try {
    const list = [...ids].slice(-COLLAPSE_MAX)
    if (list.length) globalThis.localStorage?.setItem(COLLAPSE_KEY(viewId), JSON.stringify(list))
    else globalThis.localStorage?.removeItem(COLLAPSE_KEY(viewId))
  } catch {
    // private window, blocked storage: the state lasts until reload
  }
}

/** Toggle a row; returns the new set (a fresh object, for React state). */
export function toggleCollapsed(ids: ReadonlySet<string>, rowId: string): Set<string> {
  const next = new Set(ids)
  if (next.has(rowId)) next.delete(rowId)
  else next.add(rowId)
  return next
}
