// Section chunker, ranking and packing (docs/adr/0926-*, 0927-*). Pure — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AnyBlock } from '../md/convert'
import { chunkBlocks, cjkBigrams, findSection, MAX_CHUNK_TOKENS, slugify, splitSections } from './chunker'
import { pack, queryTerms, scoreCandidate, TopK, tsqueryText } from './rank'
import type { Scored } from './rank'
import { estimateTokens, truncateToTokens } from './tokens'

const p = (t: string): AnyBlock => ({ type: 'paragraph', content: [{ type: 'text', text: t, styles: {} }] as never })
const h = (t: string, level = 2, id?: string): AnyBlock => ({
  id,
  type: 'heading',
  props: { level },
  content: [{ type: 'text', text: t, styles: {} }] as never,
})

describe('chunker', () => {
  it('slugify keeps Korean, drops punctuation', () => {
    assert.equal(slugify('Rolling deploy!'), 'rolling-deploy')
    assert.equal(slugify('결정 사항'), '결정-사항')
    assert.equal(slugify('  '), 'section')
  })

  it('splits at top-level headings with nested anchors, intro and duplicates', () => {
    const blocks = [p('intro text'), h('Setup', 1, 'b1'), p('a'), h('Backups', 2), p('b'), h('Setup', 1), h('Backups', 2), p('c')]
    const s = splitSections(blocks)
    assert.deepEqual(
      s.map((x) => x.anchor),
      ['_intro', 'setup', 'setup/backups', 'setup~2', 'setup/backups~2'],
    )
    assert.equal(s[1].blockId, 'b1')
    assert.deepEqual(s[2].headingPath, ['Setup', 'Backups'])
    assert.equal(s[2].text, 'b')
    assert.equal(s[0].start, 0)
    assert.equal(s[1].start, 1)
    assert.equal(s[1].end, 3)
  })

  it('omits an empty intro and keeps heading-only sections', () => {
    const s = splitSections([p(''), h('Only heading')])
    assert.deepEqual(s.map((x) => x.anchor), ['only-heading'])
    assert.equal(s[0].text, '')
  })

  it('section version changes with body and heading, not with other sections', () => {
    const a = splitSections([h('A'), p('one'), h('B'), p('two')])
    const b = splitSections([h('A'), p('one'), h('B'), p('two!')])
    const c = splitSections([h('A2'), p('one'), h('B'), p('two')])
    assert.equal(a[0].version, b[0].version)
    assert.notEqual(a[1].version, b[1].version)
    assert.notEqual(a[0].version, c[0].version)
  })

  it('light markdown: lists, checks, code, tables, internal links', () => {
    const blocks: AnyBlock[] = [
      h('S'),
      { type: 'bulletListItem', content: [{ type: 'text', text: 'item', styles: {} }] as never, children: [p('child')] },
      { type: 'checkListItem', props: { checked: true }, content: [{ type: 'text', text: 'done', styles: {} }] as never },
      { type: 'codeBlock', props: { language: 'ts' }, content: [{ type: 'text', text: 'let x = 1', styles: {} }] as never },
      {
        type: 'paragraph',
        content: [
          {
            type: 'link',
            href: '/w/11111111-1111-1111-1111-111111111111/p/22222222-2222-2222-2222-222222222222',
            content: [{ type: 'text', text: 'Other', styles: {} }],
          },
        ] as never,
      },
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]] }] } as never },
    ]
    const [s] = splitSections(blocks)
    assert.equal(s.text, '- item\n  child\n- [x] done\n```ts\nlet x = 1\n```\n[[Other]]\n| a | b |')
  })

  it('long sections split into parts that share the anchor, within the token cap', () => {
    const blocks = [h('Big'), ...Array.from({ length: 200 }, (_, i) => p(`line ${i} ${'word '.repeat(20)}`))]
    const chunks = chunkBlocks(blocks)
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every((c) => c.anchor === 'big' && c.tokens <= MAX_CHUNK_TOKENS))
    assert.deepEqual(chunks.map((c) => c.part), chunks.map((_, i) => i))
    assert.equal(new Set(chunks.map((c) => c.sectionHash)).size, 1)
  })

  it('CJK bigrams only for runs longer than two characters', () => {
    assert.equal(cjkBigrams('주간회의 회의 abc'), '주간 간회 회의')
  })

  it('findSection resolves anchors, heading text, paths and block ids', () => {
    const s = splitSections([h('Setup', 1, 'b1'), p('a'), h('Backups', 2, 'b2'), p('b')])
    assert.equal(findSection(s, 'setup/backups')?.blockId, 'b2')
    assert.equal(findSection(s, '§setup/backups')?.blockId, 'b2')
    assert.equal(findSection(s, 'Backups')?.blockId, 'b2')
    assert.equal(findSection(s, 'Setup › Backups')?.blockId, 'b2')
    assert.equal(findSection(s, 'Setup > Backups')?.blockId, 'b2')
    assert.equal(findSection(s, 'b1')?.anchor, 'setup')
    assert.equal(findSection(s, 'nope'), null)
  })
})

