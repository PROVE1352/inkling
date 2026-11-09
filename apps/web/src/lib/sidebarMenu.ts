import type { SidebarPrefsDTO } from '@inkling/shared'

// Sidebar menu customization (docs/adr/1020-*): pure functions that turn the stored preference
// ({ order, hidden }) plus the menus this build knows into what the sidebar shows, and back.
//
// Rules:
// - Ids this build does not know are ignored for display (a newer device may have saved them) but
//   kept when this device saves, so two app versions do not erase each other's choices.
// - A known menu missing from `order` (added in a later release) shows at its default position:
//   right after the nearest menu that precedes it in the default order.
// - Nothing stored = default order, with `defaultHidden` hidden (0.13: four menus, docs/adr/1641-*).
//   A stored value keeps its earlier meaning: every menu not in its `hidden` list shows.

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

const isEmptyPrefs = (prefs: SidebarPrefsDTO | null | undefined) => !prefs?.order?.length && !prefs?.hidden?.length

/** Every known menu in display order with its hidden flag (the settings list). */
export function resolveSidebarMenu(
  prefs: SidebarPrefsDTO | null | undefined,
  known: readonly string[],
  defaultHidden: readonly string[] = [],
): SidebarEntry[] {
  const knownSet = new Set(known)
  const saved = [...new Set((prefs?.order ?? []).filter((id) => knownSet.has(id)))]
  const order = insertByReference(saved, known, known.filter((id) => !saved.includes(id)))
  const hidden = new Set(isEmptyPrefs(prefs) ? defaultHidden : (prefs?.hidden ?? []))
  return order.map((id) => ({ id, hidden: hidden.has(id) }))
}

/** The menus the sidebar shows, in order. */
export function visibleSidebarMenu(
  prefs: SidebarPrefsDTO | null | undefined,
  known: readonly string[],
  defaultHidden: readonly string[] = [],
): string[] {
  return resolveSidebarMenu(prefs, known, defaultHidden)
    .filter((e) => !e.hidden)
    .map((e) => e.id)
}

/**
 * The value to store for an edited list. Keeps ids from `prev` this build does not know (in place in
 * `order`, as-is in `hidden`); collapses to `{ order: [], hidden: [] }` when the result equals the default
 * (default order, exactly `defaultHidden` hidden). A list that differs from the default but would store as
 * two empty lists (every menu shown, default order) stores its order instead, so it is not read back as the
 * default.
 */
export function toSidebarPrefs(
  entries: readonly SidebarEntry[],
  known: readonly string[],
  prev: SidebarPrefsDTO | null | undefined,
  defaultHidden: readonly string[] = [],
): SidebarPrefsDTO {
  const knownSet = new Set(known)
  const prevOrder = prev?.order ?? []
  const unknownOrder = prevOrder.filter((id) => !knownSet.has(id))
  const unknownHidden = (prev?.hidden ?? []).filter((id) => !knownSet.has(id))
  const knownOrder = entries.map((e) => e.id).filter((id) => knownSet.has(id))
  const isDefaultOrder = knownOrder.length === known.length && knownOrder.every((id, i) => id === known[i])
  const hidden = [...entries.filter((e) => e.hidden && knownSet.has(e.id)).map((e) => e.id), ...unknownHidden]
  const hiddenOut = [...new Set(hidden)]
  const knownHidden = hiddenOut.filter((id) => knownSet.has(id))
  const isDefaultHidden =
    unknownHidden.length === 0 &&
    knownHidden.length === defaultHidden.filter((id) => knownSet.has(id)).length &&
    knownHidden.every((id) => defaultHidden.includes(id))
  if (isDefaultOrder && unknownOrder.length === 0 && isDefaultHidden) return { order: [], hidden: [] }
  const order =
    isDefaultOrder && unknownOrder.length === 0 && hiddenOut.length > 0
      ? []
      : insertByReference(knownOrder, prevOrder, unknownOrder)
  return { order, hidden: hiddenOut }
}

// --- fitting the menus above the page tree (docs/adr/1640-*) -----------------------------------------

/** Height the page tree always keeps: 40 % of the sidebar, at least 200 px, at most 280 px. */
export function sidebarTreeMinHeight(sidebarHeight: number): number {
  return Math.min(280, Math.max(200, Math.round(sidebarHeight * 0.4)))
}

/** Below this sidebar height the footer (trash, shortcuts, settings, account) is one row of icons. */
export const COMPACT_FOOTER_BELOW = 720

export function compactSidebarFooter(sidebarHeight: number): boolean {
  return sidebarHeight > 0 && sidebarHeight < COMPACT_FOOTER_BELOW
}

/**
 * How many menus show above the tree: all of them when they fit in `available` px, otherwise as many as
 * fit with one row kept for "More (k)". Never negative; an unmeasured row height shows everything.
 */
export function menusThatFit({ count, available, rowHeight }: { count: number; available: number; rowHeight: number }): number {
  if (!(rowHeight > 0)) return count
  if (count * rowHeight <= available) return count
  return Math.max(0, Math.min(count, Math.floor(available / rowHeight) - 1))
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
