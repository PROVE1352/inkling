// Width of the desktop sidebar (docs/adr/1350-*). Stored per device in the preferences (prefs.ts),
// like the line width: a wide monitor and a laptop want different widths. The mobile drawer keeps
// its own fixed width and is not affected.

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 480
/** The fixed width before the sidebar could be resized */
export const SIDEBAR_DEFAULT = 260
const STEP = 16
const BIG_STEP = 64

const clamp = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)))

/** Stored value → a usable width. Old saves have none; anything that is not a finite number is the default. */
export function normalizeSidebarWidth(w: unknown): number {
  return typeof w === 'number' && Number.isFinite(w) ? clamp(w) : SIDEBAR_DEFAULT
}

/** Width during a drag that started at `startWidth` and moved `dx` px. */
export function dragSidebarWidth(startWidth: number, dx: number): number {
  return clamp(startWidth + dx)
}

/**
 * Keyboard on the focused resize handle (role="separator"): ←/→ by 16 px (Shift: 64), Home/End to
 * the ends, Enter back to the default. null = not a resize key.
 */
export function sidebarWidthForKey(key: string, width: number, shift: boolean): number | null {
  const step = shift ? BIG_STEP : STEP
  switch (key) {
    case 'ArrowLeft':
      return clamp(width - step)
    case 'ArrowRight':
      return clamp(width + step)
    case 'Home':
      return SIDEBAR_MIN
    case 'End':
      return SIDEBAR_MAX
    case 'Enter':
      return SIDEBAR_DEFAULT
    default:
      return null
  }
}
