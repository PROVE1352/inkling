// Select pickers inside editor blocks (docs/adr/2108-*).
//
// The app styles selects as customizable selects (`appearance: base-select`, index.css), so Chrome
// draws the picker in the page and a click on an option is a mousedown/mouseup on the <option>
// element. Inside a block's node view (the database view block's "Change view", the database and
// view pickers of an empty one) ProseMirror took that mousedown as a click on the block: the block
// became node-selected, the picker stayed open with the old value, and only a second pick worked.
// Tiptap's React node views keep INPUT/BUTTON/SELECT/TEXTAREA targets from ProseMirror, not OPTION.
//
// This extension stops a mousedown that starts inside a <select> (the select itself, its options,
// optgroups or picker content) on its way to the editor's own listeners: a capture listener on the
// editor element runs before ProseMirror's handler on the same element. The pick itself is the
// browser's default action and is not affected.
import { createExtension } from '@blocknote/core'

/** The event started inside a <select> (its button, an option, an optgroup, the picker). */
export function inSelectControl(target: EventTarget | null): boolean {
  const el =
    target && (target as Node).nodeType === 1
      ? (target as Element)
      : ((target as Node | null)?.parentElement ?? null)
  return !!el?.closest('select')
}

export function selectPickerGuard() {
  return createExtension(() => ({
    key: 'inklingSelectPickerGuard',
    mount: ({ dom, signal }: { dom: HTMLElement; signal: AbortSignal }) => {
      const stop = (e: Event) => {
        if (inSelectControl(e.target)) e.stopPropagation()
      }
      dom.addEventListener('mousedown', stop, { capture: true, signal })
    },
  }))()
}
