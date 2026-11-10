// find_context 0.15.1 (docs/adr/1900-* .. 1907-*): thin and title-only sections, URL words, packing of
// large chunks, query forms, RRF k, and the output (short ids, shared can:, verification line, hint).
// Pure — no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cutAroundHit,
  diversify,
  englishStem,
  idf,
  pack,
  proseLetters,
  queryGroups,
  queryTerms,
  scoreParts,
  searchText,
} from './rank'
import type { Fragment, Scored } from './rank'
import { fuseContextResults, RRF_K } from './multiQuery'
import type { FindContextResult } from './retrieve'
import { estimateTokens } from './tokens'
import { otherLanguageHint, printedIds, renderFindContext, wordsInNoResult } from '../mcpTools/contextTools'
import type { AgentContextDTO } from '../routes/editLock'

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
const input = (q: string, df: number[] = [], n = 1000) => {
  const groups = queryGroups(q)
  return { groups, idf: groups.map((_, i) => idf(n, df[i] ?? 10)), phrase: q, now: 0 }
}

describe('what a chunk says itself (docs/adr/1900-*, 1901-*)', () => {
  it('URL targets and bare URLs are not words; link labels are', () => {
    assert.equal(searchText('[열기](https://x.example.com/solar-forecast/1) | 7.9'), '[열기] | 7.9')
    assert.equal(searchText('see https://a.example.com/forecast?x=1 now').includes('forecast'), false)
    assert.equal(searchText('[[Solar plan]] and [Forecast doc](https://d.example.com/f)'), '[[Solar plan]] and [Forecast doc]')
    // Markdown link target with one level of parentheses
    assert.equal(searchText('[w](https://en.example.org/wiki/A_(b)) end'), '[w] end')
  })

  it('a table whose links say "solar-forecast" no longer matches solar forecast', () => {
    const inp = input('solar forecast best submission score', [3, 3, 2, 2, 5])
    const table = cand({ title: '태양광 예측 대회 기록', headingPath: '제출 목록', tokens: 600, text: Array.from({ length: 20 }, (_, i) => `| ${i} | [열기](https://c.example.com/solar-forecast/submissions/${i}) | 7.9 |`).join('\n') })
    const answer = cand({ title: '태양광 예측 대회 기록', headingPath: '최고 기록', tokens: 30, text: 'best submission은 15회차다. public score 6,465.75.' })
    assert.ok(scoreParts(answer, inp).score > scoreParts(table, inp).score)
    assert.equal(scoreParts(table, inp).coverage, 0)
  })

  it('a line of links is thin (×0.7) and weak; a short sentence is not', () => {
    const inp = input('빗물 센서 폐기 이유', [5, 5, 2, 3])
    const intro = cand({ title: '빗물 센서 3심 폐기', headingPath: '', tokens: 24, text: '← [[빗물 센서 2심 판결]] · [기록](https://court.example.com/rain-sensor/3)' })
    const ruling = cand({ title: '빗물 센서 3심 폐기', headingPath: '판결문', tokens: 75, text: '3심 재판부는 빗물 센서 안을 접는다. 첫째, 구청 데이터가 공개되지 않아 효과를 검증할 수 없다.' })
    assert.equal(proseLetters(intro.text), 0)
    const pi = scoreParts(intro, inp)
    assert.equal(pi.weak, true)
    assert.equal(pi.own, 0, 'link labels are not the section\'s own words')
    assert.equal(scoreParts(ruling, inp).weak, false)
    assert.ok(scoreParts(ruling, inp).score > pi.score, 'the ruling outranks its link line')
    assert.equal(scoreParts(cand({ headingPath: 'TF', text: '매주 화요일 오전 10시에 30분 동안 모인다.' }), input('회의 주기')).weak, true, 'no own word of the query → weak')
    assert.ok(proseLetters('매주 화요일 오전 10시에 30분 동안 모인다.') >= 8)
  })

  it('diversify: a weak section never takes its page slot from a sibling that matches by itself', () => {
    const pool = [
      cand({ pageId: 'p3', ord: 0, anchor: '_intro', score: 1, weak: true }),
      cand({ pageId: 'p1', ord: 0, anchor: 'ruling', score: 0.9 }),
      cand({ pageId: 'p3', ord: 1, anchor: 'ruling', score: 0.8 }),
    ]
    const d = diversify(pool, 1, 0.7)
    const by = (pid: string, a: string) => d.find((c) => c.pageId === pid && c.anchor === a)!.score
    assert.equal(by('p3', 'ruling'), 0.8, 'the ruling keeps its score: it is the page representative')
    assert.equal(by('p3', '_intro'), 0.7, 'the link line is the second section of its page')
    // a page with only weak sections keeps its best one
    assert.equal(diversify([cand({ anchor: 'x', score: 1, weak: true })], 1, 0.7)[0].score, 1)
  })
})

