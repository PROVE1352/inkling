// Section links `[[Page#Heading]]` (docs/adr/2100-*) and Mermaid fences (docs/adr/2104-*) through the
// Markdown paths: import, export (people and agents), vault sync, the section index text, Notion
// publishing. Pure — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  internalHref,
  parseInternalHref,
  parseSectionFragment,
  sectionFragment,
  sectionLinkMarkdown,
  wikiSectionCandidates,
} from '@inkling/shared/sectionLink'
import { blocksToMarkdown, extractInternalLinks, extractLinkSections, markdownToBlocks, rewriteInternalLinksForPublic } from './convert'
import type { AnyBlock, LinkInline } from './convert'
import { fixAliasedLinkText, renderSyncMarkdown, wikiTitleResolver } from './syncMd'
import { splitSections } from '../context/chunker'
import { blocksToNotion } from '../notion/mapper'

const WS = '11111111-1111-4111-8111-111111111111'
const GUIDE = '22222222-2222-4222-8222-222222222222'
const CSHARP = '33333333-3333-4333-8333-333333333333'
const SPLIT_CHILD = '44444444-4444-4444-8444-444444444444'
const pageUrl = (id: string) => `/w/${WS}/p/${id}`

/** A resolver shaped like buildTitleResolver: title, then `X#Y` → split subpage Y of X, else X. */
function resolver(titles: Record<string, string>, children: Record<string, string> = {}) {
  const lower = new Map(Object.entries(titles).map(([t, id]) => [t.toLowerCase(), id]))
  return (title: string): string | null => {
    const key = title.toLowerCase()
    let pid = lower.get(key)
    const hash = key.indexOf('#')
    if (!pid && hash > 0) {
      const base = lower.get(key.slice(0, hash).trim())
      if (base) pid = children[`${base}\u0000${key.slice(hash + 1).trim()}`] ?? base
    }
    return pid ? pageUrl(pid) : null
  }
}
const resolve = resolver({ Guide: GUIDE, 'C# notes': CSHARP, C: '55555555-5555-4555-8555-555555555555' })

const toMd = async (blocks: AnyBlock[], notation: 'plain' | 'agent' = 'agent') =>
  (await blocksToMarkdown(blocks, { assetMode: 'absolute', notation })).markdown.trim()
const links = (blocks: AnyBlock[]): LinkInline[] =>
  (blocks[0].content as AnyBlock['content'] & unknown[]).filter((i) => (i as { type: string }).type === 'link') as LinkInline[]

describe('section links: href format (shared)', () => {
  it('writes and reads h, b, p in a fixed order', () => {
    const href = internalHref(WS, GUIDE, { heading: 'Set up & run', blockId: 'abc-123', page: 'Guide' })
    assert.equal(href, `/w/${WS}/p/${GUIDE}#h=Set%20up%20%26%20run&b=abc-123&p=Guide`)
    assert.deepEqual(parseInternalHref(href), {
      workspaceId: WS,
      pageId: GUIDE,
      section: { heading: 'Set up & run', blockId: 'abc-123', page: 'Guide' },
    })
    assert.deepEqual(parseInternalHref(pageUrl(GUIDE)), { workspaceId: WS, pageId: GUIDE, section: null })
    assert.equal(parseInternalHref('https://example.com/w/x'), null)
  })
  it('a fragment without a heading, or a bad block id, is not a section', () => {
    assert.equal(parseSectionFragment('#foo'), null)
    assert.equal(parseSectionFragment('#h='), null)
    assert.deepEqual(parseSectionFragment('#h=A&b=<script>'), { heading: 'A' })
    assert.equal(sectionFragment({ heading: 'A', blockId: 'x y' }), 'h=A')
    assert.equal(parseSectionFragment('#h=%E0%A4%A'), null) // malformed escape: ignored, not thrown
  })
  it('markdown: plain target, alias, current title', () => {
    assert.equal(sectionLinkMarkdown({ heading: 'Setup', page: 'Guide' }, 'Guide#Setup'), '[[Guide#Setup]]')
    assert.equal(sectionLinkMarkdown({ heading: 'Setup', page: 'Guide' }, 'how to start'), '[[Guide#Setup|how to start]]')
    assert.equal(sectionLinkMarkdown({ heading: 'Setup', page: 'Guide' }, 'Guide#Setup', 'Handbook'), '[[Handbook#Setup]]')
    assert.equal(sectionLinkMarkdown({ heading: 'Setup' }, 'Guide#Setup'), '[[Guide#Setup]]')
  })
  it('candidates: every # with a page and a heading, alias cut first', () => {
    assert.deepEqual(wikiSectionCandidates('C# notes#Setup|go'), [
      { page: 'C', heading: 'notes#Setup', alias: 'go' },
      { page: 'C# notes', heading: 'Setup', alias: 'go' },
    ])
    assert.deepEqual(wikiSectionCandidates('#Only'), [])
    assert.deepEqual(wikiSectionCandidates('C#'), [])
  })
})

