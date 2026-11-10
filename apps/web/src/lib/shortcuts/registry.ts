// Every keyboard shortcut and palette command of the app, in one table (docs/adr/1400-*, 1401-*).
//
// This file is data only (no React, no DOM, no t() calls — labels are i18n keys), so the conflict
// and label tests run under node:test. Who carries a command out is `via`:
//   app        the window keydown dispatcher (dispatch.ts) runs the handler a component bound
//              with useCommand(), or the built-in one in commands.ts
//   editor     our BlockNote extension (editorKeys.ts) puts the key in the editor's keymap
//   blocknote  BlockNote binds the key itself; listed for the help window, the palette and the
//              conflict test (the pinned editor is not patched for this)
//   tree       the sidebar tree's own onKeyDown matches the key through matchCommand()
//   table      the database table's own onKeyDown matches the key through matchCommand() (1407)
//   browser    a browser event does the work (copy/paste in the table); listed only
//   viewer     the image viewer's own keydown while it is open (components/imageViewer, 2386); fixed keys, listed only
//
// Keys come from currentKeys(): the defaults below, or the user's own keys from Settings ›
// Shortcuts (setKeyOverrides, docs/adr/1404-*). The overrides are plain module state here; reading
// and writing them in localStorage is overrides.ts, so this file stays free of the DOM.
import type { TKey } from '../../i18n'
import { canonicalKey, formatKey, type InInputs, type Platform } from './keys'

export type Scope = 'global' | 'page' | 'editor' | 'tree' | 'table' | 'ink' | 'viewer'
export type Via = 'app' | 'editor' | 'blocknote' | 'tree' | 'table' | 'browser' | 'viewer'
export type KeySpecs = { mac: string[]; other: string[] }

export type ShortcutDef = {
  id: string
  scope: Scope
  via: Via
  label: TKey
  /** A longer name for the palette (the help window keeps `label`); both are searchable. */
  paletteLabel?: TKey
  hint?: TKey
  /** Shown and bound; the first one is the primary key. Absent: a palette-only command. */
  keys?: KeySpecs
  /** Extra text shown next to the keys in the help window (a typed form such as "$…$"); not bound. */
  alsoTyped?: string[]
  /** Bound but not shown (an alias that only works in some browsers, or a second spelling). */
  extraKeys?: Partial<KeySpecs>
  inInputs?: InInputs
  /** Listed in the command palette (default: true when the command can run from there). */
  palette?: boolean
  /** Ids of commands this one overrides on purpose when both are live (it runs first). */
  shadows?: string[]
  /** Keys in RESERVED_KEYS that this command binds anyway, with the reason in docs/adr/1401-*. */
  reservedOk?: string[]
  /** false: the key cannot be changed in Settings (besides `blocknote` and `browser` commands, which never can). */
  remap?: false
}

const both = (...k: string[]): KeySpecs => ({ mac: k, other: k })

