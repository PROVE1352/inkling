// Agent search pure parts (docs/adr/2183-*, 2184-*): the whole-word pattern (JS side; the same string
// runs in Postgres `~*`), snippets, and the compact/lines/json renderers with groups and the more line.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { escapeRegex, searchSnippet, wholeWordPattern } from './agentSearchText'
import type { AgentSearchHit, AgentSearchResponse } from './agentSearchText'
import { renderCompactSearch, searchJson, searchMoreLine } from '../mcpTools/compactList'

const re = (term: string) => new RegExp(wholeWordPattern(term), 'iu')

describe('wholeWordPattern', () => {
  it('whole words, case-insensitive; part of a longer word is not', () => {
    assert.ok(re('harness').test('the HARNESS.md file'))
    assert.ok(re('harness').test('harness'))
    assert.ok(!re('harness').test('harnesses'))
    assert.ok(!re('harness').test('prharness'))
    assert.ok(!re('harness').test('my_harness'))
    assert.ok(re('harness').test('my-harness'))
    assert.ok(re('école').test('une ÉCOLE ici'))
  })

  it('regex characters are literal; a non-word edge gets no boundary test', () => {
    assert.equal(escapeRegex('a.b(c)+[d]{e}|f/g\\h^$*?'), 'a\\.b\\(c\\)\\+\\[d\\]\\{e\\}\\|f\\/g\\\\h\\^\\$\\*\\?')
    assert.ok(re('v1.2').test('shipped v1.2 today'))
    assert.ok(!re('v1.2').test('shipped v1x2 today'))
    assert.ok(re('C++').test('Modern C++20 notes'), 'no right boundary after +')
    assert.ok(!re('C++').test('ObjC++'), 'left boundary before C')
    assert.ok(re('.md').test('HARNESS.md'))
    assert.ok(re('a-b').test('x a-b y'))
  })

  it('Korean: a particle that fits the final sound, and a second one, still count as a whole word', () => {
    assert.ok(re('하네스').test('오늘 하네스를 돌렸다'))
    assert.ok(re('하네스').test('하네스에서는 문제 없음'))
    assert.ok(re('하네스').test('(하네스)'))
    assert.ok(!re('하네스').test('하네스테스트'))
    assert.ok(!re('하네스').test('새하네스'))
    assert.ok(re('해커톤').test('해커톤에서 쓸 예정'))
    assert.ok(re('해커톤').test('해커톤은 끝났다'))
    assert.ok(!re('해커톤').test('해커톤를'), '를 does not follow a final consonant')
    assert.ok(!re('해커톤').test('해커톤장'))
  })
})

describe('searchSnippet', () => {
  it('±60 characters around the whole-word match, cut at spaces, … where text was left out', () => {
    const text = `${'alpha '.repeat(30)}the prharness and the harness ran ${'omega '.repeat(30)}`
    const s = searchSnippet(text, 'harness', { exact: true, atStart: true, atEnd: true })
    assert.ok(s.startsWith('…') && s.endsWith('…'), s)
    assert.ok(s.includes('the harness ran'), s)
    const at = s.indexOf('the harness')
    assert.ok(at > 40, 'centred on the whole word, not on prharness')
    // a window that does not start or end with the text gets … even when nothing is cut inside it
    assert.equal(searchSnippet('a harness b', 'harness', { exact: false, atStart: false, atEnd: true }), '…a harness b')
    assert.equal(searchSnippet('a  harness\n b', 'harness', { exact: false, atStart: true, atEnd: true }), 'a harness b')
  })
})

const ws1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const ws2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const hit = (n: number, ws: string, extra: Partial<AgentSearchHit> = {}): AgentSearchHit => ({
  id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
  workspaceId: ws,
  title: `Page ${n}`,
  kind: 'doc',
  scope: 'shared',
  updatedAt: '2026-11-10T00:00:00.000Z',
  match: 'title',
  exact: true,
  ...extra,
})

