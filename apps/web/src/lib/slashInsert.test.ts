// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Slash menu insertion: where the block goes and where the caret ends up (docs/adr/1270-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  caretBelow,
  insertFromSlash,
  isEmptyParagraph,
  slashPlacement,
  withCaretBelow,
  withSyncNodeViews,
} from './slashInsert'

// A flat document of top-level blocks with BlockNote's editor calls used by the module. `flags` records
// tiptap's isEditorContentInitialized at the moment blocks are inserted.
function fakeEditor(blocks, cursorId) {
  let n = 0
  const doc = blocks.map((b) => ({ content: [], children: [], ...b }))
  const tt = { isEditorContentInitialized: undefined }
  const ed = {
    doc,
    cursor: { id: cursorId, placement: 'start' },
    flags: [],
    _tiptapEditor: tt,
    getTextCursorPosition: () => ({ block: doc.find((b) => b.id === ed.cursor.id) }),
    getBlock: (id) => doc.find((b) => b.id === id),
    getNextBlock: (id) => doc[doc.findIndex((b) => b.id === id) + 1],
    insertBlocks(list, ref, placement) {
      ed.flags.push(tt.isEditorContentInitialized)
      const made = list.map((b) => ({ id: `new${++n}`, content: [], children: [], ...b }))
      const i = doc.findIndex((b) => b.id === ref)
      doc.splice(placement === 'after' ? i + 1 : i, 0, ...made)
      return made
    },
    replaceBlocks(remove, list) {
      ed.flags.push(tt.isEditorContentInitialized)
      const i = doc.findIndex((b) => b.id === remove[0])
      const made = list.map((b) => ({ id: `new${++n}`, content: [], children: [], ...b }))
      doc.splice(i, remove.length, ...made)
      return { insertedBlocks: made }
    },
    setTextCursorPosition(id, placement) {
      ed.cursor = { id, placement }
    },
  }
  return ed
}

const text = (s) => [{ type: 'text', text: s, styles: {} }]
const types = (ed) => ed.doc.map((b) => `${b.type}${Array.isArray(b.content) && b.content.length ? ':' + b.content[0].text : ''}`)

describe('slashPlacement', () => {
  it('replaces only an empty paragraph without children', () => {
    assert.equal(slashPlacement({ id: 'a', type: 'paragraph', content: [], children: [] }), 'replace')
    assert.equal(slashPlacement({ id: 'a', type: 'paragraph', content: text('X'), children: [] }), 'after')
    assert.equal(slashPlacement({ id: 'a', type: 'paragraph', content: [], children: [{ id: 'c' }] }), 'after')
    assert.equal(slashPlacement({ id: 'a', type: 'heading', content: [], children: [] }), 'after')
    assert.equal(isEmptyParagraph(undefined), false)
  })
})

describe('insertFromSlash', () => {
  it('after a paragraph with text: inserts below it and puts the caret at the end of the new block', () => {
    const ed = fakeEditor([{ id: 'a', type: 'paragraph', content: text('X') }, { id: 'b', type: 'paragraph', content: text('Bravo') }], 'a')
    const got = insertFromSlash(ed, { type: 'callout', props: { type: 'note' } }, 'inside')
    assert.deepEqual(types(ed), ['paragraph:X', 'callout', 'paragraph:Bravo'])
    assert.deepEqual(ed.cursor, { id: got.id, placement: 'end' })
  })

  it('in an empty paragraph: replaces it; the caret goes into the new block, not the next one', () => {
    const ed = fakeEditor([{ id: 'a', type: 'paragraph', content: text('X') }, { id: 'e', type: 'paragraph' }, { id: 'b', type: 'paragraph', content: text('Bravo') }], 'e')
    const got = insertFromSlash(ed, { type: 'callout' }, 'inside')
    assert.deepEqual(types(ed), ['paragraph:X', 'callout', 'paragraph:Bravo'])
    assert.equal(ed.cursor.id, got.id)
  })

  it('renders node views synchronously only while inserting a block the caret goes into', () => {
    const ed = fakeEditor([{ id: 'a', type: 'paragraph', content: text('X') }], 'a')
    insertFromSlash(ed, { type: 'callout' }, 'inside')
    insertFromSlash(ed, { type: 'math' }, 'own')
    assert.deepEqual(ed.flags, [true, undefined])
    assert.equal(ed._tiptapEditor.isEditorContentInitialized, undefined)
  })

  it('`own`: leaves the editor caret where it was (the block focuses its own field)', () => {
    const ed = fakeEditor([{ id: 'a', type: 'paragraph', content: text('X') }], 'a')
    insertFromSlash(ed, { type: 'linkEmbed' }, 'own')
    assert.deepEqual(types(ed), ['paragraph:X', 'linkEmbed'])
    assert.deepEqual(ed.cursor, { id: 'a', placement: 'start' })
  })

  it('`below`: an empty line after the block takes the caret', () => {
    const ed = fakeEditor([{ id: 'e', type: 'paragraph' }, { id: 'b', type: 'paragraph', content: text('Bravo') }], 'e')
    insertFromSlash(ed, { type: 'pluginBlock' }, 'below')
    assert.deepEqual(types(ed), ['pluginBlock', 'paragraph', 'paragraph:Bravo'])
    assert.deepEqual(ed.cursor, { id: ed.doc[1].id, placement: 'start' })
  })
})

