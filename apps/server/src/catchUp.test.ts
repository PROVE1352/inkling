// catch_up pure parts (docs/adr/1520-*, 1521-*): since parsing, cursor, importance packing and
// rendering. The database side is in mcpTools/catchUp.db.test.ts.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  actorPhrase,
  decodeCatchUpCursor,
  dueItems,
  encodeCatchUpCursor,
  inboxItems,
  packItems,
  pageItems,
  parseSince,
  renderPacked,
} from './catchUp'
import type { Item, PageAggregate } from './catchUp'
import { encodeCursor } from './context/changeFeed'

const item = (group: Item['group'], score: number, key: string, head: string, detail?: string[]): Item => ({ group, score, key, head: [head], detail })

describe('catch_up since and cursor', () => {
  it('round-trips its own cursor and rejects junk', () => {
    const c = encodeCatchUpCursor({ seq: 42, at: 1_700_000_000_000 })
    assert.deepEqual(decodeCatchUpCursor(c), { seq: 42, at: 1_700_000_000_000 })
    assert.equal(decodeCatchUpCursor('nope!'), null)
    assert.equal(decodeCatchUpCursor(Buffer.from('u1.x.1').toString('base64url')), null)
  })

  it('accepts a catch_up cursor, a changes_since cursor and ISO times (UTC when no zone)', () => {
    assert.deepEqual(parseSince(encodeCatchUpCursor({ seq: 7, at: 1000 })), { kind: 'cursor', seq: 7, at: 1000 })
    assert.deepEqual(parseSince(encodeCursor({ seq: 9, at: 3_600_000, ws: null })), { kind: 'cursor', seq: 9, at: 3_600_000 })
    assert.deepEqual(parseSince('2026-11-08'), { kind: 'time', at: Date.parse('2026-11-08T00:00:00Z') })
    assert.deepEqual(parseSince('2026-11-08T09:30'), { kind: 'time', at: Date.parse('2026-11-08T09:30:00Z') })
    assert.deepEqual(parseSince('2026-11-08T09:30+09:00'), { kind: 'time', at: Date.parse('2026-11-08T00:30:00Z') })
    assert.throws(() => parseSince('yesterday'), /since must be/)
  })
})

describe('catch_up packing', () => {
  const items = [
    item('pages', 0.5, 'pages:a', '- page A', ['    + a1', '    + a2']),
    item('you', 1, 'you:1', '- mention X'),
    item('due', 0.89, 'due:1', '- today T'),
    item('own', 0.2, 'pages:z', '- page Z (mine)', ['    + z']),
    item('comments', 0.7, 'comments:c', '- page C · 1 new thread', ['    thread t · bob: hi']),
  ]

  it('lists in group order, importance inside a group, details while they fit', () => {
    const p = packItems(items, 2_000)
    assert.equal(p.hidden.length, 0)
    const text = renderPacked(p).join('\n')
    const order = ['## For you', '- mention X', '## Due soon', '## Comments', 'thread t', '## Pages changed by others', '+ a1', '## Your own changes', '+ z']
    let at = -1
    for (const s of order) {
      const i = text.indexOf(s)
      assert.ok(i > at, `${s} out of order in\n${text}`)
      at = i
    }
  })

  it('a small budget hides the least important heads first and never the most important one', () => {
    const many = Array.from({ length: 200 }, (_, i) => item('pages', 0.4 + (i % 7) / 100, `pages:${String(i).padStart(3, '0')}`, `- page number ${i} with a fairly long title to cost tokens`))
    const p = packItems([...many, item('you', 1, 'you:1', '- mention X')], 500)
    assert.ok(p.hidden.length > 0)
    assert.ok(p.items.some((x) => x.item.key === 'you:1'))
    const minListed = Math.min(...p.items.map((x) => x.item.score))
    const maxHidden = Math.max(...p.hidden.map((x) => x.score))
    assert.ok(minListed >= maxHidden, 'listed items rank at least as high as hidden ones')
    assert.ok(p.used <= 500 + 40)
  })

  it('cuts the first detail that does not fit and leaves the rest head-only; deterministic', () => {
    const big = Array.from({ length: 300 }, (_, i) => `    + line ${i} of a long diff`)
    const its = [item('pages', 0.6, 'pages:big', '- page Big', big), item('pages', 0.55, 'pages:b', '- page B', ['    + b'])]
    const p = packItems(its, 700)
    const big1 = p.items.find((x) => x.item.key === 'pages:big')!
    assert.equal(big1.cut, true)
    assert.ok(big1.detail!.length < big.length)
    assert.deepEqual(packItems(its, 700), p)
    assert.match(renderPacked(p).join('\n'), /cut to fit the budget/)
  })
})

