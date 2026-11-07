import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UnionFind, components, groupByKeys } from '@inkling/shared'
import type { UnionFindOptions } from '@inkling/shared'

// docs/adr/1120-*: what union by size and path compression each buy, measured as parent-pointer
// hops (`steps`) on inputs built to be the worst case for the variant without them.

const VARIANTS: [string, UnionFindOptions][] = [
  ['no size, no compression', { bySize: false, compress: false }],
  ['size only', { bySize: true, compress: false }],
  ['compression only', { bySize: false, compress: true }],
  ['size + compression', { bySize: true, compress: true }],
]

/**
 * Worst case for "no size": every union hangs the big tree under a new singleton, so the tree is
 * one chain and each union's find(0) walks all of it (Θ(n²) without either fix). Then n finds.
 */
function chainWorkload(opt: UnionFindOptions, n: number): number {
  const uf = new UnionFind(n, opt)
  for (let k = 1; k < n; k++) uf.union(0, k)
  for (let i = 0; i < n; i++) uf.find(i)
  return uf.steps
}

/**
 * Worst case for "size only": pairwise unions of equal-size trees build a binomial tree of height
 * log2 n (the most union by size allows); then n finds of its deepest leaf, which without
 * compression pays the full height every time.
 */
function binomialWorkload(opt: UnionFindOptions, n: number): { steps: number; height: number } {
  const uf = new UnionFind(n, opt)
  for (let w = 1; w < n; w *= 2) {
    // Union roots (not leaves) so the build itself costs no hops and the variants start equal.
    for (let i = 0; i + w < n; i += 2 * w) uf.union(i + w, i)
  }
  // height of element 0's path before the timed finds
  let h = 0
  for (let x = 0; uf.parent[x] !== x; x = uf.parent[x]) h++
  // deepest leaf: walk the tree for the element whose path is longest
  let deepest = 0
  let best = -1
  for (let i = 0; i < n; i++) {
    let d = 0
    for (let x = i; uf.parent[x] !== x; x = uf.parent[x]) d++
    if (d > best) {
      best = d
      deepest = i
    }
  }
  uf.steps = 0
  for (let i = 0; i < n; i++) uf.find(deepest)
  return { steps: uf.steps, height: Math.max(h, best) }
}

describe('UnionFind', () => {
  it('find-set, union and set sizes', () => {
    const uf = new UnionFind(6)
    assert.equal(uf.count, 6)
    assert.equal(uf.union(0, 1), true)
    assert.equal(uf.union(2, 3), true)
    assert.equal(uf.union(1, 0), false)
    assert.equal(uf.union(1, 3), true)
    assert.equal(uf.count, 3)
    assert.equal(uf.same(0, 2), true)
    assert.equal(uf.same(0, 4), false)
    assert.equal(uf.setSize(3), 4)
    assert.equal(uf.setSize(5), 1)
  })

  it('a long chain does not overflow the stack (iterative find)', () => {
    const uf = new UnionFind(200_000, { bySize: false, compress: true })
    for (let k = 1; k < 200_000; k++) uf.union(k - 1, k)
    assert.equal(uf.find(0), uf.find(199_999))
  })

  it('components() agrees with BFS on random graphs', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let round = 0; round < 50; round++) {
      const n = 1 + Math.floor(rnd() * 40)
      const ids = Array.from({ length: n }, (_, i) => `p${i}`)
      const edges: [string, string][] = []
      const m = Math.floor(rnd() * n)
      for (let e = 0; e < m; e++) edges.push([ids[Math.floor(rnd() * n)], ids[Math.floor(rnd() * n)]])
      // an edge to a node outside the set is ignored
      edges.push(['p0', 'not-a-node'])
      const { groups, indexOf } = components(ids, edges)
      // BFS reference
      const adj = new Map(ids.map((id) => [id, [] as string[]]))
      for (const [a, b] of edges) {
        if (!adj.has(a) || !adj.has(b)) continue
        adj.get(a)!.push(b)
        adj.get(b)!.push(a)
      }
      const comp = new Map<string, number>()
      let c = 0
      for (const id of ids) {
        if (comp.has(id)) continue
        const q = [id]
        comp.set(id, c)
        while (q.length) for (const nb of adj.get(q.pop()!)!) if (!comp.has(nb)) (comp.set(nb, c), q.push(nb))
        c++
      }
      assert.equal(groups.length, c)
      for (const a of ids) for (const b of ids) assert.equal(indexOf.get(a) === indexOf.get(b), comp.get(a) === comp.get(b))
      for (let i = 1; i < groups.length; i++) assert.ok(groups[i - 1].length >= groups[i].length, 'largest first')
      assert.equal(groups.flat().length, n)
    }
  })

  it('groupByKeys merges transitively and keeps the first item as representative', () => {
    const items = [
      { name: 'a', keys: ['x'] },
      { name: 'b', keys: ['q'] },
      { name: 'c', keys: ['y', 'z'] },
      { name: 'd', keys: ['x', 'y'] }, // joins a and c
      { name: 'e', keys: [] as string[] },
    ]
    const rep = groupByKeys(items, (i) => i.keys)
    assert.deepEqual(rep, [0, 1, 0, 0, 4])
  })

  it('find steps on worst-case inputs: size and compression each remove a factor', () => {
    const n = 4096
    const chain = VARIANTS.map(([name, opt]) => [name, chainWorkload(opt, n)] as const)
    const bin = VARIANTS.map(([name, opt]) => [name, binomialWorkload(opt, n)] as const)
    console.log(`[union-find] n = ${n}, find steps (parent-pointer hops)`)
    console.log('  variant                    | chain: n unions + n finds | binomial: n finds of the deepest leaf (height)')
    for (let i = 0; i < VARIANTS.length; i++) {
      console.log(
        `  ${chain[i][0].padEnd(26)} | ${String(chain[i][1]).padStart(25)} | ${String(bin[i][1].steps).padStart(10)} (h=${bin[i][1].height})`,
      )
    }
    const steps = Object.fromEntries(chain) as Record<string, number>
    const none = steps['no size, no compression']
    const both = steps['size + compression']
    // No fix at all: Θ(n²) — every union walks the whole chain.
    assert.ok(none >= (n * (n - 1)) / 2, `quadratic chain: ${none}`)
    // Either fix alone already brings the chain workload to near-linear here.
    assert.ok(steps['size only'] <= 2 * n, `size only: ${steps['size only']}`)
    assert.ok(steps['compression only'] <= 4 * n, `compression only: ${steps['compression only']}`)
    assert.ok(both <= 2 * n, `both: ${both}`)
    assert.ok(none / both > 500, 'at least 500× fewer hops with both fixes')
    // Binomial tree: union by size bounds the height by log2 n, so size-only pays log2 n per find…
    const b = Object.fromEntries(bin) as Record<string, { steps: number; height: number }>
    assert.equal(b['size only'].height, Math.log2(n))
    assert.equal(b['size only'].steps, n * Math.log2(n))
    // …and compression makes every find after the first one hop.
    assert.equal(b['size + compression'].steps, Math.log2(n) + (n - 1))
  })
})
