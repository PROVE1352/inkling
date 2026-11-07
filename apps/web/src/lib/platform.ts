// Platform detection + shortcut label helpers (M10).
// Key *handling* accepts only the platform modifier via isMod(e) — ⌘ on Mac, Ctrl elsewhere (Windows etc.).
// (It used to accept metaKey||ctrlKey, so Mac Ctrl+D/O/N/L text-editing keys and Windows Win-key combos
// misfired as shortcuts.)
// This module only picks the symbols to *display* for the platform.

function detect(): boolean {
  if (typeof navigator === 'undefined') return false
  const s = navigator.platform || navigator.userAgent || ''
  return /Mac|iP(hone|ad|od)/.test(s)
}

export const isMac = detect()

// Display symbols for modifiers/special keys (Mac vs others)
export const MOD = isMac ? '⌘' : 'Ctrl'
export const DEL = isMac ? '⌫' : 'Del'
export const ALT = isMac ? '⌥' : 'Alt'
export const SHIFT = isMac ? '⇧' : 'Shift'

// shortcut(mod?, key) → "⌘K" on Mac, "Ctrl+K" elsewhere. Without mod, just key.
// mod/key are already display symbols (e.g. MOD, DEL, 'K', '\\', '↑').
export function shortcut(mod: string | null | undefined, key: string): string {
  if (!mod) return key
  return isMac ? `${mod}${key}` : `${mod}+${key}`
}

// Several modifiers — combo(MOD, ALT, '←') → "⌘⌥←" on Mac, "Ctrl+Alt+←" elsewhere.
export function combo(...parts: string[]): string {
  return isMac ? parts.join('') : parts.join('+')
}

/** Is the platform modifier pressed — ⌘ on Mac, Ctrl elsewhere. */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

// Shortcut labels where platform conventions differ.
//  - Back/forward: Mac ⌘⌥←/→ (Obsidian), Windows Alt+←/→ (browser/Explorer standard; Ctrl+Alt+← also works)
//  - New page: Chrome on Windows never passes Ctrl+N to the page, so Ctrl+Alt+N is the label shown.
export const BACK_KEY = isMac ? combo(MOD, ALT, '←') : combo(ALT, '←')
export const FORWARD_KEY = isMac ? combo(MOD, ALT, '→') : combo(ALT, '→')
export const NEW_PAGE_KEY = isMac ? shortcut(MOD, 'N') : combo(MOD, ALT, 'N')

// Convenience: mod+key (the most common form)
export function modKey(key: string): string {
  return shortcut(MOD, key)
}

// Is focus in a text input/editable element — global/tree key handlers ignore keys then.
export function isTypingElement(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

// Installed PWA (standalone)? — there is no browser back/forward/reload UI, so the app draws its own.
// navigator.standalone on iOS/iPadOS Safari, the display-mode media query elsewhere.
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone) return true
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches
    )
  } catch {
    return false
  }
}
