import { z } from 'zod'

// Sidebar menu customization (docs/adr/1020-*): which top-of-sidebar menus a person shows and in
// what order. Stored per user on the server so every device shows the same sidebar.
//
// The stored value describes a preference, not the menu: `order` is the order the person last
// arranged, `hidden` the ids they hid. Menus added in a later version are not in either list, so
// they show at their default position; ids a client does not know are ignored when merging. The
// server therefore validates the shape (id syntax, lengths), never the vocabulary.

/** Built-in top-of-sidebar menus in their default order (all visible by default). */
export const SIDEBAR_MENU_IDS = ['search', 'later', 'threads', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity', 'today'] as const
export type SidebarMenuId = (typeof SIDEBAR_MENU_IDS)[number]

/** Upper bound per list. Well above the menu count, small enough to keep the row tiny. */
export const SIDEBAR_PREFS_MAX_IDS = 32

const sidebarIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'Invalid menu id')
const idListSchema = z
  .array(sidebarIdSchema)
  .max(SIDEBAR_PREFS_MAX_IDS)
  // Duplicates carry no meaning: keep the first occurrence.
  .transform((ids) => [...new Set(ids)])

/** PUT /me/sidebar body. `{ order: [], hidden: [] }` means "back to the default". */
export const sidebarPrefsSchema = z.object({
  order: idListSchema,
  hidden: idListSchema,
})
export type SidebarPrefsInput = z.input<typeof sidebarPrefsSchema>

export interface SidebarPrefsDTO {
  /** Menu ids in the order the person arranged them (may be empty = default order). */
  order: string[]
  /** Menu ids the person hid from the sidebar. */
  hidden: string[]
}

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefsDTO = { order: [], hidden: [] }
