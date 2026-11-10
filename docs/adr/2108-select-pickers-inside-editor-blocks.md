# 2108. Select pickers inside editor blocks are kept from ProseMirror

- Status: Accepted
- Date: 2026-11-10

## Context
Since 0.5 the app styles selects as customizable selects (`appearance: base-select`, `index.css`), so
Chrome draws the picker in the page and a click on an option is a mousedown/mouseup on the `<option>`
element. In a database view block (ADR 2120) the first pick with the mouse did nothing: the block
became node-selected (the blue outline), the picker stayed open with the old value, and only a second
pick changed the view. The same happened to the database and view pickers of an empty database view
block. Keyboard picks and `select.value` changes were not affected.

The block is a React node view. Tiptap's node views keep events whose target is an INPUT, BUTTON,
SELECT or TEXTAREA from ProseMirror, but not an OPTION, so ProseMirror handled the option's mousedown
as a click on the block.

## Decision
- One editor extension, `selectPickerGuard` (`apps/web/src/lib/selectPickerGuard.ts`), in the page
  editor and the row-template editor: a capture `mousedown` listener on the editor element
  (ProseMirror's own element, from the extension's `mount`) stops the event when it started inside a
  `<select>` (the select, its options, optgroups or picker content). It runs before ProseMirror's
  listener on the same element; the pick is the browser's default action and still happens.
- Nothing else in a block is affected (buttons, labels, text): a click there still selects the block.
- No `appearance` change: the in-page picker stays.

## Consequences
- A select click inside the editor no longer reaches document-level mousedown listeners (outside-click
  closing of popovers). Picking from a select inside a block while such a popover is open leaves the
  popover open until the next click elsewhere.
- BlockNote's code block language select is drawn with `appearance: none` (BlockNote's styles) and uses
  the browser's own picker, which sends no option events to the page; it was not affected.

## Alternatives
- A listener per block (`DbViewEmbed`): every new block with a select would need it.
- A ProseMirror plugin with `handleDOMEvents.mousedown`: the web app has no direct ProseMirror
  dependency, and the extension's `mount` gives the editor element without one.
- Patching tiptap's or BlockNote's `stopEvent`: editor packages are pinned and patched only when no
  option or extension can do it (AGENTS.md).
