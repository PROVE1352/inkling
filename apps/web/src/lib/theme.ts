import { useSyncExternalStore } from 'react'

// Light/dark/system theme module.
// Shares its format with the inline script in index.html (public/theme-init.js):
//   localStorage key 'inkling-theme', plain value 'light' | 'dark' | 'system' (default 'system').
// Not zustand persist etc., because the inline script reads the plain value without JSON wrapping.

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'inkling-theme'
const listeners = new Set<() => void>()

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    if (t === 'light' || t === 'dark' || t === 'system') return t
  } catch {
    // localStorage unavailable → default
  }
  return 'system'
}

export function resolvedTheme(): ResolvedTheme {
  const t = getTheme()
  if (t === 'system') return systemDark() ? 'dark' : 'light'
  return t
}

function apply(): void {
  document.documentElement.classList.toggle('dark', resolvedTheme() === 'dark')
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // Ignore save failures (nothing is kept in memory, but the screen still updates)
  }
  apply()
  listeners.forEach((cb) => cb())
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    apply()
    cb()
  }
  mq.addEventListener('change', onChange)
  return () => {
    listeners.delete(cb)
    mq.removeEventListener('change', onChange)
  }
}

// Apply the saved value as soon as the module loads (the inline script already does, but be defensive)
apply()

export function useTheme(): { theme: Theme; resolved: ResolvedTheme } {
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'system' as Theme)
  const resolved = useSyncExternalStore(
    subscribe,
    resolvedTheme,
    () => 'light' as ResolvedTheme,
  )
  return { theme, resolved }
}
