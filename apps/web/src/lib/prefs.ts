import { useSyncExternalStore } from 'react'
import { SIDEBAR_DEFAULT, normalizeSidebarWidth } from './sidebarWidth'

// Per-device preferences (settings screen /w/:wsId/settings), modelled on Obsidian's settings.
// Not stored on the server — zoom and line-length tastes differ per Mac/tablet (per-device localStorage).
// Same module store + useSyncExternalStore pattern as theme.ts, so changes apply to every screen at once.

export type LaunchPage = 'last' | 'home'
export type NewPageLocation = 'root' | 'child' | 'sibling'

export type Prefs = {
  /** Body text width in px (LINE_WIDTH_MIN–LINE_WIDTH_MAX), or 0 = full width. Replaces the old
   *  on/off "readable line length" (on → LINE_WIDTH_DEFAULT, off → 0, migrated in load()). */
  lineWidth: number
  /** Editor spell check (the spellcheck attribute) */
  spellcheck: boolean
  /** Character/word count at the bottom right of a document */
  wordCount: boolean
  /** Outline in the right margin of documents with 3+ headings (docs/adr/1220-*) */
  miniToc: boolean
  /** Page to open when the app starts */
  launchPage: LaunchPage
  /** Where ⌘N / the sidebar "New page" creates the page */
  newPageLocation: NewPageLocation
  /** Preview on hovering an internal link */
  linkPreview: boolean
  /** Confirm before moving to trash */
  confirmDelete: boolean
  /** App zoom (%) 80–130 */
  zoom: number
  /** Graph view display/force settings (like Obsidian's graph settings panel) */
  graph: GraphPrefs
  /** Right-panel local graph options */
  localGraph: LocalGraphPrefs
  /** Global calendar view/filters */
  calendar: CalendarPrefs
  /** Desktop sidebar width in px (SIDEBAR_MIN–SIDEBAR_MAX, docs/adr/1350-*) */
  sidebarWidth: number
}

export type CalendarPrefs = {
  /** Month view | week view */
  view: 'month' | 'week'
  /** Item kinds to show (DB row / page / daily / task) */
  row: boolean
  page: boolean
  daily: boolean
  task: boolean
  /** Show completed items (struck through, dimmed) */
  showDone: boolean
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = {
  view: 'month',
  row: true,
  page: true,
  daily: true,
  task: true,
  showDone: true,
}

export type GraphPrefs = {
  /** Show orphan (unlinked) nodes */
  showOrphans: boolean
  /** Show #tags as nodes */
  showTags: boolean
  /** Link arrows (direction) */
  arrows: boolean
  /** Group colours by top-level folder */
  colorGroups: boolean
  /** Colour by link island instead (connected components of the links, docs/adr/1123-*) */
  colorIslands: boolean
  /** Center force 0–1 */
  centerForce: number
  /** Repel force 0–20 */
  repelForce: number
  /** Link distance 20–300 */
  linkDistance: number
  /** Link force 0–1 */
  linkForce: number
  /** Node size multiplier 0.5–2.5 */
  nodeSize: number
  /** Settings panel expanded */
  panelOpen: boolean
}

export type LocalGraphPrefs = {
  /** How many hops */
  depth: 1 | 2 | 3
  /** Follow incoming links (backlinks) */
  incoming: boolean
  /** Follow outgoing links */
  outgoing: boolean
}

export const DEFAULT_GRAPH_PREFS: GraphPrefs = {
  showOrphans: true,
  showTags: false,
  arrows: false,
  colorGroups: true,
  colorIslands: false,
  centerForce: 0.5,
  repelForce: 10,
  linkDistance: 80,
  linkForce: 0.5,
  nodeSize: 1,
  panelOpen: true,
}

export const DEFAULT_LOCAL_GRAPH_PREFS: LocalGraphPrefs = {
  depth: 1,
  incoming: true,
  outgoing: true,
}

export const LINE_WIDTH_MIN = 600
export const LINE_WIDTH_MAX = 1200
/** Close to Obsidian's default readable line length */
export const LINE_WIDTH_DEFAULT = 700
/** lineWidth value for "full width" */
export const LINE_WIDTH_FULL = 0

export const DEFAULT_PREFS: Prefs = {
  lineWidth: LINE_WIDTH_DEFAULT,
  spellcheck: true,
  wordCount: true,
  miniToc: true,
  launchPage: 'last',
  newPageLocation: 'root',
  linkPreview: true,
  confirmDelete: false,
  zoom: 100,
  graph: DEFAULT_GRAPH_PREFS,
  localGraph: DEFAULT_LOCAL_GRAPH_PREFS,
  calendar: DEFAULT_CALENDAR_PREFS,
  sidebarWidth: SIDEBAR_DEFAULT,
}

export const ZOOM_MIN = 80
export const ZOOM_MAX = 130

/** Stored line width → a valid value. Older saves only have readableLineLength (true/false). */
export function normalizeLineWidth(width: unknown, legacyReadable?: unknown): number {
  if (typeof width === 'number' && Number.isFinite(width)) {
    if (width <= LINE_WIDTH_FULL) return LINE_WIDTH_FULL
    return Math.min(LINE_WIDTH_MAX, Math.max(LINE_WIDTH_MIN, Math.round(width)))
  }
  if (legacyReadable === false) return LINE_WIDTH_FULL
  return LINE_WIDTH_DEFAULT
}

const KEY = 'inkling:prefs'
const listeners = new Set<() => void>()

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const { readableLineLength, ...p } = JSON.parse(raw) as Partial<Prefs> & { readableLineLength?: unknown }
      // A shallow merge would drop newly added fields of nested objects → merge one level deeper.
      return {
        ...DEFAULT_PREFS,
        ...p,
        lineWidth: normalizeLineWidth(p.lineWidth, readableLineLength),
        sidebarWidth: normalizeSidebarWidth(p.sidebarWidth),
        graph: { ...DEFAULT_GRAPH_PREFS, ...(p.graph ?? {}) },
        localGraph: { ...DEFAULT_LOCAL_GRAPH_PREFS, ...(p.localGraph ?? {}) },
        calendar: { ...DEFAULT_CALENDAR_PREFS, ...(p.calendar ?? {}) },
      }
    }
  } catch {
    // Corrupt / inaccessible → defaults
  }
  return DEFAULT_PREFS
}

