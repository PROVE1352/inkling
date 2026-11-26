// Other people's awareness `user`, cleaned before this tab draws it (0.25.4, sec26 E-1). BlockNote's cursor puts
// `user.color` into a style attribute and calls `color.charAt`, y-prosemirror's selection puts `${color}70` into
// another, and the presence list shows `user.name`. The server already cleans what it relays
// (apps/server/src/collabAwareness.ts cleanAwarenessUser); this is the same check again in the tab, for a server
// that does not (an older one) and for anything that reaches the awareness another way.

/** The colours a cursor may have: `#rgb` or `#rrggbb`. */
export const CURSOR_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
export const FALLBACK_CURSOR_COLOR = '#888888'

/** `c` when it is a cursor colour, otherwise the neutral one. */
export function safeCursorColor(c: unknown): string {
  return typeof c === 'string' && CURSOR_COLOR_RE.test(c) ? c : FALLBACK_CURSOR_COLOR
}

/**
 * Cleans one awareness state in place: `user` stays only as an object, its `color` only as a cursor colour (or
 * becomes the neutral one), its `name` only as a string. Returns true when it changed something.
 */
export function cleanAwarenessState(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false
  const st = state as { user?: unknown }
  const user = st.user
  if (user === undefined || user === null) return false
  if (typeof user !== 'object' || Array.isArray(user)) {
    delete st.user
    return true
  }
  const u = user as Record<string, unknown>
  let changed = false
  if (u.color !== undefined && safeCursorColor(u.color) !== u.color) {
    u.color = FALLBACK_CURSOR_COLOR
    changed = true
  }
  if (u.name !== undefined && typeof u.name !== 'string') {
    delete u.name
    changed = true
  }
  return changed
}

type AwarenessLike = {
  clientID: number
  getStates: () => Map<number, unknown>
  on: (event: 'change', fn: (e: { added: number[]; updated: number[]; removed: number[] }) => void) => void
  off: (event: 'change', fn: (e: { added: number[]; updated: number[]; removed: number[] }) => void) => void
}

/**
 * Cleans every remote state as it arrives. Must be attached before the editor's cursor plugin (openCollab does it
 * when it creates the provider): awareness listeners run in the order they were added, and the cursor plugin
 * draws on the same 'change'. Returns the detach.
 */
export function guardAwareness(awareness: AwarenessLike | null | undefined): () => void {
  if (!awareness) return () => {}
  const onChange = ({ added, updated }: { added: number[]; updated: number[] }) => {
    const states = awareness.getStates()
    for (const id of [...added, ...updated]) {
      if (id === awareness.clientID) continue
      cleanAwarenessState(states.get(id))
    }
  }
  onChange({ added: [...awareness.getStates().keys()], updated: [] })
  awareness.on('change', onChange)
  return () => awareness.off('change', onChange)
}
