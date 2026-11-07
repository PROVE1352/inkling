// Run: cd apps/server && npx tsx --test src/md/tagIndex.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blocksToTagText, extractTags } from './tagIndex'

const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text: t, styles })

describe('tag extraction', () => {
  it('ignores #rrggbb inside code blocks and inline code spans', () => {
    const blocks = [
      { type: 'paragraph', content: [text('Brand color '), text('#1e66f5', { code: true }), text(' #design')] },
      { type: 'codeBlock', props: { language: 'css' }, content: [text('.a { color: #ff0000; } #notatag')] },
      { type: 'codeBlock', props: { language: 'dataview' }, content: [text('LIST FROM #project')] },
      {
        type: 'paragraph',
        content: [text('see '), text('#abcdef', { code: true, bold: true })],
        children: [{ type: 'bulletListItem', content: [text('nested #roadmap')] }],
      },
      {
        type: 'table',
        content: { type: 'tableContent', rows: [{ cells: [[text('#cell')], [text('#c0ffee', { code: true })]] }] },
      },
    ]
    assert.deepEqual(extractTags(blocksToTagText(blocks as unknown as Parameters<typeof blocksToTagText>[0])), ['design', 'roadmap', 'cell'])
  })
})
