// Thin module store for asking the canvas currently on screen to "add a page card at these
// coordinates". CanvasInner registers its handle on mount and resets it to null on unmount.
// The canvas-drop handler of AppDnd (the app-level DndContext) calls
// getActiveCanvas()?.addPageNodeAt(...).
export type CanvasDropHandle = {
  addPageNodeAt: (pageId: string, client: { x: number; y: number }) => void
}

let current: CanvasDropHandle | null = null

export function setActiveCanvas(handle: CanvasDropHandle | null): void {
  current = handle
}

export function getActiveCanvas(): CanvasDropHandle | null {
  return current
}
