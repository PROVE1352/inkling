// AppDnd (the app-level DndContext) runs outside the tree, so it cannot reach PageTree's
// internal expand state (localStorage) directly. This thin bridge keeps the existing behaviour
// of expanding the target folder right after a child-drop.
// PageTree registers its expand function on mount.
let handler: ((id: string) => void) | null = null

export function setTreeExpandHandler(fn: ((id: string) => void) | null): void {
  handler = fn
}

export function requestTreeExpand(id: string): void {
  handler?.(id)
}