describe('packing (docs/adr/1902-*)', () => {
  const table = Array.from({ length: 24 }, (_, i) => `| ${i + 1} | 11/0${i % 9} | G${i} | ${(7900 - i * 61).toFixed(2)} |`)
  table[0] = '| 회차 | 날짜 | 모델 | score |'
  table[17] = '| 18 | 11/10 | G10_seed9 best | 6465.75 |'
  const big = cand({ pageId: 'pa', anchor: 'list', headingPath: 'List', score: 1, text: table.join('\n'), tokens: estimateTokens(table.join('\n')) })
  const small = cand({ pageId: 'pb', anchor: 'best', headingPath: 'Best', score: 0.9, text: 'best submission G10_seed9, public score 6,465.75.', tokens: 20 })

  it('cuts around the best matching line, keeps a table\'s header row', () => {
    const out = cutAroundHit(big.text, { groups: queryGroups('g10_seed9 best') }, 40)
    assert.ok(out.startsWith('| 회차 | 날짜 | 모델 | score |\n…'), out)
    assert.ok(out.includes('G10_seed9 best'))
    assert.ok(estimateTokens(out) <= 44)
  })

  it('a chunk above largeShare × budget is cut even when it fits, so the next one is shown', () => {
    const budget = Math.ceil(big.tokens * 1.3)
    const r = pack([big, small], ['best', 'g10'], budget, { cut: { groups: queryGroups('best g10') }, sectionTokens: () => 900 })
    const a = r.fragments.find((f) => f.pageId === 'pa')!
    assert.equal(a.truncated, true)
    assert.equal(a.fullTokens, 900)
    assert.ok(a.text.includes('G10_seed9 best'))
    assert.ok(r.fragments.some((f) => f.pageId === 'pb'), 'the short answer fits after the cut table')
    assert.ok(r.usedTokens <= budget)
  })

  it('the same input packs to the same bytes', () => {
    const a = pack([big, small], ['best'], 300, { cut: { groups: queryGroups('best') } })
    const b = pack([small, big], ['best'], 300, { cut: { groups: queryGroups('best') } })
    assert.deepEqual(a, b)
  })

  const piece = (pageId: string, text: string, anchors = ['s']): Fragment => ({
    pageId,
    workspaceId: 'w',
    title: pageId,
    anchor: anchors[0],
    headingPath: anchors[0],
    sections: anchors.map((a) => ({ anchor: a, headingPath: a, version: 'v', short: a, heading: a })),
    ords: anchors.map((_, i) => i),
    text,
    tokens: estimateTokens(text),
    score: 1,
    truncated: false,
  })
  const res = (frags: Fragment[], budget: number): FindContextResult => ({ fragments: frags, more: [], titleOnly: [], budget, usedTokens: 0, candidates: 1 })

  it('several queries: a piece that does not fit is cut around its own query\'s words, not from the start', () => {
    const budget = Math.floor(big.tokens * 0.8)
    const r = fuseContextResults([res([piece('pa', big.text)], budget)], { queries: ['g10_seed9 best'], budget })
    assert.equal(r.fragments[0].truncated, true)
    assert.ok(r.fragments[0].text.includes('G10_seed9 best'), r.fragments[0].text)
    assert.equal(r.fragments[0].fullTokens, big.tokens)
  })

  it('several queries: per-query pieces are not capped again (two merged sections stay whole when they fit)', () => {
    const two = piece('pm', `${'a '.repeat(500)}\n\n§b — b\n${'b '.repeat(500)}`, ['a', 'b'])
    const budget = 1000
    assert.ok(two.tokens > budget * 0.4 && two.tokens < budget - 100)
    const r = fuseContextResults([res([two], budget), res([], budget)], { queries: ['a', 'b'], budget })
    assert.equal(r.fragments[0].truncated, false)
    assert.equal(r.fragments[0].text, two.text)
  })

  it('several queries: a raw section from an extra list above largeShare is cut around its query\'s words', () => {
    const budget = Math.ceil(big.tokens * 1.5)
    const r = fuseContextResults([res([], budget), res([], budget)], {
      queries: ['최고 기록', 'g10_seed9 best'],
      budget,
      extra: [{ label: '2', items: [{ pageId: 'pa', anchor: 's', fragment: piece('pa', big.text) }] }],
    })
    assert.equal(r.fragments[0].truncated, true)
    assert.ok(r.fragments[0].text.includes('G10_seed9 best'))
    assert.ok(r.fragments[0].tokens <= Math.floor(budget * 0.4))
  })
})