export const SHORTCUTS: readonly ShortcutDef[] = [
  // --- global: anywhere in a workspace ---------------------------------------------------------
  { id: 'app.search', scope: 'global', via: 'app', label: 'common.search', paletteLabel: 'palette.openSearch', keys: both('Mod-k') },
  { id: 'app.quickSwitcher', scope: 'global', via: 'app', label: 'shortcuts.quickSwitcher', paletteLabel: 'palette.quickSwitcher', keys: both('Mod-o') },
  {
    id: 'app.fullTextSearch',
    scope: 'global',
    via: 'app',
    label: 'shortcuts.fullTextSearch',
    paletteLabel: 'palette.fullTextSearch',
    keys: both('Mod-Shift-f'),
  },
  { id: 'app.palette', scope: 'global', via: 'app', label: 'shortcuts.commandPalette', keys: both('Mod-p'), palette: false },
  {
    id: 'app.newPage',
    scope: 'global',
    via: 'app',
    label: 'shortcuts.newPage',
    paletteLabel: 'palette.newDoc',
    // ⌘N/Ctrl+N reach the page only in the installed app; a browser tab opens a window (1401)
    keys: { mac: ['Mod-Alt-n', 'Mod-n'], other: ['Mod-Alt-n'] },
    extraKeys: { other: ['Mod-n'] },
    reservedOk: ['Mod-n'],
  },
  {
    id: 'nav.back',
    scope: 'global',
    via: 'app',
    label: 'common.back',
    keys: { mac: ['Mod-Alt-ArrowLeft'], other: ['Alt-ArrowLeft'] },
    extraKeys: { other: ['Mod-Alt-ArrowLeft'] },
    reservedOk: ['Mod-Alt-ArrowLeft'],
  },
  {
    id: 'nav.forward',
    scope: 'global',
    via: 'app',
    label: 'nav.forward',
    keys: { mac: ['Mod-Alt-ArrowRight'], other: ['Alt-ArrowRight'] },
    extraKeys: { other: ['Mod-Alt-ArrowRight'] },
    reservedOk: ['Mod-Alt-ArrowRight'],
  },
  { id: 'app.graph', scope: 'global', via: 'app', label: 'shortcuts.graph', keys: both('Mod-g') },
  { id: 'app.settings', scope: 'global', via: 'app', label: 'common.settings', keys: both('Mod-,') },
  { id: 'app.toggleSidebar', scope: 'global', via: 'app', label: 'shortcuts.toggleSidebar', paletteLabel: 'palette.toggleSidebar', keys: both('Mod-\\') },
  { id: 'app.help', scope: 'global', via: 'app', label: 'shortcuts.help', keys: both('?') },
  // palette-only commands
  { id: 'app.newFolder', scope: 'global', via: 'app', label: 'palette.newFolder' },
  { id: 'app.newDatabase', scope: 'global', via: 'app', label: 'palette.newDatabase' },
  { id: 'app.newCanvas', scope: 'global', via: 'app', label: 'palette.newCanvas' },
  { id: 'app.fromTemplate', scope: 'global', via: 'app', label: 'palette.fromTemplate' },
  { id: 'app.dailyToday', scope: 'global', via: 'app', label: 'palette.dailyToday' },
  { id: 'app.dailyYesterday', scope: 'global', via: 'app', label: 'palette.dailyYesterday' },
  { id: 'app.dailyTomorrow', scope: 'global', via: 'app', label: 'palette.dailyTomorrow' },
  { id: 'app.randomPage', scope: 'global', via: 'app', label: 'palette.randomPage' },
  { id: 'app.due', scope: 'global', via: 'app', label: 'palette.due' },
  { id: 'app.tags', scope: 'global', via: 'app', label: 'palette.tags' },
  { id: 'app.webShares', scope: 'global', via: 'app', label: 'palette.webShares' },
  { id: 'app.calendar', scope: 'global', via: 'app', label: 'palette.calendar' },
  { id: 'app.activity', scope: 'global', via: 'app', label: 'palette.activity' },
  { id: 'app.trash', scope: 'global', via: 'app', label: 'palette.openTrash' },
  { id: 'app.reload', scope: 'global', via: 'app', label: 'palette.reload' },
  { id: 'app.cycleTheme', scope: 'global', via: 'app', label: 'palette.cycleTheme' },
  { id: 'app.customizeSidebar', scope: 'global', via: 'app', label: 'palette.customizeSidebar' },
  { id: 'app.mcp', scope: 'global', via: 'app', label: 'palette.mcpConnections' },
  // Later and Threads (docs/adr/1410-*, 1412-*): no default key, like the other sidebar menus (the
  // chords that came up were taken: ⌘⌥L Safari's downloads, Ctrl+Alt+L/T lock screen and terminal on Linux)
  { id: 'app.later', scope: 'global', via: 'app', label: 'sidebar.later' },
  { id: 'app.threads', scope: 'global', via: 'app', label: 'sidebar.threads' },

  // --- page: while a page is open --------------------------------------------------------------
  {
    id: 'page.renameTitle',
    scope: 'page',
    via: 'app',
    label: 'shortcuts.renameTitle',
    hint: 'shortcuts.hintOutsideTree',
    keys: both('F2'),
    // from the editor body too, not from a field (the title itself, a comment box)
    inInputs: 'editable',
  },
  { id: 'page.properties', scope: 'page', via: 'app', label: 'shortcuts.openProperties', paletteLabel: 'palette.editProperties', keys: both('Mod-;') },
  { id: 'page.toggleRightPanel', scope: 'page', via: 'app', label: 'palette.toggleRightPanel', keys: both('Mod-Alt-\\') },
  { id: 'page.toggleFavorite', scope: 'page', via: 'app', label: 'cmd.toggleFavorite', keys: both('Mod-Alt-s') },
  { id: 'page.togglePen', scope: 'page', via: 'app', label: 'cmd.togglePen', keys: both('Mod-Alt-p') },
  // ⌘S would be the browser's "Save page as", ⌘⌥S is favorites: no default key (docs/adr/1410-*)
  { id: 'page.saveForLater', scope: 'page', via: 'app', label: 'cmd.saveForLater' },
  // Follow / unfollow the comment thread that has the focus (CommentsPanel). Not in the palette: the
  // palette takes the focus, so no thread is focused when it runs. No default key (docs/adr/1412-*).
  { id: 'thread.toggleFollow', scope: 'page', via: 'app', label: 'cmd.toggleFollowThread', palette: false },

  // --- editor: caret in a document body ---------------------------------------------------------
  { id: 'editor.slashMenu', scope: 'editor', via: 'blocknote', label: 'shortcuts.blockMenu', keys: both('/'), palette: false },
  { id: 'editor.bold', scope: 'editor', via: 'blocknote', label: 'shortcuts.bold', keys: both('Mod-b'), palette: false },
  { id: 'editor.italic', scope: 'editor', via: 'blocknote', label: 'shortcuts.italic', keys: both('Mod-i'), palette: false },
  { id: 'editor.underline', scope: 'editor', via: 'blocknote', label: 'cmd.underline', keys: both('Mod-u'), palette: false },
  { id: 'editor.strike', scope: 'editor', via: 'blocknote', label: 'cmd.strike', keys: both('Mod-Shift-s'), palette: false },
  { id: 'editor.code', scope: 'editor', via: 'blocknote', label: 'cmd.inlineCode', keys: both('Mod-e'), palette: false },
  { id: 'editor.inlineMath', scope: 'editor', via: 'editor', label: 'shortcuts.inlineMath', keys: both('Mod-Shift-e'), alsoTyped: ['$…$'] },
  { id: 'editor.paragraph', scope: 'editor', via: 'blocknote', label: 'cmd.paragraph', keys: both('Mod-Alt-0') },
  { id: 'editor.heading1', scope: 'editor', via: 'blocknote', label: 'cmd.heading1', keys: both('Mod-Alt-1') },
  { id: 'editor.heading2', scope: 'editor', via: 'blocknote', label: 'cmd.heading2', keys: both('Mod-Alt-2') },
  { id: 'editor.heading3', scope: 'editor', via: 'blocknote', label: 'cmd.heading3', keys: both('Mod-Alt-3') },
  { id: 'editor.toggleList', scope: 'editor', via: 'blocknote', label: 'cmd.toggleList', keys: both('Mod-Shift-6') },
  { id: 'editor.numberedList', scope: 'editor', via: 'blocknote', label: 'cmd.numberedList', keys: both('Mod-Shift-7') },
  { id: 'editor.bulletList', scope: 'editor', via: 'blocknote', label: 'cmd.bulletList', keys: both('Mod-Shift-8') },
  { id: 'editor.checkList', scope: 'editor', via: 'blocknote', label: 'cmd.checkList', keys: both('Mod-Shift-9') },
  { id: 'editor.toggleCheckbox', scope: 'editor', via: 'editor', label: 'shortcuts.toggleCheckbox', keys: both('Mod-l') },
  { id: 'editor.checkTodo', scope: 'editor', via: 'editor', label: 'cmd.checkTodo', keys: both('Mod-Enter') },
  { id: 'editor.moveBlockUp', scope: 'editor', via: 'blocknote', label: 'cmd.moveBlockUp', keys: both('Mod-Shift-ArrowUp') },
  { id: 'editor.moveBlockDown', scope: 'editor', via: 'blocknote', label: 'cmd.moveBlockDown', keys: both('Mod-Shift-ArrowDown') },
  { id: 'editor.indent', scope: 'editor', via: 'blocknote', label: 'cmd.indent', keys: both('Tab') },
  { id: 'editor.outdent', scope: 'editor', via: 'blocknote', label: 'cmd.outdent', keys: both('Shift-Tab') },
  { id: 'editor.duplicateBlock', scope: 'editor', via: 'editor', label: 'cmd.duplicateBlock', keys: both('Mod-Shift-d') },
  // palette only, no default key: a 3 × 3 table where the caret is (typed forms: "| a | b |" Enter, /표 3x4 — docs/adr/1642-*)
  { id: 'editor.insertTable', scope: 'editor', via: 'editor', label: 'cmd.insertTable' },
  { id: 'editor.deleteBlock', scope: 'editor', via: 'editor', label: 'shortcuts.deleteBlock', keys: both('Mod-d') },
  { id: 'editor.toggleFold', scope: 'editor', via: 'editor', label: 'shortcuts.toggleFold', keys: both('Mod-.') },
  { id: 'editor.undo', scope: 'editor', via: 'blocknote', label: 'shortcuts.undo', keys: both('Mod-z') },
  {
    id: 'editor.redo',
    scope: 'editor',
    via: 'blocknote',
    label: 'cmd.redo',
    keys: { mac: ['Mod-Shift-z'], other: ['Mod-y', 'Mod-Shift-z'] },
    extraKeys: { mac: ['Mod-y'] },
  },

  // --- sidebar tree: a row selected, focus in the tree ------------------------------------------
  { id: 'tree.up', scope: 'tree', via: 'tree', label: 'cmd.treeUp', keys: both('ArrowUp'), palette: false },
  { id: 'tree.down', scope: 'tree', via: 'tree', label: 'cmd.treeDown', keys: both('ArrowDown'), palette: false },
  { id: 'tree.collapse', scope: 'tree', via: 'tree', label: 'cmd.treeCollapse', keys: both('ArrowLeft'), palette: false },
  { id: 'tree.expand', scope: 'tree', via: 'tree', label: 'cmd.treeExpand', keys: both('ArrowRight'), palette: false },
  {
    id: 'tree.open',
    scope: 'tree',
    via: 'tree',
    label: 'shortcuts.openToggle',
    keys: both('Enter'),
    extraKeys: both('Space'),
    palette: false,
  },
  { id: 'tree.rename', scope: 'tree', via: 'tree', label: 'common.rename', keys: both('F2'), palette: false, shadows: ['page.renameTitle'] },
  {
    id: 'tree.delete',
    scope: 'tree',
    via: 'tree',
    label: 'shortcuts.deleteToTrash',
    keys: { mac: ['Mod-Backspace'], other: ['Mod-Delete', 'Delete'] },
    extraKeys: { mac: ['Mod-Delete', 'Delete'], other: ['Mod-Backspace'] },
    palette: false,
  },

  // --- database table: a cell has the focus (docs/adr/1407-*) ------------------------------------
  { id: 'table.up', scope: 'table', via: 'table', label: 'cmd.tableUp', keys: both('ArrowUp'), palette: false },
  { id: 'table.down', scope: 'table', via: 'table', label: 'cmd.tableDown', keys: both('ArrowDown'), palette: false },
  { id: 'table.left', scope: 'table', via: 'table', label: 'cmd.tableLeft', keys: both('ArrowLeft'), palette: false },
  { id: 'table.right', scope: 'table', via: 'table', label: 'cmd.tableRight', keys: both('ArrowRight'), palette: false },
  { id: 'table.nextCell', scope: 'table', via: 'table', label: 'cmd.tableNextCell', keys: both('Tab'), palette: false },
  { id: 'table.prevCell', scope: 'table', via: 'table', label: 'cmd.tablePrevCell', keys: both('Shift-Tab'), palette: false },
  { id: 'table.rowStart', scope: 'table', via: 'table', label: 'cmd.tableRowStart', keys: both('Home'), palette: false },
  { id: 'table.rowEnd', scope: 'table', via: 'table', label: 'cmd.tableRowEnd', keys: both('End'), palette: false },
  { id: 'table.extendUp', scope: 'table', via: 'table', label: 'cmd.tableExtendUp', keys: both('Shift-ArrowUp'), palette: false },
  { id: 'table.extendDown', scope: 'table', via: 'table', label: 'cmd.tableExtendDown', keys: both('Shift-ArrowDown'), palette: false },
  { id: 'table.extendLeft', scope: 'table', via: 'table', label: 'cmd.tableExtendLeft', keys: both('Shift-ArrowLeft'), palette: false },
  { id: 'table.extendRight', scope: 'table', via: 'table', label: 'cmd.tableExtendRight', keys: both('Shift-ArrowRight'), palette: false },
  {
    id: 'table.edit',
    scope: 'table',
    via: 'table',
    label: 'cmd.tableEdit',
    hint: 'cmd.tableEditHint',
    keys: both('Enter', 'F2'),
    palette: false,
    // F2 on a focused cell edits the cell, not the page title
    shadows: ['page.renameTitle'],
  },
  { id: 'table.toggle', scope: 'table', via: 'table', label: 'cmd.tableToggle', keys: both('Space'), palette: false },
  {
    id: 'table.clear',
    scope: 'table',
    via: 'table',
    label: 'cmd.tableClear',
    keys: { mac: ['Backspace'], other: ['Delete'] },
    extraKeys: { mac: ['Delete'], other: ['Backspace'] },
    palette: false,
  },
  { id: 'table.newRow', scope: 'table', via: 'table', label: 'cmd.tableNewRow', keys: both('Mod-Enter'), palette: false },
  { id: 'table.openRow', scope: 'table', via: 'table', label: 'cmd.tableOpenRow', keys: both('Mod-Shift-Enter'), palette: false },
  { id: 'table.copy', scope: 'table', via: 'browser', label: 'cmd.tableCopy', keys: both('Mod-c'), palette: false },
  { id: 'table.paste', scope: 'table', via: 'browser', label: 'cmd.tablePaste', keys: both('Mod-v'), palette: false },

  // --- pen mode ---------------------------------------------------------------------------------
  { id: 'ink.undo', scope: 'ink', via: 'app', label: 'cmd.inkUndo', keys: both('Mod-z'), inInputs: 'deny', palette: false },

  // --- image viewer (docs/adr/2386-*): its own keydown while it is open; listed for the help window --
  { id: 'viewer.zoomIn', scope: 'viewer', via: 'viewer', label: 'imageViewer.zoomIn', keys: both('+'), palette: false, remap: false },
  { id: 'viewer.zoomOut', scope: 'viewer', via: 'viewer', label: 'imageViewer.zoomOut', keys: both('-'), palette: false, remap: false },
  { id: 'viewer.fit', scope: 'viewer', via: 'viewer', label: 'imageViewer.fit', hint: 'imageViewer.fitHint', keys: both('0'), palette: false, remap: false },
  { id: 'viewer.prev', scope: 'viewer', via: 'viewer', label: 'imageViewer.prev', keys: both('ArrowLeft'), palette: false, remap: false },
  { id: 'viewer.next', scope: 'viewer', via: 'viewer', label: 'imageViewer.next', keys: both('ArrowRight'), palette: false, remap: false },
  { id: 'viewer.close', scope: 'viewer', via: 'viewer', label: 'imageViewer.close', hint: 'imageViewer.closeHint', keys: both('Escape'), palette: false, remap: false },
]

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

