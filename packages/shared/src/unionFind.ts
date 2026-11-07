/**
 * Disjoint sets (Union-Find) with union by size and path compression (docs/adr/1120-*).
 *
 * Elements are dense integers 0..n-1; callers map their ids to indices (see `groupByKeys` and
 * `components`). Two arrays, no objects per element:
 *   parent[i] = parent of i in its tree (a root points to itself)
 *   size[i]   = number of elements under root i (only meaningful at roots)
 *
 * Why size and not rank: the size of a set is useful by itself (island size, how many duplicates
 * a group merged), and union by size gives the same O(log n) height bound as union by rank
 * (a tree of height h has at least 2^h elements). With path compression on top, m operations on
 * n elements cost O(m α(n)) — α is the inverse Ackermann function, ≤ 4 for any n that fits in memory.
 *
 * What it cannot do: split. Once two sets are joined, there is no operation that separates them
 * again (the tree no longer remembers which union created which edge). That is the test for
 * whether it fits a problem here: things that only ever merge (links counted in one pass,
 * duplicates found during one import) fit; things that also come apart (a page moved out of a
 * subtree, a link deleted later, a page name taken over by another page) do not — those are
 * recomputed from scratch or keyed by a version instead (ADR 1071).
 *
 * `bySize` / `compress` exist only so the unit test can measure what each half buys; production
 * code uses the defaults (both on).
 */
export interface UnionFindOptions {
  /** Attach the smaller tree under the larger one (default true). Off = always attach a under b. */
  bySize?: boolean
  /** Point every node on a find path straight at the root (default true). */
  compress?: boolean
}

export class UnionFind {
  readonly parent: Int32Array
  readonly size: Int32Array
  private readonly bySize: boolean
  private readonly compress: boolean
  /** Number of disjoint sets. */
  count: number
  /** Parent-pointer hops taken by every find so far (measurement only). */
  steps = 0

  constructor(n: number, opt: UnionFindOptions = {}) {
    this.parent = new Int32Array(n)
    this.size = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      this.parent[i] = i
      this.size[i] = 1
    }
    this.count = n
    this.bySize = opt.bySize ?? true
    this.compress = opt.compress ?? true
  }

  /** Root of x's set (find-set). Iterative: no recursion depth limit on a degenerate chain. */
  find(x: number): number {
    const p = this.parent
    let root = x
    while (p[root] !== root) {
      root = p[root]
      this.steps++
    }
    if (this.compress) {
      // Second pass: every node on the path now points at the root (path compression).
      while (p[x] !== root) {
        const next = p[x]
        p[x] = root
        x = next
      }
    }
    return root
  }

  /** Joins the sets of a and b. Returns false when they already were one set. */
  union(a: number, b: number): boolean {
    let ra = this.find(a)
    let rb = this.find(b)
    if (ra === rb) return false
    if (this.bySize && this.size[ra] > this.size[rb]) {
      const t = ra
      ra = rb
      rb = t
    }
    // ra (the smaller tree, when bySize) goes under rb
    this.parent[ra] = rb
    this.size[rb] += this.size[ra]
    this.count--
    return true
  }

  same(a: number, b: number): boolean {
    return this.find(a) === this.find(b)
  }

  /** Size of x's set. */
  setSize(x: number): number {
    return this.size[this.find(x)]
  }
}

/**
 * Connected components of an undirected graph over string ids. Edges whose ends are not in `ids`
 * are ignored (the caller decides the node set — e.g. only pages the viewer may see).
 * Returns the components largest first (ties: by the first id in input order), each listing its
 * ids in input order, and the component index of every id.
 */
export function components(
  ids: readonly string[],
  edges: Iterable<readonly [string, string]>,
): { groups: string[][]; indexOf: Map<string, number> } {
  const at = new Map<string, number>()
  ids.forEach((id, i) => at.set(id, i))
  const uf = new UnionFind(ids.length)
  for (const [a, b] of edges) {
    const ia = at.get(a)
    const ib = at.get(b)
    if (ia === undefined || ib === undefined || ia === ib) continue
    uf.union(ia, ib)
  }
  const byRoot = new Map<number, string[]>()
  const order: number[] = []
  for (let i = 0; i < ids.length; i++) {
    const r = uf.find(i)
    let g = byRoot.get(r)
    if (!g) {
      g = []
      byRoot.set(r, g)
      order.push(r)
    }
    g.push(ids[i])
  }
  // order already follows the first member's input position; a stable sort by size keeps that for ties
  const groups = order.map((r) => byRoot.get(r)!).sort((a, b) => b.length - a.length)
  const indexOf = new Map<string, number>()
  groups.forEach((g, gi) => {
    for (const id of g) indexOf.set(id, gi)
  })
  return { groups, indexOf }
}

/**
 * Groups items that share any key (transitively): item A with keys {x, y} and item B with {y, z}
 * and item C with {z} end up in one group even though A and C share nothing directly. With a
 * single key per item a `Map<key, first item>` gives the same answer; the union-find earns its
 * place when an item has several identities (docs/adr/1122-*).
 *
 * Returns, for every item index, the index of its group's representative — the first item of the
 * group in input order (so "keep the first, point the rest at it" is deterministic).
 */
export function groupByKeys<T>(items: readonly T[], keysOf: (item: T) => Iterable<string>): number[] {
  const uf = new UnionFind(items.length)
  const firstWithKey = new Map<string, number>()
  items.forEach((item, i) => {
    for (const k of keysOf(item)) {
      const prev = firstWithKey.get(k)
      if (prev === undefined) firstWithKey.set(k, i)
      else uf.union(prev, i)
    }
  })
  const rep = new Map<number, number>()
  const out = new Array<number>(items.length)
  for (let i = 0; i < items.length; i++) {
    const r = uf.find(i)
    const have = rep.get(r)
    if (have === undefined) {
      rep.set(r, i)
      out[i] = i
    } else {
      out[i] = have
    }
  }
  return out
}
