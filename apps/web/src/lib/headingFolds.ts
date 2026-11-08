// Folding a document at its headings, Obsidian style (docs/adr/1221-heading-folds-per-device.md).
//
// A fold is a view setting, not an edit: the folded heading ids live in this device's localStorage per
// page and nothing is written to the collaborative document. What a fold hides is computed from the
// current ProseMirror doc on every change:
//   - top-level headings only (blocks directly in the root blockGroup; nested headings do not fold);
//   - a folded heading hides the top-level blocks after it up to the next heading of the same or a
//     higher level (H2 folds until the next H1 or H2), and its own nested children.
// The hiding itself is a generated stylesheet keyed by block id (components/HeadingFolds.tsx), so the
// editor's DOM is never touched. A block created after the last computation is not in the list yet,
// and the selection entering a hidden block unfolds its heading (`foldsToOpen`), so the caret never
// sits in a block that cannot be laid out (the failure class of docs/adr/0850-*).

/** Minimal structural view of a ProseMirror node (same idea as lib/docOutline.ts). */
export type FoldNode = {
  type: { name: string }
  attrs: Record<string, unknown>
  childCount: number
  child: (i: number) => FoldNode
  nodeSize: number
}

export type FoldLayout = {
  /** Folded heading ids that exist as top-level headings in this doc (stale ids dropped). */
  active: string[]
  /** Top-level block id → the folded heading that hides it (the outermost one). */
  hiddenBy: Map<string, string>
  /** Folded headings whose own nested children are hidden too. */
  withChildren: string[]
}

/** Root blockGroup of a BlockNote doc (doc → blockGroup → blockContainer*). */
function rootGroup(doc: FoldNode): FoldNode | null {
  for (let i = 0; i < doc.childCount; i++) {
    const c = doc.child(i)
    if (c.type.name === 'blockGroup') return c
  }
  return null
}

/** Heading level of a blockContainer (0 = not a heading). */
export function headingLevel(container: FoldNode): number {
  if (container.childCount === 0) return 0
  const content = container.child(0)
  if (content.type.name !== 'heading') return 0
  const level = Number(content.attrs.level ?? 1)
  return Number.isFinite(level) && level > 0 ? level : 1
}

function hasChildren(container: FoldNode): boolean {
  for (let i = 1; i < container.childCount; i++) {
    const c = container.child(i)
    if (c.type.name === 'blockGroup' && c.childCount > 0) return true
  }
  return false
}

/** Which top-level blocks the folded headings hide, in one pass over the root group. */
export function foldLayout(doc: FoldNode, folded: ReadonlySet<string>): FoldLayout {
  const active: string[] = []
  const hiddenBy = new Map<string, string>()
  const withChildren: string[] = []
  const group = folded.size ? rootGroup(doc) : null
  if (!group) return { active, hiddenBy, withChildren }
  // The outermost open fold: its heading id and level. Blocks are hidden while it lasts.
  let owner: string | null = null
  let ownerLevel = 0
  for (let i = 0; i < group.childCount; i++) {
    const c = group.child(i)
    const id = String(c.attrs.id ?? '')
    const level = headingLevel(c)
    if (owner && level && level <= ownerLevel) owner = null
    if (owner) {
      if (id) hiddenBy.set(id, owner)
      // a folded heading inside a hidden range is still remembered as folded
      if (level && folded.has(id)) active.push(id)
      continue
    }
    if (level && folded.has(id)) {
      active.push(id)
      owner = id
      ownerLevel = level
      if (hasChildren(c)) withChildren.push(id)
    }
  }
  return { active, hiddenBy, withChildren }
}

/** Selection position resolved against the doc (the parts of ProseMirror's ResolvedPos used here). */
export type FoldPos = { depth: number; node: (depth: number) => FoldNode; index: (depth: number) => number }

/**
 * Folds to open because the selection [from, to] reaches into them: a hidden top-level block, the hidden
 * children of a folded heading, or a range that spans hidden blocks (select-all, shift-click over a fold).
 * Depths follow BlockNote's layout: 0 doc, 1 root blockGroup, 2 top-level blockContainer, 3 its content
 * or its child blockGroup.
 */
export function foldsToOpen(
  layout: FoldLayout,
  $from: FoldPos,
  $to: FoldPos,
  group: FoldNode | null,
): Set<string> {
  const open = new Set<string>()
  if (!layout.active.length) return open
  const visit = ($p: FoldPos) => {
    if ($p.depth < 2) return
    const top = $p.node(2)
    const id = String(top.attrs.id ?? '')
    const by = layout.hiddenBy.get(id)
    if (by) open.add(by)
    // inside a folded heading's own nested children
    if ($p.depth >= 3 && $p.node(3).type.name === 'blockGroup' && layout.withChildren.includes(id)) open.add(id)
  }
  visit($from)
  visit($to)
  if (group && $from.depth >= 2 && $to.depth >= 2) {
    const a = $from.index(1)
    const b = $to.index(1)
    for (let i = a + 1; i < b && i < group.childCount; i++) {
      const by = layout.hiddenBy.get(String(group.child(i).attrs.id ?? ''))
      if (by) open.add(by)
    }
  }
  return open
}

