// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Inline database views (docs/adr/2120-*) are page embeds of a collection with a `viewId` prop. A
// client from before 0.17 knows `pageEmbed` but not `viewId`; this checks what such a client does to
// the live Yjs document: it must keep the block (unlike an unknown node type, CHART-2) and may only
// lose `viewId` when it rewrites that very node (then the block shows the collection's first view).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Y from 'yjs'
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { blocksToYXmlFragment } from '@blocknote/core/yjs'
import { createReactBlockSpec } from '@blocknote/react'
import '@blocknote/mantine'
import { pageEmbedConfig } from '@inkling/shared'

// y-prosemirror and prosemirror-state are BlockNote's own dependencies (not the app's): load the
// copies BlockNote binds the editor with, next to its resolved package.
const nm = path.resolve(fileURLToPath(import.meta.resolve('@blocknote/core')), '../../../..')
const { initProseMirrorDoc, updateYFragment } = await import(pathToFileURL(path.join(nm, 'y-prosemirror/src/y-prosemirror.js')).href)
const { EditorState } = await import(pathToFileURL(path.join(nm, 'prosemirror-state/dist/index.js')).href)

const COLLECTION = '11111111-2222-4333-8444-555555555555'
const VIEW = '66666666-7777-4888-9999-aaaaaaaaaaaa'

// Today's schema (pageEmbed with viewId) and an "old client" schema: the pageEmbed of 0.1 to 0.16
// (pageId only) and none of the newer custom blocks.
const newSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, pageEmbed: createReactBlockSpec(pageEmbedConfig, { render: () => null })() },
})
const oldPageEmbed = { ...pageEmbedConfig, propSchema: { pageId: { default: '' } } }
const oldSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, pageEmbed: createReactBlockSpec(oldPageEmbed, { render: () => null })() },
})

function liveDoc() {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('document')
  blocksToYXmlFragment(
    BlockNoteEditor.create({ schema: newSchema }),
    [
      { type: 'paragraph', content: 'before' },
      { type: 'pageEmbed', props: { pageId: COLLECTION, viewId: VIEW } },
      { type: 'paragraph', content: 'after' },
    ],
    fragment,
  )
  return { doc, fragment }
}

/** The old client's ProseMirror view of the doc, bound like y-prosemirror binds it. */
function oldClient(fragment) {
  const pmSchema = BlockNoteEditor.create({ schema: oldSchema }).pmSchema
  const { doc, meta } = initProseMirrorDoc(fragment, pmSchema)
  return { state: EditorState.create({ doc }), meta }
}

function findNode(doc, name) {
  let found = null
  doc.descendants((node, pos) => {
    if (!found && node.type.name === name) found = { node, pos }
    return !found
  })
  return found
}

describe('inline database view in a pre-0.17 client (2120)', () => {
  it('reading the doc keeps the block and its viewId', () => {
    const { fragment } = liveDoc()
    const before = fragment.toString()
    oldClient(fragment)
    assert.equal(fragment.toString(), before)
    assert.ok(before.includes(`viewId="${VIEW}"`) || before.includes(VIEW), 'fixture stores the view id')
  })

  it('typing in another block keeps the block and its viewId', () => {
    const { doc, fragment } = liveDoc()
    const { state, meta } = oldClient(fragment)
    const p = findNode(state.doc, 'paragraph')
    const tr = state.tr.insertText('x', p.pos + 1)
    updateYFragment(doc, fragment, tr.doc, meta)
    const after = fragment.toString()
    assert.ok(after.includes('xbefore'), 'the edit reached the doc')
    assert.ok(after.toLowerCase().includes('<pageembed'), 'the block is still there')
    assert.ok(after.includes(VIEW), 'the view id is still there')
  })

  it('rewriting the node itself keeps the block but drops viewId (first view then)', () => {
    const { doc, fragment } = liveDoc()
    const { state, meta } = oldClient(fragment)
    const e = findNode(state.doc, 'pageEmbed')
    const tr = state.tr.setNodeMarkup(e.pos, undefined, { ...e.node.attrs })
    updateYFragment(doc, fragment, tr.doc, meta)
    const after = fragment.toString()
    assert.ok(after.toLowerCase().includes('<pageembed'), 'the block is still there')
    assert.ok(after.includes(COLLECTION), 'still points at the collection')
    assert.ok(!after.includes(VIEW), 'the old schema has no viewId to write back')
  })

  it('control: a schema without pageEmbed deletes the block on read (what a new node type would do)', () => {
    const { fragment } = liveDoc()
    initProseMirrorDoc(fragment, BlockNoteEditor.create({ schema: BlockNoteSchema.create() }).pmSchema)
    assert.ok(!fragment.toString().toLowerCase().includes('<pageembed'))
  })
})
