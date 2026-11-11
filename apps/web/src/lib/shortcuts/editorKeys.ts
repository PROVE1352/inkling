// Editor-scope commands (docs/adr/1400-*, 1401-*). This module is part of the editor chunk (it
// imports BlockNote), so the app shell never loads it; the registry it reads is plain data.
//
// - inklingShortcuts(): one BlockNote extension that runs the registry's `via: 'editor'` commands. It
//   reads their keys (boundKeys) on every key press instead of building a keymap once, so a key changed
//   in Settings works in an open editor right away (docs/adr/1406-*).
// - EDITOR_COMMANDS: what each editor command does to an editor, used by that keymap and by the
//   command palette (useEditorPaletteCommands). BlockNote's own keys (headings, lists, moving
//   blocks, Tab) stay BlockNote's; the palette runs them through the same editor API.
import { useEffect } from 'react'
import { createExtension } from '@blocknote/core'
import type { InklingEditor } from '../../components/CollabEditor'
import { insertInlineMath } from '../../components/blocks/Math'
import { insertSizedTable } from '../tableQuickInput'
import { bindCommand, PLATFORM, runCommand } from './index'
import { matchKey, targetKind, toKeyEvent } from './keys'
import { SHORTCUTS, boundKeys } from './registry'

type Impl = (ed: InklingEditor) => boolean

const cursorBlock = (ed: InklingEditor) => ed.getTextCursorPosition().block

const turnInto =
  (type: string, props: Record<string, unknown> = {}): Impl =>
  (ed) => {
    const block = cursorBlock(ed)
    if (ed.schema.blockSchema[block.type]?.content !== 'inline') return false
    ed.updateBlock(block, { type, props } as never)
    return true
  }

type AnyBlock = { id?: string; children?: AnyBlock[]; [k: string]: unknown }
// A copy must not carry the original ids: two blocks with one id break the Yjs document's lookups.
function withoutIds(block: AnyBlock): AnyBlock {
  const { id: _id, children, ...rest } = block
  return { ...rest, children: (children ?? []).map(withoutIds) }
}

export const EDITOR_COMMANDS: Record<string, Impl> = {
  // ⌘L: a paragraph or list item becomes a to-do; a to-do flips (since M10)
  'editor.toggleCheckbox': (ed) => {
    const block = cursorBlock(ed)
    if (block.type === 'checkListItem') {
      ed.updateBlock(block, { props: { checked: !block.props.checked } } as never)
      return true
    }
    if (block.type === 'paragraph' || block.type === 'bulletListItem' || block.type === 'numberedListItem') {
      ed.updateBlock(block, { type: 'checkListItem', props: { checked: false } } as never)
      return true
    }
    return false
  },
  // ⌘Enter (Notion): flips a to-do; anywhere else it does nothing
  'editor.checkTodo': (ed) => {
    const block = cursorBlock(ed)
    if (block.type !== 'checkListItem') return false
    ed.updateBlock(block, { props: { checked: !block.props.checked } } as never)
    return true
  },
  // ⌘D (Obsidian): delete the block, caret to the next one (or the previous at the end)
  'editor.deleteBlock': (ed) => {
    const pos = ed.getTextCursorPosition()
    const next = pos.nextBlock ?? pos.prevBlock
    ed.removeBlocks([pos.block])
    if (next) ed.setTextCursorPosition(next, pos.nextBlock ? 'start' : 'end')
    return true
  },
  // ⌘⇧D: the selected blocks (or the caret's block) again right below, caret into the copy
  'editor.duplicateBlock': (ed) => {
    const sel = ed.getSelection()
    const blocks = sel?.blocks?.length ? sel.blocks : [cursorBlock(ed)]
    const copies = blocks.map((b) => withoutIds(b as unknown as AnyBlock))
    const inserted = ed.insertBlocks(copies as never, blocks[blocks.length - 1], 'after')
    if (inserted[0]) ed.setTextCursorPosition(inserted[0], 'end')
    return true
  },
  'editor.inlineMath': (ed) => insertInlineMath(ed),
  'editor.insertTable': (ed) => insertSizedTable(ed, 3, 3),
  'editor.paragraph': turnInto('paragraph'),
  'editor.heading1': turnInto('heading', { level: 1 }),
  'editor.heading2': turnInto('heading', { level: 2 }),
  'editor.heading3': turnInto('heading', { level: 3 }),
  'editor.toggleList': turnInto('toggleListItem'),
  'editor.numberedList': turnInto('numberedListItem'),
  'editor.bulletList': turnInto('bulletListItem'),
  'editor.checkList': turnInto('checkListItem'),
  'editor.moveBlockUp': (ed) => {
    ed.moveBlocksUp()
    return true
  },
  'editor.moveBlockDown': (ed) => {
    ed.moveBlocksDown()
    return true
  },
  'editor.indent': (ed) => {
    if (!ed.canNestBlock()) return false
    ed.nestBlock()
    return true
  },
  'editor.outdent': (ed) => {
    if (!ed.canUnnestBlock()) return false
    ed.unnestBlock()
    return true
  },
  'editor.undo': (ed) => {
    ed.undo()
    return true
  },
  'editor.redo': (ed) => {
    ed.redo()
    return true
  },
}

