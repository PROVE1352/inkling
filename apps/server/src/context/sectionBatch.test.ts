// patch_sections on a Y.Doc (docs/adr/1542-*): all edits or none. Pure — no database, no server.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as Y from 'yjs'
import { splitSections } from './chunker'
import { markdownToBlocks } from '../md/convert'
import { getServerEditor } from '../md/editor'
import { applySectionBatch } from './sectionBatch'
import type { BatchEdit } from './sectionBatch'
import { readBlocks } from './sectionPatch'

const editor = getServerEditor()
const noTitles = () => null
const MD = '## Setup\n\nInstall.\n\n## Backups\n\nNightly.\n\n## Restore\n\nMonthly.'

async function setup() {
  const doc = editor.blocksToYDoc((await markdownToBlocks(MD, noTitles)) as never, 'document')
  const sections = splitSections(readBlocks(doc))
  const by = (a: string) => sections.find((s) => s.anchor === a)!
  const edit = async (anchor: string, mode: BatchEdit['mode'], md: string, baseVersion?: string): Promise<BatchEdit> => ({
    blockId: by(anchor).blockId,
    anchor,
    incoming: md ? await markdownToBlocks(md, noTitles) : [],
    mode,
    baseVersion,
    echo: null,
  })
  return { doc, by, edit }
}

const state = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')

describe('applySectionBatch', () => {
  it('applies every edit in order; later edits find their section by block id after earlier ones', async () => {
    const { doc, by, edit } = await setup()
    const out = applySectionBatch(doc, [
      // a new "## Setup" section right after Backups takes the "setup~2" anchor; Restore is still found
      await edit('backups', 'insert_after', '## Setup\n\nAgain.'),
      await edit('setup', 'replace', 'Install with pnpm.', by('setup').version),
      await edit('restore', 'append', 'Quarterly.'),
    ])
    assert.equal(out.status, 'ok')
    const text = splitSections(readBlocks(doc)).map((s) => `${s.anchor}:${s.text.trim()}`)
    assert.deepEqual(text, ['setup:Install with pnpm.', 'backups:Nightly.', 'setup~2:Again.', 'restore:Monthly.\nQuarterly.'])
  })

  it('a stale baseVersion anywhere: nothing is written, every stale edit is listed', async () => {
    const { doc, edit } = await setup()
    const before = state(doc)
    const out = applySectionBatch(doc, [await edit('setup', 'append', 'x'), await edit('backups', 'replace', 'y', 'stale'), await edit('restore', 'delete', '', 'stale')])
    assert.equal(out.status, 'failed')
    if (out.status === 'failed') assert.deepEqual(out.failures.map((f) => [f.index, f.reason]), [[1, 'version'], [2, 'version']])
    assert.equal(state(doc), before)
  })

  it('an edit that fails on the copy (empty body) leaves the live document untouched, even after a good first edit', async () => {
    const { doc, edit } = await setup()
    const before = state(doc)
    const out = applySectionBatch(doc, [await edit('setup', 'append', 'fine'), await edit('backups', 'append', '')])
    assert.equal(out.status, 'failed')
    if (out.status === 'failed') {
      assert.equal(out.failures[0].index, 1)
      assert.equal(out.failures[0].reason, 'invalid')
    }
    assert.equal(state(doc), before)
  })

  it('a section an earlier edit deleted: nothing is written', async () => {
    const { doc, by, edit } = await setup()
    const before = state(doc)
    // same block id twice is refused by the route; here the batch itself must still be all-or-nothing
    const del = await edit('backups', 'delete', '', by('backups').version)
    const out = applySectionBatch(doc, [del, { ...del, mode: 'append', incoming: await markdownToBlocks('late', noTitles), baseVersion: undefined }])
    assert.equal(out.status, 'failed')
    assert.equal(state(doc), before)
  })
})
