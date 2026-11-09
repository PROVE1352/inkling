// The user's own shortcut keys, kept per device in localStorage (docs/adr/1404-*). Loading installs them
// in the registry (setKeyOverrides), so the dispatcher, the editor keymap, the tree, the table, the help
// window, the menus and the palette read them through currentKeys() without knowing about storage.
// React screens that show key labels call useShortcutKeys() to re-render when they change; other tabs
// follow through the storage event.
import { useSyncExternalStore } from 'react'
import { getKeyOverrides, setKeyOverrides, type KeyOverrides } from './registry'
import { exportOverrides, parseOverrides } from './remap'

const KEY = 'inkling:shortcuts'
const listeners = new Set<() => void>()
let version = 0

function load(): KeyOverrides {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return parseOverrides(JSON.parse(raw)).overrides
  } catch {
    // no storage (private window, blocked site data) or a corrupt value: the defaults
  }
  return {}
}

function notify(): void {
  version++
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  setKeyOverrides(load())
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return
    setKeyOverrides(load())
    notify()
  })
}

export function getOverrides(): KeyOverrides {
  return getKeyOverrides()
}

/** Saves and installs new overrides ({} = every default). Without storage they last for this tab. */
export function saveOverrides(o: KeyOverrides): void {
  setKeyOverrides(o)
  try {
    if (Object.keys(o).length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, exportOverrides(o))
  } catch {
    // storage full or blocked: this session only
  }
  notify()
}

export function onShortcutsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const getVersion = () => version

/** Re-renders the caller when the user's keys change (returns a counter, useful as a memo dependency). */
export function useShortcutKeys(): number {
  return useSyncExternalStore(onShortcutsChanged, getVersion, getVersion)
}
