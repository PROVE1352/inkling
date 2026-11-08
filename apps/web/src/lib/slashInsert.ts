// Inserting a block from the slash menu so that the next keystroke lands in it
// (docs/adr/1270-caret-after-slash-menu-insert.md).
//
// Custom blocks made with createReactBlockSpec (callout, math, link embed, plugin blocks) are tiptap
// React node views. tiptap renders a new React node view synchronously only when
// `editor.isEditorContentInitialized` is set, which tiptap's own <EditorContent> does and BlockNote's
// view does not. So the node view rendered in a microtask, after ProseMirror had already tried to put
// the DOM caret into the new block's still detached content element. The browser ignored that, the DOM
// caret stayed in the paragraph the slash was typed in (or moved to the next block), ProseMirror kept
// believing the caret was in the new block, and the next typed characters went where the DOM caret was:
// "X" + /callout + "hello" became "Xhello". `withSyncNodeViews` sets the flag for the duration of one
// insertion only, so that one node view is rendered (flushSync) before the caret is placed.

/** The parts of a BlockNote block this module reads. */
export type SlashBlock = { id: string; type: string; content?: unknown; children?: unknown }

/** The parts of BlockNote's editor used here (kept structural so the logic is testable in Node). */
export type SlashEditor = {
  getTextCursorPosition(): { block: SlashBlock }
  getBlock(id: string): SlashBlock | undefined
  getNextBlock(id: string): SlashBlock | undefined
  insertBlocks(blocks: unknown[], ref: string, placement: 'before' | 'after'): SlashBlock[]
  replaceBlocks(remove: string[], insert: unknown[]): { insertedBlocks: SlashBlock[] }
  setTextCursorPosition(id: string, placement: 'start' | 'end'): void
  _tiptapEditor?: unknown
  prosemirrorView?: unknown
}

/**
 * Where the caret goes after the insertion.
 * - `inside`: the new block has inline content (callout, query code block): its end.
 * - `below`: the new block has no inline content and no field of its own (divider, file blocks, plugin
 *   blocks): an empty paragraph right after it (reused if one is there, created otherwise), like Notion.
 *   BlockNote's default put the caret at the end of whatever block followed, so "hello" typed after
 *   /divider was appended to the next paragraph.
 * - `own`: the block focuses a field of its own (math source, embed URL); the editor caret is left alone.
 */
export type CaretTarget = 'inside' | 'below' | 'own'

function isEmptyArray(v: unknown): boolean {
  return !Array.isArray(v) || v.length === 0
}

/** An empty paragraph without children: the slash item replaces it instead of inserting after it. */
export function isEmptyParagraph(b: SlashBlock | undefined): boolean {
  return !!b && b.type === 'paragraph' && isEmptyArray(b.content) && isEmptyArray(b.children)
}

export function slashPlacement(cur: SlashBlock): 'replace' | 'after' {
  return isEmptyParagraph(cur) ? 'replace' : 'after'
}

type ContentFlag = { isEditorContentInitialized?: boolean }

/**
 * Runs `fn` with tiptap rendering new React node views synchronously (flushSync). Only for a single,
 * user-triggered insertion: called from a key or click handler, never from inside a React render.
 */
export function withSyncNodeViews<T>(editor: { _tiptapEditor?: unknown }, fn: () => T): T {
  const tt = editor._tiptapEditor as ContentFlag | undefined
  if (!tt || tt.isEditorContentInitialized) return fn()
  const prev = tt.isEditorContentInitialized
  tt.isEditorContentInitialized = true
  try {
    return fn()
  } finally {
    tt.isEditorContentInitialized = prev
  }
}

/** Puts the caret at the start of an empty paragraph right after `id`, creating one when needed. */
export function caretBelow(editor: SlashEditor, id: string): void {
  const next = editor.getNextBlock(id)
  const target = isEmptyParagraph(next) ? next : editor.insertBlocks([{ type: 'paragraph' }], id, 'after')[0]
  if (target) editor.setTextCursorPosition(target.id, 'start')
}

/**
 * Inserts `block` where the slash menu was opened (replacing an empty paragraph, otherwise after the
 * current block) and places the caret per `caret`. Returns the inserted block.
 *
 * Only `inside` renders the new node view synchronously: there the caret must land in its content. A
 * block that focuses a field of its own (`own`) must not, because a synchronously rendered node view is
 * still outside the document while it renders (ProseMirror attaches it afterwards), so `autoFocus` and
 * focus() in its layout effects would do nothing; rendered in the microtask that follows, it is attached
 * and its field takes focus before the next key event.
 */
export function insertFromSlash(editor: SlashEditor, block: unknown, caret: CaretTarget): SlashBlock | undefined {
  const run = () => {
    const cur = editor.getTextCursorPosition().block
    const inserted =
      slashPlacement(cur) === 'replace'
        ? editor.replaceBlocks([cur.id], [block]).insertedBlocks[0]
        : editor.insertBlocks([block], cur.id, 'after')[0]
    if (!inserted) return undefined
    if (caret === 'inside') {
      editor.setTextCursorPosition(inserted.id, 'end')
      resyncCaretWhenAttached(editor)
    } else if (caret === 'below') caretBelow(editor, inserted.id)
    return inserted
  }
  return caret === 'inside' ? withSyncNodeViews(editor, run) : run()
}

/**
 * Wraps a BlockNote default slash item for a block without inline content (divider, image, video, audio,
 * file) so the caret goes below it (`caretBelow`) instead of to the end of the next block.
 */
export function withCaretBelow(
  editor: SlashEditor,
  run: () => void,
  /** after the caret moved, e.g. reopen BlockNote's file panel (it closes on every selection change) */
  then?: (insertedId: string) => void,
): () => void {
  return () => {
    const { id, type } = editor.getTextCursorPosition().block
    run()
    // BlockNote's insertOrUpdateBlockForSlashMenu turns an empty block of any type into the new one
    // (same id, new type), and otherwise inserts right after it. Read which one happened.
    const now = editor.getBlock(id)
    const inserted = now && now.type !== type ? now : editor.getNextBlock(id)
    if (!inserted) return
    caretBelow(editor, inserted.id)
    then?.(inserted.id)
  }
}

type ViewLike = {
  state: { selection: { head: number } }
  dom: Element
  domAtPos(pos: number): { node: Node }
  hasFocus(): boolean
  focus(): void
}

/**
 * Safety net for the same failure if a node view still renders late (a future BlockNote that renders
 * differently): when the DOM node holding the caret is not in the document yet, wait for the editor's
 * DOM to change and then let ProseMirror put the DOM caret where its state says (`view.focus()` always
 * re-syncs the DOM selection). Gives up after a second. Does nothing when the editor lost focus meanwhile.
 */
export function resyncCaretWhenAttached(editor: { prosemirrorView?: unknown }): void {
  const view = editor.prosemirrorView as ViewLike | undefined
  if (!view || typeof MutationObserver === 'undefined') return
  const attached = () => {
    try {
      return view.domAtPos(view.state.selection.head).node.isConnected
    } catch {
      return true
    }
  }
  if (attached()) return
  const mo = new MutationObserver(() => {
    if (!attached()) return
    stop()
    if (view.hasFocus()) view.focus()
  })
  const timer = setTimeout(() => stop(), 1000)
  const stop = () => {
    mo.disconnect()
    clearTimeout(timer)
  }
  mo.observe(view.dom, { childList: true, subtree: true })
}