describe('search renderers', () => {
  const res: AgentSearchResponse = {
    results: [
      hit(1, ws2),
      hit(2, ws1, { match: 'heading', anchor: 'setup/harness', shortAnchor: 'harness', headingPath: 'Setup › Harness' }),
      hit(3, ws2, { match: 'body', exact: false, anchor: '_intro', shortAnchor: '_intro', snippet: '…the harnesses…', kind: 'collection', scope: 'private' }),
    ],
    total: 10,
    workspaces: [
      { id: ws1, name: 'Lab\nnotes', matches: 6 },
      { id: ws2, name: 'Hackathon', matches: 4 },
    ],
    limit: 3,
  }

  it('compact: groups in best-hit order, short ids and anchors, more line outside the data block, legend last', () => {
    const out = renderCompactSearch(res, { format: 'compact', workspaceGiven: false })
    assert.equal(
      out.split('\n</untrusted_content>')[0],
      [
        '<untrusted_content source="search">',
        '## Hackathon (bbbbbbbb)',
        '00000001 | Page 1',
        '00000003 | Page 3 [collection] 🔒 | §_intro …the harnesses…',
        '',
        '## Lab notes (aaaaaaaa)',
        '00000002 | Page 2 | §harness Setup › Harness',
      ].join('\n'),
    )
    const tail = out.split('</untrusted_content>\n')[1].split('\n')
    assert.equal(tail[0], '7 more matches (5 in aaaaaaaa, 2 in bbbbbbbb); narrow with workspaceId=<id or name> or more specific words.')
    assert.match(tail[1], /^ids are 8-character prefixes/)
  })

  it('lines: full ids and anchors, no legend; one workspace prints no head', () => {
    const out = renderCompactSearch(res, { format: 'lines', workspaceGiven: false })
    assert.ok(out.includes(`## Hackathon (${ws2})`))
    assert.ok(out.includes('| §setup/harness Setup › Harness'))
    assert.doesNotMatch(out, /ids are 8-character/)
    const single: AgentSearchResponse = { ...res, results: [res.results[1]], total: 6, workspaces: [res.workspaces[0]] }
    const one = renderCompactSearch(single, { format: 'compact', workspaceGiven: true })
    assert.doesNotMatch(one, /^## /m)
    assert.match(one, /^5 more matches; narrow with more specific words or a higher limit \(max 50\)\.$/m)
  })

  it('more line: none when all shown; the hint without a limit at 50; long workspace lists summarised', () => {
    assert.equal(searchMoreLine({ ...res, total: 3 }, false), null)
    assert.equal(searchMoreLine({ ...res, limit: 50, workspaces: [res.workspaces[0]], total: 4 }, true), '1 more match; narrow with more specific words.')
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`.repeat(8), name: `W${i}`, matches: 10 - i }))
    const line = searchMoreLine({ results: [], total: 49, workspaces: many, limit: 10 }, false)!
    assert.equal(line, '49 more matches (10 in 00000000, 9 in 11111111, 8 in 22222222, 7 in 33333333, 6 in 44444444, 9 in 2 other workspaces); narrow with workspaceId=<id or name> or more specific words.')
  })

  it('json: results keep id/workspaceId/title/kind/section and add workspace, match, exact, anchor; counts', () => {
    const j = searchJson(res) as { results: Record<string, unknown>[]; total: number; more: number; moreByWorkspace: unknown[] }
    assert.deepEqual(Object.keys(j), ['results', 'total', 'more', 'moreByWorkspace'])
    assert.deepEqual(j.results[1], { id: res.results[1].id, workspaceId: ws1, workspace: 'Lab\nnotes', title: 'Page 2', kind: 'doc', section: 'shared', match: 'heading', exact: true, anchor: 'setup/harness', heading: 'Setup › Harness' })
    assert.equal(j.results[2].section, 'private')
    assert.deepEqual([j.total, j.more], [10, 7])
    assert.deepEqual(j.moreByWorkspace, [{ workspaceId: ws1, workspace: 'Lab\nnotes', more: 5 }, { workspaceId: ws2, workspace: 'Hackathon', more: 2 }])
  })
})
