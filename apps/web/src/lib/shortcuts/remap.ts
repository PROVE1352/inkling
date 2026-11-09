// Checking and applying a user's own keys (docs/adr/1404-*, 1405-*). Pure functions over the registry:
// Settings › Shortcuts asks checkBinding() before it saves, withBinding() builds the next overrides,
// and the JSON export/import goes through exportOverrides()/importOverrides(). Storage is overrides.ts.
import { canonicalKey, parseKey, type Platform } from './keys'
import {
  RESERVED_KEYS,
  effectiveDefs,
  findConflicts,
  isRemappable,
  liveTogether,
  shortcutById,
  type Conflict,
  type KeyOverrides,
} from './registry'

export type BindingProblem =
  /** a command whose key belongs to the pinned editor or the browser */
  | { kind: 'notRemappable' }
  /** a character without ⌘/Ctrl/⌥: it would be typed text somewhere */
  | { kind: 'bareChar' }
  /** a named key without ⌘/Ctrl/⌥ outside the tree and the table (Enter, Tab, arrows): it would take the key from fields and buttons */
  | { kind: 'bareKey' }
  /** a key the OS or the browser never hands to a page, or the clipboard keys */
  | { kind: 'blocked'; why: 'os' | 'textEditing' }
  /** a key held by a command that cannot change (`with` = its id, or 'editor.builtin' for the editor's unlisted keys) */
  | { kind: 'fixedConflict'; with: string }

export type BindingCheck = {
  problem?: BindingProblem
  /** commands that hold the key where both are live; saving takes it from them */
  conflicts: string[]
  /** allowed after a confirmation: a browser tab keeps it (the installed app gets it), or it replaces a browser function */
  warning?: 'tabReserved' | 'browser'
}

const set = (platform: Platform, specs: string[]) => new Set(specs.map((s) => canonicalKey(s, platform)))

/** Keys a browser tab keeps for itself but the installed app (PWA window) receives (docs/adr/1401-*). */
const TAB_RESERVED: Record<Platform, Set<string>> = {
  mac: set('mac', ['Mod-n', 'Mod-Shift-n', 'Mod-Shift-p', 'Mod-Alt-ArrowLeft', 'Mod-Alt-ArrowRight']),
  other: set('other', ['Mod-n', 'Mod-Shift-n', 'Mod-Shift-p']),
}

/** Browser functions a page can take over (find, reload, zoom, save, history): allowed with a warning. */
const BROWSER_KEYS: Record<Platform, Set<string>> = {
  mac: set('mac', [
    'Mod-f', 'Mod-r', 'Mod-Shift-r', 'Mod-s', 'Mod-=', 'Mod--', 'Mod-0', 'Mod-[', 'Mod-]', 'Mod-y', 'Mod-Shift-b',
    'Mod-Alt-b', 'Mod-Shift-j', 'Mod-Shift-a', 'Mod-Shift-o', 'Mod-Shift-Delete',
  ]),
  other: set('other', [
    'Mod-f', 'Mod-r', 'Mod-Shift-r', 'F5', 'Mod-F5', 'F1', 'F3', 'F6', 'F7', 'F11', 'Mod-s', 'Mod-=', 'Mod--', 'Mod-0',
    'Mod-h', 'Mod-j', 'Mod-u', 'Mod-Shift-b', 'Mod-Shift-o', 'Mod-Shift-a', 'Alt-Home', 'Alt-ArrowLeft', 'Alt-ArrowRight',
  ]),
}

/** Select all / copy / cut / paste: every text field needs them. */
const TEXT_EDITING_KEYS: Record<Platform, Set<string>> = {
  mac: set('mac', ['Mod-a', 'Mod-c', 'Mod-x', 'Mod-v']),
  other: set('other', ['Mod-a', 'Mod-c', 'Mod-x', 'Mod-v', 'Shift-Insert', 'Mod-Insert']),
}

/**
 * Keys the pinned editor (BlockNote 0.51.4, tiptap) binds that are not registry rows: headings 4–6, quote,
 * code block, delete word/line, and the Mac's Emacs-style Ctrl keys. A command live in the editor cannot
 * take them (the editor would run first).
 */
const EDITOR_BUILTIN: Record<Platform, Set<string>> = {
  mac: set('mac', [
    'Mod-Alt-4', 'Mod-Alt-5', 'Mod-Alt-6', 'Mod-Alt-q', 'Mod-Alt-c', 'Mod-Backspace', 'Mod-Delete', 'Alt-Backspace',
    'Alt-Delete', 'Alt-d', 'Ctrl-a', 'Ctrl-e', 'Ctrl-h', 'Ctrl-d', 'Ctrl-Alt-Backspace', 'Shift-Backspace', 'Mod-Shift-z',
  ]),
  other: set('other', ['Mod-Alt-4', 'Mod-Alt-5', 'Mod-Alt-6', 'Mod-Alt-q', 'Mod-Alt-c', 'Mod-Backspace', 'Mod-Delete', 'Shift-Backspace']),
}

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

