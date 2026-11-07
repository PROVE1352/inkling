import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { GraphDTO } from '../../api'
import { buildModel, G_NEUTRAL, G_ORPHAN } from './graphModel'

// Link islands in the graph model (docs/adr/1123-*): colour groups per island, "only this island".
const node = (id: string, title = id) => ({ id, title, icon: null, kind: 'doc' as const, parentId: null, links: 0 })
const graph: GraphDTO = {
  nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => node(id, id.toUpperCase())),
  edges: [
    { source: 'a', target: 'b' },
    { source: 'c', target: 'b' },
    { source: 'd', target: 'e' },
    { source: 'g', target: 'g' }, // self-link: not an edge
  ],
}

describe('graph model: link islands', () => {
  it('colours by island, largest first, named after the most linked page', () => {
    const m = buildModel(graph, { showOrphans: true, showTags: false, colorBy: 'island' })
    assert.equal(m.islandCount, 2)
    assert.deepEqual(
      m.groups.map((g) => [g.key, g.count]),
      [
        ['b', 3],
        ['d', 2],
      ],
    )
    const gi = Object.fromEntries(m.nodes.map((n) => [n.id, n.gi]))
    assert.equal(gi.a, 0)
    assert.equal(gi.c, 0)
    assert.equal(gi.e, 1)
    assert.equal(gi.f, G_ORPHAN)
    assert.equal(gi.g, G_ORPHAN)
  })

  it('shows only the island of the chosen page', () => {
    const m = buildModel(graph, { showOrphans: true, showTags: false, colorBy: 'island', island: 'e' })
    assert.deepEqual(m.nodes.map((n) => n.id).sort(), ['d', 'e'])
    assert.equal(m.links.length, 1)
    assert.equal(m.islandCount, 1)
  })

  it('folder colouring is unchanged when islands are off', () => {
    const m = buildModel(graph, { showOrphans: true, showTags: false })
    assert.ok(m.nodes.every((n) => n.gi === G_NEUTRAL || n.gi === G_ORPHAN))
    assert.equal(m.groups.length, 0)
  })
})
