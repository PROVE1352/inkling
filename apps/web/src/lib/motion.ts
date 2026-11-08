import { useEffect, useState } from 'react'

// Exit animations (docs/adr/1281-*). Entrances are pure CSS (.nd-pop, .nd-dialog, … in index.css); an exit
// needs the element to stay mounted for one short animation (.nd-out) after it was closed.

/** Length of an exit animation. Keep equal to --dur-fast in index.css. */
export const EXIT_MS = 120

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** How long to keep something mounted after it closed: 0 under reduced motion. */
export function exitDelay(reduced: boolean, ms: number = EXIT_MS): number {
  return reduced ? 0 : Math.max(0, ms)
}

/**
 * Keeps an element mounted for its exit animation after `open` turns false.
 * `mounted`: render it; `leaving`: add `nd-out` (and ignore input). Reopening while leaving cancels the exit.
 */
export function usePresence(open: boolean, ms: number = EXIT_MS): { mounted: boolean; leaving: boolean } {
  const [shown, setShown] = useState(open)
  // Derived state, set during render (React re-renders immediately): opening never waits for an effect.
  if (open && !shown) setShown(true)
  useEffect(() => {
    if (open || !shown) return
    const delay = exitDelay(prefersReducedMotion(), ms)
    if (delay === 0) {
      setShown(false)
      return
    }
    const id = window.setTimeout(() => setShown(false), delay)
    return () => window.clearTimeout(id)
  }, [open, shown, ms])
  const leaving = !open && shown && exitDelay(prefersReducedMotion(), ms) > 0
  return { mounted: open || leaving, leaving }
}
