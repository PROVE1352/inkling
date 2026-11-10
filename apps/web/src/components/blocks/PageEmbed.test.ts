// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// The page-embed viewer binds a read-only editor to another page's LIVE Yjs doc, and y-prosemirror
// deletes the Yjs items of nodes the binding's schema does not know (docs/adr/0995-*). So the
// embed schema must know every custom block and inline node the main editor writes
// (docs/adr/1539-embed-viewer-schema-from-the-shared-block-list.md).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { BlockNoteEditor, BlockNoteSchema } from '@blocknote/core'
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from '@blocknote/core/yjs'
// Loaded before the DOM stub below: prosemirror-view feature-detects `document` at load time.
import '@blocknote/react'
import '@blocknote/mantine'
import {
  CUSTOM_BLOCK_TYPES,
  CUSTOM_INLINE_CONTENT_TYPES,
  buttonBlockConfig,
  calloutConfig,
  chartBlockConfig,
  inlineMathConfig,
  linkEmbedConfig,
  mathBlockConfig,
  mentionConfig,
  pageEmbedConfig,
  pluginBlockConfig,
} from '@inkling/shared'

// Some app modules touch `window` / `document` when they load (theme, zoom, update listeners). The
// specs themselves never do, so an inert stand-in is enough to import them; it is removed again
// before any editor is created.
const g = globalThis as Record<string, unknown>
const inert = (): unknown =>
  new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : inert()),
    set: () => true,
    apply: () => inert(),
    construct: () => inert(),
  })
g.window = inert()
g.document = inert()
const { editorSchemaSpecs, embedSchema, pageEmbedSpec } = await import('./PageEmbed')
const { queryCodeBlockSpec } = await import('./QueryBlock')
delete g.window
delete g.document

// Every custom node config of @inkling/shared (the configs the server schema registers too).
const CUSTOM_BLOCKS = [calloutConfig, pageEmbedConfig, linkEmbedConfig, pluginBlockConfig, mathBlockConfig, chartBlockConfig, buttonBlockConfig]
const CUSTOM_INLINES = [mentionConfig, inlineMathConfig]

// The main editor schema, built the way CollabEditor builds it (CollabEditor itself imports CSS
// and cannot load under Node).
const mainSchema = BlockNoteSchema.create(
  editorSchemaSpecs({ pageEmbed: pageEmbedSpec, codeBlock: queryCodeBlockSpec }),
)

// A page that uses every custom node of the main schema.
const page = [
  { type: 'paragraph', content: 'before' },
  {
    type: 'callout',
    props: { type: 'tip' },
    content: [
      { type: 'text', text: 'ask ', styles: {} },
      { type: 'mention', props: { kind: 'user', id: 'u1', label: 'Ann' } },
    ],
  },
  {
    type: 'paragraph',
    content: [
      { type: 'mention', props: { kind: 'page', id: 'p1', label: 'Specs' } },
      { type: 'text', text: ' and ', styles: {} },
      { type: 'inlineMath', props: { latex: 'x^2' } },
    ],
  },
  { type: 'linkEmbed', props: { url: 'https://example.com/a', display: 'card' } },
  { type: 'pluginBlock', props: { pluginId: 'kanban', blockType: 'board', data: '{"cols":2}' } },
  { type: 'math', props: { latex: '\\frac{a}{b}' } },
  { type: 'pageEmbed', props: { pageId: 'p2' } },
  { type: 'button', props: { label: 'Start', color: 'blue', actions: '[{"pageId":"p3","type":"open"}]' } },
  { type: 'codeBlock', props: { language: 'dataview' }, content: 'LIST' },
  { type: 'paragraph', content: 'after' },
]

function liveDoc() {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('document')
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: mainSchema }), page, fragment)
  return { doc, fragment }
}

// Strips block ids so two reads of the same document compare equal.
const shape = (blocks) =>
  blocks.map(({ id: _id, children, ...rest }) => ({ ...rest, children: shape(children ?? []) }))

describe('page-embed viewer schema (1539)', () => {
  it('knows every custom block and inline node of the shared config list', () => {
    assert.deepEqual([...CUSTOM_BLOCK_TYPES].sort(), CUSTOM_BLOCKS.map((c) => c.type).sort())
    assert.deepEqual([...CUSTOM_INLINE_CONTENT_TYPES].sort(), CUSTOM_INLINES.map((c) => c.type).sort())
    const blocks = Object.keys(embedSchema.blockSchema)
    const inlines = Object.keys(embedSchema.inlineContentSchema)
    for (const c of CUSTOM_BLOCKS) assert.ok(blocks.includes(c.type), `embed schema lacks block "${c.type}"`)
    for (const c of CUSTOM_INLINES) assert.ok(inlines.includes(c.type), `embed schema lacks inline "${c.type}"`)
  })

  it('has the same block and inline node types and props as the main editor schema', () => {
    assert.deepEqual(Object.keys(embedSchema.blockSchema).sort(), Object.keys(mainSchema.blockSchema).sort())
    assert.deepEqual(
      Object.keys(embedSchema.inlineContentSchema).sort(),
      Object.keys(mainSchema.inlineContentSchema).sort(),
    )
    for (const [type, spec] of Object.entries(mainSchema.blockSchema)) {
      assert.deepEqual(embedSchema.blockSchema[type].propSchema, spec.propSchema, `props of "${type}"`)
      assert.equal(embedSchema.blockSchema[type].content, spec.content, `content of "${type}"`)
    }
    for (const [type, spec] of Object.entries(mainSchema.inlineContentSchema)) {
      if (typeof spec === 'string') assert.equal(embedSchema.inlineContentSchema[type], spec)
      else assert.deepEqual(embedSchema.inlineContentSchema[type].propSchema, spec.propSchema, `props of "${type}"`)
    }
  })

  it('reading the live doc with the embed schema deletes nothing (Yjs round trip)', () => {
    const { fragment } = liveDoc()
    const before = fragment.toString()
    const expected = shape(yXmlFragmentToBlocks(BlockNoteEditor.create({ schema: mainSchema }), fragment))
    assert.equal(fragment.toString(), before, 'reading with the main schema must not change the doc')

    const read = yXmlFragmentToBlocks(BlockNoteEditor.create({ schema: embedSchema }), fragment)
    assert.equal(fragment.toString(), before, 'the embed schema deleted nodes from the live doc')
    assert.deepEqual(shape(read), expected)
  })

  it('control: a schema without the custom nodes deletes them from the live doc', () => {
    const { fragment } = liveDoc()
    const before = fragment.toString()
    yXmlFragmentToBlocks(BlockNoteEditor.create({ schema: BlockNoteSchema.create() }), fragment)
    const after = fragment.toString()
    assert.notEqual(after, before)
    for (const tag of ['<callout', '<mention', '<linkembed', '<pluginblock', '<math', '<inlinemath', '<pageembed', '<button']) {
      assert.ok(before.toLowerCase().includes(tag), `fixture writes ${tag}`)
      assert.ok(!after.toLowerCase().includes(tag), `default schema keeps ${tag}?`)
    }
  })
})
