import * as Y from 'yjs'

// Bounded undo history for collaborative editors (docs/adr/0701-yjs-undo-stack-cap.md).
//
// In collaboration mode BlockNote uses y-prosemirror's yUndoPlugin, whose Y.UndoManager keeps
// every capture (one per typing burst — captureTimeout 500 ms) for the life of the editor and
// marks every struct it deleted as `keep`, which exempts it from Yjs GC. ProseMirror's own
// history defaults to depth 100; here we keep the newest UNDO_LIMIT captures and release the
// rest the same way `UndoManager.clear()` does (stack item dropped + its deleted structs
// un-kept so a later deletion of their parent can GC them).
//
// No node_modules patch: the UndoManager instance is read from the plugin state and trimmed
// from its 'stack-item-added' event.

export const UNDO_LIMIT = 500

/** Trims are batched: drop down to the limit only once the stack overshoots by this much. */
const TRIM_SLACK = 50

const TRIM_ORIGIN = Symbol('inkling-undo-trim')

type PluginLike = { getState: (state: never) => unknown }
type EditorLike = {
  readonly prosemirrorState: { readonly plugins: readonly PluginLike[] }
  onMount?: (cb: () => void) => () => void
}

type UndoPluginState = { undoManager?: Y.UndoManager }

function findUndoManager(editor: EditorLike): Y.UndoManager | null {
  let state: EditorLike['prosemirrorState']
  try {
    state = editor.prosemirrorState
  } catch {
    return null // view not mounted yet
  }
  for (const plugin of state.plugins) {
    // PluginKey('y-undo') → key string "y-undo$" (y-prosemirror keys.js).
    const key = (plugin as unknown as { key?: string }).key
    if (typeof key === 'string' && key.startsWith('y-undo$')) {
      return ((plugin.getState(state as never) as UndoPluginState | undefined)?.undoManager ?? null)
    }
  }
  return null
}

/**
 * Ends the current undo capture, so the next change is undone on its own: a block turned into a table
 * right after typing is one ⌘Z, not one together with the last keystrokes (docs/adr/1642-*).
 */
export function stopUndoCapture(editor: EditorLike): void {
  findUndoManager(editor)?.stopCapturing()
}

// Same as yjs' internal keepItem(item, false): un-keep the item and its kept ancestors.
function unkeep(item: Y.Item) {
  let it: Y.Item | null = item
  while (it !== null && it.keep) {
    it.keep = false
    const parent = it.parent as Y.AbstractType<unknown> | null
    it = parent && typeof parent === 'object' && '_item' in parent ? parent._item : null
  }
}

type StackItemLike = { deletions: Parameters<typeof Y.iterateDeletedStructs>[1] }

/** Drop the oldest undo captures beyond `limit`. Returns how many were dropped. */
export function trimUndoStack(um: Y.UndoManager, limit = UNDO_LIMIT): number {
  const stack = um.undoStack as unknown as StackItemLike[]
  const over = stack.length - limit
  if (over <= 0) return 0
  // Mutate in place: y-prosemirror and BlockNote's ForkYDoc read `um.undoStack` directly.
  const dropped = stack.splice(0, over)
  um.doc.transact((tr) => {
    for (const si of dropped) {
      Y.iterateDeletedStructs(tr, si.deletions, (struct) => {
        if (
          struct instanceof Y.Item &&
          um.scope.some(
            (type) =>
              type === (tr.doc as unknown) ||
              Y.isParentOf(type as Y.AbstractType<unknown>, struct),
          )
        ) {
          unkeep(struct)
        }
      })
    }
  }, TRIM_ORIGIN)
  return over
}

/**
 * Attach the cap to a BlockNote editor's Yjs UndoManager. Returns a disposer (effect cleanup).
 * Waits for the editor view to mount when needed.
 */
export function capUndoHistory(editor: EditorLike, limit = UNDO_LIMIT): () => void {
  let um: Y.UndoManager | null = null
  let disposed = false
  const onAdded = () => {
    if (um && um.undoStack.length > limit + TRIM_SLACK) trimUndoStack(um, limit)
  }
  const attach = () => {
    if (disposed || um) return
    um = findUndoManager(editor)
    if (um) um.on('stack-item-added', onAdded)
  }
  attach()
  const offMount = um ? undefined : editor.onMount?.(attach)
  return () => {
    disposed = true
    offMount?.()
    um?.off('stack-item-added', onAdded)
    um = null
  }
}