export function shortcutById(id: string): ShortcutDef | undefined {
  return BY_ID.get(id)
}

/** The user's keys per platform and command id; a list replaces the defaults and their aliases, [] = no key. */
export type KeyOverrides = Partial<Record<Platform, Record<string, string[]>>>

let overrides: KeyOverrides = {}

/** Installs the user's keys (overrides.ts loads them; tests set them directly). Not validated here. */
export function setKeyOverrides(o: KeyOverrides): void {
  overrides = o
}

export function getKeyOverrides(): KeyOverrides {
  return overrides
}

function overrideOf(id: string, platform: Platform, o: KeyOverrides = overrides): string[] | undefined {
  const list = o[platform]?.[id]
  return Array.isArray(list) ? list : undefined
}

export function isOverridden(id: string, platform: Platform): boolean {
  return overrideOf(id, platform) !== undefined
}

/**
 * Can Settings change this command's key? Not for keys the pinned editor binds itself (`blocknote`:
 * its own keymap would keep the old key, docs/adr/1406-*) or the browser handles (`browser`).
 */
export function isRemappable(def: ShortcutDef | undefined): boolean {
  return !!def && def.via !== 'blocknote' && def.via !== 'browser' && def.remap !== false
}

/**
 * The keys a command answers to now, primary first: the user's keys when they set some in Settings,
 * else the defaults. Every caller — dispatcher, editor keymap, help window, menus, palette — reads
 * this, so a remap shows up everywhere at once.
 */