/** The rules that do not depend on other commands' keys. */
function staticProblem(id: string, spec: string, platform: Platform): BindingProblem | undefined {
  const def = shortcutById(id)
  if (!isRemappable(def)) return { kind: 'notRemappable' }
  const p = parseKey(spec)
  const canon = canonicalKey(spec, platform)
  const combo = p.mod || p.alt || p.ctrl
  if (!combo && p.key.length === 1 && p.key !== ' ') return { kind: 'bareChar' }
  if (!combo && def!.scope !== 'tree' && def!.scope !== 'table' && !FUNCTION_KEY.test(p.key)) return { kind: 'bareKey' }
  if (!combo && p.key === 'Escape') return { kind: 'bareKey' }
  if (TEXT_EDITING_KEYS[platform].has(canon)) return { kind: 'blocked', why: 'textEditing' }
  if (RESERVED_KEYS[platform].has(canon) && !TAB_RESERVED[platform].has(canon)) return { kind: 'blocked', why: 'os' }
  if (liveTogether(def!.scope, 'editor') && EDITOR_BUILTIN[platform].has(canon)) return { kind: 'fixedConflict', with: 'editor.builtin' }
  return undefined
}

function withKeys(o: KeyOverrides, id: string, platform: Platform, keys: string[]): KeyOverrides {
  return { ...o, [platform]: { ...(o[platform] ?? {}), [id]: keys } }
}

function conflictsOf(id: string, canon: string, platform: Platform, o: KeyOverrides): Conflict[] {
  const trial = withKeys(o, id, platform, [canon])
  return findConflicts(effectiveDefs(platform, trial), platform).filter((c) => c.key === canon && (c.a === id || c.b === id))
}

/** Is `spec` a key `id` may take on `platform`, given the user's other keys? */
export function checkBinding(id: string, spec: string, platform: Platform, o: KeyOverrides): BindingCheck {
  let canon: string
  try {
    canon = canonicalKey(spec, platform)
  } catch {
    return { problem: { kind: 'bareKey' }, conflicts: [] }
  }
  const problem = staticProblem(id, spec, platform)
  if (problem) return { problem, conflicts: [] }
  const conflicts = [...new Set(conflictsOf(id, canon, platform, o).map((c) => (c.a === id ? c.b : c.a)))]
  const fixed = conflicts.find((c) => !isRemappable(shortcutById(c)))
  if (fixed) return { problem: { kind: 'fixedConflict', with: fixed }, conflicts }
  const out: BindingCheck = { conflicts }
  if (TAB_RESERVED[platform].has(canon)) out.warning = 'tabReserved'
  else if (BROWSER_KEYS[platform].has(canon)) out.warning = 'browser'
  return out
}

const sameKeys = (a: string[], b: string[], platform: Platform) =>
  a.length === b.length && a.every((k, i) => canonicalKey(k, platform) === canonicalKey(b[i], platform))

/** Drops overrides equal to the defaults and empty platform maps, so "back to default" stores nothing. */
function tidy(o: KeyOverrides): KeyOverrides {
  const out: KeyOverrides = {}
  for (const platform of ['mac', 'other'] as const) {
    const map = o[platform]
    if (!map) continue
    const kept: Record<string, string[]> = {}
    for (const [id, keys] of Object.entries(map)) {
      const def = shortcutById(id)
      if (!def) continue
      // equal to the defaults: nothing to store — unless the defaults carry hidden aliases (Ctrl+N for a new
      // page), which an override switches off and dropping it would switch back on
      if (sameKeys(keys, def.keys?.[platform] ?? [], platform) && !def.extraKeys?.[platform]?.length) continue
      kept[id] = keys
    }
    if (Object.keys(kept).length) out[platform] = kept
  }
  return out
}

/** Takes `canon` away from the commands that hold it where `id` is live too. */
function takeFrom(o: KeyOverrides, id: string, canon: string, platform: Platform, current: (cid: string) => string[]): KeyOverrides {
  let next = o
  for (const c of conflictsOf(id, canon, platform, o)) {
    const other = c.a === id ? c.b : c.a
    if (!isRemappable(shortcutById(other))) continue
    next = withKeys(next, other, platform, current(other).filter((k) => canonicalKey(k, platform) !== canon))
  }
  return next
}