function runOn(id: string, ed: InklingEditor): boolean {
  if (!ed.isEditable) return false
  const impl = EDITOR_COMMANDS[id]
  try {
    // no implementation here: a component binds it (HeadingFolds binds editor.toggleFold)
    return impl ? impl(ed) : runCommand(id)
  } catch {
    // the caret cannot be resolved (a table cell selection, a node selection): leave the key alone
    return false
  }
}

const EDITOR_DEFS = SHORTCUTS.filter((d) => d.via === 'editor')

/** The editor command, if any, whose current key this keydown is (IME and AltGr rules from matchKey). */
export function editorCommandFor(e: KeyboardEvent): string | undefined {
  const k = toKeyEvent(e)
  return EDITOR_DEFS.find((d) => boundKeys(d.id, PLATFORM).some((spec) => matchKey(spec, k, PLATFORM)))?.id
}

/**
 * The registry's `via: 'editor'` commands as one BlockNote extension (docs/adr/1406-*).
 *
 * BlockNote's `keyboardShortcuts` turn into a prosemirror-keymap plugin whose key table is fixed when
 * the editor is created, so a remapped key would only reach editors opened afterwards. Instead the
 * extension listens for keydown on the editor's own element in the capture phase — before
 * ProseMirror's keymaps on the same element — and looks the key up in the registry at that moment.
 * A command that ran stops the event (as a keymap returning true does); one that did nothing (⌘Enter
 * outside a to-do) lets it go on to ProseMirror and the app. Keys from a field inside the document
 * (the math input) stay that field's.
 */
export function inklingShortcuts() {
  return createExtension(({ editor }: { editor: InklingEditor }) => ({
    key: 'inklingShortcuts',
    mount: ({ dom, signal }: { dom: HTMLElement; signal: AbortSignal }) => {
      dom.addEventListener(
        'keydown',
        (e) => {
          if (e.defaultPrevented || targetKind(e.target) === 'field') return
          // a non-editable part of a block that takes its own keys (the PDF preview, docs/adr/2481-*):
          // undo, indent, fold, … would act on the editor's selection behind it
          if (e.target instanceof Element && e.target.closest('[data-own-keys]')) return
          const id = editorCommandFor(e)
          if (!id || !runOn(id, editor)) return
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        { capture: true, signal },
      )
    },
  }))()
}

/**
 * Lets the command palette run editor commands on this editor (the page body). The palette has the
 * focus when a command runs, so the editor takes it back first; the caret is where it was.
 */
export function useEditorPaletteCommands(editor: InklingEditor, readOnly: boolean): void {
  useEffect(() => {
    if (readOnly) return
    const unbind = Object.keys(EDITOR_COMMANDS).map((id) =>
      bindCommand(id, {
        run: () => {
          editor.focus()
          return runOn(id, editor)
        },
        enabled: () => editor.isEditable,
      }),
    )
    return () => unbind.forEach((u) => u())
  }, [editor, readOnly])
}
