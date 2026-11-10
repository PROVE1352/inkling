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

// --- fitting the menus above the page tree (docs/adr/1640-*, 1643-*, with the card: 2384-*) -----------

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

/**
 * While the person has "More" open, the page tree gives way down to this height (docs/adr/1643-*):
 * the section header and two or three rows, and never more than it keeps when the menus are folded.
 */
export const SIDEBAR_TREE_FLOOR_EXPANDED = 120

export function expandedTreeMinHeight(treeMin: number): number {
  return Math.min(treeMin, SIDEBAR_TREE_FLOOR_EXPANDED)
}

/** Height of the "k more below" row the open list gets when even the smaller tree leaves too little room. */
export const MENUS_MORE_BELOW_ROW = 24

/**
 * Layout of the open "More" list (docs/adr/1643-*). `available` and `treeMin` are the folded state's
 * budget (what `menusThatFit` gets), so opening the list never changes whether the menus fold.
 * The list takes the room of the tree minimum down to `expandedTreeMinHeight`, less one row for
 * "Show less". When every menu fits there, all of them show (`maxHeight` null). Otherwise the list
 * scrolls in whole rows above a "k more below" row.
 */
export function expandedMenusLayout({
  count,
  available,
  treeMin,
  rowHeight,
}: {
  count: number
  available: number
  treeMin: number
  rowHeight: number
}): { treeMin: number; maxHeight: number | null } {
  const floor = expandedTreeMinHeight(treeMin)
  if (!(rowHeight > 0)) return { treeMin: floor, maxHeight: null }
  const room = available + treeMin - floor - rowHeight
  if (count * rowHeight <= room) return { treeMin: floor, maxHeight: null }
  const rows = Math.max(1, Math.floor((room - MENUS_MORE_BELOW_ROW) / rowHeight))
  return { treeMin: floor, maxHeight: rows * rowHeight }
}

/**
 * What the "Getting started" card says about its own size, margins included (docs/adr/2384-*).
 * `open` is the height of the open card with nothing cut, or null when the person folded it.
 */
export type SidebarCardSize = {
  /** drawn folded: the title row and the progress bar */
  folded: number
  /** drawn open with every item, or null: the person folded the card */
  open: number | null
  /** the smallest open card worth drawing: title row, progress bar and the first two items */
  minOpen: number
}

export type SidebarLayout = {
  /** menus shown above the tree while "More" is closed (the count in "More (k)" is the rest) */
  shown: number
  folding: boolean
  /** "More" open: the open list's layout (`expandedMenusLayout`); null while closed or nothing folds */
  open: { treeMin: number; maxHeight: number | null } | null
  /** the page tree's minimum height */
  navMin: number
  /** the card: drawn open in at most `height` px (it scrolls inside when its items need more), or folded */
  card: { open: boolean; height: number } | null
}

/**
 * The whole sidebar budget with the "Getting started" card in it (docs/adr/1640-*, 1643-*, 2384-*).
 * `free` is the sidebar height less every row that is not the menus, the tree or the card.
 *
 * Order (ADR 1643, then 2384): the tree keeps at least `expandedTreeMinHeight` (120 px); "More" opened
 * reaches every folded menu; the open card gets what is left. The card is drawn open only in the room
 * left after the tree floor and the menus' least (one row while "More" is closed, every menu plus
 * "Show less" while it is open), scrolling inside when its items need more, and is drawn folded when
 * that room cannot hold `minOpen`. Whether the menus fold is decided with the card as it is drawn while
 * "More" is closed, so opening "More" never changes the count. Without a card it is exactly
 * `menusThatFit` + `expandedMenusLayout` with the tree minimum `treeMin`.
 */
export function sidebarLayout({
  free,
  count,
  rowHeight,
  treeMin,
  expanded,
  card,
}: {
  free: number
  count: number
  rowHeight: number
  treeMin: number
  /** the person's "More" open/closed state */
  expanded: boolean
  card: SidebarCardSize | null
}): SidebarLayout {
  const floor = expandedTreeMinHeight(treeMin)
  const row = rowHeight > 0 ? rowHeight : 0
  const draw = (room: number) => {
    if (!card) return null
    if (card.open == null || room < card.minOpen) return { open: false, height: card.folded }
    return { open: true, height: Math.min(card.open, Math.floor(room)) }
  }
  const closedCard = draw(free - floor - (count > 0 ? row : 0))
  const closedH = closedCard?.height ?? 0
  const shown = menusThatFit({ count, available: free - closedH - treeMin, rowHeight })
  const folding = shown < count
  if (folding && expanded) {
    const openCard = draw(free - floor - (count + 1) * row)
    const open = expandedMenusLayout({ count, available: free - (openCard?.height ?? 0) - treeMin, treeMin, rowHeight })
    return { shown, folding, open, navMin: open.treeMin, card: openCard }
  }
  // An open card may take the tree below `treeMin`, never below the floor.
  const menusH = (shown + (folding ? 1 : 0)) * row
  const navMin = card ? Math.min(treeMin, Math.max(floor, free - closedH - menusH)) : treeMin
  return { shown, folding, open: null, navMin, card: closedCard }
}

/**
 * Rows of a scrolled list that are not wholly inside its box: `above` the top edge, `below` the bottom
 * edge. A row cut by an edge counts as out of view.
 */
export function rowsOutOfView({
  count,
  rowHeight,
  scrollTop,
  clientHeight,
}: {
  count: number
  rowHeight: number
  scrollTop: number
  clientHeight: number
}): { above: number; below: number } {
  if (!(rowHeight > 0) || count <= 0) return { above: 0, below: 0 }
  // 1 px of slack: fractional scroll positions on zoomed or high-DPI screens
  const above = Math.min(count, Math.max(0, Math.ceil((scrollTop - 1) / rowHeight)))
  const lastWhole = Math.floor((scrollTop + clientHeight + 1) / rowHeight)
  const below = Math.max(0, count - Math.max(above, lastWhole))
  return { above, below }
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
