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

// Every page editor PageView mounts, with the page it edits (button blocks, docs/adr/2244-*). Unlike
// the active editor above, this includes locked (read-only) bodies and every page kind; an editor
// not in here (page embeds, row template bodies) has no page a button may act on.
const pageEditors = new WeakMap<object, string>()

export function registerPageEditor(editor: object, pageId: string): () => void {
  pageEditors.set(editor, pageId)
  return () => {
    if (pageEditors.get(editor) === pageId) pageEditors.delete(editor)
  }
}

export function pageOfEditor(editor: object): string | null {
  return pageEditors.get(editor) ?? null
}