export function currentKeys(id: string, platform: Platform): string[] {
  return overrideOf(id, platform) ?? BY_ID.get(id)?.keys?.[platform] ?? []
}

/** Shown keys plus the hidden aliases — everything the command is bound to. A user's keys replace both. */
export function boundKeys(id: string, platform: Platform): string[] {
  const own = overrideOf(id, platform)
  if (own) return own
  return [...currentKeys(id, platform), ...(BY_ID.get(id)?.extraKeys?.[platform] ?? [])]
}

/** The registry with the user's keys in place of the defaults on one platform (for the conflict check). */
export function effectiveDefs(platform: Platform, o: KeyOverrides = overrides): ShortcutDef[] {
  return SHORTCUTS.map((d) => {
    const own = overrideOf(d.id, platform, o)
    if (!own) return d
    const base = d.keys ?? { mac: [], other: [] }
    return {
      ...d,
      keys: { ...base, [platform]: own },
      extraKeys: { ...(d.extraKeys ?? {}), [platform]: [] },
    }
  })
}

export function keyLabels(id: string, platform: Platform): string[] {
  return currentKeys(id, platform).map((k) => formatKey(k, platform))
}

export const normalizeKey = (spec: string, platform: Platform = 'mac') => canonicalKey(spec, platform)

/**
 * Keys a page never gets (the browser or the OS takes them first) or must not take (developer tools,
 * window management). A command binds one only with `reservedOk` and a reason in docs/adr/1401-*.
 */
