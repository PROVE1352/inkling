import type { FloatingUIOptions } from '@blocknote/react'

// Where a menu opened at the caret goes (the slash menu, [[ / ![[ links, @ mentions). BlockNote's own
// middleware (autoPlacement + size) picks the side from the menu's current size: a menu opened while its
// items were still loading was small, "fitted" into the little room below a line near the bottom of the
// window, was then capped to that room by `size`, and never measured again (one item visible, the rest
// cut off). Here the side comes from the room on each side of the caret in the visible part of the
// window (visualViewport, so a phone's on-screen keyboard counts), and the height is set in the same step.

export interface CaretMenuInput {
  /** caret box, viewport coordinates */
  refTop: number
  refBottom: number
  /** the visible part of the window, same coordinates */
  viewTop: number
  viewBottom: number
  /** the menu's full content height (all items, no scrolling) */
  natural: number
  /** gap between the caret and the menu */
  gap?: number
  /** distance kept from the window edge */
  padding?: number
  /** with less room than this below, the menu opens above when there is more room there */
  comfortable?: number
}

export interface CaretMenuPlacement {
  side: 'bottom' | 'top'
  /** the most the menu may take; it scrolls inside when its content is taller */
  maxHeight: number
  /** the height it will have */
  height: number
}

export const CARET_MENU_GAP = 10
export const CARET_MENU_PADDING = 10
/** About seven items: enough room below means the menu stays below the caret, as before. */
export const CARET_MENU_COMFORTABLE = 300

/**
 * Below when there is a comfortable amount of room there (or at least as much as above); otherwise above.
 * The side does not depend on how tall the menu is right now: its items load asynchronously, and a menu
 * still empty when it opened fitted into a sliver below the caret and stayed there, shrunk to that sliver
 * (the 0.17 bug). Either way the menu is no taller than its side and scrolls inside.
 */
export function placeCaretMenu(i: CaretMenuInput): CaretMenuPlacement {
  const gap = i.gap ?? CARET_MENU_GAP
  const pad = i.padding ?? CARET_MENU_PADDING
  const comfortable = i.comfortable ?? CARET_MENU_COMFORTABLE
  const below = Math.max(0, i.viewBottom - pad - (i.refBottom + gap))
  const above = Math.max(0, i.refTop - gap - (i.viewTop + pad))
  const natural = Math.max(0, i.natural)
  const side: CaretMenuPlacement['side'] = below >= comfortable || below >= above ? 'bottom' : 'top'
  const maxHeight = Math.floor(side === 'bottom' ? below : above)
  return { side, maxHeight, height: Math.min(natural, maxHeight) }
}

/** Keeps a box of width `w` that starts at `left` inside [viewLeft + pad, viewRight - pad]; returns the shift. */
export function shiftIntoView(left: number, w: number, viewLeft: number, viewRight: number, pad = CARET_MENU_PADDING): number {
  const min = viewLeft + pad
  const max = viewRight - pad - w
  if (max < min) return min - left
  if (left > max) return max - left
  if (left < min) return min - left
  return 0
}

/** The visible part of the window: the visual viewport when the browser has one (phones with a keyboard up). */
function visibleView(): { top: number; bottom: number; left: number; right: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (vv) return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, left: vv.offsetLeft, right: vv.offsetLeft + vv.width }
  return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
}

type UseFloatingOptions = NonNullable<FloatingUIOptions['useFloatingOptions']>
type Middleware = Exclude<NonNullable<UseFloatingOptions['middleware']>[number], false | null | undefined>

/** A floating-ui middleware (BlockNote's popover takes its own; no import of floating-ui needed). */
const caretMenuMiddleware: Middleware = {
  name: 'inklingCaretMenu',
  fn({ rects, elements }) {
    const ref = elements.reference.getBoundingClientRect()
    const floating = elements.floating as HTMLElement
    // the popover wraps the menu; the menu itself scrolls (max-height: inherit)
    const menu = (floating.firstElementChild as HTMLElement | null) ?? floating
    const borders = menu.offsetHeight - menu.clientHeight
    const natural = menu.scrollHeight + Math.max(0, borders)
    const view = visibleView()
    const p = placeCaretMenu({ refTop: ref.top, refBottom: ref.bottom, viewTop: view.top, viewBottom: view.bottom, natural })
    floating.style.maxHeight = `${p.maxHeight}px`
    const y = p.side === 'bottom' ? rects.reference.y + rects.reference.height + CARET_MENU_GAP : rects.reference.y - CARET_MENU_GAP - p.height
    const dx = shiftIntoView(ref.left, rects.floating.width, view.left, view.right)
    return { x: rects.reference.x + dx, y, data: { side: p.side, maxHeight: p.maxHeight } }
  },
}

/** Pass to SuggestionMenuController as `floatingUIOptions`. */
export const CARET_MENU_FLOATING: FloatingUIOptions = {
  useFloatingOptions: { middleware: [caretMenuMiddleware] },
}