describe('tokens', () => {
  it('estimates ASCII at 1/4 and Hangul at 1 per char', () => {
    assert.equal(estimateTokens('abcdefgh'), 2)
    assert.equal(estimateTokens('가나다'), 3)
  })
  it('truncates at a line boundary within budget', () => {
    const s = Array.from({ length: 50 }, (_, i) => `line number ${i}`).join('\n')
    const { text, truncated } = truncateToTokens(s, 40)
    assert.ok(truncated)
    assert.ok(estimateTokens(text) <= 40)
    assert.ok(!text.endsWith('line number'))
  })
})

describe('ranking', () => {
  it('query terms: lowercase, dedupe, particle stripping, 1-char ASCII dropped', () => {
    assert.deepEqual(queryTerms('How do I roll back a Deploy deploy?'), ['roll', 'back', 'deploy'])
    assert.deepEqual(queryTerms('how to'), ['how', 'to'])
    assert.deepEqual(queryTerms('백업을 확인'), ['백업을', '백업', '확인'])
    assert.equal(tsqueryText(['a1', '백업']), "'a1':* | '백업':*")
    assert.deepEqual(queryTerms("x'; DROP TABLE --"), ['drop', 'table'])
  })

  it('TopK keeps the k best', () => {
    const t = new TopK<{ score: number; pageId: string; ord: number }>(3)
    for (const s of [5, 1, 9, 3, 7, 2]) t.push({ score: s, pageId: 'p', ord: s })
    assert.deepEqual(t.sorted().map((x) => x.score), [9, 7, 5])
  })

  it('TopK ties are broken by page id and position, whatever the push order', () => {
    const items = ['c', 'a', 'd', 'b'].map((id) => ({ score: 1, pageId: id, ord: 0 }))
    const t1 = new TopK<(typeof items)[number]>(2)
    const t2 = new TopK<(typeof items)[number]>(2)
    for (const i of items) t1.push(i)
    for (const i of [...items].reverse()) t2.push(i)
    assert.deepEqual(t1.sorted().map((x) => x.pageId), ['a', 'b'])
    assert.deepEqual(t2.sorted().map((x) => x.pageId), ['a', 'b'])
  })

  const cand = (o: Partial<Scored>): Scored => ({
    pageId: 'p1',
    workspaceId: 'w',
    title: 'T',
    ord: 0,
    anchor: 'a',
    headingPath: 'A',
    part: 0,
    text: 'x'.repeat(400),
    tokens: 100,
    version: 'v',
    updatedAt: new Date(),
    rank: 0,
    score: 1,
    ...o,
  })

  it('scores heading and title hits above body-only hits', () => {
    const now = Date.now()
    const base = { terms: ['rollback'], phrase: 'rollback', now }
    const body = scoreCandidate(cand({ headingPath: 'Other', text: 'do a rollback now and then more words here' }), base)
    const head = scoreCandidate(cand({ headingPath: 'Rollback', text: 'do a rollback now and then more words here' }), base)
    assert.ok(head > body)
  })

  it('packs within budget, merges neighbours, drops duplicate texts, truncates the tail', () => {
    const items = [
      cand({ ord: 0, anchor: 'a', score: 1.0, tokens: 100 }),
      cand({ ord: 1, anchor: 'b', headingPath: 'B', score: 0.9, tokens: 100, text: 'y'.repeat(400) }),
      cand({ pageId: 'p2', ord: 0, anchor: 'a', score: 0.95, tokens: 100 }), // same text as p1#0 → dropped
      cand({ pageId: 'p3', ord: 3, anchor: 'z', headingPath: 'Z', score: 0.8, tokens: 2000, text: 'rollback '.repeat(900) }),
    ]
    const r = pack(items, ['rollback'], 600)
    assert.ok(r.usedTokens <= 600, `used ${r.usedTokens}`)
    const p1 = r.fragments.find((f) => f.pageId === 'p1')!
    assert.deepEqual(p1.ords, [0, 1])
    assert.deepEqual(p1.sections.map((s) => s.anchor), ['a', 'b'])
    assert.equal(r.fragments.some((f) => f.pageId === 'p2'), false)
    const p3 = r.fragments.find((f) => f.pageId === 'p3')!
    assert.equal(p3.truncated, true)
  })

  it('drops candidates far below the best score', () => {
    const r = pack([cand({ score: 1 }), cand({ pageId: 'p9', text: 'q'.repeat(50), score: 0.1 })], [], 5000)
    assert.equal(r.fragments.length, 1)
  })
})
