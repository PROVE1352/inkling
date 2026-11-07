import { createContext, useContext } from 'react'

// Context giving custom nodes access to Y commits / navigation.
// (Node data is derived from Y and recreated on every rebuild, so callbacks are passed through
//  context rather than through data.)
export type CanvasContextValue = {
  wsId: string
  // Commit a text node edit (debouncing happens inside the node)
  commitText: (id: string, text: string) => void
}

export const CanvasContext = createContext<CanvasContextValue | null>(null)

export function useCanvasContext(): CanvasContextValue {
  const ctx = useContext(CanvasContext)
  if (!ctx) throw new Error('useCanvasContext used outside CanvasContext')
  return ctx
}