describe('section links: Markdown → blocks → Markdown', () => {
  it('[[Page#Heading]] becomes a section link and comes back unchanged', async () => {
    const md = 'See [[Guide#Setup]] first.'
    const blocks = await markdownToBlocks(md, resolve)
    const [link] = links(blocks)
    assert.equal(link.href, `/w/${WS}/p/${GUIDE}#h=Setup&p=Guide`)
    assert.deepEqual(link.content.map((c) => c.text), ['Guide#Setup'])
    assert.equal(await toMd(blocks), md)
    assert.equal(await toMd(blocks, 'plain'), md)
  })
  it('[[Page#Heading|shown]] keeps the alias as the text and comes back unchanged', async () => {
    const md = 'Read [[Guide#Setup|the setup steps]] now.'
    const blocks = await markdownToBlocks(md, resolve)
    const [link] = links(blocks)
    assert.deepEqual(link.content.map((c) => c.text), ['the setup steps'])
    assert.equal(parseInternalHref(link.href)?.section?.heading, 'Setup')
    assert.equal(await toMd(blocks), md)
  })
  it('a title with # and a heading with # both resolve', async () => {
    const a = links(await markdownToBlocks('[[C# notes#Setup]]', resolve))[0]
    assert.equal(parseInternalHref(a.href)?.pageId, CSHARP)
    assert.equal(parseInternalHref(a.href)?.section?.heading, 'Setup')
    const b = links(await markdownToBlocks('[[Guide#Step #2]]', resolve))[0]
    assert.equal(parseInternalHref(b.href)?.pageId, GUIDE)
    assert.equal(parseInternalHref(b.href)?.section?.heading, 'Step #2')
    assert.equal(await toMd(await markdownToBlocks('[[Guide#Step #2]]', resolve)), '[[Guide#Step #2]]')
  })
  it('the subpage a split made from that section stays a page link, as before (ADR 1140)', async () => {
    const r = resolver({ Guide: GUIDE }, { [`${GUIDE}\u0000setup`]: SPLIT_CHILD })
    const blocks = await markdownToBlocks('[[Guide#Setup]]', r)
    const [link] = links(blocks)
    assert.equal(link.href, pageUrl(SPLIT_CHILD))
    assert.equal(await toMd(blocks), '[[Guide#Setup]]')
  })
  it('unknown page or [[#Heading]] stays text; page links are unchanged', async () => {
    assert.equal(await toMd(await markdownToBlocks('[[Nope#Setup]] and [[#Local]]', resolve)), '[[Nope#Setup]] and [[#Local]]')
    const plain = await markdownToBlocks('[[Guide]]', resolve)
    assert.equal(links(plain)[0].href, pageUrl(GUIDE))
    assert.equal(await toMd(plain), '[[Guide]]')
  })
  it('a link made in the editor (with a block id) exports by its stored page and heading', async () => {
    const href = internalHref(WS, GUIDE, { heading: 'Setup', blockId: 'h1', page: 'Guide' })
    const blocks: AnyBlock[] = [{ type: 'paragraph', content: [{ type: 'link', href, content: [{ type: 'text', text: 'Guide#Setup', styles: {} }] }] }]
    assert.equal(await toMd(blocks), '[[Guide#Setup]]')
    // reading it back gives the same Markdown (the block id is not in Markdown; the name finds it)
    assert.equal(await toMd(await markdownToBlocks(await toMd(blocks), resolve)), '[[Guide#Setup]]')
  })
})