describe('caretBelow', () => {
  it('reuses an empty paragraph that is already there', () => {
    const ed = fakeEditor([{ id: 'd', type: 'divider' }, { id: 'e', type: 'paragraph' }], 'd')
    caretBelow(ed, 'd')
    assert.equal(ed.doc.length, 2)
    assert.deepEqual(ed.cursor, { id: 'e', placement: 'start' })
  })
  it('creates one when the next block has text or there is none', () => {
    const ed = fakeEditor([{ id: 'd', type: 'divider' }, { id: 'b', type: 'paragraph', content: text('Bravo') }], 'd')
    caretBelow(ed, 'd')
    assert.deepEqual(types(ed), ['divider', 'paragraph', 'paragraph:Bravo'])
    const last = fakeEditor([{ id: 'd', type: 'divider' }], 'd')
    caretBelow(last, 'd')
    assert.deepEqual(types(last), ['divider', 'paragraph'])
    assert.equal(last.cursor.id, last.doc[1].id)
  })
})

describe('withCaretBelow (BlockNote default items)', () => {
  // what BlockNote's insertOrUpdateBlockForSlashMenu does: update an empty block of any type in place
  // (same id, children kept), otherwise insert after it, then put the caret at the end of the next block
  // with text
  const blockNoteInsert = (ed, type) => () => {
    const cur = ed.getTextCursorPosition().block
    if (Array.isArray(cur.content) && cur.content.length === 0) Object.assign(cur, { type, content: undefined })
    else ed.insertBlocks([{ type, content: undefined }], cur.id, 'after')
    const i = ed.doc.findIndex((b) => b.id === cur.id)
    const next = ed.doc.slice(i + 1).find((b) => Array.isArray(b.content))
    if (next) ed.setTextCursorPosition(next.id, 'end')
  }

  it('after text: the caret goes to a new empty line below the divider, not to the end of "Bravo"', () => {
    const ed = fakeEditor([{ id: 'a', type: 'paragraph', content: text('X') }, { id: 'b', type: 'paragraph', content: text('Bravo') }], 'a')
    const reopened = []
    withCaretBelow(ed, blockNoteInsert(ed, 'divider'), (id) => reopened.push(id))()
    assert.deepEqual(types(ed), ['paragraph:X', 'divider', 'paragraph', 'paragraph:Bravo'])
    assert.deepEqual(ed.cursor, { id: ed.doc[2].id, placement: 'start' })
    assert.deepEqual(reopened, [ed.doc[1].id])
  })

  it('in an empty paragraph: the block keeps its id and the caret goes below it', () => {
    const ed = fakeEditor([{ id: 'e', type: 'paragraph' }, { id: 'b', type: 'paragraph', content: text('Bravo') }], 'e')
    withCaretBelow(ed, blockNoteInsert(ed, 'image'))()
    assert.deepEqual(types(ed), ['image', 'paragraph', 'paragraph:Bravo'])
    assert.equal(ed.doc[0].id, 'e')
    assert.equal(ed.cursor.id, ed.doc[1].id)
  })
})

describe('withCaretBelow, empty block that is not a plain paragraph', () => {
  it('an empty heading turned into a divider: the caret goes below the divider, not below the next block', () => {
    const ed = fakeEditor([{ id: 'h', type: 'heading' }, { id: 'b', type: 'paragraph', content: text('Bravo') }], 'h')
    const run = () => {
      const cur = ed.getTextCursorPosition().block
      Object.assign(cur, { type: 'divider', content: undefined })
      ed.setTextCursorPosition('b', 'end')
    }
    withCaretBelow(ed, run)()
    assert.deepEqual(types(ed), ['divider', 'paragraph', 'paragraph:Bravo'])
    assert.equal(ed.cursor.id, ed.doc[1].id)
  })
})

describe('withSyncNodeViews', () => {
  it('restores the flag when the insertion throws, and leaves an already set flag alone', () => {
    const ed = { _tiptapEditor: { isEditorContentInitialized: undefined } }
    assert.throws(() =>
      withSyncNodeViews(ed, () => {
        assert.equal(ed._tiptapEditor.isEditorContentInitialized, true)
        throw new Error('x')
      }),
    )
    assert.equal(ed._tiptapEditor.isEditorContentInitialized, undefined)
    const set = { _tiptapEditor: { isEditorContentInitialized: true } }
    withSyncNodeViews(set, () => {})
    assert.equal(set._tiptapEditor.isEditorContentInitialized, true)
    assert.equal(withSyncNodeViews({}, () => 7), 7)
  })
})
