// Document schema versions (docs/adr/2425-*): the node table, the walk, the live watch.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { DOC_SCHEMA_VERSION, NODE_SCHEMA, parseSchemaVersion } from '@inkling/shared'
import { MAX_NODE_SCHEMA, schemaOfDoc, schemaOfStoredState, watchDocSchema } from './docSchema'
import { getServerEditor } from './md/editor'
import { blocksToStateBuffer } from './md/convert'

/** Node types of the 0.19 editor schema (document schema 1). Never add to this list: a new node goes in NODE_SCHEMA. */
const SCHEMA_1_NODES = [
  'audio', 'blockContainer', 'blockGroup', 'bulletListItem', 'button', 'callout', 'chart', 'checkListItem', 'codeBlock',
  'divider', 'doc', 'file', 'hardBreak', 'heading', 'image', 'inlineMath', 'linkEmbed', 'math', 'mention',
  'numberedListItem', 'pageEmbed', 'paragraph', 'pluginBlock', 'quote', 'table', 'tableCell', 'tableHeader',
  'tableParagraph', 'tableRow', 'text', 'toggleListItem', 'video',
]

const t = (text: string) => [{ type: 'text', text, styles: {} }]
const p = (text: string) => ({ type: 'paragraph', content: t(text) })
const group = () => ({
  type: 'columnList',
  props: {},
  children: [
    { type: 'column', props: {}, children: [p('left')] },
    { type: 'column', props: {}, children: [p('right')] },
  ],
})
const docOf = (blocks: unknown[]) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(blocksToStateBuffer(blocks as never)))
  return doc
}

describe('document schema (2425)', () => {
  it('every node type of the server schema is a 0.19 node or listed in NODE_SCHEMA', () => {
    const nodes = Object.keys(getServerEditor().editor.pmSchema.nodes)
    const unlisted = nodes.filter((n) => !SCHEMA_1_NODES.includes(n) && NODE_SCHEMA[n] === undefined)
    assert.deepEqual(unlisted, [], 'a new node type needs an entry in NODE_SCHEMA (packages/shared/src/docSchema.ts) and a DOC_SCHEMA_VERSION bump')
    for (const n of SCHEMA_1_NODES) assert.equal(NODE_SCHEMA[n], undefined, `${n} is known to 0.19`)
    assert.equal(MAX_NODE_SCHEMA, DOC_SCHEMA_VERSION, 'the newest node needs this build')
    assert.deepEqual(NODE_SCHEMA, { columnList: 2, column: 2 })
  })

  it('client versions: missing or garbage is 1', () => {
    assert.equal(parseSchemaVersion(null), 1)
    assert.equal(parseSchemaVersion(undefined), 1)
    assert.equal(parseSchemaVersion('abc'), 1)
    assert.equal(parseSchemaVersion('0'), 1)
    assert.equal(parseSchemaVersion('-3'), 1)
    assert.equal(parseSchemaVersion('2.5'), 1)
    assert.equal(parseSchemaVersion('2'), 2)
    assert.equal(parseSchemaVersion(3), 3)
  })

  it('a page without columns needs 1, with a group 2 (also from the stored state)', () => {
    assert.equal(schemaOfDoc(docOf([p('a'), p('b')])), 1)
    assert.equal(schemaOfDoc(docOf([p('a'), group(), p('b')])), 2)
    assert.equal(schemaOfStoredState(blocksToStateBuffer([p('a')] as never)), 1)
    assert.equal(schemaOfStoredState(blocksToStateBuffer([group()] as never)), 2)
    assert.equal(schemaOfStoredState(null), 1)
  })

  it('the watch raises the need in the transaction that adds a group, also inside a rewrite', () => {
    const doc = docOf([p('a')])
    const raised: number[] = []
    watchDocSchema(doc, (_d, need) => raised.push(need))
    // typing: no raise
    doc.transact(() => {
      const frag = doc.getXmlFragment('document')
      const text = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlElement
      ;((text.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(1, 'x')
    })
    assert.deepEqual(raised, [])
    // an update that adds a new blockGroup holding a group (as a rewrite does): found in the nested subtree
    const rewrite = docOf([p('b'), group()])
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(rewrite, Y.encodeStateVector(doc)))
    assert.equal(schemaOfDoc(doc), 2)
    assert.deepEqual(raised, [2])
  })
})
