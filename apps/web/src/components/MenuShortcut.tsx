import { PLATFORM, currentKeys, useShortcutKeys } from '../lib/shortcuts'
import { ariaKey, formatKey } from '../lib/shortcuts/keys'

// The key of a registry command at the end of a menu item (docs/adr/1403-*). Menus never write key
// labels by hand: a key changed in Settings (docs/adr/1404-*) or a platform change shows up here by itself.
export function MenuShortcut({ id, className = '' }: { id: string; className?: string }) {
  useShortcutKeys()
  const key = currentKeys(id, PLATFORM)[0]
  if (!key) return null
  return (
    <span aria-hidden="true" className={`ml-auto shrink-0 pl-3 text-xs tabular-nums text-sub/80 ${className}`}>
      {formatKey(key, PLATFORM)}
    </span>
  )
}

/** aria-keyshortcuts for a command's keys (space separated), or undefined when it has none. */
export function ariaKeys(id: string): string | undefined {
  const keys = currentKeys(id, PLATFORM)
  return keys.length ? keys.map((k) => ariaKey(k, PLATFORM)).join(' ') : undefined
}
