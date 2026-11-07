// Per-field optimistic updates with targeted rollback (docs/adr/0853-react-query-optimistic-races.md).
//
// Rolling back a failed mutation by restoring a whole-cache snapshot also undoes every *other*
// optimistic change made after the snapshot (two quick renames/moves: the first fails → the second
// vanishes from the UI until the next refetch). Instead each mutation records, per item and field,
// the value it replaced and the value it wrote; rollback restores a field only while it still
// holds the value this mutation wrote (a later mutation or a refetch owns it otherwise).

/** Marks a field that did not exist before / should not exist after. */
const ABSENT: unique symbol = Symbol('absent')
type Slot = unknown | typeof ABSENT

export type FieldUndo = {
  id: string
  prev: Record<string, Slot>
  next: Record<string, Slot>
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Record + apply `patch` on `obj` (shallow). `deleteNullish` drops keys patched with null/undefined. */
function patchFields(
  obj: Record<string, unknown>,
  patch: Record<string, unknown>,
  deleteNullish: boolean,
): { out: Record<string, unknown>; prev: Record<string, Slot>; next: Record<string, Slot> } {
  const out = { ...obj }
  const prev: Record<string, Slot> = {}
  const next: Record<string, Slot> = {}
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = has(obj, k) ? obj[k] : ABSENT
    if (deleteNullish && (v === null || v === undefined)) {
      delete out[k]
      next[k] = ABSENT
    } else {
      out[k] = v
      next[k] = v
    }
  }
  return { out, prev, next }
}

/** Restore the fields of `obj` that still hold the value `next` wrote. Returns `obj` if none. */
export function revertFields<T extends Record<string, unknown>>(
  obj: T,
  prev: Record<string, Slot>,
  next: Record<string, Slot>,
): T {
  let out: Record<string, unknown> | null = null
  for (const k of Object.keys(next)) {
    const cur: Slot = has(obj, k) ? obj[k] : ABSENT
    if (!Object.is(cur, next[k])) continue // someone else wrote this field since
    out ??= { ...obj }
    if (prev[k] === ABSENT) delete out[k]
    else out[k] = prev[k]
  }
  return (out as T | null) ?? obj
}

/** Shallow-patch items by id. Items not in the list are skipped (nothing to roll back). */
export function patchItems<T extends { id: string }>(
  list: readonly T[],
  patches: ReadonlyMap<string, Partial<T>>,
): { list: T[]; undo: FieldUndo[] } {
  const undo: FieldUndo[] = []
  const out = list.map((item) => {
    const patch = patches.get(item.id)
    if (!patch) return item
    const r = patchFields(item as Record<string, unknown>, patch as Record<string, unknown>, false)
    undo.push({ id: item.id, prev: r.prev, next: r.next })
    return r.out as T
  })
  return { list: out, undo }
}

/** Undo `patchItems` on the *current* list, field by field. */
export function revertItems<T extends { id: string }>(list: readonly T[], undo: readonly FieldUndo[]): T[] {
  if (undo.length === 0) return list as T[]
  const byId = new Map(undo.map((u) => [u.id, u]))
  return list.map((item) => {
    const u = byId.get(item.id)
    return u ? revertFields(item as Record<string, unknown>, u.prev, u.next) as T : item
  })
}

/** Merge `props` into one row's `props` (null/undefined deletes, like the server's PATCH). */
export function patchRowProps<R extends { id: string; props: Record<string, unknown> }>(
  rows: readonly R[],
  id: string,
  props: Record<string, unknown>,
): { rows: R[]; undo: FieldUndo | null } {
  let undo: FieldUndo | null = null
  const out = rows.map((r) => {
    if (r.id !== id) return r
    const p = patchFields(r.props, props, true)
    undo = { id, prev: p.prev, next: p.next }
    return { ...r, props: p.out }
  })
  return { rows: out, undo }
}

export function revertRowProps<R extends { id: string; props: Record<string, unknown> }>(
  rows: readonly R[],
  undo: FieldUndo | null,
): R[] {
  if (!undo) return rows as R[]
  return rows.map((r) => {
    if (r.id !== undo.id) return r
    const props = revertFields(r.props, undo.prev, undo.next)
    return props === r.props ? r : { ...r, props }
  })
}
