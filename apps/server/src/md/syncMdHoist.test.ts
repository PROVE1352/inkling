// Vault sync import: an image inside a line of text moves onto its own line so it imports as an image
// block instead of being dropped (docs/adr/2168-*). Run: cd apps/server && npx tsx --test src/md/syncMdHoist.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markdownToBlocks } from './convert'
import { hoistInlineImages } from './syncMd'

describe('hoistInlineImages', () => {
  it('moves an inline image after its line, keeping list and quote structure', () => {
    assert.equal(hoistInlineImages('see ![x](img/a.png) here'), 'see here\n\n![x](img/a.png)')
    assert.equal(hoistInlineImages('- item ![x](a.png) tail'), '- item tail\n\n  ![x](a.png)')
    assert.equal(hoistInlineImages('1. [ ] task ![x](a.png)'), '1. [ ] task\n\n       ![x](a.png)')
    assert.equal(hoistInlineImages('> quote ![x](a.png)'), '> quote\n>\n> ![x](a.png)')
    assert.equal(hoistInlineImages('two ![a](a.png) and ![b](b.png)'), 'two and\n\n![a](a.png)\n\n![b](b.png)')
  })

  it('leaves images alone on their line, table rows and code fences', () => {
    for (const md of ['![a](b.png)', '- ![a](b.png)', '| a | ![x](a.png) |', '```\ncode ![x](a.png)\n```', '~~~md\n![x](a.png) text\n~~~', 'no image here']) {
      assert.equal(hoistInlineImages(md), md)
    }
  })

  it('the hoisted form imports as an image block; the inline form did not', async () => {
    const resolve = () => null
    const types = async (md: string) => {
      const out: string[] = []
      const walk = (bs: { type?: string; children?: unknown[] }[]) => bs.forEach((b) => (out.push(b.type ?? ''), walk((b.children ?? []) as never)))
      walk((await markdownToBlocks(md, resolve)) as never)
      return out
    }
    assert.ok(!(await types('text ![x](/files/00000000-0000-4000-8000-000000000000)')).includes('image'))
    assert.ok((await types(hoistInlineImages('text ![x](/files/00000000-0000-4000-8000-000000000000)'))).includes('image'))
    assert.ok((await types(hoistInlineImages('- item ![x](/files/00000000-0000-4000-8000-000000000000)'))).includes('image'))
  })
})