// Stable reference: a new object only on change (prevents a useSyncExternalStore infinite loop).
let current: Prefs = load()

export function getPrefs(): Prefs {
  return current
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  if (current[key] === value) return
  current = { ...current, [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Save failed — applies to this session's memory only
  }
  applyZoom()
  listeners.forEach((cb) => cb())
}

/** Changes one graph setting (keeps the rest). */
export function setGraphPref<K extends keyof GraphPrefs>(key: K, value: GraphPrefs[K]): void {
  if (current.graph[key] === value) return
  setPref('graph', { ...current.graph, [key]: value })
}

export function setLocalGraphPref<K extends keyof LocalGraphPrefs>(
  key: K,
  value: LocalGraphPrefs[K],
): void {
  if (current.localGraph[key] === value) return
  setPref('localGraph', { ...current.localGraph, [key]: value })
}

/** Changes one calendar setting (keeps the rest). */
export function setCalendarPref<K extends keyof CalendarPrefs>(key: K, value: CalendarPrefs[K]): void {
  if (current.calendar[key] === value) return
  setPref('calendar', { ...current.calendar, [key]: value })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  // Follow changes made in other tabs/windows too (PWA window + browser tab at the same time).
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    current = load()
    applyZoom()
    cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, () => DEFAULT_PREFS)
}

// Zoom — changes the root font-size instead of CSS zoom. With zoom, both Safari and Chrome disagree
// between getBoundingClientRect coordinates (unscaled) and position:fixed coordinates (scaled), so
// popovers and drag overlays drift (measured 2026-09-23). Everything rem-based (Tailwind spacing/text,
// editor body) follows along.
function applyZoom(): void {
  if (typeof document === 'undefined') return
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current.zoom || 100))
  document.documentElement.style.fontSize = z === 100 ? '' : `${(16 * z) / 100}px`
}
applyZoom()

// --- Last opened page (per workspace) — for "Page to open on start: last" ---
const LAST_PAGE_KEY = 'inkling:lastPage'

export function getLastPage(wsId: string): string | null {
  try {
    const raw = localStorage.getItem(LAST_PAGE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    return map[wsId] ?? null
  } catch {
    return null
  }
}

export function setLastPage(wsId: string, pageId: string): void {
  try {
    const raw = localStorage.getItem(LAST_PAGE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    if (map[wsId] === pageId) return
    map[wsId] = pageId
    localStorage.setItem(LAST_PAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

// One-shot app-entry flag — the workspace home (index) redirects to the last page only when the app
// first opens. AppLayout consumes it right after mounting so clicking Home in the sidebar again does not redirect.
let entryPending = true

export function consumeAppEntry(): boolean {
  const v = entryPending
  entryPending = false
  return v
}
