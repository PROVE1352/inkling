// find_context 0.20 (docs/adr/2401-*, 2402-*, 2403-*): the shorter form of a Korean compound in a title
// or heading, the rare-word rule, and the switches that turn them off. Pure — no database.
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { groupTsquery, idf, partialForm, partialOn, queryGroups, queryTerms, rareGroup, scoreParts, WORD_RULES } from './rank'
import type { Scored } from './rank'

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
  updatedAt: new Date(0),
  score: 1,
  ...o,
})
const input = (q: string, df: number[], n = 5000) => {
  const groups = queryGroups(q)
  const w = groups.map((_, i) => idf(n, df[i] ?? 10))
  return { groups, idf: w, phrase: q, now: 0, rare: rareGroup(w, groups.map((_, i) => df[i] ?? 10), groups) }
}
const saved = { ...WORD_RULES }
after(() => Object.assign(WORD_RULES, saved))

describe('shorter form of a Korean compound (docs/adr/2401-*)', () => {
  it('drops the last syllable of a Hangul word of 3+ syllables, after stripping a particle', () => {
    assert.equal(partialForm('택배함'), '택배')
    assert.equal(partialForm('회의록'), '회의')
    assert.equal(partialForm('기능정의서'), '기능정의')
    assert.equal(partialForm('택배'), null)
    assert.equal(partialForm('api키'), null)
    assert.deepEqual(queryGroups('택배함을')[0].partial, ['택배'])
    // a one-syllable noun + particle takes the whole-word path, no partial form
    assert.equal(queryGroups('팀으로')[0].partial, undefined)
    assert.equal(queryGroups('deploys')[0].partial, undefined)
  })

  it('the partial form is not searched in the text: tsquery and highlighted terms are unchanged', () => {
    const g = queryGroups('택배함')[0]
    assert.ok(!groupTsquery(g).includes("'택배':*"))
    assert.deepEqual(queryTerms('택배함 분석'), ['택배함', '분석'])
  })

  it('a title or heading with only the shorter form gets discounted title/heading credit', () => {
    const inp = input('해커톤 택배함 분석 서비스', [400, 9, 500, 870])
    const page = cand({ title: '02-1 아이디어1, 택배 한 상자', headingPath: '택배 한 상자 › 작동 방식', text: '사진에서 택배함을 세고 분석 결과를 알린다.' })
    const p = scoreParts(page, inp)
    assert.ok(p.title > 0 && p.heading > 0, JSON.stringify(p))
    Object.assign(WORD_RULES, { partialTitle: 0, partialHeading: 0, partialCover: 0 })
    assert.equal(partialOn(), false)
    const off = scoreParts(page, inp)
    Object.assign(WORD_RULES, saved)
    assert.equal(off.title, 0)
    assert.ok(p.score > off.score)
  })

  it('the field case: the page titled with the shorter form outranks long sections of the common words', () => {
    const inp = input('해커톤 택배함 분석 서비스', [400, 9, 500, 870])
    const answer = cand({ pageId: 'a', title: '02-1 아이디어1, 택배 한 상자', headingPath: '택배 한 상자 › 작동 방식', tokens: 245, text: '현관 택배함 사진을 세고 오래 쌓인 것을 알려 주는 서비스.' })
    const common = cand({ pageId: 'b', title: '해커톤 인사이트', headingPath: '해커톤 인사이트 › 서비스 분석', tokens: 430, text: '해커톤 출품작을 분석해 보면 서비스 아이디어의 절반이 생활 데이터를 다룬다. '.repeat(6) })
    assert.ok(scoreParts(answer, inp).score > scoreParts(common, inp).score)
    Object.assign(WORD_RULES, { partialTitle: 0, partialHeading: 0, partialCover: 0, rareFactor: 1 })
    const before = [scoreParts(answer, inp).score, scoreParts(common, inp).score]
    Object.assign(WORD_RULES, saved)
    assert.ok(before[0] < before[1], `the 0.19 ranking put the long section first: ${before}`)
  })
})

describe('rare-word rule (docs/adr/2402-*)', () => {
  it('names the word whose weight stands out, only when it occurs in scope', () => {
    assert.equal(rareGroup([2.5, 6.2, 2.3, 1.7], [400, 9, 500, 870]), 1)
    assert.equal(rareGroup([6.2, 6.1], [9, 10]), -1)
    assert.equal(rareGroup([3], [5]), -1)
    // an unseen word (df 0) cannot tell chunks apart
    assert.equal(rareGroup([1, 0.5, 9], [100, 0, 0]), -1)
    // a one-character word (때, 것, 중) is never the rare word, and a longer one must still stand out over it
    const g = (w: string) => ({ word: w })
    assert.equal(rareGroup([1.3, 0.5, 1.5], [18, 0, 15], [g('택배를'), g('도난당했을'), g('때')]), -1)
    assert.equal(rareGroup([1.3, 0.5, 1.5], [18, 0, 15]), 2)
    assert.equal(rareGroup([3, 0.5, 1.5], [18, 0, 15], [g('택배를'), g('도난당했을'), g('때')]), 0)
    Object.assign(WORD_RULES, { rareFactor: 1 })
    assert.equal(rareGroup([2.5, 6.2, 2.3, 1.7], [400, 9, 500, 870]), -1)
    Object.assign(WORD_RULES, saved)
  })

  it('a chunk without the rare word (nor its shorter form in title/heading) keeps rareFactor of its score', () => {
    const inp = input('해커톤 택배함 분석', [400, 9, 500])
    assert.equal(inp.rare, 1)
    const without = cand({ title: '해커톤 정리', headingPath: '분석', text: '해커톤 결과를 분석했다.' })
    const p = scoreParts(without, inp)
    assert.equal(p.rareMissing, true)
    Object.assign(WORD_RULES, { rareFactor: 1 })
    const off = scoreParts(without, inp)
    Object.assign(WORD_RULES, saved)
    assert.ok(Math.abs(p.score - off.score * WORD_RULES.rareFactor) < 1e-5)
    // the shorter form in the title counts as having it
    assert.equal(scoreParts(cand({ title: '택배 한 상자', headingPath: '분석', text: '해커톤 결과를 분석했다.' }), inp).rareMissing, false)
  })
})
