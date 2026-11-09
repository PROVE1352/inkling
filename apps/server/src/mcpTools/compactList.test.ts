// list_pages/search format 'compact' (docs/adr/1541-*): sibling folding, brace values, short ids.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PageMetaDTO } from '@inkling/shared'
import { braceValues, foldSiblings, renderCompactTree, shortIdsFor } from './compactList'
import type { FoldItem } from './compactList'

const item = (title: string, i: number, extra: Partial<FoldItem> = {}): FoldItem => ({
  id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
  title,
  marks: '',
  foldable: true,
  ...extra,
})

describe('compact list output', () => {
  it('braceValues: ranges for consecutive numbers of one width, lists otherwise', () => {
    assert.equal(braceValues(['1', '2', '3', '4', '5', '6', '7', '8']), '1..8')
    assert.equal(braceValues(['03', '10', '17']), '03,10,17')
    assert.equal(braceValues(['01', '02', '03', '05', '07', '08', '09']), '01..03,05,07..09')
    assert.equal(braceValues(['17', '16', '15']), '17..15')
    assert.equal(braceValues(['1', '2']), '1,2')
    // 09 → 10 keeps the width, so it is consecutive; 9 → 010 is not
    assert.equal(braceValues(['08', '09', '10']), '08..10')
    assert.equal(braceValues(['8', '9', '010']), '8,9,010')
  })

  it('foldSiblings: one varying number folds; months that change split the run', () => {
    const items = [
      item('Weekly sync 2026-10-27', 1),
      item('Weekly sync 2026-11-03', 2),
      item('Weekly sync 2026-11-10', 3),
      item('Weekly sync 2026-11-17', 4),
      item('Roadmap', 5),
      item('실험 일지 10-1', 6),
      item('실험 일지 10-2', 7),
      item('실험 일지 10-3', 8),
      item('실험 일지 10-4', 9),
    ]
    const f = foldSiblings(items)
    assert.deepEqual(
      f.map((x) => (x.kind === 'run' ? `${x.label} (${x.items.length})` : x.item.title)),
      ['Weekly sync 2026-10-27', 'Weekly sync 2026-11-{03,10,17} (3)', 'Roadmap', '실험 일지 10-{1..4} (4)'],
    )
  })

  it('foldSiblings: pages with children, other marks, braces or fewer than three never fold', () => {
    const f = foldSiblings([
      item('Log 1', 1),
      item('Log 2', 2, { foldable: false }),
      item('Log 3', 3),
      item('Log 4', 4, { marks: ' [collection]' }),
      item('Sprint {1}', 5),
      item('Sprint {2}', 6),
      item('Sprint {3}', 7),
      item('Day 1', 8),
      item('Day 2', 9),
    ])
    assert.equal(f.filter((x) => x.kind === 'run').length, 0)
    assert.equal(f.length, 9)
  })

  it('shortIdsFor: 8 characters, the full id only where two share the prefix', () => {
    const a = 'abcdef01-1111-4000-8000-000000000001'
    const b = 'abcdef01-2222-4000-8000-000000000002'
    const c = '12345678-0000-4000-8000-000000000003'
    const m = shortIdsFor([a, b, c])
    assert.equal(m.get(a), a)
    assert.equal(m.get(b), b)
    assert.equal(m.get(c), '12345678')
  })

  it('renderCompactTree: folded runs keep every id in order; depth and hidden children as in lines', () => {
    const page = (id: string, title: string, parentId: string | null, sortOrder: number, extra: Partial<PageMetaDTO> = {}) =>
      ({ id, title, parentId, sortOrder, kind: 'doc', scope: 'shared', ...extra }) as PageMetaDTO
    const id = (n: number) => `${String(n).padStart(8, 'a')}-0000-4000-8000-000000000000`
    const all = [
      page(id(1), 'Meetings', null, 0),
      ...[3, 10, 17, 24].map((d, i) => page(id(10 + i), `Weekly sync 2026-11-${String(d).padStart(2, '0')}`, id(1), i)),
      page(id(2), 'Private notes', null, 1, { scope: 'private' }),
      page(id(3), 'Child', id(2), 0),
    ]
    const out = renderCompactTree(all, {})
    assert.equal(
      out,
      [
        `- Meetings ${id(1).slice(0, 8)}`,
        ` - Weekly sync 2026-11-{03,10,17,24} ids: ${[10, 11, 12, 13].map((n) => id(n).slice(0, 8)).join(',')}`,
        `- Private notes 🔒 ${id(2).slice(0, 8)}`,
        ` - Child ${id(3).slice(0, 8)}`,
      ].join('\n'),
    )
    assert.equal(renderCompactTree(all, { depth: 1 }), [`- Meetings ${id(1).slice(0, 8)} (+4)`, `- Private notes 🔒 ${id(2).slice(0, 8)} (+1)`].join('\n'))
    assert.equal(renderCompactTree(all, { parentId: id(2) }), `- Child ${id(3).slice(0, 8)}`)
    assert.equal(renderCompactTree([], {}), 'No pages here.')
  })
})
