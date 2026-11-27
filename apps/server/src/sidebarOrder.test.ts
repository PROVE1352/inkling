// Sibling order shared by the server, the web app and list_pages (docs/adr/2590-*, 2591-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareTitles, orderPageTree, sortSiblingGroup } from '@inkling/shared'
import type { SiblingLike } from '@inkling/shared'

let n = 0
const page = (title: string, extra: Partial<SiblingLike> = {}): SiblingLike => {
  n++
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    parentId: null,
    scope: 'shared',
    title,
    sortOrder: n * 1000,
    createdAt: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    ...extra,
  }
}

describe('sidebar order (docs/adr/2590-*, 2591-*)', () => {
  it('titles compare numbers as numbers, ignore case, and are the same in every locale setting', () => {
    const titles = ['10 Notes', '2 Plan', '01 Summary', 'b', 'A', '05 Tasks', '실험 기록', '할 일', '가나다']
    const sorted = [...titles].sort(compareTitles)
    assert.deepEqual(sorted, ['01 Summary', '2 Plan', '05 Tasks', '10 Notes', 'A', 'b', '가나다', '실험 기록', '할 일'])
    assert.ok(compareTitles('2', '10') < 0, '"2" before "10"')
    assert.equal(compareTitles('Notes', 'notes'), 0)
  })

  it('manual: pinned first (by drag order among themselves), then drag order; new pages land below the pinned ones', () => {
    const a = page('a')
    const b = page('b', { pinned: true })
    const c = page('c')
    const d = page('d', { pinned: true })
    const newest = page('new') // largest sort_order, like a new page
    const out = orderPageTree([newest, c, d, a, b])
    assert.deepEqual(out.map((p) => p.title), ['b', 'd', 'a', 'c', 'new'])
  })

  it('title order of a parent: numeric-aware, pinned still first, ties by drag order', () => {
    const parent = page('parent', { childSort: 'title' })
    const kids = [
      page('10 Notes', { parentId: parent.id }),
      page('2 Plan', { parentId: parent.id }),
      page('Todo', { parentId: parent.id, pinned: true }),
      page('05 Tasks', { parentId: parent.id }),
      page('2 Plan', { parentId: parent.id }), // same title: the older drag order first
    ]
    const out = orderPageTree([...kids].reverse().concat(parent))
    assert.deepEqual(
      out.map((p) => p.title),
      ['parent', 'Todo', '2 Plan', '2 Plan', '05 Tasks', '10 Notes'],
    )
    const twins = out.filter((p) => p.title === '2 Plan')
    assert.ok(twins[0].sortOrder < twins[1].sortOrder)
  })

  it('top level: the shared and private sections follow their own setting; manual keeps the old interleaving', () => {
    const s1 = page('S 10')
    const p1 = page('P b', { scope: 'private' })
    const s2 = page('S 9')
    const p2 = page('P a', { scope: 'private' })
    // both manual: drag order across sections, as list_pages printed before 0.26
    assert.deepEqual(sortSiblingGroup([p2, s2, p1, s1], null).map((p) => p.title), ['S 10', 'P b', 'S 9', 'P a'])
    // shared by title, private manual
    assert.deepEqual(sortSiblingGroup([p2, s2, p1, s1], null, { shared: 'title' }).map((p) => p.title), ['S 9', 'S 10', 'P b', 'P a'])
    // private by title only
    assert.deepEqual(sortSiblingGroup([p2, s2, p1, s1], null, { private: 'title' }).map((p) => p.title), ['S 10', 'S 9', 'P a', 'P b'])
  })

  it('is deterministic: the same pages in any input order give the same output', () => {
    const parent = page('folder', { childSort: 'title' })
    const pages = [parent, page('x 1', { parentId: parent.id }), page('x 1', { parentId: parent.id }), page('top'), page('top', { pinned: true })]
    const a = orderPageTree(pages).map((p) => p.id)
    const b = orderPageTree([...pages].reverse()).map((p) => p.id)
    assert.deepEqual(a, b)
  })
})
