// Imports drop a first H1 that repeats the page title (md/titleHeading.ts). No database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markdownToBlocks } from './convert'
import { dropLeadingTitleHeading, titleKey } from './titleHeading'

const noLinks = () => null

async function blocksOf(md: string) {
  return markdownToBlocks(md, noLinks)
}

describe('dropLeadingTitleHeading', () => {
  it('drops a first H1 equal to the title, keeping the rest', async () => {
    const blocks = await blocksOf('# Meeting notes\n\nFirst paragraph\n\n## Agenda')
    const out = dropLeadingTitleHeading(blocks, 'Meeting notes')
    assert.equal(out.length, blocks.length - 1)
    assert.equal(out[0].type, 'paragraph')
    assert.equal(out[1].type, 'heading')
  })

  it('matches after whitespace and case normalisation, and through bold / links', async () => {
    assert.equal(dropLeadingTitleHeading(await blocksOf('#   meeting   NOTES  \n\nx'), 'Meeting notes')[0].type, 'paragraph')
    assert.equal(dropLeadingTitleHeading(await blocksOf('# **Meeting** notes\n\nx'), 'Meeting notes')[0].type, 'paragraph')
    assert.equal(
      dropLeadingTitleHeading(await blocksOf('# [Meeting notes](https://example.com)\n\nx'), 'Meeting notes')[0].type,
      'paragraph',
    )
  })

  it('matches an NFD (macOS zip) file name against an NFC heading', async () => {
    const nfdTitle = '회의록'.normalize('NFD')
    assert.notEqual(nfdTitle, '회의록')
    const out = dropLeadingTitleHeading(await blocksOf('# 회의록\n\n본문'), nfdTitle)
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'paragraph')
    assert.equal(titleKey(nfdTitle), titleKey('회의록'))
  })

  it('keeps a heading that differs, is not level 1, or is not first', async () => {
    const differ = await blocksOf('# Chapter 1\n\nx')
    assert.equal(dropLeadingTitleHeading(differ, 'Meeting notes'), differ)
    const h2 = await blocksOf('## Meeting notes\n\nx')
    assert.equal(dropLeadingTitleHeading(h2, 'Meeting notes'), h2)
    const notFirst = await blocksOf('Intro\n\n# Meeting notes')
    assert.equal(dropLeadingTitleHeading(notFirst, 'Meeting notes'), notFirst)
    const empty = await blocksOf('#  \n\nx')
    assert.equal(dropLeadingTitleHeading(empty, ''), empty)
  })

  it('leaves a document that is only the heading empty (the importer then stores an empty paragraph)', async () => {
    assert.deepEqual(dropLeadingTitleHeading(await blocksOf('# Solo'), 'Solo'), [])
    assert.deepEqual(dropLeadingTitleHeading([], 'Solo'), [])
  })
})
