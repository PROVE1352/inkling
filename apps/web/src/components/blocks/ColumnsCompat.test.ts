// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Columns (0.20, docs/adr/2420-*) are new nodes. A client from before 0.20 does not know `columnList`
// or `column`, and y-prosemirror deletes the Yjs items of nodes its schema does not know when it binds
// to the live document. Unlike the 0.18 button (which lost only itself, ButtonCompat.test.ts) the
// whole group goes with the blocks inside it: recorded here as the known limit; today's schema keeps it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Y from 'yjs'
import { BlockNoteEditor, BlockNoteSchema, createBlockSpecFromTiptapNode, defaultBlockSpecs } from '@blocknote/core'
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from '@blocknote/core/yjs'
import { columnListPropSchema, columnNodes, columnPropSchema } from '@inkling/shared'

const nm = path.resolve(fileURLToPath(import.meta.resolve('@blocknote/core')), '../../../..')
const { initProseMirrorDoc } = await import(pathToFileURL(path.join(nm, 'y-prosemirror/src/y-prosemirror.js')).href)

const pm = columnNodes(BlockNoteSchema.create().blockSpecs.paragraph.implementation.node.constructor)
const oldSchema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs } })
const newSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    columnList: createBlockSpecFromTiptapNode({ node: pm.columnList, type: 'columnList', content: 'none' }, columnListPropSchema),
    column: createBlockSpecFromTiptapNode({ node: pm.column, type: 'column', content: 'none' }, columnPropSchema),
  },
})

function liveDoc() {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('document')
  blocksToYXmlFragment(
    BlockNoteEditor.create({ schema: newSchema }),
    [
      { type: 'paragraph', content: 'before' },
      { type: 'columnList', children: [{ type: 'column', children: [{ type: 'paragraph', content: 'left' }] }, { type: 'column', children: [{ type: 'paragraph', content: 'right' }] }] },
      { type: 'paragraph', content: 'after' },
    ],
    fragment,
  )
  return fragment
}

describe('columns in a pre-0.20 client (2420)', () => {
  it('today’s schema keeps the group and its blocks', () => {
    const fragment = liveDoc()
    const before = fragment.toString()
    initProseMirrorDoc(fragment, BlockNoteEditor.create({ schema: newSchema }).pmSchema)
    assert.equal(fragment.toString(), before)
    const blocks = yXmlFragmentToBlocks(BlockNoteEditor.create({ schema: newSchema }), fragment)
    assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'columnList', 'paragraph'])
  })

  it('a 0.19 schema deletes the whole group with the blocks inside (known limit)', () => {
    const fragment = liveDoc()
    initProseMirrorDoc(fragment, BlockNoteEditor.create({ schema: oldSchema }).pmSchema)
    const after = fragment.toString()
    assert.ok(!/columnlist/i.test(after))
    assert.ok(!after.includes('>left<') && !after.includes('>right<'), 'the blocks inside went too')
    assert.ok(after.includes('>before<') && after.includes('>after<'), 'the rest stays')
  })
})