describe('catch_up items', () => {
  it('actor phrase: most edits first, "you" for the person, at most three', () => {
    assert.equal(
      actorPhrase([
        { name: 'bob', via: null, n: 2, me: false },
        { name: 'alice', via: 'Claude', n: 5, me: true },
        { name: 'carol', via: null, n: 1, me: false },
        { name: 'dan', via: null, n: 1, me: false },
      ]),
      'you via Claude ×5, bob ×2, carol ×1, +1 more',
    )
  })

  it('pages by others outrank own pages; a page no longer visible shows no title', () => {
    const base: Omit<PageAggregate, 'pageId' | 'others' | 'byOthers' | 'actors' | 'title' | 'visibleNow'> = {
      workspaceId: 'w', n: 3, unattributed: 0, added: false, trashed: false, restored: false, roundTrip: false, moved: false, renamed: false,
      sections: 1, first: 1, last: 3, mine: false, kind: 'doc', isRow: false, parentId: null, parentTitle: null,
    }
    const its = pageItems(
      [
        { ...base, pageId: 'p-own', others: 0, byOthers: false, actors: [{ name: 'alice', via: null, n: 3, me: true }], title: 'Mine', visibleNow: true },
        { ...base, pageId: 'p-bob', others: 3, byOthers: true, actors: [{ name: 'bob', via: 'Agent', n: 3, me: false }], title: 'Bob page', visibleNow: true },
        { ...base, pageId: 'p-gone', others: 1, byOthers: true, trashed: true, actors: [{ name: 'bob', via: null, n: 1, me: false }], title: null, visibleNow: false },
      ],
      new Map([['p-bob', { heads: [], detail: ['  modified s (S)', '    + new'] }]]),
    )
    const bob = its.find((i) => i.key === 'pages:p-bob')!
    const own = its.find((i) => i.key === 'pages:p-own')!
    assert.equal(bob.group, 'pages')
    assert.equal(own.group, 'own')
    assert.ok(bob.score > own.score)
    assert.match(bob.head[0], /page "Bob page" p-bob · 3 edits in 1 section · bob via Agent ×3/)
    assert.match(its.find((i) => i.key === 'pages:p-gone')!.head[0], /^- page p-gone: moved to the trash/)
  })

  it('inbox mentions rank first; due items: today > tomorrow > overdue > later this week', () => {
    const [m] = inboxItems([
      { seq: '5', kind: 'mention', type: 'comment_mention', workspaceId: 'w', pageId: 'p', pageTitle: 'Plan', anchor: null, actorName: 'bob', via: null, excerpt: 'hi @alice', count: 1, createdAt: '2026-11-08T10:00:00.000Z', read: false, can: 'edit' },
    ])
    assert.match(m.head.join('\n'), /mention \(comment\) · page "Plan" p · by bob · can: edit · 2026-11-08T10:00Z · inbox 5\n {4}hi @alice/)
    const d = dueItems(
      [
        { kind: 'task', pageId: 'a', title: 'later', icon: null, date: '2026-11-12', done: false, pageTitle: 'P' },
        { kind: 'task', pageId: 'b', title: 'over', icon: null, date: '2026-11-07', done: false, pageTitle: 'P' },
        { kind: 'task', pageId: 'c', title: 'now', icon: null, date: '2026-11-09', done: false, pageTitle: 'P' },
        { kind: 'row', pageId: 'e', title: 'tmr', icon: null, date: '2026-11-10', done: false, collectionTitle: 'Projects' },
      ],
      '2026-11-09',
      '2026-11-10',
    ).sort((x, y) => y.score - x.score)
    assert.deepEqual(d.map((x) => x.head[0].split(' · ')[0]), ['- today (2026-11-09)', '- tomorrow (2026-11-10)', '- overdue (2026-11-07)', '- 2026-11-12'])
    assert.ok(m.score > d[0].score)
  })
})