function keysUnder(o: KeyOverrides, platform: Platform) {
  return (id: string) => o[platform]?.[id] ?? shortcutById(id)?.keys?.[platform] ?? []
}

/**
 * The overrides after giving `id` the single key `spec` on `platform`. Commands that held the key lose
 * it (the caller asked first). Keys are stored in one spelling ("Mod-Shift-g").
 */
export function withBinding(o: KeyOverrides, id: string, spec: string, platform: Platform): KeyOverrides {
  const canon = canonicalKey(spec, platform)
  const next = takeFrom(o, id, canon, platform, keysUnder(o, platform))
  return tidy(withKeys(next, id, platform, [canon]))
}

/** The command keeps no key at all (it stays in the palette and the menus). */
export function withNoKey(o: KeyOverrides, id: string, platform: Platform): KeyOverrides {
  return tidy(withKeys(o, id, platform, []))
}

/** Commands that hold one of `id`'s default keys now (asked before a reset). */
export function defaultConflicts(o: KeyOverrides, id: string, platform: Platform): string[] {
  const out = new Set<string>()
  for (const k of shortcutById(id)?.keys?.[platform] ?? []) {
    const canon = canonicalKey(k, platform)
    const others = conflictsOf(id, canon, platform, o).map((c) => (c.a === id ? c.b : c.a))
    for (const c of others) out.add(c)
  }
  return [...out]
}

/** Back to the default keys; a command that took one of them meanwhile gives it back. */
export function withDefault(o: KeyOverrides, id: string, platform: Platform): KeyOverrides {
  let next = o
  for (const k of shortcutById(id)?.keys?.[platform] ?? []) next = takeFrom(next, id, canonicalKey(k, platform), platform, keysUnder(next, platform))
  const map = { ...(next[platform] ?? {}) }
  delete map[id]
  return tidy({ ...next, [platform]: map })
}

/**
 * Reads stored or imported overrides leniently: entries for unknown commands, commands that cannot be
 * remapped, keys that do not parse or break the static rules are dropped (listed as "platform id").
 */
export function parseOverrides(data: unknown): { overrides: KeyOverrides; dropped: string[] } {
  const out: KeyOverrides = {}
  const dropped: string[] = []
  if (!data || typeof data !== 'object') return { overrides: out, dropped }
  for (const platform of ['mac', 'other'] as const) {
    const map = (data as Record<string, unknown>)[platform]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    for (const [id, keys] of Object.entries(map as Record<string, unknown>)) {
      const ok =
        Array.isArray(keys) &&
        keys.length <= 4 &&
        keys.every((k) => {
          if (typeof k !== 'string' || k.length > 40) return false
          try {
            canonicalKey(k, platform)
          } catch {
            return false
          }
          return !staticProblem(id, k, platform)
        }) &&
        isRemappable(shortcutById(id))
      if (!ok) {
        dropped.push(`${platform} ${id}`)
        continue
      }
      out[platform] = { ...(out[platform] ?? {}), [id]: (keys as string[]).map((k) => canonicalKey(k, platform)) }
    }
  }
  return { overrides: tidy(out), dropped }
}

export const OVERRIDES_VERSION = 1

/** The JSON file Settings › Shortcuts exports (and the form kept in localStorage). */
export function exportOverrides(o: KeyOverrides): string {
  return JSON.stringify({ app: 'inkling', kind: 'shortcuts', version: OVERRIDES_VERSION, ...o }, null, 2)
}

export type ImportResult =
  | { ok: true; overrides: KeyOverrides; dropped: string[] }
  | { ok: false; error: 'json' | 'format' }
  | { ok: false; error: 'conflict'; conflicts: (Conflict & { platform: Platform })[] }

/** An imported file replaces the current keys only if it is ours and leaves no two commands on one key. */
export function importOverrides(text: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'json' }
  }
  const d = data as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || d.app !== 'inkling' || d.kind !== 'shortcuts' || typeof d.version !== 'number' || d.version > OVERRIDES_VERSION) {
    return { ok: false, error: 'format' }
  }
  const { overrides, dropped } = parseOverrides(d)
  const conflicts = (['mac', 'other'] as const).flatMap((platform) =>
    findConflicts(effectiveDefs(platform, overrides), platform).map((c) => ({ ...c, platform })),
  )
  if (conflicts.length) return { ok: false, error: 'conflict', conflicts }
  return { ok: true, overrides, dropped }
}

/** Pairs of commands on one key under the current overrides (a stored key that a newer default now collides with). */
export function overrideConflicts(o: KeyOverrides, platform: Platform): Conflict[] {
  return findConflicts(effectiveDefs(platform, o), platform)
}
