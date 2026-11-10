// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Button blocks (0.18, docs/adr/2244-*) are a new node type. A client from before 0.18 does not
// know `button`, and y-prosemirror deletes the Yjs items of nodes its schema does not know when it
// binds to the live document — the same known limit as charts in 0.15 clients (CHART-2). This
// records what happens: the button node goes, the blocks around it (and other custom blocks) stay;
// today's schema keeps it.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Y from 'yjs'
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from '@blocknote/core/yjs'
import { createReactBlockSpec } from '@blocknote/react'
import '@blocknote/mantine'
import { buttonBlockConfig, calloutConfig, chartBlockConfig } from '@inkling/shared'

const nm = path.resolve(fileURLToPath(import.meta.resolve('@blocknote/core')), '../../../..')
const { initProseMirrorDoc } = await import(pathToFileURL(path.join(nm, 'y-prosemirror/src/y-prosemirror.js')).href)

const spec = (config) => createReactBlockSpec(config, { render: () => null })()
// 0.17: callout and chart, no button. 0.18: the same plus button.
const oldSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, callout: spec(calloutConfig), chart: spec(chartBlockConfig) },
})
const newSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, callout: spec(calloutConfig), chart: spec(chartBlockConfig), button: spec(buttonBlockConfig) },
})

const ACTIONS = '[{"type":"open","url":"https://example.com/a"}]'
const CHART = '{"source":{"kind":"collection","collectionId":"11111111-2222-4333-8444-555555555555"},"kind":"bar"}'

function liveDoc() {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('document')
  blocksToYXmlFragment(
    BlockNoteEditor.create({ schema: newSchema }),
    [
      { type: 'paragraph', content: 'before' },
      { type: 'button', props: { label: 'Start review', color: 'green', actions: ACTIONS } },
      { type: 'callout', props: { type: 'tip' }, content: 'note' },
      { type: 'chart', props: { config: CHART } },
      { type: 'paragraph', content: 'after' },
    ],
    fragment,
  )
  return { doc, fragment }
}

const kinds = (blocks) => blocks.map((b) => b.type)

describe('button block in a pre-0.18 client (2244)', () => {
  it('fixture stores the button with its props', () => {
    const before = liveDoc().fragment.toString()
    assert.ok(before.toLowerCase().includes('<button'))
    assert.ok(before.includes('Start review'))
  })

  it('today’s schema keeps the button and everything else', () => {
    const { fragment } = liveDoc()
    const before = fragment.toString()
    initProseMirrorDoc(fragment, BlockNoteEditor.create({ schema: newSchema }).pmSchema)
    assert.equal(fragment.toString(), before)
    const blocks = yXmlFragmentToBlocks(BlockNoteEditor.create({ schema: newSchema }), fragment)
    assert.deepEqual(kinds(blocks), ['paragraph', 'button', 'callout', 'chart', 'paragraph'])
    assert.equal(blocks[1].props.label, 'Start review')
    assert.equal(blocks[1].props.color, 'green')
    assert.equal(blocks[1].props.actions, ACTIONS)
  })

  it('a 0.17 schema drops only the button node (known limit, like CHART-2)', () => {
    const { fragment } = liveDoc()
    initProseMirrorDoc(fragment, BlockNoteEditor.create({ schema: oldSchema }).pmSchema)
    const after = fragment.toString()
    assert.ok(!after.toLowerCase().includes('<button'), 'the old schema deletes the unknown node')
    assert.ok(!after.includes('Start review'))
    for (const s of ['before', 'after', 'note', '<callout', '<chart']) {
      assert.ok(after.toLowerCase().includes(s.toLowerCase()), `kept ${s}`)
    }
    // the whole block container goes (no empty block left behind); the rest reads in order, with
    // the old and with the new schema
    assert.equal((after.match(/<blockcontainer/gi) ?? []).length, 4)
    for (const schema of [oldSchema, newSchema]) {
      const blocks = yXmlFragmentToBlocks(BlockNoteEditor.create({ schema }), fragment)
      assert.deepEqual(kinds(blocks), ['paragraph', 'callout', 'chart', 'paragraph'])
      assert.equal(blocks[0].content[0].text, 'before')
      assert.equal(blocks[3].content[0].text, 'after')
      assert.equal(blocks[2].props.config, CHART)
    }
  })
})
