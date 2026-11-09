// Shortcut registry entry points for components (docs/adr/1400-*). The rules for every key live here:
// ⌘ on a Mac / Ctrl elsewhere, nothing while an IME composes, bare keys never while typing in a
// field, a key the editor or tree already claimed (defaultPrevented) is not taken again.
import { useEffect } from 'react'
import { isMac } from '../platform'
import { allowedIn, matchKey, targetKind, toKeyEvent, type Platform } from './keys'
import { SHORTCUTS, boundKeys, currentKeys, keyLabels, shortcutById, type ShortcutDef } from './registry'
import { isAvailable, runCommand } from './handlers'
// loads the user's own keys (localStorage) into the registry before anything reads a key
import './overrides'

export { SHORTCUTS, shortcutById, currentKeys, type ShortcutDef } from './registry'
export { bindCommand, isAvailable, runCommand, useCommand, onCommandsChanged } from './handlers'
export { useShortcutKeys, saveOverrides, getOverrides, onShortcutsChanged } from './overrides'

export const PLATFORM: Platform = isMac ? 'mac' : 'other'

/** Display labels of a command's keys on this platform ("⌘⌥S" / "Ctrl+Alt+S"), primary first. */
export function shortcutLabels(id: string): string[] {
  return keyLabels(id, PLATFORM)
}

/** The primary key label, for a menu item or a tooltip; undefined for a palette-only command. */
export function shortcutLabel(id: string): string | undefined {
  return keyLabels(id, PLATFORM)[0]
}

/** "Search (⌘K)" — a title attribute with the key in brackets when the command has one. */
export function withShortcut(text: string, id: string): string {
  const k = shortcutLabel(id)
  return k ? `${text} (${k})` : text
}

/** Does this keydown press one of the command's keys (for components that handle their own keys, like the tree)? */
export function matchCommand(id: string, e: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
  const ev = 'nativeEvent' in e ? e.nativeEvent : e
  const k = toKeyEvent(ev)
  return boundKeys(id, PLATFORM).some((spec) => matchKey(spec, k, PLATFORM))
}

// every app command, palette-only ones too: a user may give one of those a key (docs/adr/1404-*)
const APP_DEFS: readonly ShortcutDef[] = SHORTCUTS.filter((s) => s.via === 'app')

/**
 * The window keydown handler for every `via: 'app'` command. Returns true when a command ran (the
 * event is then prevented). Exported for tests of the wiring; components use useShortcutDispatcher().
 */
export function dispatchKeydown(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false
  const k = toKeyEvent(e)
  if (k.isComposing || k.keyCode === 229) return false
  const kind = targetKind(e.target)
  for (const def of APP_DEFS) {
    for (const spec of boundKeys(def.id, PLATFORM)) {
      if (!matchKey(spec, k, PLATFORM) || !allowedIn(spec, def.inInputs, kind)) continue
      if (!isAvailable(def.id)) continue
      if (runCommand(def.id)) {
        e.preventDefault()
        return true
      }
    }
  }
  return false
}

/** Installs the one window keydown listener for app shortcuts (AppLayout). */
export function useShortcutDispatcher(): void {
  useEffect(() => {
    window.addEventListener('keydown', dispatchKeydown)
    return () => window.removeEventListener('keydown', dispatchKeydown)
  }, [])
}

export function currentPrimary(id: string): string | undefined {
  return currentKeys(id, PLATFORM)[0]
}