const reserved = (platform: Platform, specs: string[]) => new Set(specs.map((s) => canonicalKey(s, platform)))
export const RESERVED_KEYS: Record<Platform, Set<string>> = {
  mac: reserved('mac', [
    'Mod-n', 'Mod-Shift-n', 'Mod-t', 'Mod-Shift-t', 'Mod-w', 'Mod-Shift-w', 'Mod-q', 'Mod-h', 'Mod-Alt-h', 'Mod-m',
    'Mod-Tab', 'Mod-Shift-Tab', 'Mod-Space', 'Mod-Alt-Space', 'Mod-Alt-d', 'Mod-Alt-Escape',
    'Mod-Shift-3', 'Mod-Shift-4', 'Mod-Shift-5',
    // Chrome/Edge: next/previous tab (reserved in a tab)
    'Mod-Alt-ArrowLeft', 'Mod-Alt-ArrowRight',
    // developer tools / page source / private window
    'Mod-Alt-i', 'Mod-Alt-j', 'Mod-Alt-c', 'Mod-Alt-u', 'Mod-Shift-p', 'Mod-Shift-Delete',
    'Ctrl-ArrowLeft', 'Ctrl-ArrowRight', 'Ctrl-ArrowUp', 'Ctrl-ArrowDown', 'Ctrl-Space',
  ]),
  other: reserved('other', [
    'Mod-n', 'Mod-Shift-n', 'Mod-t', 'Mod-Shift-t', 'Mod-w', 'Mod-Shift-w', 'Mod-Tab', 'Mod-Shift-Tab',
    'Mod-F4', 'Alt-F4', 'Mod-Alt-Delete', 'Mod-Shift-Escape',
    'Mod-Shift-i', 'Mod-Shift-j', 'Mod-Shift-c', 'F12', 'Mod-Shift-p', 'Mod-Shift-Delete',
  ]),
}

