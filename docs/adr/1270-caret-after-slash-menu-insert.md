# 1270. The caret lands in a block inserted from the slash menu (typed text went into the block before or after)

- Status: Accepted
- Date: 2026-11-08

## Context
0.8.0 shipped with a known issue: after `/callout` and Enter, the first characters typed went into the
paragraph the slash was typed in ("X" + "hello" → "Xhello"), or into the start of the next block when
the slash was typed on an empty line. A DOM trace (Selection API calls, `selectionchange`, transactions)
showed that `SlashMenu.insertCallout` did set the ProseMirror selection inside the new callout, but
ProseMirror's `selectionToDOM` called `collapse()` on the callout's content element while that element
was not in the document yet. The browser ignored the call, the DOM caret stayed in the old paragraph,
and ProseMirror (whose state still said "in the callout") read the next keystrokes from the DOM where the
caret really was.

Why the element was detached: the callout is a `createReactBlockSpec` block, i.e. a tiptap React node
view. tiptap's `ReactRenderer` renders a new node view synchronously (`flushSync`) only when
`editor.isEditorContentInitialized` is true. tiptap's own `<EditorContent>` sets that flag; BlockNote's
view sets up the portal manager (`contentComponent`) but never the flag, so every React node view renders
in a microtask after the transaction that created it. BlockNote's built-in blocks are plain node views
with a synchronous content element, which is why headings, lists, quotes, toggles and code blocks never
showed it.

An audit of every slash item (Enter, then `hello` typed with no key delay; the table is the Chromium
audit, WebKit numbers for the failing items are under Decision) found three more items with the same
symptom and two related ones:

| item | before | cause |
|---|---|---|
| Callout | text in the previous / next block | detached content element (above) |
| Math block | text in the previous / next block | the source field was focused in `requestAnimationFrame`, after the keys |
| Inline math | text in the paragraph, field empty | the field opened from a state update in `useEffect`, which React schedules after the next key event |
| Divider, Image, Video, Audio, File (BlockNote defaults) | text appended to the end of the next block | BlockNote moves the caret to the end of the next block with text |
| Plugin blocks | caret not moved at all | no caret handling |
| Query, Embed, all other defaults, Emoji | correct | |

## Decision
- One helper, `lib/slashInsert.ts`, for every custom slash item: replace an empty paragraph, otherwise
  insert after the current block (the rule the items already used, now in one place and unit-tested),
  then place the caret by kind: `inside` (callout, query: end of the new block), `below` (plugin blocks: an
  empty line after the block, reused if there is one) or `own` (math, embed: the block focuses its own field).
- `inside` insertions run with `isEditorContentInitialized` set for the duration of that one call
  (`withSyncNodeViews`), so the node view is rendered before the caret is placed. A `MutationObserver`
  safety net re-syncs the DOM caret (`EditorView.focus()`) if the caret's DOM node is still detached
  afterwards, and gives up after a second.
- `own` insertions keep the asynchronous render: a node view rendered synchronously is not attached yet
  (ProseMirror inserts it after the constructor returns), so `autoFocus` and `focus()` would do nothing.
  Instead the blocks open their field from a layout effect, which runs in the same microtask chain, before
  the next key event (Math block and inline math; the embed already used `autoFocus`).
- BlockNote's divider and file items keep their behaviour except the caret: it goes to an empty line
  below the block, as in Notion. Which block BlockNote created is read after the item ran (it turns an
  empty block of any type into the new one, otherwise inserts after it). The file panel is opened again
  after the caret moved, because BlockNote closes it on every selection change; it stays under the new
  block and closes on the first typed character, as before.

Verified by `scripts/editor-typing/run.mjs` (30 runs per scenario, Chromium and WebKit, exact block texts,
stored state equal to the live one after a reload). On the 0.8.0 build the four callout scenarios and the
divider failed 30 of 30 runs in both engines, the math block 30/30 (Chromium) and 29/30 (WebKit), inline
math 30/30 (Chromium) and 7/30 (WebKit). After the change every scenario is 30/30 in both engines.

## Alternatives considered
- Set `isEditorContentInitialized = true` once for the whole editor (what tiptap itself does). It would
  also fix pasting or undoing a callout, but it renders every React node view synchronously: a remote
  sync or an initial load with many callouts and equations becomes one `flushSync` per block instead of
  one batched render, a transaction dispatched during a React commit would hit "flushSync inside a
  lifecycle method", and it is a performance change that needs its own measurement (AGENTS.md). Kept as
  the next step if the same symptom shows up outside the slash menu.
- Only the re-sync (wait for the content element, then `view.focus()`). It depends on the render
  finishing before the next key event; the synchronous render does not.
- Re-setting the same selection with `setTextCursorPosition`. ProseMirror does not touch the DOM
  selection when the selection did not change, and tiptap's `focus()` command returns early when the view
  already has focus.
- Wrapping BlockNote's `insertOrUpdateBlockForSlashMenu`: it is internal, and the divider/file items only
  needed the caret moved afterwards.

## Consequences
- Pasting, undoing or a collaborator inserting a callout still renders it a microtask late. Undo was
  checked (callout deleted with ⌘D, ⌘Z, then typing with no delay, Chromium and WebKit): the undo leaves
  the caret where it was, so typed text goes there, as ProseMirror's state says. Paste was not checked.
  It is the same mechanism should one of those paths start moving the caret into the new block.
- After `/divider` or `/image` there is always an empty line below the block (a new one when the next
  block has text).
- A plugin block inserted from the menu leaves the caret on the line below it instead of where it was.
