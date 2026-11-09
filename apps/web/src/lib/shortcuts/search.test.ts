// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Command palette search: Korean initial consonants, both languages, ranking, recent commands (docs/adr/1402-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { choseong, pushRecent, scoreText, searchCommands } from './search'

const items = [
  { id: 'app.toggleSidebar', texts: ['사이드바 접기/펴기', 'Toggle sidebar', '⌘\\'] },
  { id: 'app.graph', texts: ['그래프', 'Graph', '⌘G'] },
  { id: 'app.search', texts: ['검색', 'Search', '⌘K'] },
  { id: 'page.toggleRightPanel', texts: ['오른쪽 패널 열기/닫기', 'Toggle right panel'] },
  { id: 'editor.heading1', texts: ['제목 1', 'Heading 1'] },
  { id: 'app.settings', texts: ['설정', 'Settings'] },
]
const ids = (r) => r.map((x) => x.id)

describe('choseong', () => {
  it('maps syllables to their initial consonant and leaves the rest', () => {
    assert.equal(choseong('사이드바'), 'ㅅㅇㄷㅂ')
    assert.equal(choseong('그래프 Graph'), 'ㄱㄹㅍ graph')
    assert.equal(choseong('쌍'), 'ㅆ')
  })
})

describe('scoreText', () => {
  it('matches initial consonants, mixed syllables + consonants, and plain substrings', () => {
    assert.ok(scoreText('사이드바 접기/펴기', 'ㅅㅇㄷ') > 0)
    assert.ok(scoreText('사이드바 접기/펴기', '사이ㄷ') > 0)
    assert.ok(scoreText('사이드바 접기/펴기', 'ㅈㄱ') > 0)
    assert.ok(scoreText('Toggle sidebar', 'SIDE') > 0)
    assert.equal(scoreText('그래프', 'ㅅㅇ'), 0)
    // two characters must be adjacent; scattered matching starts at three
    assert.equal(scoreText('전체 검색 (본문 포함)', 'ㅈㅁ'), 0)
    assert.ok(scoreText('제목 1로 바꾸기', 'ㅈㅁ') > 0)
  })

  it('a prefix beats a word start beats a substring beats a scattered match', () => {
    const prefix = scoreText('Graph view', 'gra')
    const word = scoreText('Open graph', 'gra')
    const inside = scoreText('Autograph', 'gra')
    const scattered = scoreText('Go read a page', 'gra')
    assert.ok(prefix > word && word > inside && inside > scattered && scattered > 0, `${prefix} ${word} ${inside} ${scattered}`)
  })
})

describe('searchCommands', () => {
  it('finds a command by its English name in a Korean UI and by its Korean name in an English UI', () => {
    assert.equal(searchCommands(items, 'sidebar', [])[0].id, 'app.toggleSidebar')
    assert.equal(searchCommands(items, '사이드', [])[0].id, 'app.toggleSidebar')
    assert.equal(searchCommands(items, 'ㄱㄹㅍ', [])[0].id, 'app.graph')
  })

  it('every word of the query has to match', () => {
    assert.deepEqual(ids(searchCommands(items, 'right panel', [])), ['page.toggleRightPanel'])
    assert.deepEqual(ids(searchCommands(items, 'right zebra', [])), [])
  })

  it('an empty query lists recent commands first, then the rest in registry order', () => {
    assert.deepEqual(ids(searchCommands(items, '', ['app.settings', 'app.graph'])), [
      'app.settings',
      'app.graph',
      'app.toggleSidebar',
      'app.search',
      'page.toggleRightPanel',
      'editor.heading1',
    ])
  })

  it('a recent command wins a tie', () => {
    const tie = [
      { id: 'a', texts: ['Heading 2'] },
      { id: 'b', texts: ['Heading 3'] },
    ]
    assert.equal(searchCommands(tie, 'heading', ['b'])[0].id, 'b')
  })

  it('recent ids that are no longer listed are skipped', () => {
    assert.equal(searchCommands(items, '', ['gone', 'app.graph'])[0].id, 'app.graph')
  })
})

describe('pushRecent', () => {
  it('moves the id to the front, drops duplicates and keeps five', () => {
    assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c'])
    assert.deepEqual(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f'), ['f', 'a', 'b', 'c', 'd'])
    assert.deepEqual(pushRecent([], 'a'), ['a'])
  })
})
