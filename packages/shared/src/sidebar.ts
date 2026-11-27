import { z } from 'zod'

// Sidebar menu customization (docs/adr/1020-*): which top-of-sidebar menus a person shows and in
// what order. Stored per user on the server so every device shows the same sidebar.
//
// The stored value describes a preference, not the menu: `order` is the order the person last
// arranged, `hidden` the ids they hid. Menus added in a later version are not in either list, so
// they show at their default position; ids a client does not know are ignored when merging. The
// server therefore validates the shape (id syntax, lengths), never the vocabulary.

/** Built-in top-of-sidebar menus in their default order. */
export const SIDEBAR_MENU_IDS = ['search', 'later', 'threads', 'graph', 'tags', 'shared', 'due', 'calendar', 'activity', 'today'] as const
export type SidebarMenuId = (typeof SIDEBAR_MENU_IDS)[number]

/**
 * Menus a person who never arranged the sidebar does not see (docs/adr/1641-*). Applies only while
 * nothing is stored (`{ order: [], hidden: [] }`); a stored value keeps its 0.12 meaning, every menu not
 * in `hidden` shows. Default visible: search, later, due, calendar.
 */
export const SIDEBAR_MENU_DEFAULT_HIDDEN: readonly SidebarMenuId[] = ['threads', 'graph', 'tags', 'shared', 'activity', 'today']

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

// ---------------------------------------------------------------------------
// Sibling order in the page tree (docs/adr/2590-*, 2591-*)
//
// The server orders GET /workspaces/:id/pages with `orderPageTree` and the web app orders its cached
// copy with the same function, so the sidebar, list_pages and the web app's drag logic agree.
// ---------------------------------------------------------------------------

/** How a parent orders its children: by drag order (sort_order) or by title. */
export const CHILD_SORTS = ['manual', 'title'] as const
export const childSortSchema = z.enum(CHILD_SORTS)
export type ChildSort = z.infer<typeof childSortSchema>

/** Top-level order of the two sections: shared (whole workspace) and private (this person). Absent = manual. */
export interface RootSortDTO {
  shared?: 'title'
  private?: 'title'
}

/**
 * Title comparison for "sort by title": numbers inside titles compare as numbers ("2" before "10"),
 * case and accents do not matter. A fixed locale so the server and every browser give the same order.
 */
const titleCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export function compareTitles(a: string, b: string): number {
  return titleCollator.compare(a, b)
}

/** The fields the order needs (PageMetaDTO has them). */
export interface SiblingLike {
  id: string
  parentId: string | null
  scope: 'shared' | 'private'
  title: string
  sortOrder: number
  createdAt: string
  pinned?: boolean
  childSort?: ChildSort
}

/**
 * Order of two siblings: pinned ones first; then by title (mode 'title') or by drag order (mode
 * 'manual'); ties by sort_order, creation time and id, so the order is total and the same everywhere.
 */
export function compareSiblings(a: SiblingLike, b: SiblingLike, mode: ChildSort): number {
  const pa = a.pinned ? 1 : 0
  const pb = b.pinned ? 1 : 0
  if (pa !== pb) return pb - pa
  if (mode === 'title') {
    const c = compareTitles(a.title.trim(), b.title.trim())
    if (c !== 0) return c
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Mode of the children of `parent` (null = a top-level page of `scope`'s section). */
export function childSortOf(parent: SiblingLike | null, scope: 'shared' | 'private', rootSort: RootSortDTO | undefined): ChildSort {
  if (parent) return parent.childSort === 'title' ? 'title' : 'manual'
  return rootSort?.[scope] === 'title' ? 'title' : 'manual'
}

/**
 * Sorts one group of siblings in place: the children of `parent`, or (parent null) the top level. At the
 * top level the two sections keep their drag order interleaved as before while both are manual; once one
 * is sorted by title, the shared section comes first and each follows its own setting. Either way the
 * order inside each section is the sidebar's.
 */
export function sortSiblingGroup<T extends SiblingLike>(list: T[], parent: SiblingLike | null, rootSort?: RootSortDTO): T[] {
  if (parent || (rootSort?.shared !== 'title' && rootSort?.private !== 'title')) {
    const mode = parent ? childSortOf(parent, 'shared', rootSort) : 'manual'
    return list.sort((a, b) => compareSiblings(a, b, mode))
  }
  return list.sort((a, b) => {
    const sa = a.scope === 'private' ? 1 : 0
    const sb = b.scope === 'private' ? 1 : 0
    if (sa !== sb) return sa - sb
    return compareSiblings(a, b, childSortOf(null, a.scope === 'private' ? 'private' : 'shared', rootSort))
  })
}

/**
 * The page list in tree order: each parent's children sorted by `compareSiblings`, written out depth
 * first (shared top level, then private). A page whose parent is not in the list counts as top level.
 * Returns a new array; the input is not changed.
 */
export function orderPageTree<T extends SiblingLike>(pages: readonly T[], rootSort?: RootSortDTO): T[] {
  const byId = new Map<string, T>()
  for (const p of pages) byId.set(p.id, p)
  const kids = new Map<string | null, T[]>()
  for (const p of pages) {
    const key = p.parentId && byId.has(p.parentId) ? p.parentId : null
    const list = kids.get(key)
    if (list) list.push(p)
    else kids.set(key, [p])
  }
  for (const [key, list] of kids) sortSiblingGroup(list, key === null ? null : (byId.get(key) ?? null), rootSort)
  const out: T[] = []
  const seen = new Set<string>()
  const walk = (list: T[]): void => {
    for (const p of list) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push(p)
      const c = kids.get(p.id)
      if (c) walk(c)
    }
  }
  walk(kids.get(null) ?? [])
  // cycles cannot happen (the server refuses them); anything not reached keeps its place at the end
  if (out.length < pages.length) for (const p of pages) if (!seen.has(p.id)) out.push(p)
  return out
}

/** PUT /pages/:id/pin (browser only, people who may edit the page). */
export const setPinnedSchema = z.object({ pinned: z.boolean() }).strict()
/** PUT /pages/:id/child-sort (browser only, people who may edit the page). */
export const setChildSortSchema = z.object({ childSort: childSortSchema }).strict()
/** PUT /workspaces/:id/root-sort (browser only): shared = any member, private = the caller's own. */
export const setRootSortSchema = z.object({ section: z.enum(['shared', 'private']), childSort: childSortSchema }).strict()
/** PUT /workspaces/:id/settings/agent-default-parent (browser only, owners and admins). null = unset. */
export const setAgentDefaultParentSchema = z.object({ pageId: z.uuid().nullable() }).strict()
