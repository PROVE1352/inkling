// ⌘; "Add property" — when the panel is closed, RightPanel only mounts after PageView opens it, so
// an event alone would be missed. The request is left in a module flag and consumed on mount/event.
// Lives outside RightPanel.tsx so the app shell (AppLayout, CommandPalette) can request it
// without pulling the panel (local graph, comments, …) into the entry chunk (docs/adr/0704-*).
let propsFocusPending = false

export function requestPropsFocus(): void {
  propsFocusPending = true
  window.dispatchEvent(new Event('inkling:open-props'))
}

/** Returns true (once) when a props-focus request is pending. */
export function consumePropsFocus(): boolean {
  if (!propsFocusPending) return false
  propsFocusPending = false
  return true
}