// Scopes that are live at the same moment. global and page always are; editor, tree, table and pen
// mode never have focus together (pen mode makes the body read-only and takes no focus there). The
// image viewer is modal: while it is open it takes every key first and nothing else runs (2386).
export function liveTogether(a: Scope, b: Scope): boolean {
  if (a === b) return true
  if (a === 'viewer' || b === 'viewer') return false
  const always = (s: Scope) => s === 'global' || s === 'page'
  return always(a) || always(b)
}

export type Conflict = { key: string; a: string; b: string }

/** Pairs of commands bound to the same key where both can be live, minus overlaps declared with `shadows`. */
export function findConflicts(defs: readonly ShortcutDef[], platform: Platform): Conflict[] {
  const out: Conflict[] = []
  const bound = defs.map((d) => ({
    d,
    keys: new Set([...(d.keys?.[platform] ?? []), ...(d.extraKeys?.[platform] ?? [])].map((k) => canonicalKey(k, platform))),
  }))
  for (let i = 0; i < bound.length; i++) {
    for (let j = i + 1; j < bound.length; j++) {
      const x = bound[i]
      const y = bound[j]
      if (!liveTogether(x.d.scope, y.d.scope)) continue
      if (x.d.shadows?.includes(y.d.id) || y.d.shadows?.includes(x.d.id)) continue
      for (const k of x.keys) if (y.keys.has(k)) out.push({ key: k, a: x.d.id, b: y.d.id })
    }
  }
  return out
}

/** Display order of the scope groups in the help window and settings. */
export const SCOPE_ORDER: readonly Scope[] = ['global', 'page', 'editor', 'tree', 'table', 'ink', 'viewer']
export const SCOPE_LABEL: Record<Scope, TKey> = {
  global: 'shortcuts.groupGlobal',
  page: 'common.page',
  editor: 'shortcuts.groupEditor',
  tree: 'shortcuts.groupTree',
  table: 'cmd.groupTable',
  ink: 'cmd.groupInk',
  viewer: 'imageViewer.group',
}