describe('query forms (docs/adr/1905-*)', () => {
  it('English plural / -ed / -ing add a prefix stem', () => {
    assert.equal(englishStem('deploys'), 'deploy')
    assert.equal(englishStem('approved'), 'approv')
    assert.equal(englishStem('answering'), 'answer')
    assert.equal(englishStem('planned'), 'plan')
    assert.equal(englishStem('rolled'), 'roll')
    assert.equal(englishStem('policies'), 'policy')
    assert.equal(englishStem('patches'), 'patch')
    for (const w of ['status', 'analysis', 'access', 'news', 'gas', 'need', 'speed', 'during', 'string', 'deploy']) {
      assert.ok(englishStem(w) === null || englishStem(w)!.length >= 3, w)
    }
    assert.equal(englishStem('status'), null)
    assert.equal(englishStem('access'), null)
    assert.equal(englishStem('proceed'), null)
    assert.deepEqual(queryTerms('deploys rollbacks'), ['deploys', 'deploy', 'rollbacks', 'rollback'])
    // unchanged when no form applies (the field query of ADR 0927)
    assert.deepEqual(queryTerms('How do I roll back a Deploy deploy?'), ['roll', 'back', 'deploy'])
  })

  it('a Korean word with two particles is stripped twice, never below two characters', () => {
    assert.deepEqual(queryGroups('회의에서는')[0].variants, ['회의에서는', '회의에서', '회의'])
    assert.deepEqual(queryGroups('동아리에서도')[0].variants, ['동아리에서도', '동아리에서', '동아리'])
    assert.deepEqual(queryGroups('백업을')[0].variants, ['백업을', '백업'])
    assert.deepEqual(queryGroups('회의는')[0].variants, ['회의는', '회의'])
  })

  it('RRF k is 10 (docs/adr/1905-*)', () => {
    assert.equal(RRF_K, 10)
  })
})

