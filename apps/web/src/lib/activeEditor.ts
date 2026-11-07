import type { InklingEditor } from '../components/CollabEditor'

// Thin module store holding the doc editor instance currently mounted on screen.
// AppDnd (the app-level DndContext) sits at the parent (AppLayout) level of the route tree, so it
// cannot see a child route's pageId via useParams. The page id is stored alongside the editor so
// a drop onto itself can be detected as a no-op. PageView sets it on mount / unmount (= null).
export type ActiveEditorEntry = { editor: InklingEditor; pageId: string }

let current: ActiveEditorEntry | null = null

export function setActiveEditor(entry: ActiveEditorEntry | null): void {
  current = entry
}

export function getActiveEditor(): ActiveEditorEntry | null {
  return current
}
