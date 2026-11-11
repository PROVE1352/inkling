// Public page HTML of callouts and colours (docs/adr/2387-*): the server renders a callout as the editor's
// box (type icon + text), and the icon stays out of every text form of the page. Pure — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CALLOUT_EMOJI, CALLOUT_TYPES } from '@inkling/shared'
import { blocksToFullHTML, blocksToMarkdown, markdownToBlocks } from './convert'
import type { AnyBlock } from './convert'
import { publicMarkdownFile } from './publicMarkdown'
import { getServerEditor } from './editor'

const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text: t, styles })
// shaped like the callout reported broken in production: a label, a hard break, inline code, more text
const callout = (type: string): AnyBlock =>
  ({
    type: 'callout',
    props: { type },
    content: [
      text('What we looked at\n'),
      text('strong_positive_correlations.csv', { code: true }),
      text(' sums it up. '),
      text('Bold', { bold: true }),
      text(' and '),
      { type: 'link', href: 'https://example.com/r', content: [text('a link')] },
    ],
    children: [],
  }) as unknown as AnyBlock
const noTitles = () => null
const EMOJI_RE = new RegExp(Object.values(CALLOUT_EMOJI).join('|'))

describe('public HTML: callouts', () => {
  it('each type is the box, its icon (aria-hidden, the editor’s emoji) and then the text', async () => {
    for (const type of CALLOUT_TYPES) {
      const html = await blocksToFullHTML([callout(type)])
      const m = /<div class="nd-callout" data-callout-type="([a-z]+)">(<span[^>]*>)([^<]*)<\/span><div class="bn-inline-content nd-callout-content">(.*?)<\/div><\/div>/.exec(html)
      assert.ok(m, `${type}: ${html}`)
      assert.equal(m[1], type)
      assert.match(m[2], /^<span class="nd-callout-icon" aria-hidden="true">$/)
      assert.equal(m[3], CALLOUT_EMOJI[type])
      // the text, its hard break, inline code, bold and link all inside the text element
      assert.match(m[4], /^What we looked at<br><code>strong_positive_correlations\.csv<\/code> sums it up\. <strong>Bold<\/strong> and <a [^>]*href="https:\/\/example\.com\/r"[^>]*>a link<\/a>$/)
      assert.doesNotMatch(m[4], EMOJI_RE)
    }
  })

  it('a type the server does not know is drawn as a note', async () => {
    const html = await blocksToFullHTML([{ type: 'callout', props: { type: 'bogus' }, content: [text('x')], children: [] } as unknown as AnyBlock])
    // BlockNote keeps the prop on the outer block element; the box and its icon fall back to note
    assert.match(html, /<div class="nd-callout" data-callout-type="note"><span class="nd-callout-icon" aria-hidden="true">💡<\/span>/)
  })

  it('the icon never reaches Markdown: export, the public download and the round trip keep `> [!type] text`', async () => {
    const blocks = CALLOUT_TYPES.map(callout)
    for (const notation of ['plain', 'agent', 'file'] as const) {
      const { markdown } = await blocksToMarkdown(structuredClone(blocks), { assetMode: 'absolute', notation })
      assert.doesNotMatch(markdown, EMOJI_RE, notation)
      for (const type of CALLOUT_TYPES) assert.match(markdown, new RegExp(`^> \\[!${type}\\] What we looked at`, 'm'), `${notation}: ${type}`)
    }
    const file = await publicMarkdownFile('Callouts', structuredClone(blocks), 'https://ink.example')
    assert.doesNotMatch(file.body, EMOJI_RE)
    assert.match(file.body, /^> \[!info\] What we looked at/m)
    const { markdown } = await blocksToMarkdown(structuredClone(blocks), { assetMode: 'absolute' })
    const back = await markdownToBlocks(markdown, noTitles)
    assert.deepEqual(
      back.map((b) => [b.type, b.props?.type]),
      CALLOUT_TYPES.map((t) => ['callout', t]),
    )
  })

  it('HTML read back (paste, clip) takes the text, not the icon', async () => {
    const html = await blocksToFullHTML([callout('tip')])
    const editor = getServerEditor()
    const blocks = (await editor.tryParseHTMLToBlocks(html)) as unknown as AnyBlock[]
    const all = JSON.stringify(blocks)
    assert.match(all, /What we looked at/)
    assert.doesNotMatch(all, EMOJI_RE)
  })
})

describe('public HTML: colours', () => {
  it('text and block colours keep the attributes the public CSS colours by', async () => {
    const html = await blocksToFullHTML([
      { type: 'paragraph', props: { textColor: 'blue', backgroundColor: 'green' }, content: [text('red', { textColor: 'red' }), text('yellow', { backgroundColor: 'yellow' })], children: [] } as unknown as AnyBlock,
    ])
    assert.match(html, /data-content-type="paragraph" data-text-color="blue" data-background-color="green"/)
    assert.match(html, /<span data-style-type="textColor" data-value="red"[^>]*>red<\/span>/)
    assert.match(html, /<span data-style-type="backgroundColor" data-value="yellow"[^>]*>yellow<\/span>/)
  })
})
