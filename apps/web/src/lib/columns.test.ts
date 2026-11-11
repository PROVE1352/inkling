// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Column edits (docs/adr/2420-*, 2421-*) on a headless BlockNote editor with the shared column nodes:
// the commands, the keys at a column's edge, and replaceBlocks/removeBlocks that leave columns alone
// (core's fixColumnList would remove empty columns). Also two Yjs replicas editing different columns,
// and one deleting a column while the other writes in it.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { BlockNoteEditor, BlockNoteSchema, createBlockSpecFromTiptapNode, defaultBlockSpecs } from '@blocknote/core'
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from '@blocknote/core/yjs'
import { columnListPropSchema, columnNodes, columnPropSchema } from '@inkling/shared'
import {
  addColumn,
  columnBackspace,
  columnDelete,
  columnSafeBlockEdits,
  deleteColumn,
  flattenColumnHtml,
  insertColumns,
  setColumnPercents,
  unwrapColumns,
} from './columns'

const Node = BlockNoteSchema.create().blockSpecs.paragraph.implementation.node.constructor
const pm = columnNodes(Node)
const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    columnList: createBlockSpecFromTiptapNode({ node: pm.columnList, type: 'columnList', content: 'none' }, columnListPropSchema),
    column: createBlockSpecFromTiptapNode({ node: pm.column, type: 'column', content: 'none' }, columnPropSchema),
  },
})

function editorWith(blocks) {
  const editor = BlockNoteEditor.create({ schema })
  columnSafeBlockEdits(editor)
  editor.replaceBlocks(editor.document, blocks)
  return editor
}

const text = (b) => (Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : '')
/** columnList → [[texts of column 1], [texts of column 2], …]; other blocks → their text */
const view = (editor) =>
  editor.document.map((b) => (b.type === 'columnList' ? b.children.map((c) => c.children.map(text)) : text(b)))

const P = (id, t = '') => ({ id, type: 'paragraph', content: t })
const group = (...cols) => ({ id: 'g', type: 'columnList', children: cols.map((c, i) => ({ id: `c${i + 1}`, type: 'column', children: c })) })

describe('column commands (2421)', () => {
  it('/2단 on an empty line makes an empty group with the caret in the first column', () => {
    const editor = editorWith([P('a', 'before'), P('x'), P('z', 'after')])
    editor.setTextCursorPosition('x', 'start')
    const first = insertColumns(editor, 2)
    assert.ok(first)
    assert.deepEqual(view(editor), ['before', [[''], ['']], 'after'])
    assert.equal(editor.getTextCursorPosition().block.id, first)
  })

  it('/3단 on a line with text goes below it; refused inside a column', () => {
    const editor = editorWith([P('a', 'text')])
    editor.setTextCursorPosition('a', 'end')
    insertColumns(editor, 3)
    assert.deepEqual(view(editor), ['text', [[''], [''], ['']]])
    assert.equal(insertColumns(editor, 2), null, 'caret is in a column now')
    assert.equal(editor.document.length, 2)
  })

  it('adds columns up to four', () => {
    const editor = editorWith([group([P('l', 'L')], [P('r', 'R')])])
    assert.ok(addColumn(editor, 'g'))
    assert.ok(addColumn(editor, 'g'))
    assert.equal(addColumn(editor, 'g'), null)
    assert.deepEqual(view(editor), [[['L'], ['R'], [''], ['']]])
  })

  it('deleting a column moves its blocks to the end of the left column (the first one’s to the next)', () => {
    const editor = editorWith([group([P('a', 'A')], [P('b', 'B'), P('b2', 'B2')], [P('c', 'C')])])
    deleteColumn(editor, 'c2')
    assert.deepEqual(view(editor), [[['A', 'B', 'B2'], ['C']]])
    const e2 = editorWith([group([P('a', 'A')], [P('b', 'B')], [P('c', 'C')])])
    deleteColumn(e2, 'c1')
    assert.deepEqual(view(e2), [[['A', 'B'], ['C']]])
    // an empty column moves nothing; the target's empty line is replaced by moved blocks
    const e3 = editorWith([group([P('a')], [P('b', 'B')], [P('c')])])
    deleteColumn(e3, 'c3')
    assert.deepEqual(view(e3), [[[''], ['B']]])
    deleteColumn(e3, 'c2')
    assert.deepEqual(view(e3), ['B'], 'one column left: unwrapped')
  })

  it('unwraps into ordinary blocks in order (empty columns leave nothing)', () => {
    const editor = editorWith([P('t', 'top'), group([P('a', 'A'), P('a2', 'A2')], [P('b')], [P('c', 'C')]), P('e', 'end')])
    unwrapColumns(editor, 'g')
    assert.deepEqual(view(editor), ['top', 'A', 'A2', 'C', 'end'])
    assert.deepEqual(
      editor.document.map((b) => b.id),
      ['t', 'a', 'a2', 'c', 'e'],
      'block ids kept',
    )
  })

  it('widths: whole percentages stored as weights; equal = 1 each', () => {
    const editor = editorWith([group([P('a', 'A')], [P('b', 'B')])])
    setColumnPercents(editor, 'g', [70, 30])
    assert.deepEqual(editor.document[0].children.map((c) => c.props.width), [1.4, 0.6])
    setColumnPercents(editor, 'g', [1, 1])
    assert.deepEqual(editor.document[0].children.map((c) => c.props.width), [1, 1])
  })
})

