# 1120. One union-find module, and the rule for when it fits

- Status: Accepted
- Date: 2026-11-07

## Context
Three features need "which things belong together": rename chains of page titles (ADR 1121),
duplicates found during an import (ADR 1122) and link islands of the graph (ADR 1123). The
textbook structure for that is the disjoint-set forest (union-find): `find-set(x)` walks parent
pointers to the root that names x's set, `union(a, b)` hangs one root under the other. Without
care a tree degenerates into a chain and `find` costs O(n).

## Decision
`packages/shared/src/unionFind.ts`, used by the server and the web app:

- `UnionFind(n)` over dense integers: `parent` and `size` as `Int32Array`, no object per element.
- **Union by size** (the smaller tree goes under the larger root). Size rather than rank because
  the size is wanted anyway (island size, group size) and gives the same bound: a tree of height
  h holds at least 2^h elements, so height ≤ log2 n.
- **Path compression** in `find`: a second pass points every node of the walked path at the root.
  Iterative, so a degenerate chain cannot overflow the stack.
- Together: m operations on n elements in O(m α(n)); α (inverse Ackermann) is ≤ 4 for any n that
  fits in memory.
- Helpers: `components(ids, edges)` (connected components, largest first, members in input order)
  and `groupByKeys(items, keysOf)` (items sharing any key, transitively; representative = first
  item in input order, so "keep the first, point the rest at it" is deterministic).
- `bySize` / `compress` switches exist only for the measurement below.

## Measured: what each half buys
`apps/server/src/unionFind.test.ts`, n = 4,096, parent-pointer hops counted by the module:

| Variant | Chain input: n unions `union(0, k)` + n finds | Binomial tree (height 12): n finds of the deepest leaf |
|---|---:|---:|
| Neither | 16,769,025 | 49,152 |
| Union by size only | 8,189 | 49,152 |
| Path compression only | 16,376 | 4,107 |
| Both | 8,189 | 4,107 |

The chain input (every union hangs the big tree under a new singleton) is the worst case without
union by size: Θ(n²), 2,048× more hops than with both. The binomial tree (pairwise unions of equal
trees) is the worst case union by size still allows: height log2 n = 12, paid on every find
without compression (12 n); with compression the first find pays 12 and every later one 1.

## Why this data structure, and where it does not fit
Union-find answers "are these in the same set" in near-constant time while sets only **merge**.
It has no split: once two sets are joined, nothing in the forest remembers which union joined
them. That is the test applied to every candidate:

- Fits: link islands computed in one pass over the current links (ADR 1123); duplicates found
  while one import runs (ADR 1122).
- Does not fit: anything that also comes apart. A page moved out of a locked subtree, a link
  deleted later, a name that another page takes over (ADR 1121). Page-tree moves were solved with
  a version-keyed cache instead (ADR 1071); islands are recomputed instead of maintained; former
  titles are keyed by the page id, which never changes, so no set ever needs to split.
- Where one key decides membership (a content hash), a `Map<key, representative>` is the same
  answer with every tree of depth 1; the union-find only adds value when an item has several
  identities that can chain (A shares a key with B, B with C).

## Alternatives considered
- **BFS/DFS for components.** Same O(V + E) for a one-off pass and no less code; union-find was
  kept because the same module serves the import grouping, works on an edge stream without
  building adjacency lists, and is the structure the course this was written alongside teaches.
- **Union by rank.** Equivalent bound; size is more useful to the callers.
- **Recursive find.** Shorter, but a 200,000-element chain (no union by size) overflows the stack;
  the test covers it.

## Consequences
- One small module with no dependencies; the web bundle gains about 1 KB.
- The structure is rebuilt per use (per import, per graph request); nothing persistent depends on it.

## References
- ADR 1121 (former titles), ADR 1122 (import de-duplication), ADR 1123 (link islands), ADR 1071
  (why a version key, not a split, handles page moves).
- Tarjan, "Efficiency of a Good But Not Linear Set Union Algorithm", JACM 1975.
