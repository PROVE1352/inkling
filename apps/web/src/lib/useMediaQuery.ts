import { useSyncExternalStore } from 'react'

// Subscribes to a CSS media query — use only when a render branch (e.g. how many chips to show) can't be done in CSS alone.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Below Tailwind `sm` (phone, portrait) */
export const useIsPhone = () => useMediaQuery('(max-width: 639.98px)')
