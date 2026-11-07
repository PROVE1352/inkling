import type { SidebarPrefsDTO } from '@inkling/shared'

// Sidebar menu customization (docs/adr/1020-*): pure functions that turn the stored preference
// ({ order, hidden }) plus the menus this build knows into what the sidebar shows, and back.
//
// Rules:
// - Ids this build does not know are ignored for display (a newer device may have saved them) but
//   kept when this device saves, so two app versions do not erase each other's choices.
// - A known menu missing from `order` (added in a later release) shows at its default position:
//   right after the nearest menu that precedes it in the default order.
// - Nothing stored = every menu, default order.

export type SidebarEntry = { id: string; hidden: boolean }

/** Inserts `ids` into `base`, each right after its nearest predecessor in `reference` already in the result (else at the front). */
function insertByReference(base: string[], reference: readonly string[], ids: readonly string[]): string[] {
  const out = [...base]
  for (const id of ids) {
    if (out.includes(id)) continue
    const at = reference.indexOf(id)
    let pos = 0
    for (let i = at - 1; i >= 0; i--) {
      const j = out.indexOf(reference[i])
      if (j !== -1) {
        pos = j + 1
        break
      }
    }
    out.splice(pos, 0, id)
  }
  return out
}

/** Every known menu in display order with its hidden flag (the settings list). */
export function resolveSidebarMenu(prefs: SidebarPrefsDTO | null | undefined, known: readonly string[]): SidebarEntry[] {
  const knownSet = new Set(known)
  const saved = [...new Set((prefs?.order ?? []).filter((id) => knownSet.has(id)))]
  const order = insertByReference(saved, known, known.filter((id) => !saved.includes(id)))
  const hidden = new Set(prefs?.hidden ?? [])
  return order.map((id) => ({ id, hidden: hidden.has(id) }))
}

/** The menus the sidebar shows, in order. */
export function visibleSidebarMenu(prefs: SidebarPrefsDTO | null | undefined, known: readonly string[]): string[] {
  return resolveSidebarMenu(prefs, known)
    .filter((e) => !e.hidden)
    .map((e) => e.id)
}

/**
 * The value to store for an edited list. Keeps ids from `prev` this build does not know (in place in
 * `order`, as-is in `hidden`); collapses to `{ order: [], hidden: [] }` when the result equals the default.
 */
export function toSidebarPrefs(
  entries: readonly SidebarEntry[],
  known: readonly string[],
  prev: SidebarPrefsDTO | null | undefined,
): SidebarPrefsDTO {
  const knownSet = new Set(known)
  const prevOrder = prev?.order ?? []
  const unknownOrder = prevOrder.filter((id) => !knownSet.has(id))
  const unknownHidden = (prev?.hidden ?? []).filter((id) => !knownSet.has(id))
  const knownOrder = entries.map((e) => e.id).filter((id) => knownSet.has(id))
  const isDefaultOrder = knownOrder.length === known.length && knownOrder.every((id, i) => id === known[i])
  const hidden = [...entries.filter((e) => e.hidden && knownSet.has(e.id)).map((e) => e.id), ...unknownHidden]
  const order =
    isDefaultOrder && unknownOrder.length === 0 ? [] : insertByReference(knownOrder, prevOrder, unknownOrder)
  return { order, hidden: [...new Set(hidden)] }
}

/** Moves the entry at `from` to `to` (array move). Out-of-range indexes leave the list unchanged. */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list]
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

/** Shows or hides one menu. */
export function setEntryHidden(list: readonly SidebarEntry[], id: string, hidden: boolean): SidebarEntry[] {
  return list.map((e) => (e.id === id ? { ...e, hidden } : e))
}