describe('replaceBlocks / removeBlocks inside columns (2421)', () => {
  it('replacing a line in a column keeps the empty columns next to it', () => {
    const editor = editorWith([group([P('a')], [P('b')])])
    const { insertedBlocks } = editor.replaceBlocks(['a'], [{ type: 'heading', content: 'Title' }])
    assert.equal(insertedBlocks[0].type, 'heading')
    assert.deepEqual(view(editor), [[['Title'], ['']]])
  })

  it('removing the only block of a column leaves an empty line; the group stays', () => {
    const editor = editorWith([group([P('a', 'A')], [P('b', 'B')])])
    editor.removeBlocks(['b'])
    assert.deepEqual(view(editor), [[['A'], ['']]])
    editor.removeBlocks(['a'])
    assert.deepEqual(view(editor), [[[''], ['']]])
  })

  it('blocks outside columns go through BlockNote as before', () => {
    const editor = editorWith([P('a', 'A'), P('b', 'B')])
    editor.removeBlocks(['a'])
    assert.deepEqual(view(editor), ['B'])
  })
})

describe('keys at a column edge (2421)', () => {
  it('Backspace in a group whose columns are all empty removes it', () => {
    const editor = editorWith([P('t', 'top'), group([P('a')], [P('b')])])
    editor.setTextCursorPosition('b', 'start')
    assert.equal(columnBackspace(editor), true)
    assert.deepEqual(view(editor), ['top', ''])
  })

  it('Backspace at the start of a column moves the caret left, nothing moves', () => {
    const editor = editorWith([P('t', 'top'), group([P('a', 'A')], [P('b', 'B')])])
    editor.setTextCursorPosition('b', 'start')
    assert.equal(columnBackspace(editor), true)
    assert.equal(editor.getTextCursorPosition().block.id, 'a')
    editor.setTextCursorPosition('a', 'start')
    assert.equal(columnBackspace(editor), true)
    assert.equal(editor.getTextCursorPosition().block.id, 't')
    assert.deepEqual(view(editor), ['top', [['A'], ['B']]])
    // not at the start, or not the first line: BlockNote's own Backspace
    editor.setTextCursorPosition('a', 'end')
    assert.equal(columnBackspace(editor), false)
  })

  it('Delete at the end of a column moves the caret right; before a group into it', () => {
    const editor = editorWith([P('t', 'top'), group([P('a', 'A')], [P('b', 'B')]), P('e', 'end')])
    editor.setTextCursorPosition('a', 'end')
    assert.equal(columnDelete(editor), true)
    assert.equal(editor.getTextCursorPosition().block.id, 'b')
    editor.setTextCursorPosition('b', 'end')
    assert.equal(columnDelete(editor), true)
    assert.equal(editor.getTextCursorPosition().block.id, 'e')
    editor.setTextCursorPosition('t', 'end')
    assert.equal(columnDelete(editor), true)
    assert.equal(editor.getTextCursorPosition().block.id, 'a')
    assert.deepEqual(view(editor), ['top', [['A'], ['B']], 'end'])
  })
})

describe('Yjs: two people in one group', () => {
  const live = () => {
    const a = new Y.Doc()
    blocksToYXmlFragment(BlockNoteEditor.create({ schema }), [group([P('l', 'left')], [P('m', 'mid')], [P('r', 'right')])], a.getXmlFragment('document'))
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    return { a, b }
  }
  const sync = (x, y) => {
    Y.applyUpdate(x, Y.encodeStateAsUpdate(y))
    Y.applyUpdate(y, Y.encodeStateAsUpdate(x))
  }
  const textOf = (doc) => JSON.stringify(yXmlFragmentToBlocks(BlockNoteEditor.create({ schema }), doc.getXmlFragment('document')))
  const paragraphText = (doc, n) => {
    // group › column n › blockContainer › paragraph › text
    const col = doc.getXmlFragment('document').get(0).get(0).get(n)
    return col.get(0).get(0).get(0)
  }

  it('edits in different columns at once both stay', () => {
    const { a, b } = live()
    paragraphText(a, 0).insert(4, ' A')
    paragraphText(b, 2).insert(5, ' B')
    sync(a, b)
    assert.match(textOf(a), /left A/)
    assert.match(textOf(a), /right B/)
    assert.equal(textOf(a), textOf(b))
  })

  it('removing two different columns at once leaves a one-column group (valid, nothing deleted by the read)', () => {
    const { a, b } = live()
    a.getXmlFragment('document').get(0).get(0).delete(0, 1)
    b.getXmlFragment('document').get(0).get(0).delete(2, 1)
    sync(a, b)
    const before = a.getXmlFragment('document').toString()
    const read = textOf(a)
    assert.equal(a.getXmlFragment('document').toString(), before, 'the read deleted nothing')
    assert.match(read, /mid/)
  })

  it('writing in a column another person deletes at the same time: the column goes with that text, the doc stays valid', () => {
    const { a, b } = live()
    a.getXmlFragment('document').get(0).get(0).delete(1, 1)
    paragraphText(b, 1).insert(3, ' typed')
    sync(a, b)
    const read = textOf(a)
    assert.doesNotMatch(read, /typed/)
    assert.match(read, /left/)
    assert.match(read, /right/)
    assert.equal(textOf(a), textOf(b))
  })
})

describe('paste inside a column', () => {
  it('drops column wrappers from pasted HTML', async () => {
    // the jsdom @blocknote/server-util ships (as in sanitizeHtml.test.ts)
    const serverRequire = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/package.json'))
    const { JSDOM } = createRequire(serverRequire.resolve('@blocknote/server-util'))('jsdom')
    const parse = (html) => new JSDOM(html).window.document
    const html = '<div data-node-type="columnList"><div data-node-type="column"><p>a</p></div><div data-node-type="column"><p>b</p></div></div>'
    assert.equal(flattenColumnHtml(html, parse), '<p>a</p><p>b</p>')
    assert.equal(flattenColumnHtml('<p>x</p>', parse), null)
  })
})