describe('output (docs/adr/1904-*, 1906-*, 1907-*)', () => {
  const frag = (pageId: string, title: string, text: string): Fragment => ({
    pageId,
    workspaceId: 'w',
    title,
    anchor: 'a',
    headingPath: 'A',
    sections: [{ anchor: 'a', headingPath: 'A', version: 'v1', short: 'a', heading: 'A' }],
    ords: [0],
    text,
    tokens: estimateTokens(text),
    score: 1,
    truncated: false,
  })
  const P1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const P2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const P3 = '22222222-cccc-4ccc-8ccc-cccccccccccc'
  const r: FindContextResult = {
    fragments: [frag(P1, 'Deploy runbook', 'Run lumen-deploy --rollback.'), frag(P2, 'Backups', 'Nightly at 02:30.')],
    more: [{ pageId: P3, title: 'Other', anchor: 'x', headingPath: 'X', short: 'x', heading: 'X', tokens: 40 }],
    titleOnly: [],
    budget: 700,
    usedTokens: 90,
    candidates: 3,
  }
  const ac = (cans: string[]): AgentContextDTO => ({
    pages: [P1, P2].map((id, i) => ({ id, can: cans[i], createdBy: null, lastEdit: null, suspicious: [], large: false })),
    applies: [],
  })

  it('page ids: 8 characters, longer only where two printed ids share them', () => {
    const ids = printedIds([P1, P2, P3])
    assert.equal(ids.get(P1), '11111111')
    assert.equal(ids.get(P2), '22222222-bbbb')
    assert.equal(ids.get(P3), '22222222-cccc')
    const out = renderFindContext('rollback', r)
    assert.match(out, /^\(page 11111111; §a v=v1\)$/m)
    assert.match(out, /- Other \(page 22222222-cccc\): §x ~40 tok/)
    assert.ok(!out.includes(P1))
  })

  it('can: once in the header when every result has the same; per result otherwise', () => {
    const same = renderFindContext('rollback', r, undefined, ac(['read,comment,edit', 'read,comment,edit']))
    assert.match(same.split('\n')[0], /; can: read,comment,edit \(all results\)$/)
    assert.equal(same.match(/can: /g)!.length, 1)
    const mixed = renderFindContext('rollback', r, undefined, ac(['read,comment,edit', 'read']))
    assert.doesNotMatch(mixed.split('\n')[0], /can:/)
    assert.match(mixed, /\(page 11111111; §a v=v1; can: read,comment,edit\)/)
    assert.match(mixed, /\(page 22222222-bbbb; §a v=v1; can: read\)/)
  })

  it('verification marks are one line at the end, the fragment headers stay the same', () => {
    const plain = renderFindContext('rollback', r)
    const v = renderFindContext('rollback', r, undefined, undefined, undefined, new Map([[P2, { state: 'stale', changedMuch: false } as never]]))
    assert.equal(v.split('\n').slice(-1)[0], 'Verification: [2] stale: verification lapsed')
    assert.equal(v.slice(0, plain.length), plain)
  })

  it('a truncated section says its full size', () => {
    const t = { ...r, fragments: [{ ...r.fragments[0], truncated: true, fullTokens: 612 }] }
    assert.match(renderFindContext('rollback', t), /\(page 11111111; §a v=v1; truncated, section ~612 tok\)/)
  })

  it('weak answer: words no result contains, and the bundle to try (one query only)', () => {
    assert.deepEqual(wordsInNoResult('solar forecast rollback', r), ['solar', 'forecast'])
    assert.equal(otherLanguageHint('rollback nightly', r), null)
    const hint = otherLanguageHint('solar forecast rollback', r)!
    assert.equal(hint, 'Not in any result: solar, forecast. If the notes may be in another language, ask again with queries=["solar forecast rollback", "<translation>"].')
    assert.equal(renderFindContext('solar forecast rollback', r).split('\n').slice(-1)[0], hint)
    // URL words do not count as found
    const url = { ...r, fragments: [frag(P1, 'Log', '[open](https://x.example.com/solar-forecast) rollback')] }
    assert.deepEqual(wordsInNoResult('solar forecast rollback', url), ['solar', 'forecast'])
    // one word that only an alias matched ("PayFix"), or one missing word of two: no line
    assert.equal(otherLanguageHint('payfix', r), null)
    assert.equal(otherLanguageHint('payfix rollback', r), null)
    // a merged answer (several queries, or semantic search on) never gets it
    const merged = { ...r, queries: ['solar forecast rollback'], fragments: r.fragments.map((f) => ({ ...f, matched: ['1'] })) }
    assert.doesNotMatch(renderFindContext('solar forecast rollback', merged), /Not in any result/)
  })
})