describe('section links: indexes and other writers', () => {
  const href = internalHref(WS, GUIDE, { heading: 'Setup', blockId: 'h1', page: 'Guide' })
  const doc: AnyBlock[] = [
    { type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Intro', styles: {} }] },
    {
      type: 'paragraph',
      content: [
        { type: 'link', href, content: [{ type: 'text', text: 'Guide#Setup', styles: {} }] },
        { type: 'text', text: ' and ', styles: {} },
        { type: 'link', href: pageUrl(GUIDE), content: [{ type: 'text', text: 'Guide', styles: {} }] },
        { type: 'link', href: internalHref(WS, CSHARP, { heading: 'Setup', page: 'C# notes' }), content: [{ type: 'text', text: 'go', styles: {} }] },
      ],
    },
  ]
  it('backlinks: a section link is a link to its page; sections are listed per target', () => {
    assert.deepEqual(extractInternalLinks(doc).sort(), [CSHARP, GUIDE].sort())
    const s = extractLinkSections(doc)
    assert.deepEqual(s.get(GUIDE), [{ h: 'Setup', b: 'h1' }])
    assert.deepEqual(s.get(CSHARP), [{ h: 'Setup' }])
  })
  it('section index text (find_context, read_page outline) prints [[Page#Heading]]', () => {
    const [sec] = splitSections(doc)
    assert.match(sec.text, /\[\[Guide#Setup\]\] and \[\[Guide\]\]\[\[C# notes#Setup\|go\]\]/)
  })
  it('vault sync export uses the current title and keeps the heading; import keeps the link', async () => {
    const md = await renderSyncMarkdown({ id: GUIDE, properties: [], aliases: [] }, doc, new Map([[GUIDE, 'Handbook'], [CSHARP, 'C# notes']]))
    // the page link keeps its old shown-text rule ([[Current|shown]]); the section link follows the title
    assert.match(md, /\[\[Handbook#Setup\]\] and \[\[Handbook\|Guide\]\]\[\[C# notes#Setup\|go\]\]/)
    const back = await markdownToBlocks('[[Handbook#Setup]] [[Notes#Setup|go]]', wikiTitleResolver(resolver({ Handbook: GUIDE, Notes: CSHARP })))
    fixAliasedLinkText(back)
    const ls = links(back)
    assert.equal(parseInternalHref(ls[0].href)?.section?.heading, 'Setup')
    assert.deepEqual(ls[1].content.map((c) => c.text), ['go'])
    assert.equal(await toMd(back), '[[Handbook#Setup]] [[Notes#Setup|go]]')
    // a title with `#` resolves as itself in sync too (integration, wave 16): never re-pointed to "C"
    const C = '55555555-5555-4555-8555-555555555555'
    const hash = await markdownToBlocks('[[C# notes]] [[C# notes#Setup|go]] [[C#Intro]]', wikiTitleResolver(resolver({ 'C# notes': CSHARP, C })))
    fixAliasedLinkText(hash)
    assert.deepEqual(
      links(hash).map((l) => l.href),
      [pageUrl(CSHARP), `${pageUrl(CSHARP)}#h=Setup&p=C%23%20notes`, `${pageUrl(C)}#h=Intro&p=C`],
    )
  })
  it('public folder share: the link goes to the public page, the fragment is dropped', () => {
    const copy = structuredClone(doc)
    rewriteInternalLinksForPublic(copy, (id) => (id === GUIDE ? '/s/tok/p/g' : null))
    const inl = copy[1].content as { type: string; href?: string; text?: string }[]
    assert.equal(inl[0].href, '/s/tok/p/g')
    assert.equal(inl[3].type, 'text') // target outside the share: text, as page links
  })
  it('Notion publish writes [[Page#Heading]] text', async () => {
    const out = JSON.stringify((await blocksToNotion(doc)).blocks)
    assert.match(out, /\[\[Guide#Setup\]\]/)
  })
})

describe('mermaid fences (docs/adr/2104-*)', () => {
  const fence = '```mermaid\nflowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[[Guide]]\n  B -.-> D[[Guide#Setup]]\n```'
  it('round-trip byte for byte, even with [[…]] shapes that name pages', async () => {
    const blocks = await markdownToBlocks(fence, resolve)
    assert.equal(blocks[0].type, 'codeBlock')
    assert.equal(blocks[0].props?.language, 'mermaid')
    // the code stays plain text: no link is made inside a code block
    assert.ok((blocks[0].content as { type: string }[]).every((c) => c.type === 'text'))
    assert.equal(await toMd(blocks), fence)
    assert.equal(await toMd(blocks, 'plain'), fence)
  })
  it('section index keeps the fence as code', async () => {
    const [sec] = splitSections(await markdownToBlocks(`# D\n\n${fence}`, resolve))
    assert.match(sec.text, /```mermaid\n/)
  })
})
