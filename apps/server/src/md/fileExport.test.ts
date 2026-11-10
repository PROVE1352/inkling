// Inline database views and the file export's snapshots in the Markdown notation (docs/adr/2120-*,
// 2122-*, 2123-*). Pure: no database. The [db] suite (md/dbView.db.test.ts) covers the numbers.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blocksToMarkdown, markdownToBlocks } from './convert'
import type { AnyBlock } from './convert'
import { SNAPSHOT_BLOCK, SNAPSHOT_CLOSE, SNAPSHOT_OPEN } from './notation'

const COLLECTION = '6f1c2a10-1111-4c3b-9a55-0123456789ab'
const VIEW = '7a6b5c4d-3333-4e2f-9a1b-fedcba987654'
const noTitles = () => null
const para = (text: string): AnyBlock => ({ type: 'paragraph', content: [{ type: 'text', text, styles: {} }], children: [] })

/** Blocks without ids, for comparing two reads. */
const shape = (blocks: AnyBlock[]): unknown =>
  blocks.map((b) => ({ type: b.type, props: b.props, content: b.content, children: shape(b.children ?? []) }))

async function md(blocks: AnyBlock[], notation: 'plain' | 'agent' | 'file'): Promise<string> {
  return (await blocksToMarkdown(blocks, { assetMode: 'absolute', notation })).markdown
}

async function snapshotOf(markdown: string): Promise<AnyBlock> {
  return { type: SNAPSHOT_BLOCK, props: {}, content: [], children: await markdownToBlocks(markdown, noTitles) }
}

describe('database view token and file-export snapshots', () => {
  it('a database view reads as the page-embed token with its view id, and comes back', async () => {
    const blocks = [para('before'), { type: 'pageEmbed', props: { pageId: COLLECTION, viewId: VIEW }, children: [] }, para('after')]
    const out = await md(blocks, 'agent')
    assert.match(out, new RegExp(`<!-- inkling:pageEmbed \\{"pageId":"${COLLECTION}","viewId":"${VIEW}"\\} -->`))
    const back = await markdownToBlocks(out, noTitles)
    const embed = back.find((b) => b.type === 'pageEmbed')
    assert.deepEqual(embed?.props, { pageId: COLLECTION, viewId: VIEW })
    // a page embed without a view keeps its old token (the default is not written)
    const plainEmbed = await md([{ type: 'pageEmbed', props: { pageId: COLLECTION, viewId: '' }, children: [] }], 'agent')
    assert.match(plainEmbed, new RegExp(`<!-- inkling:pageEmbed \\{"pageId":"${COLLECTION}"\\} -->`))
  })

  it('a view id that is not an id is dropped (the first view), the block kept', async () => {
    const back = await markdownToBlocks(`<!-- inkling:pageEmbed {"pageId":"${COLLECTION}","viewId":"Board"} -->`, noTitles)
    assert.equal(back[0].type, 'pageEmbed')
    assert.equal(back[0].props?.pageId, COLLECTION)
    assert.ok(!back[0].props?.viewId)
  })

  it('plain Markdown (vault sync, templates) is unchanged: no token, no snapshot', async () => {
    const blocks = [para('a'), { type: 'pageEmbed', props: { pageId: COLLECTION, viewId: VIEW }, children: [] }, para('b')]
    const out = await md(blocks, 'plain')
    assert.doesNotMatch(out, /inkling/)
    assert.equal(out.trim(), 'a\n\nb')
  })

  it('file mode: token + snapshot; import restores the block and drops the snapshot; export again is identical', async () => {
    const blocks = [
      para('before'),
      { type: 'pageEmbed', props: { pageId: COLLECTION, viewId: VIEW }, children: [] },
      await snapshotOf('**Roadmap · Open**\n\n| Title | Status |\n| --- | --- |\n| Login | Done |\n| Search | Doing |\n'),
      para('after'),
    ]
    const first = await md(blocks, 'file')
    assert.ok(first.includes(SNAPSHOT_OPEN) && first.includes(SNAPSHOT_CLOSE), first)
    assert.match(first, /<!-- inkling:pageEmbed \{.*\} -->\n\n<!-- inkling:snapshot -->\n\n\*\*Roadmap · Open\*\*/)
    assert.match(first, /\| Login\s*\| Done\s*\|/)
    const back = await markdownToBlocks(first, noTitles)
    assert.deepEqual(
      back.map((b) => b.type),
      ['paragraph', 'pageEmbed', 'paragraph'],
      'the snapshot table is not imported',
    )
    // the importer (or a person) gets the block back; exporting it again with a fresh snapshot is stable
    const again = await md([...back.slice(0, 2), await snapshotOf('**Roadmap · Open**\n\n| Title | Status |\n| --- | --- |\n| Login | Done |\n| Search | Doing |\n'), back[2]], 'file')
    assert.equal(again, first)
  })

  it('a snapshot after a query fence is dropped; the fence comes back as the query block', async () => {
    const query = { type: 'codeBlock', props: { language: 'dataview' }, content: [{ type: 'text', text: 'LIST FROM "Roadmap"', styles: {} }], children: [] }
    const out = await md([query, await snapshotOf('| Page |\n| --- |\n| Login |\n')], 'file')
    assert.match(out, /```dataview\nLIST FROM "Roadmap"\n```\n\n<!-- inkling:snapshot -->/)
    const back = await markdownToBlocks(out, noTitles)
    assert.equal(back.length, 1)
    assert.equal(back[0].type, 'codeBlock')
    assert.equal(back[0].props?.language, 'dataview')
  })

  it('a snapshot that follows nothing it belongs to stays as written (only the markers vanish)', async () => {
    const md0 = `Some text\n\n${SNAPSHOT_OPEN}\n\n| A |\n| --- |\n| 1 |\n\n${SNAPSHOT_CLOSE}\n`
    const back = await markdownToBlocks(md0, noTitles)
    assert.deepEqual(
      back.map((b) => b.type),
      ['paragraph', 'table'],
    )
    // and an unterminated snapshot after a token is not swallowed
    const open = await markdownToBlocks(`<!-- inkling:pageEmbed {"pageId":"${COLLECTION}"} -->\n\n${SNAPSHOT_OPEN}\n\nkept text\n`, noTitles)
    assert.deepEqual(
      open.map((b) => b.type),
      ['pageEmbed', 'paragraph'],
    )
  })

  it('a chart token followed by its snapshot comes back as the chart alone', async () => {
    const config = JSON.stringify({ groupBy: { field: 'st' }, kind: 'bar', source: { collectionId: COLLECTION, type: 'collection' } })
    const out = await md([{ type: 'chart', props: { config }, children: [] }, await snapshotOf('| Status | Count |\n| --- | --- |\n| Done | 2 |\n')], 'file')
    assert.match(out, /^<!-- inkling:chart \{/)
    const back = await markdownToBlocks(out, noTitles)
    assert.deepEqual(shape(back), shape([{ type: 'chart', props: { config }, children: [] }]))
  })
})
