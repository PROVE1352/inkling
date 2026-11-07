# 0710. Graph view: keep d3-force object nodes (SoA rewrite rejected after measuring)

- Status: Rejected
- Date: 2026-11-07

## Context
The audit suggested moving the graph layout (d3-force, thousands of nodes) from arrays of objects to
TypedArray structure-of-arrays for cache locality, and checking the page-tree build.

## Measurements
Graph view, workspace with 2 335 pages (production build, headless Chromium, M-series Mac): frame
intervals over the first 6 s of simulation p50 16.7 ms, p95 16.8 ms (vsync-bound), one 57 ms long
task at start (model build + warm-up ticks capped at 40 ms in `graphEngine.ts`). The tree build is
already O(n) with a parent index (`buildTree`, and `buildTreeShared` from 0708).

## Decision
No change. Every frame fits the 60 Hz budget at this size; replacing d3-force's node objects with
SoA means re-implementing many-body/link/collide forces (965-line engine) for no measurable gain.

## Alternatives considered
- SoA Float64Array positions/velocities with a custom Barnes–Hut: worthwhile only past ~20 k nodes
  or on low-end mobile; revisit with a measurement there.
- Running the simulation in a worker: same trigger.

## Trade-offs
Large graphs on slow phones may drop frames during the first seconds of layout.

## How others solve it
Obsidian (pixi + d3-force), Cosmograph (GPU force layout) for 100 k+ nodes.

## Consequences
Revisit if graphs with >10 k nodes become common (see also 0759 for the server side).

## References
- apps/web/src/components/graph/graphEngine.ts:225 (warm-up ticks), :393 (frame tick)
- apps/web/src/components/PageTree.tsx (`buildTree`, `buildTreeShared`)