/**
 * The heading the fold shortcut (⌘. / Ctrl+.) acts on for a caret at `$pos`: the top-level heading the
 * caret is in, otherwise the nearest top-level heading above the caret's top-level block (the section it
 * is reading). `inHeading` is false when the caret is in the section's body or in the heading's own
 * nested children; folding then has to move the caret onto the heading first, or the selection would
 * reopen the fold at once (`foldsToOpen`). Null before the first heading or outside the root group.
 */
export function foldTarget(
  $pos: FoldPos,
  group: FoldNode | null,
): { id: string; inHeading: boolean } | null {
  if (!group || $pos.depth < 2) return null
  const top = $pos.node(2)
  const inHeading = $pos.depth >= 3 && $pos.node(3).type.name === 'heading'
  if (inHeading) return { id: String(top.attrs.id ?? ''), inHeading: true }
  for (let i = Math.min($pos.index(1), group.childCount - 1); i >= 0; i--) {
    const c = group.child(i)
    if (headingLevel(c)) return { id: String(c.attrs.id ?? ''), inHeading: false }
  }
  return null
}

/** Stylesheet hiding what the layout hides; screen only, so printing shows the whole document. */
export function foldCss(layout: FoldLayout, escape: (s: string) => string = cssEscape): string {
  const sel: string[] = []
  for (const id of layout.hiddenBy.keys()) sel.push(`.bn-block-outer[data-id="${escape(id)}"]`)
  for (const id of layout.withChildren)
    sel.push(`.bn-block-outer[data-id="${escape(id)}"] > .bn-block > .bn-block-group`)
  if (!sel.length) return ''
  // "…" after the text of a folded heading that hides something (docs/adr/1271-*). A pseudo-element: not
  // a DOM node, so ProseMirror never sees it and the caret cannot enter it. The empty alternative text
  // keeps screen readers from reading it (the arrow says "Unfold section").
  const owners = new Set<string>([...layout.hiddenBy.values(), ...layout.withChildren])
  const more = [...owners].map(
    (id) => `.bn-block-outer[data-id="${escape(id)}"] > .bn-block > .bn-block-content > .bn-inline-content::after`,
  )
  return (
    `@media screen {\n${sel.join(',\n')} { display: none !important; }\n` +
    `${more.join(',\n')} { content: "\\2026"; content: "\\2026" / ""; ${FOLD_MORE_STYLE} }\n}`
  )
}

/** The "…" marker's look; colours are the theme's tokens, so light and dark both work. */
const FOLD_MORE_STYLE =
  'margin-inline-start: 0.4em; padding: 0.1em 0.45em; border-radius: 4px; font-size: 0.6em; line-height: 1; ' +
  'vertical-align: 0.2em; font-weight: 400; ' +
  'color: var(--color-sub); background: var(--color-hover); pointer-events: none; user-select: none;'


function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

// --- Storage: per device, per page -------------------------------------------------------------

const KEY = 'inkling:folds'
/** Pages remembered; the least recently changed are dropped beyond this. */
export const MAX_FOLD_PAGES = 300

type Stored = Record<string, { ids: string[]; t: number }>

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return v && typeof v === 'object' ? (v as Stored) : {}
  } catch {
    return {}
  }
}

export function loadFolds(pageId: string): string[] {
  const e = readAll()[pageId]
  return e && Array.isArray(e.ids) ? e.ids.filter((x) => typeof x === 'string') : []
}

/** Saves one page's folds; an empty list removes the page, and the key goes when nothing is left. */
export function saveFolds(pageId: string, ids: readonly string[], now = Date.now()): void {
  try {
    const all = readAll()
    if (ids.length) all[pageId] = { ids: [...ids], t: now }
    else delete all[pageId]
    const pages = Object.keys(all)
    if (pages.length > MAX_FOLD_PAGES) {
      pages.sort((a, b) => all[a].t - all[b].t)
      for (const p of pages.slice(0, pages.length - MAX_FOLD_PAGES)) delete all[p]
    }
    if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all))
    else localStorage.removeItem(KEY)
  } catch {
    // storage unavailable: folds last for this view only
  }
}

// --- Reveal hook for the page's jump paths (?block=, outline, comments, mini outline) ---------------

let revealer: ((blockId: string) => boolean) | null = null

/** HeadingFolds registers the open page's revealer; null on unmount. */
export function setFoldRevealer(fn: ((blockId: string) => boolean) | null): void {
  revealer = fn
}

/** Opens the fold that hides `blockId`, if any. Returns true when something was unfolded. */
export function revealBlock(blockId: string): boolean {
  return revealer ? revealer(blockId) : false
}

/** Fired on window after folds change the layout (comment badges and the mini outline re-measure). */
export const FOLDS_EVENT = 'inkling:folds'
